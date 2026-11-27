/**
 * Antigravity Token Tracker — Adversarial Active Agent Tree Test Suite.
 * Validates alphabetical subagent ordering with deterministic tie-breaking,
 * 2-minute idle subagent grace retention & boundary pruning, maxScan prioritization,
 * and fail-fast negative-path validation for findActiveAgentTree, compareSubagentNodes,
 * and isWithinIdleGrace.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { findActiveAgentTree } from "../lib/agent-tree.js";
import { compareSubagentNodes, isWithinIdleGrace } from "../lib/active-status.js";

/**
 * Creates a minimal SQLite conversation database with an explicit mtime.
 * @param {string} convDir
 * @param {string} convId
 * @param {number} mtimeMs
 */
function createAgentDb(convDir, convId, mtimeMs) {
  const dbPath = path.join(convDir, `${convId}.db`);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB);
      CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
      CREATE TABLE steps (step_id TEXT PRIMARY KEY, metadata TEXT, step_payload TEXT, render_info TEXT, task_details TEXT);
    `);
    db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (1, ?)").run(Buffer.alloc(4096, 0x61));
  } finally {
    db.close();
  }
  const ts = new Date(mtimeMs);
  fs.utimesSync(dbPath, ts, ts);
}

/**
 * Runs the active agent tree test suite.
 * @returns {Promise<{ passed: number, failed: number }>}
 */
export async function runAgentTreeTests() {
  console.log("--- Running test_agent_tree.js ---");
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

  const NOW = 1_700_000_000_000;

  // 1. Alphabetical Subagent Ordering & Deterministic Tie-Breaking
  test("agent-tree: sorts root.children alphabetically (case-insensitive, numeric) regardless of mtime", () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-tree-order-"));
    try {
      const convDir = path.join(testDir, "conversations");
      fs.mkdirSync(convDir, { recursive: true });

      createAgentDb(convDir, "main-root", NOW - 10_000);
      createAgentDb(convDir, "sub-z", NOW - 1_000);   // newest mtime, alphabetically last
      createAgentDb(convDir, "sub-10", NOW - 2_000);
      createAgentDb(convDir, "sub-2", NOW - 3_000);
      createAgentDb(convDir, "sub-b", NOW - 4_000);
      createAgentDb(convDir, "sub-a", NOW - 5_000);   // oldest mtime, alphabetically first

      const runningBase = {
        status: "CASCADE_RUN_STATUS_RUNNING",
        isIdle: false,
        isRunning: true,
        rootConversationId: "main-root"
      };
      const cascadeStatuses = new Map([
        ["main-root", { status: "CASCADE_RUN_STATUS_RUNNING", isIdle: false, isRunning: true, title: "Main Session", lastModifiedTime: new Date(NOW - 10_000).toISOString() }],
        ["sub-z", { ...runningBase, subagentRole: "zulu-agent", subagentType: "explore", title: "Zulu Task", lastModifiedTime: new Date(NOW - 1_000).toISOString() }],
        ["sub-10", { ...runningBase, subagentRole: "worker-10", subagentType: "coder", title: "Worker 10", lastModifiedTime: new Date(NOW - 2_000).toISOString() }],
        ["sub-2", { ...runningBase, subagentRole: "worker-2", subagentType: "coder", title: "Worker 2", lastModifiedTime: new Date(NOW - 3_000).toISOString() }],
        ["sub-b", { ...runningBase, subagentRole: "Beta-Agent", subagentType: "coder", title: "Beta Task", lastModifiedTime: new Date(NOW - 4_000).toISOString() }],
        ["sub-a", { ...runningBase, subagentRole: "alpha-agent", subagentType: "planner", title: "Alpha Task", lastModifiedTime: new Date(NOW - 5_000).toISOString() }]
      ]);

      const tree = findActiveAgentTree({
        conversationsDir: convDir,
        currentConversationId: "main-root",
        cascadeStatuses,
        nowMs: NOW
      });

      assert.strictEqual(tree.mainCount, 1);
      assert.strictEqual(tree.subagentCount, 5);
      assert.strictEqual(tree.totalActiveCount, 6);
      assert.deepStrictEqual(
        tree.roots[0].children.map((c) => c.conversationId),
        ["sub-a", "sub-b", "sub-2", "sub-10", "sub-z"]
      );
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("agent-tree: tie-breaks identical subagentName deterministically by type -> title -> id", () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-tree-tie-"));
    try {
      const convDir = path.join(testDir, "conversations");
      fs.mkdirSync(convDir, { recursive: true });

      createAgentDb(convDir, "main-tie", NOW - 10_000);
      createAgentDb(convDir, "aud-type-b", NOW - 1_000);
      createAgentDb(convDir, "aud-title-b", NOW - 2_000);
      createAgentDb(convDir, "aud-id-2", NOW - 3_000);
      createAgentDb(convDir, "aud-id-1", NOW - 4_000);

      const shared = {
        status: "CASCADE_RUN_STATUS_RUNNING",
        isIdle: false,
        isRunning: true,
        rootConversationId: "main-tie",
        subagentRole: "team-auditor",
        lastModifiedTime: new Date(NOW - 1_000).toISOString()
      };
      // Insert in reverse order to ensure sorting does not depend on insertion order
      const cascadeStatuses = new Map([
        ["main-tie", { status: "CASCADE_RUN_STATUS_RUNNING", isIdle: false, isRunning: true }],
        ["aud-type-b", { ...shared, subagentType: "review-b", title: "Task A" }],
        ["aud-title-b", { ...shared, subagentType: "review-a", title: "Task B" }],
        ["aud-id-2", { ...shared, subagentType: "review-a", title: "Task A" }],
        ["aud-id-1", { ...shared, subagentType: "review-a", title: "Task A" }]
      ]);

      const tree = findActiveAgentTree({ conversationsDir: convDir, cascadeStatuses, nowMs: NOW });
      assert.deepStrictEqual(
        tree.roots[0].children.map((c) => c.conversationId),
        ["aud-id-1", "aud-id-2", "aud-title-b", "aud-type-b"]
      );
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 2. 2-Minute (120000 ms) Idle Subagent Grace Window & Main Pruning
  test("agent-tree: retains idle subagents within 120000ms grace window and prunes expired ones", () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-tree-grace-"));
    try {
      const convDir = path.join(testDir, "conversations");
      fs.mkdirSync(convDir, { recursive: true });

      createAgentDb(convDir, "main-idle-parent", NOW - 300_000);
      createAgentDb(convDir, "sub-in-grace", NOW - 119_000);
      createAgentDb(convDir, "sub-exact-boundary", NOW - 120_000);
      createAgentDb(convDir, "sub-future-skew", NOW + 2_000);
      createAgentDb(convDir, "sub-expired-1ms", NOW - 120_001);
      createAgentDb(convDir, "sub-expired-121s", NOW - 121_000);
      createAgentDb(convDir, "main-idle-orphan", NOW - 30_000);

      const idleSubBase = {
        status: "CASCADE_RUN_STATUS_IDLE",
        isIdle: true,
        isRunning: false,
        rootConversationId: "main-idle-parent"
      };
      const cascadeStatuses = new Map([
        ["main-idle-parent", { status: "CASCADE_RUN_STATUS_IDLE", isIdle: true, isRunning: false, lastModifiedTime: new Date(NOW - 300_000).toISOString() }],
        ["sub-in-grace", { ...idleSubBase, subagentRole: "b-in-grace", lastModifiedTime: new Date(NOW - 119_000).toISOString() }],
        ["sub-exact-boundary", { ...idleSubBase, subagentRole: "a-boundary", lastModifiedTime: new Date(NOW - 120_000).toISOString() }],
        ["sub-future-skew", { ...idleSubBase, subagentRole: "c-skew", lastModifiedTime: new Date(NOW + 2_000).toISOString() }],
        ["sub-expired-1ms", { ...idleSubBase, subagentRole: "d-expired-1ms", lastModifiedTime: new Date(NOW - 120_001).toISOString() }],
        ["sub-expired-121s", { ...idleSubBase, subagentRole: "e-expired-121s", lastModifiedTime: new Date(NOW - 121_000).toISOString() }],
        ["main-idle-orphan", { status: "CASCADE_RUN_STATUS_IDLE", isIdle: true, isRunning: false, lastModifiedTime: new Date(NOW - 30_000).toISOString() }]
      ]);

      const tree = findActiveAgentTree({
        conversationsDir: convDir,
        cascadeStatuses,
        idleGraceMs: 120_000,
        nowMs: NOW
      });

      // Idle orphan main is pruned; main-idle-parent stays visible because of retained idle subagents
      assert.strictEqual(tree.mainCount, 1);
      assert.strictEqual(tree.subagentCount, 3);
      assert.strictEqual(tree.totalActiveCount, 0);
      assert.strictEqual(tree.roots[0].conversationId, "main-idle-parent");
      assert.strictEqual(tree.roots[0].isActive, false);
      assert.deepStrictEqual(
        tree.roots[0].children.map((c) => c.conversationId),
        ["sub-exact-boundary", "sub-in-grace", "sub-future-skew"]
      );
      for (const child of tree.roots[0].children) {
        assert.strictEqual(child.isActive, false);
        assert.strictEqual(child.runState, "idle");
      }

      // Standalone idle main conversation without retained children is pruned even within 2 minutes
      const orphanOnlyTree = findActiveAgentTree({
        conversationsDir: convDir,
        cascadeStatuses: new Map([
          ["main-idle-orphan", { status: "CASCADE_RUN_STATUS_IDLE", isIdle: true, isRunning: false, lastModifiedTime: new Date(NOW - 30_000).toISOString() }]
        ]),
        idleGraceMs: 120_000,
        nowMs: NOW
      });
      assert.strictEqual(orphanOnlyTree.roots.length, 0);
      assert.strictEqual(orphanOnlyTree.totalActiveCount, 0);
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 3. maxScan Prioritization: Active Subagents Ahead of Recently-Idle Subagents
  test("agent-tree: maxScan prioritizes active subagents ahead of recently-idle subagents", () => {
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "tt-tree-maxscan-"));
    try {
      const convDir = path.join(testDir, "conversations");
      fs.mkdirSync(convDir, { recursive: true });

      createAgentDb(convDir, "main-cur", NOW - 10_000);
      createAgentDb(convDir, "sub-idle-1", NOW - 5_000);
      createAgentDb(convDir, "sub-idle-2", NOW - 4_000);
      createAgentDb(convDir, "sub-active", NOW - 1_000);

      // Place both idle subagents BEFORE the active subagent in cascadeStatuses
      const cascadeStatuses = new Map([
        ["sub-idle-1", { status: "CASCADE_RUN_STATUS_IDLE", isIdle: true, isRunning: false, rootConversationId: "main-cur", subagentRole: "idle-1", lastModifiedTime: new Date(NOW - 5_000).toISOString() }],
        ["sub-idle-2", { status: "CASCADE_RUN_STATUS_IDLE", isIdle: true, isRunning: false, rootConversationId: "main-cur", subagentRole: "idle-2", lastModifiedTime: new Date(NOW - 4_000).toISOString() }],
        ["sub-active", { status: "CASCADE_RUN_STATUS_RUNNING", isIdle: false, isRunning: true, rootConversationId: "main-cur", subagentRole: "z-active", lastModifiedTime: new Date(NOW - 1_000).toISOString() }]
      ]);

      const tree = findActiveAgentTree({
        conversationsDir: convDir,
        currentConversationId: "main-cur",
        cascadeStatuses,
        maxScan: 3,
        idleGraceMs: 120_000,
        nowMs: NOW
      });

      assert.strictEqual(tree.mainCount, 1);
      assert.strictEqual(tree.subagentCount, 2);
      assert.strictEqual(tree.totalActiveCount, 1);
      assert.deepStrictEqual(
        tree.roots[0].children.map((c) => c.conversationId),
        ["sub-idle-1", "sub-active"]
      );
      const activeNode = tree.roots[0].children.find((c) => c.conversationId === "sub-active");
      assert.strictEqual(activeNode.isActive, true);
      assert.strictEqual(activeNode.runState, "running");
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // 4. Negative-Path Validation & Unit Edge Cases
  test("agent-tree: rejects invalid options and validates compareSubagentNodes & isWithinIdleGrace", () => {
    for (const badOpts of [null, [], "options", 42]) {
      assert.throws(
        () => findActiveAgentTree(badOpts),
        (err) => err instanceof TypeError && err.message.includes("plain object")
      );
    }

    for (const badRangeGrace of [0, -1, 12.5, Infinity]) {
      assert.throws(
        () => findActiveAgentTree({ idleGraceMs: badRangeGrace }),
        (err) => err instanceof RangeError && err.message.includes("idleGraceMs")
      );
    }
    for (const badTypeGrace of ["120000", NaN, null]) {
      assert.throws(
        () => findActiveAgentTree({ idleGraceMs: badTypeGrace }),
        (err) => err instanceof TypeError && err.message.includes("idleGraceMs")
      );
    }

    for (const badRangeNow of [-5, -Infinity, Infinity]) {
      assert.throws(
        () => findActiveAgentTree({ nowMs: badRangeNow }),
        (err) => err instanceof RangeError && err.message.includes("nowMs")
      );
    }
    for (const badTypeNow of [NaN, "now", null]) {
      assert.throws(
        () => findActiveAgentTree({ nowMs: badTypeNow }),
        (err) => err instanceof TypeError && err.message.includes("nowMs")
      );
    }

    // isWithinIdleGrace boundary & invalid date cases
    assert.strictEqual(isWithinIdleGrace(null, NOW, 120_000), false);
    assert.strictEqual(isWithinIdleGrace({}, NOW, 120_000), false);
    assert.strictEqual(isWithinIdleGrace({ lastActivityAt: "" }, NOW, 120_000), false);
    assert.strictEqual(isWithinIdleGrace({ lastActivityAt: "not-a-date" }, NOW, 120_000), false);
    assert.strictEqual(isWithinIdleGrace({ lastActivityAt: "1970-01-01T00:00:00.000Z" }, NOW, 120_000), false);
    assert.strictEqual(isWithinIdleGrace({ lastUpdatedAt: new Date(NOW - 120_000).toISOString() }, NOW, 120_000), true);
    assert.strictEqual(isWithinIdleGrace({ lastUpdatedAt: new Date(NOW - 120_001).toISOString() }, NOW, 120_000), false);
    assert.strictEqual(isWithinIdleGrace({ lastActivityAt: new Date(NOW + 5_000).toISOString() }, NOW, 120_000), true);
    assert.strictEqual(isWithinIdleGrace({ lastActivityAt: new Date(NOW + 5_001).toISOString() }, NOW, 120_000), false);

    // compareSubagentNodes fallback fields & equality
    assert.strictEqual(
      compareSubagentNodes({ subagentName: "Alpha", conversationId: "2" }, { subagentName: "alpha", conversationId: "1" }) > 0,
      true
    );
    assert.strictEqual(
      compareSubagentNodes({ subagentType: "worker-2" }, { subagentType: "worker-10" }) < 0,
      true
    );
    assert.strictEqual(
      compareSubagentNodes({ conversationName: "B" }, { conversationName: "a" }) > 0,
      true
    );
    assert.strictEqual(compareSubagentNodes({ conversationId: "same" }, { conversationId: "same" }), 0);
  });

  return { passed, failed };
}

const isMain = Boolean(
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
);

if (isMain) {
  runAgentTreeTests()
    .then(({ failed }) => {
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error("[FATAL] Agent tree test runner failed:", err);
      process.exit(1);
    });
}
