/**
 * Immutable Model Context Window Catalog.
 * Defines supported Antigravity and third-party model entries with display names,
 * context window capacities, and quota groups.
 */

export const DEFAULT_CONTEXT_WINDOW = 1048576; // 1,048,576 tokens (1M default)
export const DEFAULT_COMPACTION_CAP_TOKENS = 512000; // Antigravity checkpointer ceiling (512k tokens)

/**
 * Registers a model entry and automatic dot/hyphen version key variants.
 * @param {Record<string, { name: string, maxTokens: number, compactionTokens: number, group: "gemini"|"thirdParty" }>} target
 * @param {string} key
 * @param {string} name
 * @param {number} maxTokens
 * @param {"gemini"|"thirdParty"} group
 * @param {number|null} [compactionTokens]
 */
function addModel(target, key, name, maxTokens, group, compactionTokens = null) {
  const resolvedCompaction =
    typeof compactionTokens === "number" && Number.isFinite(compactionTokens) && compactionTokens > 0
      ? compactionTokens
      : Math.min(DEFAULT_COMPACTION_CAP_TOKENS, Math.round(maxTokens * 0.80));
  const entry = Object.freeze({ name, maxTokens, compactionTokens: resolvedCompaction, group });
  target[key] = entry;
  const dotVariant = key.replace(/(\d+)-(\d+)/g, "$1.$2");
  const hyphenVariant = key.replace(/(\d+)\.(\d+)/g, "$1-$2");
  if (dotVariant !== key) target[dotVariant] = entry;
  if (hyphenVariant !== key) target[hyphenVariant] = entry;
}

/**
 * Registers a base model along with tiered variants (e.g. -low, -medium, -high).
 * @param {Record<string, { name: string, maxTokens: number, compactionTokens: number, group: "gemini"|"thirdParty" }>} target
 * @param {string} baseKey
 * @param {string} baseName
 * @param {number} maxTokens
 * @param {"gemini"|"thirdParty"} group
 * @param {Array<[string, string]>} tiers
 * @param {number|null} [compactionTokens]
 */
function addTieredModels(target, baseKey, baseName, maxTokens, group, tiers, compactionTokens = null) {
  addModel(target, baseKey, baseName, maxTokens, group, compactionTokens);
  for (const [suffix, label] of tiers) {
    addModel(target, `${baseKey}-${suffix}`, `${baseName} (${label})`, maxTokens, group, compactionTokens);
  }
}

function buildCatalog() {
  const catalog = {};

  const STANDARD_TIERS = [["low", "Low"], ["medium", "Medium"], ["high", "High"]];
  const TIERED_SUBTIERS = [
    ["tiered-low", "Low"],
    ["tiered-medium", "Medium"],
    ["tiered-high", "High"],
    ["tiered-xhigh", "XHigh"]
  ];
  const GEMINI_4_HYDROGEN_TIERS = [
    ...STANDARD_TIERS,
    ["xhigh", "XHigh"],
    ["sonar", "Sonar"],
    ["orchestrator", "Orchestrator"],
    ...TIERED_SUBTIERS
  ];
  const GEMINI_4_STANDARD_TIERED = [...STANDARD_TIERS, ...TIERED_SUBTIERS];
  const GEMINI_4_NEON_TIERS = [...STANDARD_TIERS, ["xhigh", "XHigh"], ...TIERED_SUBTIERS];
  const FLASH_TIERED_VARIANTS = [...STANDARD_TIERS, ["tiered", "Tiered"]];
  const CLAUDE_5_5_TIERS = [...STANDARD_TIERS, ["max", "Max"]];

  // Google Gemini 4 Series (1M, 512k checkpointer compaction limit)
  addTieredModels(catalog, "gemini-4-hydrogen", "Gemini 4 Hydrogen", 1048576, "gemini", GEMINI_4_HYDROGEN_TIERS, 512000);
  addTieredModels(catalog, "gemini-4-argon", "Gemini 4 Argon", 1048576, "gemini", GEMINI_4_STANDARD_TIERED, 512000);
  addTieredModels(catalog, "gemini-4-carbon", "Gemini 4 Carbon", 1048576, "gemini", GEMINI_4_STANDARD_TIERED, 512000);
  addTieredModels(catalog, "gemini-4-neon", "Gemini 4 Neon", 1048576, "gemini", GEMINI_4_NEON_TIERS, 512000);

  // Google Gemini 3.x, 2.5 & 1.5 Series
  addTieredModels(catalog, "gemini-3.8-flash", "Gemini 3.8 Flash", 1048576, "gemini", FLASH_TIERED_VARIANTS, 256000);
  addTieredModels(catalog, "gemini-3.7-flash", "Gemini 3.7 Flash", 1048576, "gemini", FLASH_TIERED_VARIANTS, 256000);
  addTieredModels(catalog, "gemini-3.6-flash", "Gemini 3.6 Flash", 1048576, "gemini", STANDARD_TIERS, 256000);

  addModel(catalog, "gemini-3.5-pro", "Gemini 3.5 Pro", 2097152, "gemini", 512000);
  addModel(catalog, "gemini-3.5-pro-preview", "Gemini 3.5 Pro Preview", 2097152, "gemini", 512000);
  addTieredModels(catalog, "gemini-3.5-flash", "Gemini 3.5 Flash", 1048576, "gemini", [
    ...STANDARD_TIERS,
    ["extra-low", "Extra Low"]
  ], 256000);
  addModel(catalog, "gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", 1048576, "gemini", 256000);

  addTieredModels(catalog, "gemini-3.1-pro", "Gemini 3.1 Pro", 1048576, "gemini", [
    ["low", "Low"],
    ["high", "High"]
  ], 512000);
  addModel(catalog, "gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", 1048576, "gemini", 512000);
  addModel(catalog, "gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite", 1048576, "gemini", 256000);
  addModel(catalog, "gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash-Lite Preview", 1048576, "gemini", 256000);
  addModel(catalog, "gemini-3.1-ultra", "Gemini 3.1 Ultra", 1048576, "gemini", 512000);

  addModel(catalog, "gemini-3-pro", "Gemini 3 Pro", 1048576, "gemini", 512000);
  addModel(catalog, "gemini-3-pro-preview", "Gemini 3 Pro Preview", 1048576, "gemini", 512000);
  addModel(catalog, "gemini-3-flash", "Gemini 3 Flash", 1048576, "gemini", 256000);
  addModel(catalog, "gemini-3-flash-preview", "Gemini 3 Flash Preview", 1048576, "gemini", 256000);

  addModel(catalog, "gemini-2.5-pro", "Gemini 2.5 Pro", 1048576, "gemini", 128000);
  addModel(catalog, "gemini-2.5-flash", "Gemini 2.5 Flash", 1048576, "gemini", 128000);
  addModel(catalog, "gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite", 1048576, "gemini", 128000);

  addModel(catalog, "gemini-1.5-pro", "Gemini 1.5 Pro", 2097152, "gemini", 512000);
  addModel(catalog, "gemini-1.5-flash", "Gemini 1.5 Flash", 1048576, "gemini", 512000);

  // Gemini Short Aliases
  addModel(catalog, "flash", "Gemini 3.8 Flash", 1048576, "gemini", 256000);
  addModel(catalog, "flash-lite", "Gemini 3.5 Flash-Lite", 1048576, "gemini", 256000);
  addModel(catalog, "flash_lite", "Gemini 3.5 Flash-Lite", 1048576, "gemini", 256000);
  addModel(catalog, "pro", "Gemini 3.5 Pro", 2097152, "gemini", 512000);
  addModel(catalog, "hydrogen", "Gemini 4 Hydrogen", 1048576, "gemini", 512000);
  addModel(catalog, "argon", "Gemini 4 Argon", 1048576, "gemini", 512000);
  addModel(catalog, "carbon", "Gemini 4 Carbon", 1048576, "gemini", 512000);
  addModel(catalog, "neon", "Gemini 4 Neon", 1048576, "gemini", 512000);

  // Anthropic Claude 5.5 Series (200k standard -> 160k, 1M with -1m -> 512k)
  for (const [family, label] of [
    ["opus", "Claude Opus 5.5"],
    ["sonnet", "Claude Sonnet 5.5"]
  ]) {
    addTieredModels(catalog, `claude-${family}-5-5`, label, 200000, "thirdParty", CLAUDE_5_5_TIERS, 160000);
    addModel(catalog, `claude-${family}-5-5-1m`, `${label} (1M)`, 1000000, "thirdParty", 512000);
    addTieredModels(catalog, `claude-5-5-${family}`, label, 200000, "thirdParty", CLAUDE_5_5_TIERS, 160000);
    addModel(catalog, `claude-5-5-${family}-1m`, `${label} (1M)`, 1000000, "thirdParty", 512000);
  }

  // Anthropic Claude 4.x Series (200k)
  for (const [ver, family, label] of [
    ["4-8", "opus", "Claude Opus 4.8"],
    ["4-6", "sonnet", "Claude Sonnet 4.6"],
    ["4-6", "opus", "Claude Opus 4.6"],
    ["4-5", "sonnet", "Claude Sonnet 4.5"],
    ["4-5", "opus", "Claude Opus 4.5"],
    ["4-5", "haiku", "Claude Haiku 4.5"]
  ]) {
    addModel(catalog, `claude-${family}-${ver}`, label, 200000, "thirdParty");
    addModel(catalog, `claude-${ver}-${family}`, label, 200000, "thirdParty");
  }
  addModel(catalog, "claude-sonnet-4", "Claude Sonnet 4", 200000, "thirdParty");
  addModel(catalog, "claude-4-sonnet", "Claude Sonnet 4", 200000, "thirdParty");
  addModel(catalog, "claude-sonnet-4-0", "Claude Sonnet 4", 200000, "thirdParty");

  // Anthropic Claude 3.x Series (200k)
  for (const [ver, family, label] of [
    ["3-7", "sonnet", "Claude 3.7 Sonnet"],
    ["3-5", "sonnet", "Claude 3.5 Sonnet"],
    ["3-5", "haiku", "Claude 3.5 Haiku"]
  ]) {
    addModel(catalog, `claude-${ver}-${family}`, label, 200000, "thirdParty");
    addModel(catalog, `claude-${family}-${ver}`, label, 200000, "thirdParty");
  }
  addModel(catalog, "claude-3-opus", "Claude 3 Opus", 200000, "thirdParty");
  addModel(catalog, "claude-opus-3", "Claude 3 Opus", 200000, "thirdParty");
  addModel(catalog, "claude-3-haiku", "Claude 3 Haiku", 200000, "thirdParty");
  addModel(catalog, "claude-haiku-3", "Claude 3 Haiku", 200000, "thirdParty");

  // OpenAI GPT-5, GPT-4.1, GPT-4.5, GPT-4o, o-series & GPT-OSS
  addModel(catalog, "gpt-5.2", "GPT-5.2", 400000, "thirdParty");
  addModel(catalog, "gpt-5.1", "GPT-5.1", 400000, "thirdParty");
  addModel(catalog, "gpt-5", "GPT-5", 400000, "thirdParty");
  addModel(catalog, "gpt-5-mini", "GPT-5 Mini", 400000, "thirdParty");
  addModel(catalog, "gpt-5-nano", "GPT-5 Nano", 400000, "thirdParty");
  addModel(catalog, "gpt-5-codex", "GPT-5 Codex", 400000, "thirdParty");

  addModel(catalog, "gpt-4.1", "GPT-4.1", 1047576, "thirdParty");
  addModel(catalog, "gpt-4.1-mini", "GPT-4.1 Mini", 1047576, "thirdParty");
  addModel(catalog, "gpt-4.1-nano", "GPT-4.1 Nano", 1047576, "thirdParty");

  addModel(catalog, "gpt-4.5", "GPT-4.5", 128000, "thirdParty");
  addModel(catalog, "gpt-4.5-preview", "GPT-4.5", 128000, "thirdParty");
  addModel(catalog, "gpt-4o", "GPT-4o", 128000, "thirdParty");
  addModel(catalog, "gpt-4o-mini", "GPT-4o Mini", 128000, "thirdParty");
  addModel(catalog, "gpt-4-turbo", "GPT-4 Turbo", 128000, "thirdParty");

  addModel(catalog, "o4-mini", "OpenAI o4 Mini", 200000, "thirdParty");
  addModel(catalog, "openai-o4-mini", "OpenAI o4 Mini", 200000, "thirdParty");
  addModel(catalog, "o3-pro", "OpenAI o3 Pro", 200000, "thirdParty");
  addModel(catalog, "openai-o3-pro", "OpenAI o3 Pro", 200000, "thirdParty");
  addModel(catalog, "o3", "OpenAI o3", 200000, "thirdParty");
  addModel(catalog, "openai-o3", "OpenAI o3", 200000, "thirdParty");
  addModel(catalog, "o3-mini", "OpenAI o3 Mini", 200000, "thirdParty");
  addModel(catalog, "openai-o3-mini", "OpenAI o3 Mini", 200000, "thirdParty");
  addModel(catalog, "o1", "OpenAI o1", 128000, "thirdParty");
  addModel(catalog, "openai-o1", "OpenAI o1", 128000, "thirdParty");
  addModel(catalog, "o1-preview", "OpenAI o1 Preview", 128000, "thirdParty");
  addModel(catalog, "o1-mini", "OpenAI o1 Mini", 128000, "thirdParty");

  addModel(catalog, "gpt-oss-120b", "GPT-OSS 120B", 128000, "thirdParty", 80000);
  addModel(catalog, "gpt-oss-120b-maas", "GPT-OSS 120B", 128000, "thirdParty", 80000);
  addModel(catalog, "openai/gpt-oss-120b-maas", "GPT-OSS 120B", 128000, "thirdParty", 80000);
  addModel(catalog, "openai-gpt-oss-120b-maas", "GPT-OSS 120B", 128000, "thirdParty", 80000);

  addModel(catalog, "gpt-oss-20b", "GPT-OSS 20B", 128000, "thirdParty");
  addModel(catalog, "gpt-oss-20b-maas", "GPT-OSS 20B", 128000, "thirdParty");
  addModel(catalog, "openai/gpt-oss-20b-maas", "GPT-OSS 20B", 128000, "thirdParty");
  addModel(catalog, "openai-gpt-oss-20b-maas", "GPT-OSS 20B", 128000, "thirdParty");

  // DeepSeek & xAI Grok
  addModel(catalog, "deepseek-r1", "DeepSeek R1", 128000, "thirdParty");
  addModel(catalog, "deepseek-v3", "DeepSeek V3", 128000, "thirdParty");
  addModel(catalog, "deepseek-v3.1", "DeepSeek V3.1", 128000, "thirdParty");
  addModel(catalog, "deepseek-v3.2", "DeepSeek V3.2", 128000, "thirdParty");
  addModel(catalog, "deepseek-reasoner", "DeepSeek Reasoner", 128000, "thirdParty");
  addModel(catalog, "deepseek-chat", "DeepSeek Chat", 128000, "thirdParty");

  addModel(catalog, "grok-4", "Grok 4", 256000, "thirdParty");
  addModel(catalog, "grok-3", "Grok 3", 131072, "thirdParty");
  addModel(catalog, "grok-3-mini", "Grok 3 Mini", 131072, "thirdParty");
  addModel(catalog, "grok-2", "Grok 2", 131072, "thirdParty");

  return Object.freeze(catalog);
}

export const MODEL_CATALOG = buildCatalog();
