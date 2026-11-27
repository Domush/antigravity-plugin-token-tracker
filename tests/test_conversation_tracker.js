/**
 * Antigravity Token Tracker — Adversarial Conversation Tracker Test Suite.
 * Validates session ID resolution, model identifier extraction, compaction threshold
 * validation, and delegates SQLite/metrics tests to the companion sub-suite.
 */

import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConversationTracker,
  resolveSessionId
} from "../lib/conversation-tracker.js";
import { registerConversationTrackerSqliteTests } from "./test_conversation_tracker_sqlite.js";

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
      assert.strictEqual(resolveSessionId(), "id-env-active");

      delete process.env.ANTIGRAVITY_CONVERSATION_ID;
      process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID = "id-env-root";
      assert.strictEqual(resolveSessionId({}), "id-env-root");

      delete process.env.ANTIGRAVITY_ROOT_CONVERSATION_ID;
      assert.strictEqual(resolveSessionId({}), null);
      assert.strictEqual(resolveSessionId(), null);
      assert.strictEqual(resolveSessionId(undefined), null);
      assert.strictEqual(resolveSessionId({ conversationId: "", session_id: null }), null);
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

    assert.strictEqual(tracker.extractModelIdentifier("selected model gemini-3.8-flash-high for task"), "gemini-3.8-flash-high");
    assert.strictEqual(tracker.extractModelIdentifier("Gemini 3.8 Flash (High) active"), "Gemini 3.8 Flash (High)");
    assert.strictEqual(tracker.extractModelIdentifier("Gemini 3.5 Pro active"), "Gemini 3.5 Pro");
    assert.strictEqual(tracker.extractModelIdentifier("prefix claude-3-5-sonnet suffix"), "claude-3-5-sonnet");
    assert.strictEqual(tracker.extractModelIdentifier("Claude Sonnet 4.6 active"), "Claude Sonnet 4.6");
    assert.strictEqual(tracker.extractModelIdentifier("Claude 3.5 Sonnet active"), "Claude 3.5 Sonnet");
    assert.strictEqual(tracker.extractModelIdentifier("gpt-4o-2024-08-06"), "gpt-4o-2024-08-06");

    const binBuf = Buffer.concat([
      Buffer.from([0x00, 0x01, 0xff, 0xfe]),
      Buffer.from("header data gemini-3.5-pro-preview trailer"),
      Buffer.from([0xaa, 0xbb, 0x00])
    ]);
    assert.strictEqual(tracker.extractModelIdentifier(binBuf), "gemini-3.5-pro-preview");

    assert.strictEqual(tracker.extractModelIdentifier("no models mentioned here"), null);
    assert.strictEqual(tracker.extractModelIdentifier(Buffer.from([0x01, 0x02, 0x03])), null);
  });

  // 3. Extended Model Identifier Extraction & Negative/Punctuation Boundaries
  test("conversation-tracker: extractModelIdentifier handles Gemini 4, Claude 5.5, OpenAI, DeepSeek, Grok, and compiler-flag guards", () => {
    const tracker = new ConversationTracker();
    const cases = [
      ["running gemini-4-hydrogen-xhigh now", "gemini-4-hydrogen-xhigh"],
      ["model: gemini-4-hydrogen-orchestrator!", "gemini-4-hydrogen-orchestrator"],
      ["using gemini-4-argon-high", "gemini-4-argon-high"],
      ["Gemini 4 Hydrogen (High) active", "Gemini 4 Hydrogen (High)"],
      ["Gemini 4 Neon (XHigh) ready", "Gemini 4 Neon (XHigh)"],
      ["gemini-2.0-flash with -O3", "gemini-2.0-flash"],
      ["gemini-3.7-flash-tiered", "gemini-3.7-flash-tiered"],
      ["claude-opus-5-5-max", "claude-opus-5-5-max"],
      ["claude-sonnet-5-5-1m@default", "claude-sonnet-5-5-1m@default"],
      ["Claude Opus 5.5 (High) (1M) selected", "Claude Opus 5.5 (High) (1M)"],
      ["Using claude-opus-4-8@20260101. Done.", "claude-opus-4-8@20260101"],
      ["claude-3-7-sonnet", "claude-3-7-sonnet"],
      ["route openai/gpt-oss-120b-maas", "openai/gpt-oss-120b-maas"],
      ["gpt-5.2-codex", "gpt-5.2-codex"],
      ["using o3-pro and o4-mini", "o3-pro"],
      ["using o4-mini", "o4-mini"],
      ["isolated o3 model", "o3"],
      ["deepseek-v3.2 active", "deepseek-v3.2"],
      ["grok-4 and grok-3-mini", "grok-4"]
    ];
    for (const [input, expected] of cases) {
      assert.strictEqual(tracker.extractModelIdentifier(input), expected, `mismatch for "${input}"`);
    }

    const rejected = [
      "-O3",
      "O1",
      "O3",
      "O4",
      "foo-o3",
      "compiler flags: -O3 -Wall with llama-3.1-405b",
      null,
      undefined
    ];
    for (const input of rejected) {
      assert.strictEqual(tracker.extractModelIdentifier(input), null, `expected null for "${String(input)}"`);
    }
  });

  // 4. Compaction Threshold Fail-Fast Validation (Explicit & Env)
  test("conversation-tracker: compactionThresholdBytes and env fail fast on invalid values", () => {
    const savedEnv = process.env.ANTIGRAVITY_COMPACTION_THRESHOLD_BYTES;
    try {
      delete process.env.ANTIGRAVITY_COMPACTION_THRESHOLD_BYTES;
      for (const badRange of [0, -100, Infinity, 12.5]) {
        assert.throws(
          () => new ConversationTracker({ compactionThresholdBytes: badRange }),
          (err) =>
            err instanceof RangeError &&
            err.message.includes("compactionThresholdBytes must be a positive finite integer")
        );
      }
      for (const badType of [NaN, "abc"]) {
        assert.throws(
          () => new ConversationTracker({ compactionThresholdBytes: badType }),
          (err) =>
            err instanceof TypeError &&
            err.message.includes("compactionThresholdBytes must be a positive finite integer")
        );
      }

      for (const badEnv of ["0", "-100", "NaN", "Infinity", "12.5", "abc", "   ", "12abc"]) {
        process.env.ANTIGRAVITY_COMPACTION_THRESHOLD_BYTES = badEnv;
        assert.throws(
          () => new ConversationTracker(),
          (err) =>
            err instanceof RangeError &&
            err.message.includes("Invalid ANTIGRAVITY_COMPACTION_THRESHOLD_BYTES") &&
            err.message.includes("must be a positive finite integer")
        );
      }

      process.env.ANTIGRAVITY_COMPACTION_THRESHOLD_BYTES = " 262144 ";
      const validFromEnv = new ConversationTracker();
      assert.strictEqual(validFromEnv.compactionThresholdBytes, 262144);
    } finally {
      if (savedEnv !== undefined) process.env.ANTIGRAVITY_COMPACTION_THRESHOLD_BYTES = savedEnv;
      else delete process.env.ANTIGRAVITY_COMPACTION_THRESHOLD_BYTES;
    }
  });

  // 5-9. SQLite Discovery, Metrics, Compaction & Cache Sub-Suite
  registerConversationTrackerSqliteTests(test);

  return { passed, failed };
}

const isMain = Boolean(
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
);

if (isMain) {
  runConversationTrackerTests()
    .then(({ failed }) => {
      process.exit(failed > 0 ? 1 : 0);
    })
    .catch((err) => {
      console.error("[FATAL] Conversation tracker test runner failed:", err);
      process.exit(1);
    });
}
