/**
 * Antigravity Token Tracker — Master Test Runner.
 * Orchestrates adversarial unit, boundary, contract, and integration suites across:
 * - models (test_models.js)
 * - quota service (test_quota_service.js)
 * - conversation tracker (test_conversation_tracker.js)
 * - telemetry server (test_telemetry_server.js)
 * - injector & ASAR offsets (test_injector_offset.js)
 * - hooks isolation
 * - unified CLI (test_cli.js)
 * - live hook usage & offline fallback (test_hooks_live_usage.js)
 * - active agent tree ordering & idle grace (test_agent_tree.js)
 */

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runModelsTests } from "./test_models.js";
import { runQuotaServiceTests } from "./test_quota_service.js";
import { runConversationTrackerTests } from "./test_conversation_tracker.js";
import { runTelemetryServerTests } from "./test_telemetry_server.js";
import { runInjectorOffsetTests } from "./test_injector_offset.js";
import { runCliTests } from "./test_cli.js";
import { runHooksLiveUsageTests } from "./test_hooks_live_usage.js";
import { runAgentTreeTests } from "./test_agent_tree.js";

/**
 * Executes the complete test matrix.
 * @returns {Promise<boolean>}
 */
export async function runAllTests() {
  console.log("==================================================");
  console.log("   ANTIGRAVITY TOKEN TRACKER TEST EXECUTION       ");
  console.log("==================================================");

  let totalPassed = 0;
  let totalFailed = 0;
  const suiteResults = [];

  // Suite 1: Models Catalog & Token Formatting
  try {
    const res = await runModelsTests();
    suiteResults.push({ name: "Models Catalog", ...res });
    totalPassed += res.passed;
    totalFailed += res.failed;
  } catch (err) {
    console.error(`[CRITICAL] Models suite crashed: ${err.message}`);
    suiteResults.push({ name: "Models Catalog", passed: 0, failed: 1 });
    totalFailed++;
  }

  // Suite 2: Quota Service & RPC Client
  try {
    const res = await runQuotaServiceTests();
    suiteResults.push({ name: "Quota Service", ...res });
    totalPassed += res.passed;
    totalFailed += res.failed;
  } catch (err) {
    console.error(`[CRITICAL] Quota Service suite crashed: ${err.message}`);
    suiteResults.push({ name: "Quota Service", passed: 0, failed: 1 });
    totalFailed++;
  }

  // Suite 3: Conversation Tracker & SQLite Trajectory
  try {
    const res = await runConversationTrackerTests();
    suiteResults.push({ name: "Conversation Tracker", ...res });
    totalPassed += res.passed;
    totalFailed += res.failed;
  } catch (err) {
    console.error(`[CRITICAL] Conversation Tracker suite crashed: ${err.message}`);
    suiteResults.push({ name: "Conversation Tracker", passed: 0, failed: 1 });
    totalFailed++;
  }

  // Suite 4: Telemetry HTTP Server
  try {
    const res = await runTelemetryServerTests();
    suiteResults.push({ name: "Telemetry Server", ...res });
    totalPassed += res.passed;
    totalFailed += res.failed;
  } catch (err) {
    console.error(`[CRITICAL] Telemetry Server suite crashed: ${err.message}`);
    suiteResults.push({ name: "Telemetry Server", passed: 0, failed: 1 });
    totalFailed++;
  }

  // Suite 5: Injector & ASAR Offset Math
  try {
    const res = await runInjectorOffsetTests();
    suiteResults.push({ name: "Injector & ASAR", ...res });
    totalPassed += res.passed;
    totalFailed += res.failed;
  } catch (err) {
    console.error(`[CRITICAL] Injector suite crashed: ${err.message}`);
    suiteResults.push({ name: "Injector & ASAR", passed: 0, failed: 1 });
    totalFailed++;
  }

  // Suite 6: Hook Module Isolation Test
  console.log("--- Running hooks isolation tests ---");
  let hookPassed = 0;
  let hookFailed = 0;
  try {
    const sModule = await import("../hooks/session-start.js");
    assert.strictEqual(typeof sModule.resolveSessionId, "function");
    assert.strictEqual(sModule.resolveSessionId({ conversationId: "active-session-123" }), "active-session-123");
    assert.strictEqual(sModule.resolveSessionId({ root_conversation_id: "root-session-456" }), "root-session-456");
    const savedConv = process.env.ANTIGRAVITY_CONVERSATION_ID;
    const savedRoot = process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID;
    try {
      delete process.env.ANTIGRAVITY_CONVERSATION_ID;
      delete process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID;
      assert.strictEqual(sModule.resolveSessionId({}), null);
    } finally {
      if (savedConv !== undefined) process.env.ANTIGRAVITY_CONVERSATION_ID = savedConv;
      if (savedRoot !== undefined) process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID = savedRoot;
    }
    console.log("  [PASS] hooks: session-start module exports resolveSessionId and executes resolution contract");
    hookPassed++;

    const pModule = await import("../hooks/pre-invocation.js");
    assert.strictEqual(pModule[Symbol.toStringTag], "Module");
    assert.strictEqual(Object.isSealed(pModule), true);
    assert.strictEqual(Object.isExtensible(pModule), false);
    assert.strictEqual(typeof pModule.shouldEmitCompactionAdvisory, "function");
    assert.strictEqual(pModule.ADVISORY_COOLDOWN_MS, 120000);
    assert.throws(() => {
      pModule.ADVISORY_COOLDOWN_MS = 0;
    }, TypeError);
    assert.strictEqual(pModule.ADVISORY_COOLDOWN_MS, 120000);

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "tt-hook-cli-"));
    try {
      const hookOutput = execFileSync(process.execPath, [path.resolve("hooks/pre-invocation.js")], {
        input: JSON.stringify({ conversationId: "test-non-existent-session-for-hook" }),
        encoding: "utf8",
        env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome }
      });
      const parsedHook = JSON.parse(hookOutput.trim());
      assert.deepStrictEqual(parsedHook, {});
      const isolatedActivePath = path.join(
        tmpHome,
        ".gemini",
        "antigravity",
        "plugin_data",
        "token-tracker",
        "active_conversation.json"
      );
      const isolatedActive = JSON.parse(fs.readFileSync(isolatedActivePath, "utf8"));
      assert.strictEqual(isolatedActive.conversationId, "test-non-existent-session-for-hook");
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
    console.log("  [PASS] hooks: pre-invocation module imports safely and executes CLI lifecycle contract");
    hookPassed++;
  } catch (err) {
    console.error(`  [FAIL] hooks: isolation test failed: ${err.message}`);
    hookFailed++;
  }
  suiteResults.push({ name: "Hooks Isolation", passed: hookPassed, failed: hookFailed });
  totalPassed += hookPassed;
  totalFailed += hookFailed;

  // Suite 7: Unified CLI & Workspace Management
  try {
    const res = await runCliTests();
    suiteResults.push({ name: "Unified CLI", ...res });
    totalPassed += res.passed;
    totalFailed += res.failed;
  } catch (err) {
    console.error(`[CRITICAL] CLI suite crashed: ${err.message}`);
    suiteResults.push({ name: "Unified CLI", passed: 0, failed: 1 });
    totalFailed++;
  }

  // Suite 8: Live Hook Usage & Offline Fallback
  try {
    const res = await runHooksLiveUsageTests();
    suiteResults.push({ name: "Hooks Live Usage", ...res });
    totalPassed += res.passed;
    totalFailed += res.failed;
  } catch (err) {
    console.error(`[CRITICAL] Hooks Live Usage suite crashed: ${err.message}`);
    suiteResults.push({ name: "Hooks Live Usage", passed: 0, failed: 1 });
    totalFailed++;
  }

  // Suite 9: Active Agent Tree Ordering & Idle Grace
  try {
    const res = await runAgentTreeTests();
    suiteResults.push({ name: "Agent Tree", ...res });
    totalPassed += res.passed;
    totalFailed += res.failed;
  } catch (err) {
    console.error(`[CRITICAL] Agent Tree suite crashed: ${err.message}`);
    suiteResults.push({ name: "Agent Tree", passed: 0, failed: 1 });
    totalFailed++;
  }

  console.log("\n==================================================");
  console.log("             TEST EXECUTION SUMMARY               ");
  console.log("==================================================");
  for (const suite of suiteResults) {
    const status = suite.failed === 0 ? "PASSED" : "FAILED";
    console.log(`  ${suite.name.padEnd(25)}: ${suite.passed} passed, ${suite.failed} failed [${status}]`);
  }
  console.log("--------------------------------------------------");
  console.log(`  TOTAL: ${totalPassed} passed, ${totalFailed} failed.`);
  console.log("==================================================\n");

  return totalFailed === 0;
}

const isMain = Boolean(
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
);

if (isMain) {
  runAllTests()
    .then((success) => {
      process.exit(success ? 0 : 1);
    })
    .catch((err) => {
      console.error("[FATAL] Test runner failure:", err);
      process.exit(1);
    });
}
