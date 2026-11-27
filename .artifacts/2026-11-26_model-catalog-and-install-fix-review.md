# Review: Model Catalog Update & Junction-Safe Plugin Installation

**Date:** 2026-11-26
**Verdict:** PASS (All P0/P1 findings remediated and verified across independent audit passes and QA)

---

## Audit & QA Trail

1. **Stage 2 Adversarial Code Audit (Pass 1 — REJECT):**
   - `bin/cli.js:89-90, 145-146`: `fs.rmSync` on Windows left broken junctions and broken directory symlinks intact on disk; subdirectory symlinks under `targetDir` also risked `ERR_FS_CP_DIR_TO_NON_DIR`.
   - `lib/conversation-tracker.js:152`: Case-insensitive `/\bo[134]\b/i` caused false positives on compiler flags (`-O3`) and uppercase tokens (`O1`, `O3`, `O4`); missing `gemini-2.0` and generic Gemini fallback.
   - `lib/conversation-tracker.js:134-160`: Trailing punctuation capture on IDs/`@tag`, single-parenthetical truncation on `"Claude Opus 5.5 (High) (1M)"`, missing `@tag` on Gemini/GPT patterns.
   - `lib/model-catalog.js:98, 106-110` & `lib/models.js:44-70`: Unreachable `flash_lite` key, missing reversed Claude 5.5 aliases, `-maas` recursive chaining, and mid-key `-1m-` handling.
   - `lib/conversation-tracker.js:54-55`: Missing fail-fast validation for `compactionThresholdBytes` / `ANTIGRAVITY_COMPACTION_THRESHOLD_BYTES`.

2. **Stage 2 Adversarial Code Audit (Pass 2 — PASS):**
   - Verified all 5 Stage 2 findings remediated cleanly (`lstatOrNull` + `removeSymlinkOrJunction`, strict lowercase boundary-checked `o[134]`, tightened ID/parenthetical regexes, catalog symmetry, and `resolveCompactionThreshold` validation).

3. **Stage 3b Test Suite Audit (Pass 1 — REJECT) & Pass 2 (`lib/models.js` + Tests — REJECT):**
   - Remediated host isolation (`--path` + synthetic `app.asar` + isolated `HOME`/`USERPROFILE`), `DatabaseSync` `try/finally` handle closure, `fs.mkdtempSync` temp dirs, decomposed `tests/test_conversation_tracker_sqlite.js` and `tests/test_cli_symlinks.js`, and added `Object.hasOwn(MODEL_CATALOG, ...)` prototype-lookup guard (`lib/models.js:18-31`) plus `o[134]`/`-O3`/`foo-o3`/`constructor` assertions.

4. **Stage 3b + `lib/models.js` Audit (Pass 3 — PASS) & Stage 4 QA Execution (PASS):**
   - `npm test`: **61 passed, 0 failed, 0 skipped** across 7 test suites (`Logs/test-results.log`).
   - `npm run audit-gate`: **27 project file(s), 0 errors, 0 warnings, `GATE VERDICT: PASS`** (`Logs/audit-gate.log`).
   - `node bin/cli.js install`: Replaced live junction at `C:\Users\domus\.gemini\config\plugins\antigravity-plugin-token-tracker` with a real copied directory (`LinkType` empty, 18 files deployed).

---

## Next Steps

- Run `npm login` (if not already authenticated) and `npm publish` when ready to publish `v1.0.0` to npm, or push a `v1.0.0` tag to trigger `.github/workflows/publish.yml`.
- Restart or reload Antigravity to ensure the updated copied plugin files are loaded across all active sessions.
