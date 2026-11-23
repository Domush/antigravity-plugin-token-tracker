/**
 * Antigravity Token Tracker — Adversarial Models Catalog Test Suite.
 * Validates catalog integrity, fuzzy matching, case normalization,
 * token count formatting boundaries, and negative-path fallbacks.
 */

import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_CATALOG,
  DEFAULT_CONTEXT_WINDOW,
  sanitizeModelKey,
  getModelContextWindow,
  normalizeModelName,
  detectModelGroup,
  formatTokenCount
} from "../lib/models.js";

/**
 * Runs the models test suite.
 * @returns {Promise<{ passed: number, failed: number }>}
 */
export async function runModelsTests() {
  console.log("--- Running test_models.js ---");
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

  // 1. Catalog Structural Integrity
  test("models: catalog is immutable and fully typed", () => {
    assert.strictEqual(Object.isFrozen(MODEL_CATALOG), true);
    const keys = Object.keys(MODEL_CATALOG);
    assert.strictEqual(keys.length >= 20, true);

    for (const key of keys) {
      const entry = MODEL_CATALOG[key];
      assert.strictEqual(typeof entry.name, "string");
      assert.strictEqual(entry.name.length > 0, true);
      assert.strictEqual(typeof entry.maxTokens, "number");
      assert.strictEqual(entry.maxTokens > 0, true);
      assert.strictEqual(entry.group === "gemini" || entry.group === "thirdParty", true);
    }
  });

  // 2. Exact Gemini Catalog Invariants
  test("models: exact catalog entries for Google Gemini models", () => {
    assert.strictEqual(getModelContextWindow("gemini-3.8-flash-high"), 1048576);
    assert.strictEqual(normalizeModelName("gemini-3.8-flash-high"), "Gemini 3.8 Flash (High)");
    assert.strictEqual(detectModelGroup("gemini-3.8-flash-high"), "gemini");

    assert.strictEqual(getModelContextWindow("gemini-3.8-flash-low"), 1048576);
    assert.strictEqual(normalizeModelName("gemini-3.8-flash-low"), "Gemini 3.8 Flash (Low)");
    assert.strictEqual(detectModelGroup("gemini-3.8-flash-low"), "gemini");

    assert.strictEqual(getModelContextWindow("gemini-3.8-flash-tiered"), 1048576);
    assert.strictEqual(normalizeModelName("gemini-3.8-flash-tiered"), "Gemini 3.8 Flash (Tiered)");

    assert.strictEqual(getModelContextWindow("gemini-3.8-flash"), 1048576);
    assert.strictEqual(normalizeModelName("gemini-3.8-flash"), "Gemini 3.8 Flash");

    assert.strictEqual(getModelContextWindow("gemini-3.5-pro"), 2097152);
    assert.strictEqual(normalizeModelName("gemini-3.5-pro"), "Gemini 3.5 Pro");
    assert.strictEqual(detectModelGroup("gemini-3.5-pro"), "gemini");

    assert.strictEqual(getModelContextWindow("gemini-3.5-flash"), 1048576);
    assert.strictEqual(getModelContextWindow("gemini-3.5-flash-lite"), 1048576);
    assert.strictEqual(getModelContextWindow("gemini-1.5-pro"), 2097152);
    assert.strictEqual(getModelContextWindow("gemini-1.5-flash"), 1048576);

    // Shorthand aliases
    assert.strictEqual(getModelContextWindow("flash"), 1048576);
    assert.strictEqual(getModelContextWindow("pro"), 2097152);
    assert.strictEqual(getModelContextWindow("flash_lite"), 1048576);
  });

  // 3. Exact Anthropic Claude Catalog Invariants
  test("models: exact catalog entries for Anthropic Claude models", () => {
    assert.strictEqual(getModelContextWindow("claude-3-5-sonnet"), 200000);
    assert.strictEqual(normalizeModelName("claude-3-5-sonnet"), "Claude 3.5 Sonnet");
    assert.strictEqual(detectModelGroup("claude-3-5-sonnet"), "thirdParty");

    assert.strictEqual(getModelContextWindow("claude-3-7-sonnet"), 200000);
    assert.strictEqual(normalizeModelName("claude-3-7-sonnet"), "Claude 3.7 Sonnet");

    assert.strictEqual(getModelContextWindow("claude-sonnet-4-6"), 200000);
    assert.strictEqual(normalizeModelName("claude-sonnet-4-6"), "Claude Sonnet 4.6");

    assert.strictEqual(getModelContextWindow("claude-3-opus"), 200000);
    assert.strictEqual(normalizeModelName("claude-3-opus"), "Claude 3 Opus");

    assert.strictEqual(getModelContextWindow("claude-opus-4-6"), 200000);
    assert.strictEqual(normalizeModelName("claude-opus-4-6"), "Claude Opus 4.6");

    assert.strictEqual(getModelContextWindow("claude-3-haiku"), 200000);
    assert.strictEqual(normalizeModelName("claude-3-haiku"), "Claude 3 Haiku");

    assert.strictEqual(getModelContextWindow("claude-3-5-haiku"), 200000);
    assert.strictEqual(normalizeModelName("claude-3-5-haiku"), "Claude 3.5 Haiku");
  });

  // 4. Exact OpenAI & DeepSeek Catalog Invariants
  test("models: exact catalog entries for OpenAI and DeepSeek models", () => {
    assert.strictEqual(getModelContextWindow("gpt-4o"), 128000);
    assert.strictEqual(normalizeModelName("gpt-4o"), "GPT-4o");
    assert.strictEqual(detectModelGroup("gpt-4o"), "thirdParty");

    assert.strictEqual(getModelContextWindow("gpt-4o-mini"), 128000);
    assert.strictEqual(getModelContextWindow("gpt-4-turbo"), 128000);

    assert.strictEqual(getModelContextWindow("o1"), 128000);
    assert.strictEqual(normalizeModelName("o1"), "OpenAI o1");
    assert.strictEqual(detectModelGroup("o1"), "thirdParty");

    assert.strictEqual(getModelContextWindow("o1-preview"), 128000);
    assert.strictEqual(getModelContextWindow("o1-mini"), 128000);

    assert.strictEqual(getModelContextWindow("o3-mini"), 200000);
    assert.strictEqual(normalizeModelName("o3-mini"), "OpenAI o3 Mini");
    assert.strictEqual(detectModelGroup("o3-mini"), "thirdParty");

    assert.strictEqual(getModelContextWindow("gpt-oss-120b"), 128000);

    assert.strictEqual(getModelContextWindow("deepseek-r1"), 128000);
    assert.strictEqual(normalizeModelName("deepseek-r1"), "DeepSeek R1");
    assert.strictEqual(detectModelGroup("deepseek-r1"), "thirdParty");

    assert.strictEqual(getModelContextWindow("deepseek-v3"), 128000);
  });

  // 5. Normalization, Case Variations, and Special Characters
  test("models: sanitizeModelKey handles whitespace, uppercase, and special chars", () => {
    assert.strictEqual(sanitizeModelKey("  GEMINI-3.8-FLASH-HIGH  "), "gemini-3.8-flash-high");
    assert.strictEqual(sanitizeModelKey("Claude (Sonnet 3.5)"), "claude-sonnet-3.5");
    assert.strictEqual(sanitizeModelKey("GPT__4o   Mini"), "gpt-4o-mini");
    assert.strictEqual(sanitizeModelKey("o3---mini"), "o3-mini");
    assert.strictEqual(sanitizeModelKey("gemini_3_5_pro"), "gemini-3-5-pro");

    // Non-string or empty inputs fallback safely
    assert.strictEqual(sanitizeModelKey(""), "gemini-3.8-flash-high");
    assert.strictEqual(sanitizeModelKey("   "), "gemini-3.8-flash-high");
    assert.strictEqual(sanitizeModelKey(null), "gemini-3.8-flash-high");
    assert.strictEqual(sanitizeModelKey(undefined), "gemini-3.8-flash-high");
    assert.strictEqual(sanitizeModelKey(12345), "gemini-3.8-flash-high");
    assert.strictEqual(sanitizeModelKey({}), "gemini-3.8-flash-high");
  });

  // 6. Fuzzy Substring Match Patterns
  test("models: fuzzy matches uncatalogued variants by family keyword", () => {
    assert.strictEqual(getModelContextWindow("custom-3-5-pro-preview"), 2097152);
    assert.strictEqual(getModelContextWindow("experimental-1-5-pro-v2"), 2097152);
    assert.strictEqual(getModelContextWindow("pro-2m-extended"), 2097152);

    assert.strictEqual(getModelContextWindow("unknown-gemini-preview"), 1048576);
    assert.strictEqual(getModelContextWindow("private-flash-router"), 1048576);

    assert.strictEqual(getModelContextWindow("custom-claude-agent"), 200000);
    assert.strictEqual(getModelContextWindow("internal-sonnet-model"), 200000);
    assert.strictEqual(getModelContextWindow("opus-fine-tune"), 200000);
    assert.strictEqual(getModelContextWindow("haiku-fast-eval"), 200000);

    assert.strictEqual(getModelContextWindow("gpt-4-custom-agent"), 128000);
    assert.strictEqual(getModelContextWindow("o1-synthetic-test"), 128000);
    assert.strictEqual(getModelContextWindow("deepseek-distill-qwen"), 128000);
    assert.strictEqual(getModelContextWindow("o3-experimental-thinking"), 200000);
  });

  // 7. Unknown / Fallback Default Handling
  test("models: safely falls back to default 1M context window for unknown models", () => {
    assert.strictEqual(DEFAULT_CONTEXT_WINDOW, 1048576);
    assert.strictEqual(getModelContextWindow("llama-3.1-405b"), DEFAULT_CONTEXT_WINDOW);
    assert.strictEqual(getModelContextWindow("mistral-large-2407"), DEFAULT_CONTEXT_WINDOW);
    assert.strictEqual(getModelContextWindow("qwen-2.5-72b"), DEFAULT_CONTEXT_WINDOW);
    assert.strictEqual(getModelContextWindow(""), DEFAULT_CONTEXT_WINDOW);
    assert.strictEqual(getModelContextWindow(null), DEFAULT_CONTEXT_WINDOW);
    assert.strictEqual(getModelContextWindow(undefined), DEFAULT_CONTEXT_WINDOW);
    assert.strictEqual(getModelContextWindow(999), DEFAULT_CONTEXT_WINDOW);
  });

  test("models: normalizeModelName fallback behaviors", () => {
    assert.strictEqual(normalizeModelName("  GEMINI-3.5-PRO  "), "Gemini 3.5 Pro");
    assert.strictEqual(normalizeModelName("llama-3-70b-instruct"), "llama-3-70b-instruct");
    assert.strictEqual(normalizeModelName(""), "Gemini 3.8 Flash (High)");
    assert.strictEqual(normalizeModelName("   "), "Gemini 3.8 Flash (High)");
    assert.strictEqual(normalizeModelName(null), "Gemini 3.8 Flash (High)");
    assert.strictEqual(normalizeModelName(undefined), "Gemini 3.8 Flash (High)");
  });

  test("models: detectModelGroup classification rules", () => {
    assert.strictEqual(detectModelGroup("gemini-3.8-flash-high"), "gemini");
    assert.strictEqual(detectModelGroup("gemini-custom-router"), "gemini");
    assert.strictEqual(detectModelGroup("claude-experimental"), "thirdParty");
    assert.strictEqual(detectModelGroup("gpt-5-preview"), "thirdParty");
    assert.strictEqual(detectModelGroup("openai-agent-v1"), "thirdParty");
    assert.strictEqual(detectModelGroup("deepseek-special"), "thirdParty");
    assert.strictEqual(detectModelGroup("my-3p-hosted-endpoint"), "thirdParty");
    assert.strictEqual(detectModelGroup("unlabeled-generic-model"), "gemini");
    assert.strictEqual(detectModelGroup(null), "gemini");
    assert.strictEqual(detectModelGroup(undefined), "gemini");
  });

  // 8. Boundary Tests for formatTokenCount
  test("models: formatTokenCount boundary conditions and input sanitization", () => {
    // Zero & sub-thousand counts
    assert.strictEqual(formatTokenCount(0), "0");
    assert.strictEqual(formatTokenCount(1), "1");
    assert.strictEqual(formatTokenCount(500), "500");
    assert.strictEqual(formatTokenCount(999), "999");

    // Thousands threshold & rounding
    assert.strictEqual(formatTokenCount(1000), "1k");
    assert.strictEqual(formatTokenCount(1001), "1.0k");
    assert.strictEqual(formatTokenCount(1499), "1.5k");
    assert.strictEqual(formatTokenCount(1500), "1.5k");
    assert.strictEqual(formatTokenCount(25000), "25k");
    assert.strictEqual(formatTokenCount(99900), "99.9k");
    assert.strictEqual(formatTokenCount(100000), "100k");
    assert.strictEqual(formatTokenCount(100450), "100k");
    assert.strictEqual(formatTokenCount(999999), "1000k");

    // Millions threshold & rounding
    assert.strictEqual(formatTokenCount(1000000), "1M");
    assert.strictEqual(formatTokenCount(1048576), "1.05M");
    assert.strictEqual(formatTokenCount(2097152), "2.10M");
    assert.strictEqual(formatTokenCount(10000000), "10M");
    assert.strictEqual(formatTokenCount(10500000), "10.5M");

    // Negative numbers clamp to zero
    assert.strictEqual(formatTokenCount(-1), "0");
    assert.strictEqual(formatTokenCount(-500), "0");
    assert.strictEqual(formatTokenCount(-1048576), "0");

    // Non-numeric & invalid inputs fallback to zero
    assert.strictEqual(formatTokenCount(null), "0");
    assert.strictEqual(formatTokenCount(undefined), "0");
    assert.strictEqual(formatTokenCount(NaN), "0");
    assert.strictEqual(formatTokenCount("1000"), "0");
    assert.strictEqual(formatTokenCount({}), "0");
    assert.strictEqual(formatTokenCount([]), "0");
    assert.strictEqual(formatTokenCount(true), "0");
    assert.strictEqual(formatTokenCount(false), "0");
  });

  return { passed, failed };
}

const isMain = Boolean(
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
);

if (isMain) {
  runModelsTests().then(({ failed }) => {
    process.exit(failed > 0 ? 1 : 0);
  });
}
