/**
 * Antigravity Token Tracker — Adversarial Conversation Tracker Test Suite.
 * Validates SQLite database discovery, trajectory extraction, compaction headroom calculations,
 * prompt prefix caching math, and boundary conditions.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  ConversationTracker,
  resolveSessionId,
  DEFAULT_COMPACTION_THRESHOLD_BYTES
} from "../lib/conversation-tracker.js";

/**
 * Runs the conversation tracker test suite.
 * @returns {Promise<{ passed: number, failed: number }>}
 */
export async function runConversationTrackerTests() {
  console.log("--- Running test_conversation_tracker.js ---");
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

  // 1. Session ID Resolution Contract
  test("conversation-tracker: resolveSessionId extracts session identifier across payload schemas", () => {
    assert.strictEqual(resolveSessionId({ conversationId: "id-camel" }), "id-camel");
    assert.strictEqual(resolveSessionId({ conversation_id: "id-snake" }), "id-snake");
    assert.strictEqual(resolveSessionId({ rootConversationId: "id-root-camel" }), "id-root-camel");
    assert.strictEqual(resolveSessionId({ root_conversation_id: "id-root-snake" }), "id-root-snake");
    assert.strictEqual(resolveSessionId({ parentConversationId: "id-parent-camel" }), "id-parent-camel");
    assert.strictEqual(resolveSessionId({ parent_conversation_id: "id-parent-snake" }), "id-parent-snake");
    assert.strictEqual(resolveSessionId({ sessionId: "id-sess-camel" }), "id-sess-camel");
    assert.strictEqual(resolveSessionId({ session_id: "id-sess-snake" }), "id-sess-snake");

    const savedEnvConv = process.env.ANTIGRAVITY_CONVERSATION_ID;
    const savedEnvRoot = process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID;
    try {
      delete process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID;
      process.env.ANTIGRAVITY_CONVERSATION_ID = "id-env-active";
      assert.strictEqual(resolveSessionId({}), "id-env-active");

      delete process.env.ANTIGRAVITY_CONVERSATION_ID;
      process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID = "id-env-root";
      assert.strictEqual(resolveSessionId({}), "id-env-root");

      delete process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID;
      assert.strictEqual(resolveSessionId({}), null);
    } finally {
      if (savedEnvConv !== undefined) process.env.ANTIGRAVITY_CONVERSATION_ID = savedEnvConv;
      else delete process.env.ANTIGRAVITY_CONVERSATION_ID;

      if (savedEnvRoot !== undefined) process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID = savedEnvRoot;
      else delete process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID;
    }
  });

  // 2. Model Identifier Extraction from Binary and Text Payloads
  test("conversation-tracker: extractModelIdentifier detects models in strings and binary buffers", () => {
    const tracker = new ConversationTracker();

    // Standard strings
    assert.strictEqual(tracker.extractModelIdentifier("selected model gemini-3.8-flash-high for task"), "gemini-3.8-flash-high");
    assert.strictEqual(tracker.extractModelIdentifier("Gemini 3.8 Flash (High) active"), "Gemini 3.8 Flash (High)");
    assert.strictEqual(tracker.extractModelIdentifier("Gemini 3.5 Pro active"), "Gemini 3.5 Pro");
    assert.strictEqual(tracker.extractModelIdentifier("prefix claude-3-5-sonnet suffix"), "claude-3-5-sonnet");
    assert.strictEqual(tracker.extractModelIdentifier("Claude Sonnet 4.6 active"), "Claude Sonnet 4.6");
    assert.strictEqual(tracker.extractModelIdentifier("Claude 3.5 Sonnet active"), "Claude 3.5 Sonnet");
    assert.strictEqual(tracker.extractModelIdentifier("gpt-4o-2024-08-06"), "gpt-4o-2024-08-06");

    // Binary buffer wrapping model name with arbitrary non-ASCII bytes
    const binBuf = Buffer.concat([
      Buffer.from([0x00, 0x01, 0xff, 0xfe]),
      Buffer.from("header data gemini-3.5-pro-preview trailer"),
      Buffer.from([0xaa, 0xbb, 0x00])
    ]);
    assert.strictEqual(tracker.extractModelIdentifier(binBuf), "gemini-3.5-pro-preview");

    // Unrecognized payloads return null
    assert.strictEqual(tracker.extractModelIdentifier("no models mentioned here"), null);
    assert.strictEqual(tracker.extractModelIdentifier(Buffer.from([0x01, 0x02, 0x03])), null);
  });

  // 3. SQLite Path Resolution & Edge Cases
  test("conversation-tracker: resolveConversationDbPath error conditions and priority rules", () => {
    const testDir = path.join(os.tmpdir(), `token-tracker-conv-test-${Date.now()}`);
    const convDir = path.join(testDir, "conversations");
    const presenceDir = path.join(testDir, "presence");
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(presenceDir, { recursive: true });

    try {
      const tracker = new ConversationTracker({ conversationsDir: convDir });

      // 1. Empty conversations directory throws descriptive error
      assert.throws(
        () => tracker.resolveConversationDbPath(),
        (err) => err.message.includes("No SQLite conversation databases found")
      );

      // 2. Non-existent directory throws
      const missingTracker = new ConversationTracker({ conversationsDir: path.join(testDir, "does-not-exist") });
      assert.throws(
        () => missingTracker.resolveConversationDbPath(),
        (err) => err.message.includes("Conversations directory not found")
      );

      // 3. Create two conversation files with explicit mtimes
      const oldDb = path.join(convDir, "conv-old.db");
      const newDb = path.join(convDir, "conv-new.db");
      // Also create -shm and -wal files to verify they are ignored
      const shmFile = path.join(convDir, "conv-new.db-shm");
      const walFile = path.join(convDir, "conv-new.db-wal");

      fs.writeFileSync(oldDb, "");
      fs.writeFileSync(newDb, "");
      fs.writeFileSync(shmFile, "");
      fs.writeFileSync(walFile, "");

      fs.utimesSync(oldDb, 1000, 1000);
      fs.utimesSync(newDb, 2000, 2000);

      // Should pick conv-new.db as newest
      assert.strictEqual(tracker.resolveConversationDbPath(), newDb);

      // 4. Preferred ID lookup
      assert.strictEqual(tracker.resolveConversationDbPath("conv-old"), oldDb);
      assert.strictEqual(tracker.resolveConversationDbPath("conv-old.db"), oldDb);

      // 5. Presence lock overrides mtime scan
      const lockPath = path.join(presenceDir, "conv-old.lock");
      fs.writeFileSync(lockPath, "");
      fs.utimesSync(lockPath, 3000, 3000);

      assert.strictEqual(tracker.resolveConversationDbPath(), oldDb);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 4. Database Metrics with Corrupt and Empty SQLite Files
  test("conversation-tracker: handles corrupt and empty SQLite files deterministically", () => {
    const testDir = path.join(os.tmpdir(), `token-tracker-sqlite-edge-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    try {
      // 1. Corrupt DB throws SQLite error when queried directly
      const corruptDbPath = path.join(testDir, "corrupt.db");
      fs.writeFileSync(corruptDbPath, "GARBAGE NOT SQLITE DATA 12345");
      assert.throws(
        () => {
          const corruptDb = new DatabaseSync(corruptDbPath, { readOnly: true });
          try {
            corruptDb.prepare("SELECT 1 FROM sqlite_master").get();
          } finally {
            corruptDb.close();
          }
        },
        (err) => err.code === "ERR_SQLITE_ERROR" && err.message.includes("file is not a database")
      );

      // 2. ConversationTracker handles corrupt file safely with fallback defaults
      const corruptTracker = new ConversationTracker({ conversationsDir: testDir });
      const corruptMetrics = corruptTracker.getConversationMetrics("corrupt");
      assert.strictEqual(corruptMetrics.conversationId, "corrupt");
      assert.strictEqual(corruptMetrics.model.id, "gemini-3.8-flash-high");
      assert.strictEqual(corruptMetrics.stepCount, 0);
      assert.strictEqual(corruptMetrics.contextWindow.currentTokens, 0);
      assert.strictEqual(corruptMetrics.cache.hitRatio, 0);
      assert.strictEqual(corruptMetrics.compaction.trajectoryBytes, fs.statSync(corruptDbPath).size);

      // 2. Empty SQLite DB (valid sqlite, but no schema/tables)
      const emptyDbPath = path.join(testDir, "empty.db");
      const emptyDb = new DatabaseSync(emptyDbPath);
      emptyDb.close();

      const tracker = new ConversationTracker({ conversationsDir: testDir });
      const metrics = tracker.getConversationMetrics("empty");

      assert.strictEqual(metrics.conversationId, "empty");
      assert.strictEqual(metrics.model.id, "gemini-3.8-flash-high");
      assert.strictEqual(metrics.contextWindow.currentTokens, 0);
      assert.strictEqual(metrics.contextWindow.percentUsed, 0);
      assert.strictEqual(metrics.cache.hitRatio, 0);
      assert.strictEqual(metrics.cache.hitRatioPercent, 0);
      assert.strictEqual(metrics.stepCount, 0);
      assert.strictEqual(metrics.compaction.trajectoryBytes, fs.statSync(emptyDbPath).size);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 5. Populated SQLite DB with Trajectory, Metadata, and Steps
  test("conversation-tracker: parses populated SQLite database with exact metric values", () => {
    const testDir = path.join(os.tmpdir(), `token-tracker-populated-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    try {
      const dbPath = path.join(testDir, "session-populated.db");
      const db = new DatabaseSync(dbPath);

      // Create schema
      db.exec(`
        CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
        CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
        CREATE TABLE steps (step_id TEXT PRIMARY KEY, metadata TEXT, step_payload TEXT, render_info TEXT, task_details TEXT);
      `);

      // 1. Model blob in trajectory_metadata_blob
      const modelBlob = Buffer.from("runtime config claude-3-5-sonnet end config");
      db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(modelBlob);

      // 2. Generation metadata (current: 4000 bytes = 1000 tokens, previous: 2000 bytes = 500 tokens)
      const currentGen = Buffer.alloc(4000, 0x61);
      const prevGen = Buffer.alloc(2000, 0x62);
      db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (1, ?)").run(prevGen);
      db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (2, ?)").run(currentGen);

      // 3. Steps table (5 rows, total bytes = 10240 bytes = 10 KB)
      const stepInsert = db.prepare("INSERT INTO steps (step_id, metadata, step_payload, render_info, task_details) VALUES (?, ?, ?, ?, ?)");
      for (let i = 0; i < 5; i++) {
        stepInsert.run(`step-${i}`, "a".repeat(512), "b".repeat(512), "c".repeat(512), "d".repeat(512));
      }
      db.close();

      const tracker = new ConversationTracker({
        conversationsDir: testDir,
        compactionThresholdBytes: DEFAULT_COMPACTION_THRESHOLD_BYTES
      });
      const metrics = tracker.getConversationMetrics("session-populated");

      // Verify Model Resolution
      assert.strictEqual(metrics.conversationId, "session-populated");
      assert.strictEqual(metrics.model.id, "claude-3-5-sonnet");
      assert.strictEqual(metrics.model.displayName, "Claude 3.5 Sonnet");
      assert.strictEqual(metrics.model.maxTokens, 200000);
      assert.strictEqual(metrics.model.group, "thirdParty");

      // Verify Context Window (4000 bytes / 4 bytes per token = 1000 tokens)
      assert.strictEqual(metrics.contextWindow.currentTokens, 1000);
      assert.strictEqual(metrics.contextWindow.maxTokens, 200000);
      assert.strictEqual(metrics.contextWindow.percentUsed, 0.5);
      assert.strictEqual(metrics.contextWindow.currentTokensFormatted, "1k");

      // Verify Prompt Prefix Cache (cached: 500, uncached: 500, ratio: 0.5 = 50.0%)
      assert.strictEqual(metrics.cache.cachedTokens, 500);
      assert.strictEqual(metrics.cache.uncachedTokens, 500);
      assert.strictEqual(metrics.cache.totalTokens, 1000);
      assert.strictEqual(metrics.cache.hitRatio, 0.5);
      assert.strictEqual(metrics.cache.hitRatioPercent, 50.0);
      assert.strictEqual(metrics.cache.cachedTokensFormatted, "500");
      assert.strictEqual(metrics.cache.uncachedTokensFormatted, "500");

      // Verify Steps and Compaction (5 * 2048 = 10240 bytes = 10.0 KB)
      assert.strictEqual(metrics.stepCount, 5);
      assert.strictEqual(metrics.compaction.trajectoryBytes, 10240);
      assert.strictEqual(metrics.compaction.trajectoryKb, 10.0);
      assert.strictEqual(metrics.compaction.thresholdBytes, 184320);
      assert.strictEqual(metrics.compaction.thresholdKb, 180);
      assert.strictEqual(metrics.compaction.kbRemaining, 170);
      assert.strictEqual(metrics.compaction.percentCompacted, 6);
      assert.strictEqual(metrics.compaction.isNearCompaction, false);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 6. Compaction Headroom Edge Cases (0KB, Threshold, Overflow)
  test("conversation-tracker: compaction headroom clamping and proximity thresholds", () => {
    const testDir = path.join(os.tmpdir(), `token-tracker-compaction-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    try {
      function createTestDb(name, totalBytes) {
        const dbPath = path.join(testDir, `${name}.db`);
        const db = new DatabaseSync(dbPath);
        db.exec("CREATE TABLE steps (step_id TEXT PRIMARY KEY, metadata TEXT, step_payload TEXT, render_info TEXT, task_details TEXT);");
        if (totalBytes > 0) {
          db.prepare("INSERT INTO steps VALUES ('1', ?, '', '', '')").run("x".repeat(totalBytes));
        }
        db.close();
        return name;
      }

      const tracker = new ConversationTracker({
        conversationsDir: testDir,
        compactionThresholdBytes: 184320 // 180 KB
      });

      // Case 1: 0 trajectory bytes
      createTestDb("zero-bytes", 0);
      const mZero = tracker.getConversationMetrics("zero-bytes");
      assert.strictEqual(mZero.compaction.trajectoryBytes, 0);
      assert.strictEqual(mZero.compaction.trajectoryKb, 0);
      assert.strictEqual(mZero.compaction.kbRemaining, 180);
      assert.strictEqual(mZero.compaction.percentCompacted, 0);
      assert.strictEqual(mZero.compaction.isNearCompaction, false);

      // Case 2: Exact threshold (184320 bytes = 180 KB)
      createTestDb("exact-threshold", 184320);
      const mExact = tracker.getConversationMetrics("exact-threshold");
      assert.strictEqual(mExact.compaction.trajectoryBytes, 184320);
      assert.strictEqual(mExact.compaction.kbRemaining, 0);
      assert.strictEqual(mExact.compaction.percentCompacted, 100);
      assert.strictEqual(mExact.compaction.isNearCompaction, true);

      // Case 3: Overflow / Massive payload (never negative remaining, never > 100%)
      createTestDb("overflow-bytes", 300000);
      const mOverflow = tracker.getConversationMetrics("overflow-bytes");
      assert.strictEqual(mOverflow.compaction.trajectoryBytes, 300000);
      assert.strictEqual(mOverflow.compaction.kbRemaining, 0);
      assert.strictEqual(mOverflow.compaction.percentCompacted, 100);
      assert.strictEqual(mOverflow.compaction.isNearCompaction, true);

      // Case 4: Near compaction proximity boundary (<= 35 KB remaining triggers near compaction)
      createTestDb("near-compaction", 184320 - 35 * 1024);
      const mNear = tracker.getConversationMetrics("near-compaction");
      assert.strictEqual(mNear.compaction.kbRemaining, 35);
      assert.strictEqual(mNear.compaction.isNearCompaction, true);

      // Case 5: 36 KB remaining and < 80% is not near compaction
      createTestDb("not-quite-near", 184320 - 40 * 1024);
      const mNotNear = tracker.getConversationMetrics("not-quite-near");
      assert.strictEqual(mNotNear.compaction.kbRemaining, 40);
      assert.strictEqual(mNotNear.compaction.isNearCompaction, false);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 7. Cache Hit Ratio Edge Cases (0%, 100%, 0 tokens, truncated)
  test("conversation-tracker: prompt prefix cache ratio edge cases and zero guards", () => {
    const testDir = path.join(os.tmpdir(), `token-tracker-cache-${Date.now()}`);
    fs.mkdirSync(testDir, { recursive: true });

    try {
      function createCacheDb(name, currentBytes, prevBytes) {
        const dbPath = path.join(testDir, `${name}.db`);
        const db = new DatabaseSync(dbPath);
        db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);");
        if (prevBytes > 0) {
          db.prepare("INSERT INTO gen_metadata VALUES (1, ?)").run(Buffer.alloc(prevBytes, 0x61));
        }
        if (currentBytes > 0) {
          db.prepare("INSERT INTO gen_metadata VALUES (2, ?)").run(Buffer.alloc(currentBytes, 0x62));
        }
        db.close();
        return name;
      }

      const tracker = new ConversationTracker({ conversationsDir: testDir });

      // Case 1: 0 total tokens (no division by zero)
      createCacheDb("zero-tokens", 0, 0);
      const mZero = tracker.getConversationMetrics("zero-tokens");
      assert.strictEqual(mZero.cache.totalTokens, 0);
      assert.strictEqual(mZero.cache.hitRatio, 0);
      assert.strictEqual(mZero.cache.hitRatioPercent, 0);

      // Case 2: 100% cached (prev = current = 4000 bytes = 1000 tokens)
      createCacheDb("full-cached", 4000, 4000);
      const mFull = tracker.getConversationMetrics("full-cached");
      assert.strictEqual(mFull.cache.cachedTokens, 1000);
      assert.strictEqual(mFull.cache.uncachedTokens, 0);
      assert.strictEqual(mFull.cache.hitRatio, 1);
      assert.strictEqual(mFull.cache.hitRatioPercent, 100);

      // Case 3: 0% cached (prev = 0, current = 4000 bytes = 1000 tokens)
      createCacheDb("zero-cached", 4000, 0);
      const mNone = tracker.getConversationMetrics("zero-cached");
      assert.strictEqual(mNone.cache.cachedTokens, 0);
      assert.strictEqual(mNone.cache.uncachedTokens, 1000);
      assert.strictEqual(mNone.cache.hitRatio, 0);
      assert.strictEqual(mNone.cache.hitRatioPercent, 0);

      // Case 4: Context truncated (prev 8000 bytes > current 4000 bytes)
      createCacheDb("truncated-context", 4000, 8000);
      const mTrunc = tracker.getConversationMetrics("truncated-context");
      assert.strictEqual(mTrunc.cache.cachedTokens, 1000);
      assert.strictEqual(mTrunc.cache.uncachedTokens, 0);
      assert.strictEqual(mTrunc.cache.hitRatio, 1);
      assert.strictEqual(mTrunc.cache.hitRatioPercent, 100);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  return { passed, failed };
}

const isMain = Boolean(
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
);

if (isMain) {
  runConversationTrackerTests().then(({ failed }) => {
    process.exit(failed > 0 ? 1 : 0);
  });
}
