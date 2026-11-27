/**
 * Binary & Text Model Identifier Detection.
 * Decodes SQLite BLOB/text payloads cleanly and identifies active LLM models
 * while ignoring monitor override configuration strings.
 */

const SPECIFIC_MODEL_PATTERNS = [
  // Google Gemini 4 & 3.x / 2.x / 1.5 IDs
  /gemini-4-(?:hydrogen|argon|carbon|neon)(?:-(?:orchestrator|xhigh|medium|sonar|high|low)|-[a-z0-9_-]*[a-z0-9])?(?:@[a-z0-9._-]*[a-z0-9])?/i,
  /gemini-(?:3[.-][0-9]|3|2[.-][05]|1[.-]5)-(?:flash-lite|flash|pro|ultra)(?:-[a-z0-9_-]*[a-z0-9])?(?:@[a-z0-9._-]*[a-z0-9])?/i,
  // Google Gemini Display Names
  /Gemini\s+4\s+(?:Hydrogen|Argon|Carbon|Neon)(?:\s*\([A-Za-z0-9\s-]+\))*/i,
  /Gemini\s+(?:3\.[0-9]|3|2\.[05]|1\.5)\s+(?:Flash-Lite|Flash\s+Lite|Flash|Pro|Ultra)(?:\s+Preview)?(?:\s*\([A-Za-z0-9\s-]+\))*/i,
  // Anthropic Claude Specific IDs & Display Names
  /claude-(?:opus|sonnet|haiku)-(?:5[.-]5|4[.-][0-9]|4|3[.-][0-9]|3)(?:-[a-z0-9_-]*[a-z0-9])?(?:@[a-z0-9._-]*[a-z0-9])?/i,
  /claude-(?:5[.-]5|4[.-][0-9]|4|3[.-][0-9]|3)-(?:opus|sonnet|haiku)(?:-[a-z0-9_-]*[a-z0-9])?(?:@[a-z0-9._-]*[a-z0-9])?/i,
  /Claude\s+(?:Opus|Sonnet|Haiku)\s+(?:5\.5|4\.[0-9]|4|3\.[0-9]|3)(?:\s*\([A-Za-z0-9\s-]+\))*/i,
  /Claude\s+(?:5\.5|4\.[0-9]|4|3\.[0-9]|3)\s+(?:Opus|Sonnet|Haiku)(?:\s*\([A-Za-z0-9\s-]+\))*/i,
  // OpenAI GPT-OSS & GPT-5 / GPT-4.x / GPT-4o
  /openai\/gpt-oss-(?:120b|20b)(?:-[a-z0-9_-]*[a-z0-9])?(?:@[a-z0-9._-]*[a-z0-9])?/i,
  /gpt-oss-(?:120b|20b)(?:-[a-z0-9_-]*[a-z0-9])?(?:@[a-z0-9._-]*[a-z0-9])?/i,
  /GPT-OSS\s+(?:120B|20B)/i,
  /gpt-(?:5(?:\.[0-9]+)?|4[.-]5|4[.-]1|4o|4)(?:-[a-z0-9_-]*[a-z0-9])*(?:@[a-z0-9._-]*[a-z0-9])?/i,
  /GPT-(?:5(?:\.[0-9]+)?|4\.5|4\.1|4o|4)(?:\s+(?:Mini|Nano|Codex|Turbo))?/i,
  // OpenAI o-series
  /OpenAI\s+o[134](?:\s+(?:Pro|Mini|Preview))?/i,
  /\b(?:openai[-\s]+)?o[134]-(?:pro|mini|preview)(?:-[a-z0-9_-]*[a-z0-9])*(?:@[a-z0-9._-]*[a-z0-9])?/i,
  /\bopenai[-\s]+o[134]\b/i,
  /(?<![A-Za-z0-9_.-])o[134](?![A-Za-z0-9_.-])/,
  // DeepSeek
  /deepseek-(?:r1|v3(?:\.[0-9]+)?|reasoner|chat)(?:-[a-z0-9_-]*[a-z0-9])*(?:@[a-z0-9._-]*[a-z0-9])?/i,
  /DeepSeek\s+(?:R1|V3(?:\.[0-9]+)?|Reasoner|Chat)/i,
  // xAI Grok
  /grok-(?:4|3|2)(?:-[a-z0-9_-]*[a-z0-9])*(?:@[a-z0-9._-]*[a-z0-9])?/i,
  /Grok\s+(?:4|3|2)(?:\s+Mini)?/i
];

const GENERIC_MODEL_PATTERNS = [
  /gemini-[a-z0-9_.-]*[a-z0-9](?:@[a-z0-9._-]*[a-z0-9])?/i,
  /claude-[a-z0-9_.-]*[a-z0-9](?:@[a-z0-9._-]*[a-z0-9])?/i,
  /gpt-[a-z0-9_.-]*[a-z0-9](?:@[a-z0-9._-]*[a-z0-9])?/i,
  /deepseek-[a-z0-9_.-]*[a-z0-9](?:@[a-z0-9._-]*[a-z0-9])?/i,
  /grok-[a-z0-9_.-]*[a-z0-9](?:@[a-z0-9._-]*[a-z0-9])?/i
];

/**
 * Converts a string, Buffer, or Uint8Array to a latin1 string.
 * @param {Buffer|Uint8Array|string} bufferOrStr
 * @returns {string}
 */
export function toLatin1Text(bufferOrStr) {
  if (typeof bufferOrStr === "string") {
    return bufferOrStr;
  }
  if (Buffer.isBuffer(bufferOrStr)) {
    return bufferOrStr.toString("latin1");
  }
  if (bufferOrStr instanceof Uint8Array) {
    return Buffer.from(bufferOrStr.buffer, bufferOrStr.byteOffset, bufferOrStr.byteLength).toString("latin1");
  }
  throw new TypeError("Expected string, Buffer, or Uint8Array for payload decoding.");
}

/**
 * Strips monitor configuration override strings so they do not mask the active model.
 * Supports unquoted, double-quoted, and single-quoted keys and values.
 * @param {Buffer|Uint8Array|string} bufferOrStr
 * @returns {string}
 */
export function stripMonitorConfigOverrides(bufferOrStr) {
  const text = toLatin1Text(bufferOrStr);
  return text.replace(/["']?model_name_override["']?\s*:\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi, " ");
}

function validateNonNegativeInt(value, name) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new TypeError(`${name} must be a non-negative finite integer.`);
  }
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite integer (received ${value}).`);
  }
  return value;
}

/**
 * Strips monitor overrides across a padded tail window before slicing the trailer,
 * preventing boundary-straddling overrides from leaving unmasked model names.
 * @param {Buffer|Uint8Array|string} bufferOrStr
 * @param {number} [trailerBytes=2048]
 * @param {number} [paddingBytes=256]
 * @returns {string}
 */
export function extractStrippedTrailer(bufferOrStr, trailerBytes = 2048, paddingBytes = 256) {
  const safeTrailerBytes = validateNonNegativeInt(trailerBytes, "trailerBytes");
  const safePaddingBytes = validateNonNegativeInt(paddingBytes, "paddingBytes");
  if (safeTrailerBytes === 0) {
    return "";
  }
  const buf = Buffer.isBuffer(bufferOrStr)
    ? bufferOrStr
    : bufferOrStr instanceof Uint8Array
      ? Buffer.from(bufferOrStr.buffer, bufferOrStr.byteOffset, bufferOrStr.byteLength)
      : Buffer.from(toLatin1Text(bufferOrStr), "latin1");
  const windowSize = safeTrailerBytes + safePaddingBytes;
  const tailWindow = buf.length > windowSize ? buf.subarray(buf.length - windowSize) : buf;
  const stripped = stripMonitorConfigOverrides(tailWindow);
  return stripped.length > safeTrailerBytes ? stripped.slice(-safeTrailerBytes) : stripped;
}

function findPatternMatch(text, patterns, preferLast) {
  if (!preferLast) {
    for (const pat of patterns) {
      const match = text.match(pat);
      if (match) {
        return match[0];
      }
    }
    return null;
  }

  let best = null;
  let bestEnd = -1;
  for (const pat of patterns) {
    const flags = pat.flags.includes("g") ? pat.flags : `${pat.flags}g`;
    const globalPat = new RegExp(pat.source, flags);
    for (const match of text.matchAll(globalPat)) {
      const matchEnd = match.index + match[0].length;
      if (
        !best ||
        matchEnd > bestEnd ||
        (matchEnd === bestEnd && match[0].length > best.text.length)
      ) {
        best = { index: match.index, text: match[0] };
        bestEnd = matchEnd;
      }
    }
  }
  return best ? best.text : null;
}

/**
 * Scans a buffer, Uint8Array, or string for recognized model names or enums.
 * Runs specific model patterns across all vendors before generic vendor fallbacks.
 * @param {Buffer|Uint8Array|string|null|undefined} bufferOrStr
 * @param {{ preferLast?: boolean }} [options]
 * @returns {string|null}
 */
export function extractModelIdentifier(bufferOrStr, { preferLast = false } = {}) {
  if (bufferOrStr == null) return null;
  const text = toLatin1Text(bufferOrStr);
  return (
    findPatternMatch(text, SPECIFIC_MODEL_PATTERNS, preferLast) ||
    findPatternMatch(text, GENERIC_MODEL_PATTERNS, preferLast)
  );
}
