# Review: Sidebar Conversation Pinning, Model Detection, Compaction Headroom & PreInvocation Cooldown

**Date:** 2026-11-26
**Scope:** Code + Adversarial Audit (`With Audit` — tests and QA omitted per user instruction)
**Verdict:** PASS

---

## Audit Trail

1. **Pass 1 (Sidebar Pinning & Model Detection — REJECT):**
   - Identified path traversal / `strict` empty-ID bypass in `lib/conversation-tracker.js`, hardcoded developer path in `sidecars/dashboard/server.mjs`, `Uint8Array` & fallback precedence in `extractModelIdentifier`, `isSubagentPayload` 1-arg/`sessionId` gaps, `console.debug` stdout corruption in `hooks/session-start.js`, trailer override stripping edge cases, and whitespace/CORS/formatting inconsistencies.
2. **Pass 2 (Combined with Model-Aware Compaction Headroom & PreInvocation Cooldown — REJECT):**
   - Identified `DEF-01` (non-strict lookup in hooks), `DEF-02` (`TelemetryServer` `isPinnedConversation` overwrite), `DEF-03` (`findPatternMatch` `preferLast` inner-substring overwrite), `DEF-04` (`buildCompactionMetrics` validation), `DEF-05` (async HTTP `try/catch`, port validation, bounded POST body), `DEF-06` (`extractStrippedTrailer` bounds), `DEF-07` (backwards clock skew in cooldown), `DEF-08` (`pill.isConnected` detached-DOM check), and `DEF-09` (`README.md` directory tree).
3. **Pass 3 (Verification Pass 2 across all 11 files — PASS):**
   - Verified all 9 findings remediated cleanly (`lib/compaction.js` extracted, all files under 500 lines, `node --check` exit 0 on 24 `.js`/`.mjs` files, `node scripts/audit-gate.js` `GATE VERDICT: PASS` across 29 project files, `package.json` and `plugin.json` unchanged at `v1.0.0`).

---

## Next Steps

- Run `npm test` when ready to update/verify unit and integration tests for the new compaction headroom defaults, strict lookup behavior, and `PreInvocation` cooldown/deduplication rules.
- Re-enable the plugin in Antigravity (the latest audited files are already copied to `C:\Users\domus\.gemini\config\plugins\antigravity-plugin-token-tracker`).
