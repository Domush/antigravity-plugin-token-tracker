/**
 * Antigravity Token Tracker — Live Usage Fallback, Model Enrichment & SQLite Stub Sub-Suite.
 * Companion sub-suite for `test_hooks_live_usage.js` covering SessionStart offline/subagent
 * resilience, `hasCatalogMatch` / `applyModelUsageMetrics`, and >10-stub `gen_metadata` fallback.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { ConversationTracker } from "../lib/conversation-tracker.js";
import { hasCatalogMatch } from "../lib/models.js";
import { applyModelUsageMetrics } from "../lib/compaction.js";
import { runSessionStart } from "../hooks/session-start.js";

/**
 * Creates a temporary SQLite conversation database with deterministic rows.
 * @param {string} convDir
 * @param {string} convId
 * @param {{ genRows?: Array<{ idx: number, data: Buffer }>, trajText?: string|null, stepCount?: number }} [opts]
 * @returns {string}
 */
export function createConvDb(convDir, convId, { genRows = [], trajText = null, stepCount = 0 } = {}) {
  const dbPath = path.join(convDir, `${convId}.db`);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE steps (step_id TEXT PRIMARY KEY, metadata TEXT, step_payload TEXT, render_info TEXT, task_details TEXT);
    `);
    if (typeof trajText === "string") {
      db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(Buffer.from(trajText));
    }
    const insertGen = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
    for (const row of genRows) {
      insertGen.run(row.idx, row.data);
    }
    const insertStep = db.prepare("INSERT INTO steps (step_id, metadata, step_payload, render_info, task_details) VALUES (?, '', '', '', '')");
    for (let i = 0; i < stepCount; i++) {
      insertStep.run(`step-${i}`);
    }
  } finally {
    db.close();
  }
  return dbPath;
}

/**
 * Registers SessionStart fallback/isolation, model-enrichment, and SQLite >10-stub fallback tests.
 * @param {(name: string, fn: () => void) => void} test
 * @param {(name: string, fn: () => Promise<void>) => Promise<void>} testAsync
 */
export async function registerHooksLiveFallbackTests(test, testAsync) {
  // 8. SessionStart: Offline resilience, missing DB, & subagent isolation
  await testAsync("session-start: offline RPC fallback, missing DB, and subagent isolation", async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-sess-off-"));
    try {
      const convDir = path.join(testDir, "conversations");
      const dataDir = path.join(testDir, "data");
      fs.mkdirSync(convDir, { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true });

      const activeFile = path.join(dataDir, "active_conversation.json");
      const rootSnapshot = JSON.stringify({ conversationId: "root-sess", updatedAt: "2026-01-01T00:00:00.000Z" }, null, 2);
      fs.writeFileSync(activeFile, rootSnapshot, "utf8");

      createConvDb(convDir, "sub-sess", {
        trajText: "model gemini-4-hydrogen-high",
        genRows: [{ idx: 1, data: Buffer.alloc(400000, 0x61) }],
        stepCount: 1
      });

      const tracker = new ConversationTracker({ conversationsDir: convDir });
      const res = await runSessionStart({
        payload: { conversationId: "sub-sess", parentConversationId: "root-sess" },
        tracker,
        quotaService: {
          async getQuotaSummary() { throw new Error("offline"); },
          async getCascadeUsage() { throw new Error("offline"); }
        },
        dataDir
      });

      assert.strictEqual(fs.readFileSync(activeFile, "utf8"), rootSnapshot);
      const msg = res?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.strictEqual(
        msg,
        [
          "[token-tracker active]",
          "• Model: Gemini 4 Hydrogen (High) (1.05M max context)",
          "• Context Usage: 100k tokens (9.5%)",
          "• Cache Efficiency: 0% hit ratio (0 cached / 100k uncached)",
          "• Compaction Headroom: 412k tokens (~1609 KB) remaining before automatic compaction (Trigger: 512k)"
        ].join("\n")
      );

      // Missing DB with healthy quota still emits baseline active message + quota line
      const healthyQuota = {
        gemini: {
          fiveHour: { remainingPercent: 88, countdown: "3h 10m" },
          weekly: { remainingPercent: 92, countdown: "5d 4h" }
        }
      };
      const emptyRes = await runSessionStart({
        payload: { conversationId: "unknown-db" },
        tracker,
        quotaService: {
          async getQuotaSummary() { return healthyQuota; },
          async getCascadeUsage() { throw new Error("should not run"); }
        },
        dataDir: null
      });
      assert.strictEqual(
        emptyRes?.injectSteps?.[0]?.systemMessage?.systemMessage,
        [
          "[token-tracker active]",
          "• Gemini Quotas: 5h limit 88% (resets 3h 10m), Weekly 92% (resets 5d 4h)"
        ].join("\n")
      );

      // Corrupt DB emits baseline fallback metrics (0 tokens) + quota without throwing
      const corruptBytes = "GARBAGE NOT SQLITE DATA 12345";
      fs.writeFileSync(path.join(convDir, "corrupt-sess.db"), corruptBytes, "utf8");
      const corruptMetrics = tracker.getConversationMetrics("corrupt-sess", { strict: true });
      assert.strictEqual(corruptMetrics.contextWindow.currentTokens, 0);
      assert.strictEqual(corruptMetrics.stepCount, 0);
      assert.strictEqual(corruptMetrics.model.isFallback, true);
      assert.strictEqual(corruptMetrics.compaction.cumulativeHistoryBytes, Buffer.byteLength(corruptBytes));

      const corruptRes = await runSessionStart({
        payload: { conversationId: "corrupt-sess" },
        tracker,
        quotaService: {
          async getQuotaSummary() { return healthyQuota; },
          async getCascadeUsage() { return null; }
        },
        dataDir: null
      });
      assert.strictEqual(
        corruptRes?.injectSteps?.[0]?.systemMessage?.systemMessage,
        [
          "[token-tracker active]",
          "• Model: Gemini 3.8 Flash (High) (1.05M max context)",
          "• Context Usage: 0 tokens (0%)",
          "• Cache Efficiency: 0% hit ratio (0 cached / 0 uncached)",
          "• Compaction Headroom: 256k tokens (~1000 KB) remaining before automatic compaction (Trigger: 256k)",
          "• Gemini Quotas: 5h limit 88% (resets 3h 10m), Weekly 92% (resets 5d 4h)"
        ].join("\n")
      );
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 9. lib/compaction.js & lib/models.js: hasCatalogMatch & applyModelUsageMetrics
  test("compaction & models: hasCatalogMatch and applyModelUsageMetrics enrichment vs non-clobber", () => {
    assert.strictEqual(hasCatalogMatch("gemini-4-hydrogen-high"), true);
    assert.strictEqual(hasCatalogMatch("claude-opus-5-5-1m"), true);
    assert.strictEqual(hasCatalogMatch("MODEL_PLACEHOLDER_M37"), false);
    assert.strictEqual(hasCatalogMatch("-O3"), false);
    assert.strictEqual(hasCatalogMatch(null), false);

    // Enriches fallback model when modelUsage.model matches catalog
    const fallbackMetrics = {
      model: { id: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)", maxTokens: 1048576, compactionTokens: 256000, group: "gemini", isFallback: true },
      contextWindow: {},
      cache: {},
      compaction: { cumulativeHistoryBytes: 1024 }
    };
    const enriched = applyModelUsageMetrics(fallbackMetrics, {
      cacheReadTokens: 200000,
      inputTokens: 56000,
      cacheCreationTokens: 0,
      totalPromptTokens: 256000,
      model: "gemini-4-hydrogen-high"
    });
    assert.strictEqual(enriched.model.id, "gemini-4-hydrogen-high");
    assert.strictEqual(enriched.model.displayName, "Gemini 4 Hydrogen (High)");
    assert.strictEqual(enriched.model.maxTokens, 1048576);
    assert.strictEqual(enriched.model.compactionTokens, 512000);
    assert.strictEqual(enriched.model.isFallback, false);
    assert.strictEqual(enriched.compaction.thresholdTokens, 512000);
    assert.strictEqual(enriched.compaction.percentCompacted, 50);

    // Fallback model stays intact when LS sends unrecognized placeholder enum
    const fallbackWithPlaceholder = applyModelUsageMetrics(fallbackMetrics, {
      cacheReadTokens: 100000,
      inputTokens: 10000,
      cacheCreationTokens: 0,
      totalPromptTokens: 110000,
      model: "MODEL_PLACEHOLDER_M37"
    });
    assert.strictEqual(fallbackWithPlaceholder.model.id, "gemini-3.8-flash-high");
    assert.strictEqual(fallbackWithPlaceholder.model.isFallback, true);

    // Does NOT clobber catalog-matched model with unknown LS enum or different catalog model
    const matchedMetrics = {
      model: { id: "claude-opus-5-5-1m", displayName: "Claude Opus 5.5 (1M)", maxTokens: 1000000, compactionTokens: 512000, group: "thirdParty", isFallback: false },
      contextWindow: {},
      cache: {},
      compaction: { cumulativeHistoryBytes: 0 }
    };
    const withPlaceholder = applyModelUsageMetrics(matchedMetrics, {
      cacheReadTokens: 100000,
      inputTokens: 10000,
      cacheCreationTokens: 0,
      totalPromptTokens: 110000,
      model: "MODEL_PLACEHOLDER_M37"
    });
    assert.strictEqual(withPlaceholder.model.id, "claude-opus-5-5-1m");
    assert.strictEqual(withPlaceholder.model.maxTokens, 1000000);

    const withOtherCatalog = applyModelUsageMetrics(matchedMetrics, {
      cacheReadTokens: 100000,
      inputTokens: 10000,
      cacheCreationTokens: 0,
      totalPromptTokens: 110000,
      model: "gemini-3.8-flash"
    });
    assert.strictEqual(withOtherCatalog.model.id, "claude-opus-5-5-1m");

    // Negative paths: null / non-positive / zero component tokens leave metrics unchanged
    assert.strictEqual(applyModelUsageMetrics(null, { totalPromptTokens: 100 }), null);
    assert.strictEqual(applyModelUsageMetrics(matchedMetrics, null), matchedMetrics);
    assert.strictEqual(applyModelUsageMetrics(matchedMetrics, { totalPromptTokens: 0 }), matchedMetrics);
    assert.strictEqual(applyModelUsageMetrics(matchedMetrics, { totalPromptTokens: -10 }), matchedMetrics);
    assert.strictEqual(applyModelUsageMetrics(matchedMetrics, { totalPromptTokens: 100, cacheReadTokens: 0, inputTokens: 0, cacheCreationTokens: 0 }), matchedMetrics);
  });

  // 10. lib/conversation-tracker.js: Offline gen_metadata >10-stub fallback
  test("conversation-tracker: offline gen_metadata >10-stub fallback preserves prior substantial cache ratio", () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-gen-stubs-"));
    try {
      const genRows = [{ idx: 1, data: Buffer.alloc(24000, 0x61) }];
      for (let idx = 2; idx <= 13; idx++) {
        genRows.push({ idx, data: Buffer.alloc(512, 0x62) });
      }
      genRows.push({ idx: 14, data: Buffer.alloc(32000, 0x63) });

      createConvDb(testDir, "conv-many-stubs", { genRows });
      const tracker = new ConversationTracker({ conversationsDir: testDir });
      const metrics = tracker.getConversationMetrics("conv-many-stubs");

      assert.strictEqual(metrics.contextWindow.currentTokens, 8000);
      assert.strictEqual(metrics.cache.cachedTokens, 6000);
      assert.strictEqual(metrics.cache.uncachedTokens, 2000);
      assert.strictEqual(metrics.cache.hitRatio, 0.75);
      assert.strictEqual(metrics.cache.hitRatioPercent, 75);

      // Boundary: >10 stubs with NO prior substantial row resolves cleanly to 0%
      const stubOnlyRows = [];
      for (let idx = 1; idx <= 12; idx++) {
        stubOnlyRows.push({ idx, data: Buffer.alloc(512, 0x62) });
      }
      stubOnlyRows.push({ idx: 13, data: Buffer.alloc(32000, 0x63) });
      createConvDb(testDir, "conv-no-prior-substantial", { genRows: stubOnlyRows });

      const stubMetrics = tracker.getConversationMetrics("conv-no-prior-substantial");
      assert.strictEqual(stubMetrics.contextWindow.currentTokens, 8000);
      assert.strictEqual(stubMetrics.cache.cachedTokens, 0);
      assert.strictEqual(stubMetrics.cache.hitRatioPercent, 0);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });
}
