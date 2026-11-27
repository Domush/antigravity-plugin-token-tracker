/**
 * Antigravity Token Tracker — Conversation Tracker SQLite & Metrics Sub-Suite.
 * Validates SQLite database discovery, handle-safe fixtures, trajectory metrics,
 * compaction headroom, and prompt prefix caching math.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  ConversationTracker,
  DEFAULT_COMPACTION_THRESHOLD_BYTES
} from "../lib/conversation-tracker.js";

/**
 * Registers SQLite & metrics test cases onto the parent runner.
 * @param {(name: string, fn: () => void) => void} test
 */
export function registerConversationTrackerSqliteTests(test) {
  // 1. SQLite Path Resolution, Lock Fallback & Error Conditions
  test("conversation-tracker: resolveConversationDbPath priority, fallbacks, and errors", () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-conv-test-"));

    try {
      const convDir = path.join(testDir, "conversations");
      const presenceDir = path.join(testDir, "presence");
      fs.mkdirSync(convDir, { recursive: true });
      fs.mkdirSync(presenceDir, { recursive: true });
      const tracker = new ConversationTracker({ conversationsDir: convDir });

      assert.throws(
        () => tracker.resolveConversationDbPath(),
        (err) => err instanceof Error && err.message.includes("No SQLite conversation databases found")
      );

      const missingTracker = new ConversationTracker({ conversationsDir: path.join(testDir, "does-not-exist") });
      assert.throws(
        () => missingTracker.resolveConversationDbPath(),
        (err) => err instanceof Error && err.message.includes("Conversations directory not found")
      );

      const oldDb = path.join(convDir, "conv-old.db");
      const newDb = path.join(convDir, "conv-new.db");
      fs.writeFileSync(oldDb, "");
      fs.writeFileSync(newDb, "");
      fs.writeFileSync(path.join(convDir, "conv-new.db-shm"), "");
      fs.writeFileSync(path.join(convDir, "conv-new.db-wal"), "");
      fs.utimesSync(oldDb, 1000, 1000);
      fs.utimesSync(newDb, 2000, 2000);

      assert.strictEqual(tracker.resolveConversationDbPath(), newDb);
      assert.strictEqual(tracker.resolveConversationDbPath("conv-old"), oldDb);
      assert.strictEqual(tracker.resolveConversationDbPath("conv-old.db"), oldDb);

      // Non-existent preferredId falls back cleanly to mtime scan
      assert.strictEqual(tracker.resolveConversationDbPath("missing-preferred-id"), newDb);

      // Stale .lock without a matching .db falls back cleanly to mtime scan
      const staleLockPath = path.join(presenceDir, "ghost-session.lock");
      fs.writeFileSync(staleLockPath, "");
      fs.utimesSync(staleLockPath, 4000, 4000);
      assert.strictEqual(tracker.resolveConversationDbPath(), newDb);

      // Valid presence lock overrides mtime scan
      const lockPath = path.join(presenceDir, "conv-old.lock");
      fs.writeFileSync(lockPath, "");
      fs.utimesSync(lockPath, 3000, 3000);
      assert.strictEqual(tracker.resolveConversationDbPath(), oldDb);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 2. Database Metrics with Corrupt, Empty, and Partial-Schema SQLite Files
  test("conversation-tracker: handles corrupt, empty, and partial-schema SQLite files deterministically", () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-sqlite-edge-"));

    try {
      // Corrupt DB throws SQLite error when queried directly
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

      const tracker = new ConversationTracker({ conversationsDir: testDir });
      const corruptMetrics = tracker.getConversationMetrics("corrupt");
      assert.strictEqual(corruptMetrics.conversationId, "corrupt");
      assert.strictEqual(corruptMetrics.model.id, "gemini-3.8-flash-high");
      assert.strictEqual(corruptMetrics.stepCount, 0);
      assert.strictEqual(corruptMetrics.contextWindow.currentTokens, 0);
      assert.strictEqual(corruptMetrics.cache.hitRatio, 0);
      assert.strictEqual(corruptMetrics.compaction.trajectoryBytes, fs.statSync(corruptDbPath).size);

      // Empty SQLite DB (no tables)
      const emptyDbPath = path.join(testDir, "empty.db");
      const emptyDb = new DatabaseSync(emptyDbPath);
      try {
        emptyDb.prepare("SELECT 1").get();
      } finally {
        emptyDb.close();
      }

      const emptyMetrics = tracker.getConversationMetrics("empty");
      assert.strictEqual(emptyMetrics.conversationId, "empty");
      assert.strictEqual(emptyMetrics.model.id, "gemini-3.8-flash-high");
      assert.strictEqual(emptyMetrics.contextWindow.currentTokens, 0);
      assert.strictEqual(emptyMetrics.contextWindow.percentUsed, 0);
      assert.strictEqual(emptyMetrics.cache.hitRatio, 0);
      assert.strictEqual(emptyMetrics.stepCount, 0);
      assert.strictEqual(emptyMetrics.compaction.trajectoryBytes, fs.statSync(emptyDbPath).size);

      // Partial schema: gen_metadata only (no trajectory_metadata_blob, no steps table)
      const partialDbPath = path.join(testDir, "partial-gen.db");
      const partialDb = new DatabaseSync(partialDbPath);
      try {
        partialDb.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);");
        const genPayload = Buffer.from("header claude-opus-5-5-1m " + "z".repeat(3975));
        partialDb.prepare("INSERT INTO gen_metadata (idx, data) VALUES (1, ?)").run(genPayload);
      } finally {
        partialDb.close();
      }

      const partialMetrics = tracker.getConversationMetrics("partial-gen");
      const partialSize = fs.statSync(partialDbPath).size;
      assert.strictEqual(partialSize > 0, true);
      assert.strictEqual(partialMetrics.model.id, "claude-opus-5-5-1m");
      assert.strictEqual(partialMetrics.model.displayName, "Claude Opus 5.5 (1M)");
      assert.strictEqual(partialMetrics.model.maxTokens, 1000000);
      assert.strictEqual(partialMetrics.model.group, "thirdParty");
      assert.strictEqual(partialMetrics.stepCount, 0);
      assert.strictEqual(partialMetrics.compaction.trajectoryBytes, partialSize);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 3. Populated SQLite DB with Trajectory, Metadata, and Steps
  test("conversation-tracker: parses populated SQLite database with exact metric values", () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-populated-"));

    try {
      const dbPath = path.join(testDir, "session-populated.db");
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(`
          CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
          CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
          CREATE TABLE steps (step_id TEXT PRIMARY KEY, metadata TEXT, step_payload TEXT, render_info TEXT, task_details TEXT);
        `);
        const modelBlob = Buffer.from("runtime config claude-3-5-sonnet end config");
        db.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(modelBlob);
        db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (1, ?)").run(Buffer.alloc(2000, 0x62));
        db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (2, ?)").run(Buffer.alloc(4000, 0x61));

        const stepInsert = db.prepare("INSERT INTO steps (step_id, metadata, step_payload, render_info, task_details) VALUES (?, ?, ?, ?, ?)");
        for (let i = 0; i < 5; i++) {
          stepInsert.run(`step-${i}`, "a".repeat(512), "b".repeat(512), "c".repeat(512), "d".repeat(512));
        }
      } finally {
        db.close();
      }

      const tracker = new ConversationTracker({
        conversationsDir: testDir,
        compactionThresholdBytes: DEFAULT_COMPACTION_THRESHOLD_BYTES
      });
      const metrics = tracker.getConversationMetrics("session-populated");

      assert.strictEqual(metrics.conversationId, "session-populated");
      assert.strictEqual(metrics.model.id, "claude-3-5-sonnet");
      assert.strictEqual(metrics.model.displayName, "Claude 3.5 Sonnet");
      assert.strictEqual(metrics.model.maxTokens, 200000);
      assert.strictEqual(metrics.model.group, "thirdParty");
      assert.strictEqual(metrics.contextWindow.currentTokens, 1000);
      assert.strictEqual(metrics.contextWindow.maxTokens, 200000);
      assert.strictEqual(metrics.contextWindow.percentUsed, 0.5);
      assert.strictEqual(metrics.contextWindow.currentTokensFormatted, "1k");
      assert.strictEqual(metrics.cache.cachedTokens, 500);
      assert.strictEqual(metrics.cache.uncachedTokens, 500);
      assert.strictEqual(metrics.cache.totalTokens, 1000);
      assert.strictEqual(metrics.cache.hitRatio, 0.5);
      assert.strictEqual(metrics.cache.hitRatioPercent, 50.0);
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

  // 4. Compaction Headroom Edge Cases (0KB, Threshold, Overflow)
  test("conversation-tracker: compaction headroom clamping and proximity thresholds", () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-compaction-"));

    try {
      function createTestDb(name, totalBytes) {
        const dbPath = path.join(testDir, `${name}.db`);
        const db = new DatabaseSync(dbPath);
        try {
          db.exec("CREATE TABLE steps (step_id TEXT PRIMARY KEY, metadata TEXT, step_payload TEXT, render_info TEXT, task_details TEXT);");
          if (totalBytes > 0) {
            db.prepare("INSERT INTO steps VALUES ('1', ?, '', '', '')").run("x".repeat(totalBytes));
          }
        } finally {
          db.close();
        }
        return name;
      }

      const tracker = new ConversationTracker({
        conversationsDir: testDir,
        compactionThresholdBytes: 184320
      });

      createTestDb("zero-bytes", 0);
      const mZero = tracker.getConversationMetrics("zero-bytes");
      assert.strictEqual(mZero.compaction.trajectoryBytes, 0);
      assert.strictEqual(mZero.compaction.kbRemaining, 180);
      assert.strictEqual(mZero.compaction.percentCompacted, 0);
      assert.strictEqual(mZero.compaction.isNearCompaction, false);

      createTestDb("exact-threshold", 184320);
      const mExact = tracker.getConversationMetrics("exact-threshold");
      assert.strictEqual(mExact.compaction.trajectoryBytes, 184320);
      assert.strictEqual(mExact.compaction.kbRemaining, 0);
      assert.strictEqual(mExact.compaction.percentCompacted, 100);
      assert.strictEqual(mExact.compaction.isNearCompaction, true);

      createTestDb("overflow-bytes", 300000);
      const mOverflow = tracker.getConversationMetrics("overflow-bytes");
      assert.strictEqual(mOverflow.compaction.trajectoryBytes, 300000);
      assert.strictEqual(mOverflow.compaction.kbRemaining, 0);
      assert.strictEqual(mOverflow.compaction.percentCompacted, 100);
      assert.strictEqual(mOverflow.compaction.isNearCompaction, true);

      createTestDb("near-compaction", 184320 - 35 * 1024);
      const mNear = tracker.getConversationMetrics("near-compaction");
      assert.strictEqual(mNear.compaction.kbRemaining, 35);
      assert.strictEqual(mNear.compaction.isNearCompaction, true);

      createTestDb("not-quite-near", 184320 - 40 * 1024);
      const mNotNear = tracker.getConversationMetrics("not-quite-near");
      assert.strictEqual(mNotNear.compaction.kbRemaining, 40);
      assert.strictEqual(mNotNear.compaction.isNearCompaction, false);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 5. Cache Hit Ratio Edge Cases (0%, 100%, 0 tokens, truncated)
  test("conversation-tracker: prompt prefix cache ratio edge cases and zero guards", () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-tracker-cache-"));

    try {
      function createCacheDb(name, currentBytes, prevBytes) {
        const dbPath = path.join(testDir, `${name}.db`);
        const db = new DatabaseSync(dbPath);
        try {
          db.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);");
          if (prevBytes > 0) {
            db.prepare("INSERT INTO gen_metadata VALUES (1, ?)").run(Buffer.alloc(prevBytes, 0x61));
          }
          if (currentBytes > 0) {
            db.prepare("INSERT INTO gen_metadata VALUES (2, ?)").run(Buffer.alloc(currentBytes, 0x62));
          }
        } finally {
          db.close();
        }
        return name;
      }

      const tracker = new ConversationTracker({ conversationsDir: testDir });

      createCacheDb("zero-tokens", 0, 0);
      const mZero = tracker.getConversationMetrics("zero-tokens");
      assert.strictEqual(mZero.cache.totalTokens, 0);
      assert.strictEqual(mZero.cache.hitRatio, 0);
      assert.strictEqual(mZero.cache.hitRatioPercent, 0);

      createCacheDb("full-cached", 4000, 4000);
      const mFull = tracker.getConversationMetrics("full-cached");
      assert.strictEqual(mFull.cache.cachedTokens, 1000);
      assert.strictEqual(mFull.cache.uncachedTokens, 0);
      assert.strictEqual(mFull.cache.hitRatio, 1);
      assert.strictEqual(mFull.cache.hitRatioPercent, 100);

      createCacheDb("zero-cached", 4000, 0);
      const mNone = tracker.getConversationMetrics("zero-cached");
      assert.strictEqual(mNone.cache.cachedTokens, 0);
      assert.strictEqual(mNone.cache.uncachedTokens, 1000);
      assert.strictEqual(mNone.cache.hitRatio, 0);
      assert.strictEqual(mNone.cache.hitRatioPercent, 0);

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
}
