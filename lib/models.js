/**
 * Model Context Window Catalog and Normalization Utilities.
 * Provides context window limits, human-readable names, and group classification.
 */

export const DEFAULT_CONTEXT_WINDOW = 1048576; // 1,048,576 tokens (1M default)

export const MODEL_CATALOG = Object.freeze({
  // Google Gemini Models
  "gemini-3.8-flash-high": { name: "Gemini 3.8 Flash (High)", maxTokens: 1048576, group: "gemini" },
  "gemini-3-8-flash-high": { name: "Gemini 3.8 Flash (High)", maxTokens: 1048576, group: "gemini" },
  "gemini-3.8-flash-low": { name: "Gemini 3.8 Flash (Low)", maxTokens: 1048576, group: "gemini" },
  "gemini-3-8-flash-low": { name: "Gemini 3.8 Flash (Low)", maxTokens: 1048576, group: "gemini" },
  "gemini-3.8-flash-tiered": { name: "Gemini 3.8 Flash (Tiered)", maxTokens: 1048576, group: "gemini" },
  "gemini-3-8-flash-tiered": { name: "Gemini 3.8 Flash (Tiered)", maxTokens: 1048576, group: "gemini" },
  "gemini-3.8-flash": { name: "Gemini 3.8 Flash", maxTokens: 1048576, group: "gemini" },
  "gemini-3-8-flash": { name: "Gemini 3.8 Flash", maxTokens: 1048576, group: "gemini" },
  "gemini-3.5-pro": { name: "Gemini 3.5 Pro", maxTokens: 2097152, group: "gemini" },
  "gemini-3-5-pro": { name: "Gemini 3.5 Pro", maxTokens: 2097152, group: "gemini" },
  "gemini-3.5-flash": { name: "Gemini 3.5 Flash", maxTokens: 1048576, group: "gemini" },
  "gemini-3-5-flash": { name: "Gemini 3.5 Flash", maxTokens: 1048576, group: "gemini" },
  "gemini-3.5-flash-lite": { name: "Gemini 3.5 Flash-Lite", maxTokens: 1048576, group: "gemini" },
  "gemini-3-5-flash-lite": { name: "Gemini 3.5 Flash-Lite", maxTokens: 1048576, group: "gemini" },
  "gemini-1.5-pro": { name: "Gemini 1.5 Pro", maxTokens: 2097152, group: "gemini" },
  "gemini-1-5-pro": { name: "Gemini 1.5 Pro", maxTokens: 2097152, group: "gemini" },
  "gemini-1.5-flash": { name: "Gemini 1.5 Flash", maxTokens: 1048576, group: "gemini" },
  "gemini-1-5-flash": { name: "Gemini 1.5 Flash", maxTokens: 1048576, group: "gemini" },
  "flash": { name: "Gemini 3.8 Flash", maxTokens: 1048576, group: "gemini" },
  "flash_lite": { name: "Gemini 3.5 Flash-Lite", maxTokens: 1048576, group: "gemini" },
  "pro": { name: "Gemini 3.5 Pro", maxTokens: 2097152, group: "gemini" },

  // Anthropic Claude Models
  "claude-3-5-sonnet": { name: "Claude 3.5 Sonnet", maxTokens: 200000, group: "thirdParty" },
  "claude-3.5-sonnet": { name: "Claude 3.5 Sonnet", maxTokens: 200000, group: "thirdParty" },
  "claude-sonnet-3.5": { name: "Claude 3.5 Sonnet", maxTokens: 200000, group: "thirdParty" },
  "claude-sonnet-3-5": { name: "Claude 3.5 Sonnet", maxTokens: 200000, group: "thirdParty" },
  "claude-3-7-sonnet": { name: "Claude 3.7 Sonnet", maxTokens: 200000, group: "thirdParty" },
  "claude-3.7-sonnet": { name: "Claude 3.7 Sonnet", maxTokens: 200000, group: "thirdParty" },
  "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", maxTokens: 200000, group: "thirdParty" },
  "claude-sonnet-4.6": { name: "Claude Sonnet 4.6", maxTokens: 200000, group: "thirdParty" },
  "claude-3-opus": { name: "Claude 3 Opus", maxTokens: 200000, group: "thirdParty" },
  "claude-opus-4-6": { name: "Claude Opus 4.6", maxTokens: 200000, group: "thirdParty" },
  "claude-opus-4.6": { name: "Claude Opus 4.6", maxTokens: 200000, group: "thirdParty" },
  "claude-3-haiku": { name: "Claude 3 Haiku", maxTokens: 200000, group: "thirdParty" },
  "claude-3-5-haiku": { name: "Claude 3.5 Haiku", maxTokens: 200000, group: "thirdParty" },
  "claude-3.5-haiku": { name: "Claude 3.5 Haiku", maxTokens: 200000, group: "thirdParty" },

  // OpenAI Models
  "gpt-4o": { name: "GPT-4o", maxTokens: 128000, group: "thirdParty" },
  "gpt-4o-mini": { name: "GPT-4o Mini", maxTokens: 128000, group: "thirdParty" },
  "gpt-4-turbo": { name: "GPT-4 Turbo", maxTokens: 128000, group: "thirdParty" },
  "o1": { name: "OpenAI o1", maxTokens: 128000, group: "thirdParty" },
  "o1-preview": { name: "OpenAI o1 Preview", maxTokens: 128000, group: "thirdParty" },
  "o1-mini": { name: "OpenAI o1 Mini", maxTokens: 128000, group: "thirdParty" },
  "o3-mini": { name: "OpenAI o3 Mini", maxTokens: 200000, group: "thirdParty" },
  "gpt-oss-120b": { name: "GPT-OSS 120B", maxTokens: 128000, group: "thirdParty" },

  // DeepSeek & Open Source Models
  "deepseek-r1": { name: "DeepSeek R1", maxTokens: 128000, group: "thirdParty" },
  "deepseek-v3": { name: "DeepSeek V3", maxTokens: 128000, group: "thirdParty" }
});

/**
 * Normalizes any raw model string, enum, or identifier to catalog match.
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeModelKey(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return "gemini-3.8-flash-high";
  }
  return raw
    .trim()
    .toLowerCase()
    .replace(/[()]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Resolves context window limits for a given model identifier.
 * @param {string} modelIdentifier
 * @returns {number}
 */
export function getModelContextWindow(modelIdentifier) {
  const key = sanitizeModelKey(modelIdentifier);
  if (MODEL_CATALOG[key]) {
    return MODEL_CATALOG[key].maxTokens;
  }

  // Substring / fuzzy pattern matching
  if (key.includes("3-5-pro") || key.includes("3.5-pro") || key.includes("1-5-pro") || key.includes("1.5-pro") || key.includes("pro-2m")) {
    return 2097152;
  }
  if (key.includes("gemini") || key.includes("flash")) {
    return 1048576;
  }
  if (key.includes("claude") || key.includes("sonnet") || key.includes("opus") || key.includes("haiku")) {
    return 200000;
  }
  if (key.includes("gpt-4") || key.includes("o1") || key.includes("deepseek")) {
    return 128000;
  }
  if (key.includes("o3")) {
    return 200000;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Returns formatted human-readable name for a model.
 * @param {string} modelIdentifier
 * @returns {string}
 */
export function normalizeModelName(modelIdentifier) {
  if (typeof modelIdentifier !== "string" || !modelIdentifier.trim()) {
    return "Gemini 3.8 Flash (High)";
  }
  const key = sanitizeModelKey(modelIdentifier);
  if (MODEL_CATALOG[key]) {
    return MODEL_CATALOG[key].name;
  }
  const dotKey = key.replace(/(\d+)-(\d+)/g, "$1.$2");
  if (MODEL_CATALOG[dotKey]) {
    return MODEL_CATALOG[dotKey].name;
  }
  const hyphenKey = key.replace(/(\d+)\.(\d+)/g, "$1-$2");
  if (MODEL_CATALOG[hyphenKey]) {
    return MODEL_CATALOG[hyphenKey].name;
  }
  return modelIdentifier.trim();
}

/**
 * Determines whether the model belongs to the 'gemini' or 'thirdParty' quota group.
 * @param {string} modelIdentifier
 * @returns {"gemini"|"thirdParty"}
 */
export function detectModelGroup(modelIdentifier) {
  if (typeof modelIdentifier !== "string" || !modelIdentifier.trim()) {
    return "gemini";
  }
  const key = sanitizeModelKey(modelIdentifier);
  if (MODEL_CATALOG[key]) {
    return MODEL_CATALOG[key].group;
  }
  if (key.includes("claude") || key.includes("gpt") || key.includes("openai") || key.includes("deepseek") || key.includes("3p")) {
    return "thirdParty";
  }
  return "gemini";
}

/**
 * Formats a raw number of tokens with human-friendly suffixes (k, M).
 * @param {number} tokens
 * @returns {string}
 */
export function formatTokenCount(tokens) {
  if (typeof tokens !== "number" || Number.isNaN(tokens) || !Number.isFinite(tokens) || tokens <= 0) {
    return "0";
  }
  const num = Math.floor(tokens);
  if (num >= 1000000) {
    const m = num / 1000000;
    if (num % 1000000 === 0) return `${m}M`;
    const formatted = m >= 10 ? m.toFixed(1) : m.toFixed(2);
    return `${formatted}M`;
  }
  if (num >= 1000) {
    const k = num / 1000;
    if (num % 1000 === 0) return `${k}k`;
    const formatted = k >= 100 ? k.toFixed(0) : k.toFixed(1);
    return `${formatted}k`;
  }
  return num.toString();
}
