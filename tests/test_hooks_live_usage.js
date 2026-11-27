/**
 * Antigravity Token Tracker — Live Model Usage Hook & Fallback Test Suite.
 * Validates PreInvocation & SessionStart live Language Server `modelUsage` enrichment,
 * offline/error resilience, subagent isolation, cooldown/delta suppression,
 * `applyModelUsageMetrics` / `hasCatalogMatch` contracts, and >10-stub SQLite fallback.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ConversationTracker } from "../lib/conversation-tracker.js";
import { runPreInvocation, shouldEmitCompactionAdvisory } from "../hooks/pre-invocation.js";
import { runSessionStart } from "../hooks/session-start.js";
import { createConvDb, registerHooksLiveFallbackTests } from "./test_hooks_live_fallback.js";

/**
 * Runs the live hook usage test suite.
 * @returns {Promise<{ passed: number, failed: number }>}
 */
export async function runHooksLiveUsageTests() {
  console.log("--- Running test_hooks_live_usage.js ---");
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }

  // 1. PreInvocation: Live LS enrichment overrides inflated SQLite metrics
  await testAsync("pre-invocation: live LS enrichment overrides SQLite heuristics and formats lines", async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-pre-live-"));
    try {
      const convDir = path.join(testDir, "conversations");
      const dataDir = path.join(testDir, "data");
      fs.mkdirSync(convDir, { recursive: true });
      createConvDb(convDir, "conv-live-enrich", {
        genRows: [{ idx: 1, data: Buffer.alloc(2000000, 0x61) }],
        stepCount: 3
      });

      const rpcCalls = [];
      const tracker = new ConversationTracker({ conversationsDir: convDir });
      const quotaService = {
        async getCascadeUsage(convId, stepCount, forceRefresh) {
          rpcCalls.push({ convId, stepCount, forceRefresh });
          return {
            cacheReadTokens: 410435,
            inputTokens: 4565,
            cacheCreationTokens: 0,
            outputTokens: 1200,
            totalPromptTokens: 415000,
            model: "gemini-4-hydrogen-high"
          };
        }
      };

      const res = await runPreInvocation({
        payload: { conversationId: "conv-live-enrich" },
        tracker,
        quotaService,
        dataDir,
        nowMs: 1_700_000_000_000
      });

      assert.deepStrictEqual(rpcCalls, [{ convId: "conv-live-enrich", stepCount: 3, forceRefresh: false }]);
      const msg = res?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.strictEqual(
        msg,
        [
          "[token-tracker compaction advisory]",
          "• Context Window: 415k / 1.05M (39.6%)",
          "• Active Context: 415k / Trigger: 512k (81%, ~1621.1 / 2000 KB)",
          "• Compaction Headroom: 97k tokens (~379 KB) remaining before automatic context compaction occurs.",
          "• Prompt Cache: 98.9% hit ratio (410k cached / 415k total)"
        ].join("\n")
      );

      const activeState = JSON.parse(fs.readFileSync(path.join(dataDir, "active_conversation.json"), "utf8"));
      assert.strictEqual(activeState.conversationId, "conv-live-enrich");

      const advState = JSON.parse(fs.readFileSync(path.join(dataDir, "advisories", "conv-live-enrich.json"), "utf8"));
      assert.strictEqual(advState.lastPercentCompacted, 81);
      assert.strictEqual(advState.lastTrajectoryKb, 1621.1);
      assert.strictEqual(advState.lastKbRemaining, 379);
      assert.strictEqual(advState.wasNearCompaction, true);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 2. PreInvocation: LS lowering below 80% suppresses advisory
  await testAsync("pre-invocation: LS lowering active usage below 80% threshold injects no advisory", async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-pre-lower-"));
    try {
      const convDir = path.join(testDir, "conversations");
      const dataDir = path.join(testDir, "data");
      fs.mkdirSync(convDir, { recursive: true });
      createConvDb(convDir, "conv-lowered", {
        trajText: "model gemini-4-hydrogen-high",
        genRows: [{ idx: 1, data: Buffer.alloc(1740800, 0x61) }],
        stepCount: 4
      });

      const tracker = new ConversationTracker({ conversationsDir: convDir });
      const quotaService = {
        async getCascadeUsage() {
          return {
            cacheReadTokens: 250000,
            inputTokens: 57200,
            cacheCreationTokens: 0,
            outputTokens: 500,
            totalPromptTokens: 307200,
            model: "gemini-4-hydrogen-high"
          };
        }
      };

      const freshRes = await runPreInvocation({
        payload: { conversationId: "conv-lowered" },
        tracker,
        quotaService,
        dataDir,
        nowMs: 1_700_000_000_000
      });
      assert.deepStrictEqual(freshRes, {});

      // Transition from previously near-compaction state clears wasNearCompaction
      const advPath = path.join(dataDir, "advisories", "conv-lowered.json");
      fs.mkdirSync(path.dirname(advPath), { recursive: true });
      fs.writeFileSync(
        advPath,
        JSON.stringify({ lastSentAt: 1000, lastPercentCompacted: 85, lastTrajectoryKb: 1700, lastKbRemaining: 300, wasNearCompaction: true }),
        "utf8"
      );
      const transitionRes = await runPreInvocation({
        payload: { conversationId: "conv-lowered" },
        tracker,
        quotaService,
        dataDir,
        nowMs: 1_700_000_200_000
      });
      assert.deepStrictEqual(transitionRes, {});
      const updatedAdv = JSON.parse(fs.readFileSync(advPath, "utf8"));
      assert.strictEqual(updatedAdv.wasNearCompaction, false);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 3. PreInvocation: Offline / null / zero-token resilience
  await testAsync("pre-invocation: offline, null, and zero-token getCascadeUsage falls back to SQLite", async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-pre-offline-"));
    try {
      const convDir = path.join(testDir, "conversations");
      fs.mkdirSync(convDir, { recursive: true });
      createConvDb(convDir, "conv-offline-near", {
        trajText: "model gemini-4-hydrogen-high",
        genRows: [{ idx: 1, data: Buffer.alloc(1740800, 0x61) }],
        stepCount: 2
      });
      createConvDb(convDir, "conv-offline-safe", {
        trajText: "model gemini-4-hydrogen-high",
        genRows: [{ idx: 1, data: Buffer.alloc(40000, 0x61) }],
        stepCount: 1
      });

      const tracker = new ConversationTracker({ conversationsDir: convDir });
      const modes = [
        async () => { throw new Error("ECONNREFUSED"); },
        async () => null,
        async () => ({ cacheReadTokens: 0, inputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, totalPromptTokens: 0, model: null })
      ];

      for (let i = 0; i < modes.length; i++) {
        const res = await runPreInvocation({
          payload: { conversationId: "conv-offline-near" },
          tracker,
          quotaService: { getCascadeUsage: modes[i] },
          dataDir: path.join(testDir, `data-${i}`),
          nowMs: 1_700_000_000_000
        });
        const msg = res?.injectSteps?.[0]?.systemMessage?.systemMessage;
        assert.strictEqual(msg.includes("Active Context: 435k / Trigger: 512k (85%"), true);
        assert.strictEqual(msg.includes("Compaction Headroom: 76.8k tokens"), true);
      }

      const safeRes = await runPreInvocation({
        payload: { conversationId: "conv-offline-safe" },
        tracker,
        quotaService: { getCascadeUsage: modes[0] },
        dataDir: path.join(testDir, "data-safe"),
        nowMs: 1_700_000_000_000
      });
      assert.deepStrictEqual(safeRes, {});
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 4. PreInvocation: Subagent isolation
  await testAsync("pre-invocation: subagent payload skips active_conversation.json while enriching own convId", async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-pre-sub-"));
    try {
      const convDir = path.join(testDir, "conversations");
      const dataDir = path.join(testDir, "data");
      fs.mkdirSync(convDir, { recursive: true });
      fs.mkdirSync(dataDir, { recursive: true });

      const activeFile = path.join(dataDir, "active_conversation.json");
      const rootSnapshot = JSON.stringify({ conversationId: "root-conv", updatedAt: "2026-01-01T00:00:00.000Z" }, null, 2);
      fs.writeFileSync(activeFile, rootSnapshot, "utf8");

      createConvDb(convDir, "subagent-conv", {
        genRows: [{ idx: 1, data: Buffer.alloc(160000, 0x61) }],
        stepCount: 5
      });

      const seenConvIds = [];
      const tracker = new ConversationTracker({ conversationsDir: convDir });
      const quotaService = {
        async getCascadeUsage(convId) {
          seenConvIds.push(convId);
          return {
            cacheReadTokens: 410435,
            inputTokens: 4565,
            cacheCreationTokens: 0,
            outputTokens: 100,
            totalPromptTokens: 415000,
            model: "gemini-4-hydrogen-high"
          };
        }
      };

      const res = await runPreInvocation({
        payload: { conversationId: "subagent-conv", rootConversationId: "root-conv", isSubagent: true },
        tracker,
        quotaService,
        dataDir,
        nowMs: 1_700_000_000_000
      });

      assert.deepStrictEqual(seenConvIds, ["subagent-conv"]);
      assert.strictEqual(fs.readFileSync(activeFile, "utf8"), rootSnapshot);
      const msg = res?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.strictEqual(msg.includes("Context Window: 415k / 1.05M (39.6%)"), true);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 5. PreInvocation: Cooldown, delta suppression, and critical >= 95% override
  await testAsync("pre-invocation: cooldown window, minimal-change guard, and >=95% critical override", async () => {
    // Unit assertions on shouldEmitCompactionAdvisory
    const baseMetrics = { compaction: { isNearCompaction: true, percentCompacted: 81, trajectoryKb: 1621.1, kbRemaining: 379 } };
    const first = shouldEmitCompactionAdvisory(baseMetrics, null, 10000);
    assert.strictEqual(first.emit, true);
    assert.deepStrictEqual(first.nextState, {
      lastSentAt: 10000,
      lastPercentCompacted: 81,
      lastTrajectoryKb: 1621.1,
      lastKbRemaining: 379,
      wasNearCompaction: true
    });

    // Within 2-minute cooldown: always suppressed
    const inCooldown = shouldEmitCompactionAdvisory(
      { compaction: { isNearCompaction: true, percentCompacted: 98, trajectoryKb: 1960, kbRemaining: 40 } },
      first.nextState,
      10000 + 119999
    );
    assert.deepStrictEqual(inCooldown, { emit: false, nextState: null });

    // After cooldown, small delta (< 5% and < 32 KB): suppressed
    const smallDelta = shouldEmitCompactionAdvisory(
      { compaction: { isNearCompaction: true, percentCompacted: 82, trajectoryKb: 1630, kbRemaining: 370 } },
      first.nextState,
      10000 + 120000
    );
    assert.deepStrictEqual(smallDelta, { emit: false, nextState: null });

    // After cooldown, crossing >= 95% from 93% with tiny KB delta triggers critical override
    const criticalCross = shouldEmitCompactionAdvisory(
      { compaction: { isNearCompaction: true, percentCompacted: 95, trajectoryKb: 190, kbRemaining: 10 } },
      { lastSentAt: 10000, lastPercentCompacted: 93, lastTrajectoryKb: 186, lastKbRemaining: 14, wasNearCompaction: true },
      10000 + 120000
    );
    assert.strictEqual(criticalCross.emit, true);
    assert.strictEqual(criticalCross.nextState.lastPercentCompacted, 95);

    // End-to-end persistence via runPreInvocation
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-pre-cool-"));
    try {
      const convDir = path.join(testDir, "conversations");
      const dataDir = path.join(testDir, "data");
      fs.mkdirSync(convDir, { recursive: true });
      createConvDb(convDir, "conv-cool", {
        trajText: "model gemini-4-hydrogen-high",
        genRows: [{ idx: 1, data: Buffer.alloc(1660000, 0x61) }],
        stepCount: 1
      });
      const tracker = new ConversationTracker({ conversationsDir: convDir });
      let currentPromptTokens = 476160; // 93% of 512k
      const quotaService = {
        async getCascadeUsage() {
          return {
            cacheReadTokens: currentPromptTokens,
            inputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: 0,
            totalPromptTokens: currentPromptTokens,
            model: "gemini-4-hydrogen-high"
          };
        }
      };

      const t0 = 1_700_000_000_000;
      const r1 = await runPreInvocation({ payload: { conversationId: "conv-cool" }, tracker, quotaService, dataDir, nowMs: t0 });
      assert.strictEqual(r1.injectSteps?.[0]?.systemMessage?.systemMessage.includes("(93%,"), true);

      currentPromptTokens = 491520; // 96% of 512k
      const r2 = await runPreInvocation({ payload: { conversationId: "conv-cool" }, tracker, quotaService, dataDir, nowMs: t0 + 60000 });
      assert.deepStrictEqual(r2, {});

      const r3 = await runPreInvocation({ payload: { conversationId: "conv-cool" }, tracker, quotaService, dataDir, nowMs: t0 + 120000 });
      assert.strictEqual(r3.injectSteps[0].systemMessage.systemMessage.includes("(96%,"), true);
      const saved = JSON.parse(fs.readFileSync(path.join(dataDir, "advisories", "conv-cool.json"), "utf8"));
      assert.strictEqual(saved.lastSentAt, t0 + 120000);
      assert.strictEqual(saved.lastPercentCompacted, 96);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 6. PreInvocation: Missing / unknown / corrupt DB negative paths
  await testAsync("pre-invocation: missing or corrupt conversation DB returns empty object without throwing", async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-pre-missing-"));
    try {
      const convDir = path.join(testDir, "conversations");
      const dataDir = path.join(testDir, "data");
      fs.mkdirSync(convDir, { recursive: true });
      const tracker = new ConversationTracker({ conversationsDir: convDir });

      const missingRes = await runPreInvocation({
        payload: { conversationId: "does-not-exist" },
        tracker,
        quotaService: { async getCascadeUsage() { throw new Error("should not be called"); } },
        dataDir
      });
      assert.deepStrictEqual(missingRes, {});

      const corruptPayload = "GARBAGE NOT SQLITE DATA 12345";
      const corruptDbPath = path.join(convDir, "corrupt-pre.db");
      fs.writeFileSync(corruptDbPath, corruptPayload, "utf8");
      const corruptMetrics = tracker.getConversationMetrics("corrupt-pre", { strict: true });
      assert.strictEqual(corruptMetrics.contextWindow.currentTokens, 0);
      assert.strictEqual(corruptMetrics.stepCount, 0);
      assert.strictEqual(corruptMetrics.model.isFallback, true);
      assert.strictEqual(corruptMetrics.compaction.cumulativeHistoryBytes, Buffer.byteLength(corruptPayload));

      const corruptRes = await runPreInvocation({
        payload: { conversationId: "corrupt-pre" },
        tracker,
        quotaService: { async getCascadeUsage() { return null; } },
        dataDir
      });
      assert.deepStrictEqual(corruptRes, {});
      assert.strictEqual(fs.existsSync(path.join(dataDir, "advisories", "corrupt-pre.json")), false);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 7. SessionStart: Parallel getQuotaSummary + getCascadeUsage enrichment
  await testAsync("session-start: runs quota and cascade usage in parallel and enriches fallback model", async () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-sess-live-"));
    try {
      const convDir = path.join(testDir, "conversations");
      const dataDir = path.join(testDir, "data");
      fs.mkdirSync(convDir, { recursive: true });
      createConvDb(convDir, "conv-sess", {
        genRows: [{ idx: 1, data: Buffer.alloc(2000000, 0x61) }],
        stepCount: 2
      });

      let resolveQuota;
      let resolveUsage;
      const callEvents = [];
      const quotaService = {
        getQuotaSummary(forceRefresh) {
          callEvents.push(`quota:${forceRefresh}`);
          return new Promise((resolve) => { resolveQuota = resolve; });
        },
        getCascadeUsage(convId, stepCount, forceRefresh) {
          callEvents.push(`usage:${convId}:${stepCount}:${forceRefresh}`);
          return new Promise((resolve) => { resolveUsage = resolve; });
        }
      };

      const tracker = new ConversationTracker({ conversationsDir: convDir });
      const pending = runSessionStart({
        payload: { conversationId: "conv-sess" },
        tracker,
        quotaService,
        dataDir
      });

      // Both RPC calls must be initiated synchronously before either resolves
      assert.deepStrictEqual(callEvents, ["quota:false", "usage:conv-sess:2:false"]);

      resolveQuota({
        gemini: {
          fiveHour: { remainingPercent: 79, countdown: "4h 5m" },
          weekly: { remainingPercent: 71.5, countdown: "6d 13h" }
        }
      });
      resolveUsage({
        cacheReadTokens: 410435,
        inputTokens: 4565,
        cacheCreationTokens: 0,
        outputTokens: 200,
        totalPromptTokens: 415000,
        model: "gemini-4-hydrogen-high"
      });

      const res = await pending;
      const msg = res?.injectSteps?.[0]?.systemMessage?.systemMessage;
      assert.strictEqual(
        msg,
        [
          "[token-tracker active]",
          "• Model: Gemini 4 Hydrogen (High) (1.05M max context)",
          "• Context Usage: 415k tokens (39.6%)",
          "• Cache Efficiency: 98.9% hit ratio (410k cached / 4.6k uncached)",
          "• ⚠️ Compaction Alert: Active Context 415k / Trigger 512k (81%, 97k tokens / ~379 KB remaining)",
          "• Gemini Quotas: 5h limit 79% (resets 4h 5m), Weekly 71.5% (resets 6d 13h)"
        ].join("\n")
      );

      const active = JSON.parse(fs.readFileSync(path.join(dataDir, "active_conversation.json"), "utf8"));
      assert.strictEqual(active.conversationId, "conv-sess");
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 8-10. SessionStart offline/subagent, compaction/models, and >10-stub SQLite fallback
  await registerHooksLiveFallbackTests(test, testAsync);

  return { passed, failed };
}

const isMain = Boolean(
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
);

if (isMain) {
  runHooksLiveUsageTests()
    .then(({ failed }) => {
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error("[FATAL] Hooks live usage test runner failed:", err);
      process.exit(1);
    });
}
