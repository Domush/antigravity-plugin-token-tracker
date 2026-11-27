# Summary: Model Catalog Update & Junction-Safe Plugin Installation

**Date:** 2026-11-26
**Package Version:** `1.0.0` (unchanged in `package.json` and `plugin.json`)

---

## Created & Modified Files

- `lib/model-catalog.js` (Created, 204 lines): Immutable `MODEL_CATALOG` and `DEFAULT_CONTEXT_WINDOW` covering:
  - Google Gemini 4 (`Hydrogen`, `Argon`, `Carbon`, `Neon` across tiers), Gemini 3.8 / 3.7 / 3.6 / 3.5 / 3.1 / 3 / 2.5 / 1.5, and short aliases (`flash`, `flash-lite`, `flash_lite`, `pro`, `hydrogen`, `argon`, `carbon`, `neon`).
  - Anthropic Claude 5.5 (`Opus` & `Sonnet` with `-low`, `-medium`, `-high`, `-max`, `-1m`, and reversed `claude-5-5-*` aliases), Claude 4.8 / 4.6 / 4.5 / 4, and Claude 3.7 / 3.5 / 3.
  - OpenAI `GPT-5` / `5.1` / `5.2` / `Mini` / `Nano` / `Codex`, `GPT-4.1` / `4.5` / `4o` / `4-turbo`, `o4-mini`, `o3` / `o3-pro` / `o3-mini`, `o1`, and `GPT-OSS 120B` / `20B` (`openai/gpt-oss-*-maas`).
  - DeepSeek (`R1`, `V3`, `V3.1`, `V3.2`, `Reasoner`, `Chat`) and xAI Grok (`Grok 4`, `Grok 3`, `Grok 3 Mini`, `Grok 2`).
- `lib/models.js` (Modified, 248 lines): Updated `sanitizeModelKey`, `lookupCatalogBase` (`Object.hasOwn` guarded), `resolveCatalogEntry` (`-1m`, dates, vendor prefixes, `-maas`), `getModelContextWindow`, `normalizeModelName`, and `detectModelGroup` (including strict `O_SERIES_PATTERN` / `isDisqualifiedOSeriesInput` guards).
- `lib/conversation-tracker.js` (Modified, 353 lines): Updated `extractModelIdentifier` for all current model IDs and multi-parenthetical display names with strict `o[134]` boundaries and trailing punctuation exclusion, plus fail-fast `resolveCompactionThreshold` validation.
- `bin/cli.js` (Modified, 394 lines): Added `lstatOrNull` and `removeSymlinkOrJunction` (`unlinkSync` with `rmdirSync` fallback) in `installPlugin` and `uninstallPlugin` to cleanly replace or remove active and broken Windows junctions/symlinks and guard against same-realpath collisions.
- `README.md` (Modified, 156 lines): Updated supported model summary, architecture tree (`lib/model-catalog.js`), and Quick Install note clarifying copied directory installation.
- `tests/test_models.js` (Modified, 441 lines), `tests/test_conversation_tracker.js` (Modified, 201 lines), `tests/test_conversation_tracker_sqlite.js` (Created, 320 lines), `tests/test_cli.js` (Modified, 380 lines), `tests/test_cli_symlinks.js` (Created, 150 lines): Comprehensive unit, boundary, negative-path, SQLite, and Windows junction/symlink replacement test suites.

---

## Verification & Environment State

- `npm test`: **61 passed, 0 failed, 0 skipped** (`Logs/test-results.log`).
- `npm run audit-gate`: **27 project file(s) validated, 0 errors, 0 warnings (`GATE VERDICT: PASS`)** (`Logs/audit-gate.log`).
- `npm pack --dry-run`: Exited 0 (`19` files, `34.0 kB` tarball).
- Live Plugin Directory (`C:\Users\domus\.gemini\config\plugins\antigravity-plugin-token-tracker`): Reinstalled via `node bin/cli.js install` as a standard directory (`LinkType` empty, 18 files copied, replacing the prior Windows Junction).
