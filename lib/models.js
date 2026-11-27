/**
 * Model Context Window Catalog and Normalization Utilities.
 * Provides context window limits, human-readable names, and group classification.
 */

import {
  MODEL_CATALOG,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_COMPACTION_CAP_TOKENS
} from "./model-catalog.js";

export { MODEL_CATALOG, DEFAULT_CONTEXT_WINDOW, DEFAULT_COMPACTION_CAP_TOKENS };

const FALLBACK_MODEL_KEY = "gemini-3.8-flash-high";
const FALLBACK_MODEL_NAME = "Gemini 3.8 Flash (High)";

/**
 * Looks up a catalog entry using exact, dot-version, and hyphen-version keys.
 * @param {string} key
 * @returns {{ name: string, maxTokens: number, group: "gemini"|"thirdParty" }|null}
 */
function lookupCatalogBase(key) {
  if (!key) return null;
  const candidates = [
    key,
    key.replace(/(\d+)-(\d+)/g, "$1.$2"),
    key.replace(/(\d+)\.(\d+)/g, "$1-$2")
  ];
  for (const candidate of candidates) {
    if (Object.hasOwn(MODEL_CATALOG, candidate)) {
      return MODEL_CATALOG[candidate];
    }
  }
  return null;
}

const O_SERIES_PATTERN = /^(?:openai-)?o[134](?:-|$)/;

/**
 * Returns true when a raw input looks like a CLI/compiler flag (e.g. "-O3", "-o3")
 * or bare uppercase O-token ("O1", "O3", "O4") rather than a valid o-series model ID.
 * @param {*} raw
 * @returns {boolean}
 */
function isDisqualifiedOSeriesInput(raw) {
  if (typeof raw !== "string") return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("-")) return true;
  return /^O[134]$/.test(trimmed);
}

/**
 * Resolves a sanitized key against the catalog, supporting 1M context suffixes,
 * trailing version dates, and vendor prefixes.
 * @param {string} key
 * @param {*} [rawInput]
 * @returns {{ name: string, maxTokens: number, group: "gemini"|"thirdParty" }|null}
 */
function resolveCatalogEntry(key, rawInput = null) {
  if (isDisqualifiedOSeriesInput(rawInput) && O_SERIES_PATTERN.test(key)) {
    return null;
  }

  const direct = lookupCatalogBase(key);
  if (direct) return direct;

  if (key.endsWith("-1m") || key.includes("-1m-")) {
    const without1m = key.endsWith("-1m") ? key.slice(0, -3) : key.replace("-1m-", "-");
    const baseEntry = resolveCatalogEntry(without1m, rawInput);
    if (baseEntry) {
      return {
        name: baseEntry.name.includes("(1M)") ? baseEntry.name : `${baseEntry.name} (1M)`,
        maxTokens: 1000000,
        compactionTokens: DEFAULT_COMPACTION_CAP_TOKENS,
        group: baseEntry.group
      };
    }
  }

  const noDate = key.replace(/-(?:\d{8}|\d{4}-\d{2}-\d{2})$/, "");
  if (noDate !== key) {
    const dateStripped = resolveCatalogEntry(noDate, rawInput);
    if (dateStripped) return dateStripped;
  }

  const noVendor = noDate.replace(/^(?:openai|anthropic|google|xai|x-ai)-/, "");
  if (noVendor !== noDate) {
    const vendorStripped = resolveCatalogEntry(noVendor, rawInput);
    if (vendorStripped) return vendorStripped;
  }

  const noMaas = noVendor.replace(/-maas$/, "");
  if (noMaas !== noVendor) {
    return resolveCatalogEntry(noMaas, rawInput);
  }

  return null;
}

/**
 * Normalizes any raw model string, enum, or identifier to catalog match.
 * @param {string} raw
 * @returns {string}
 */
export function sanitizeModelKey(raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    return FALLBACK_MODEL_KEY;
  }
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/@[a-z0-9._-]+$/i, "")
    .replace(/[()]/g, "")
    .replace(/[\s_/]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  return cleaned || FALLBACK_MODEL_KEY;
}

/**
 * Resolves context window limits for a given model identifier.
 * @param {string} modelIdentifier
 * @returns {number}
 */
export function getModelContextWindow(modelIdentifier) {
  const key = sanitizeModelKey(modelIdentifier);
  const entry = resolveCatalogEntry(key, modelIdentifier);
  if (entry) {
    return entry.maxTokens;
  }

  const disqualifiedOSeries = isDisqualifiedOSeriesInput(modelIdentifier);

  // Substring / fuzzy pattern matching
  if (key.includes("3-5-pro") || key.includes("3.5-pro") || key.includes("1-5-pro") || key.includes("1.5-pro") || key.includes("pro-2m")) {
    return 2097152;
  }
  if (
    key.includes("gemini") ||
    key.includes("flash") ||
    key.includes("hydrogen") ||
    key.includes("argon") ||
    key.includes("carbon") ||
    key.includes("neon")
  ) {
    return 1048576;
  }
  if (key.includes("claude") || key.includes("sonnet") || key.includes("opus") || key.includes("haiku")) {
    return /(?:^|-)1m(?:-|$)/.test(key) ? 1000000 : 200000;
  }
  if (/gpt-4[.-]1(?:-|$)/.test(key)) {
    return 1047576;
  }
  if (/(?:^|-)gpt-5(?:[.-]|$)/.test(key)) {
    return 400000;
  }
  if (
    key.includes("gpt-4") ||
    key.includes("gpt-oss") ||
    (!disqualifiedOSeries && /^(?:openai-)?o1(?:-|$)/.test(key)) ||
    key.includes("deepseek")
  ) {
    return 128000;
  }
  if (!disqualifiedOSeries && /^(?:openai-)?o[34](?:-|$)/.test(key)) {
    return 200000;
  }
  if (/(?:^|-)grok-4(?:-|$)/.test(key)) {
    return 256000;
  }
  if (key.includes("grok")) {
    return 131072;
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Resolves Antigravity's checkpointer compaction threshold (in tokens) for a model.
 * Antigravity triggers CORTEX_STEP_TYPE_CHECKPOINT per model checkpointer max_token_limit
 * rather than 80% of full 1M/2M context windows.
 * @param {string} modelIdentifier
 * @returns {number}
 */
export function getModelCompactionThreshold(modelIdentifier) {
  const key = sanitizeModelKey(modelIdentifier);
  const entry = resolveCatalogEntry(key, modelIdentifier);
  if (entry && Number.isFinite(entry.compactionTokens) && entry.compactionTokens > 0) {
    return entry.compactionTokens;
  }

  if (/gemini-4(?:[.-]|$)|(?:^|-)(?:hydrogen|argon|carbon|neon)(?:-|$)/.test(key)) {
    return 512000;
  }
  if (/gemini-3(?:[.-]\d+)?-flash|(?:^|-)flash(?:-|$)/.test(key) && !/gemini-[12][.-]5/.test(key)) {
    return 256000;
  }
  if (/gemini-2[.-]5/.test(key)) {
    return 128000;
  }
  if (/gpt-oss-120b/.test(key)) {
    return 80000;
  }
  if (key.includes("claude") || key.includes("sonnet") || key.includes("opus") || key.includes("haiku")) {
    return /(?:^|-)1m(?:-|$)/.test(key) ? DEFAULT_COMPACTION_CAP_TOKENS : 160000;
  }

  const maxTokens = getModelContextWindow(modelIdentifier);
  return Math.min(DEFAULT_COMPACTION_CAP_TOKENS, Math.round(maxTokens * 0.80));
}

/**
 * Returns true when a model identifier resolves to a known catalog entry.
 * @param {*} modelIdentifier
 * @returns {boolean}
 */
export function hasCatalogMatch(modelIdentifier) {
  if (typeof modelIdentifier !== "string" || !modelIdentifier.trim()) {
    return false;
  }
  const key = sanitizeModelKey(modelIdentifier);
  return resolveCatalogEntry(key, modelIdentifier) !== null;
}

/**
 * Returns formatted human-readable name for a model.
 * @param {string} modelIdentifier
 * @returns {string}
 */
export function normalizeModelName(modelIdentifier) {
  if (typeof modelIdentifier !== "string" || !modelIdentifier.trim()) {
    return FALLBACK_MODEL_NAME;
  }
  const key = sanitizeModelKey(modelIdentifier);
  const entry = resolveCatalogEntry(key, modelIdentifier);
  if (entry) {
    return entry.name;
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
  const entry = resolveCatalogEntry(key, modelIdentifier);
  if (entry) {
    return entry.group;
  }
  const disqualifiedOSeries = isDisqualifiedOSeriesInput(modelIdentifier);
  if (
    key.includes("claude") ||
    key.includes("anthropic") ||
    key.includes("sonnet") ||
    key.includes("opus") ||
    key.includes("haiku") ||
    key.includes("gpt") ||
    key.includes("openai") ||
    key.includes("deepseek") ||
    key.includes("grok") ||
    key.includes("3p") ||
    (!disqualifiedOSeries && O_SERIES_PATTERN.test(key))
  ) {
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
