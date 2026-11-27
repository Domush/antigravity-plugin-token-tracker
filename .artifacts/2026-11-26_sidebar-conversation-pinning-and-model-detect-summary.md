# Summary: Sidebar Conversation Pinning, Model Detection, Compaction Headroom & PreInvocation Cooldown

**Date:** 2026-11-26
**Package Version:** `1.0.0` (unchanged)

---

## Created & Modified Files

- `lib/compaction.js` (Created, 108 lines): Model-aware active-context compaction calculator (`DEFAULT_COMPACTION_TRIGGER_RATIO = 0.80`, `validatePositiveThresholdInteger`, `resolveCompactionThreshold`, `buildCompactionMetrics`).
- `lib/model-detector.js` (Created, 155 lines): Extracted `Uint8Array`-safe decoding (`toLatin1Text`), `stripMonitorConfigOverrides`, `extractStrippedTrailer`, and two-pass end-offset-aware `extractModelIdentifier`.
- `lib/conversation-tracker.js` (Modified, 402 lines): Added path-containment + `{ strict }` conversation lookup in `resolveConversationDbPath`/`getConversationMetrics`, `isSubagentPayload`, `gen_metadata` trailer-first model extraction, and active-context compaction evaluation.
- `lib/model-catalog.js` (Modified, 212 lines): Added `gemini-4-{hydrogen,argon,carbon,neon}-tiered-{low,medium,high,xhigh}` entries.
- `lib/telemetry-server.js` (Modified, 313 lines): Added `isPinnedConversation` isolation, strict query/pin enforcement, bounded POST body (`64 KB`), and async HTTP `try/catch`.
- `sidecars/dashboard/index.html` (Modified, 334 lines): Loaded `/preload.js`, pinned fetches with `?conversationId=` via `window.sidecar?.fetch || fetch`, and displayed active-context token + KB compaction headroom.
- `sidecars/dashboard/server.mjs` (Modified, 290 lines): Enforced strict explicit `conversationId` lookups, dynamic `os.homedir()` `sidecar_sdk` resolution, standalone `/preload.js` route, port validation, and outer HTTP `try/catch`.
- `injector/status-bar.js` (Modified, 410 lines): Added `pill.isConnected && inputBox.contains(pill)` check and active-context token + KB compaction display.
- `hooks/pre-invocation.js` (Modified, 233 lines): Added strict `{ strict: Boolean(convId) }` lookup, `!isSubagentPayload` guard, active-context advisory formatting, and per-conversation deduplication with 2-minute cooldown (`ADVISORY_COOLDOWN_MS = 120000`), minimal-change suppression (`MIN_PERCENT_DELTA = 5`, `MIN_KB_DELTA = 32`), critical threshold override (`>= 95%`), clock-skew guard, and safe `advisories/<safeConvId>.json` persistence.
- `hooks/session-start.js` (Modified, 164 lines): Added `{ strict: Boolean(convId) }`, `!isSubagentPayload` guard, `console.error` diagnostics, and active-context compaction status formatting.
- `README.md` (Modified, 158 lines): Updated compaction feature description and Architecture Overview (`lib/compaction.js`, `lib/model-detector.js`).

---

## Verification Status

- **Static Audit Gate (`node scripts/audit-gate.js`):** `GATE VERDICT: PASS` (29 files, 0 errors, 0 warnings).
- **Syntax Check (`node --check`):** Passed on all 24 `.js`/`.mjs` files (exit 0).
- **Adversarial Audit (`@team-auditor`):** `VERDICT: PASS` across all 11 modified/created files.
- **Live Plugin Directory (`C:\Users\domus\.gemini\config\plugins\antigravity-plugin-token-tracker`):** Updated via `node bin/cli.js install`.
- **Tests / QA:** Not executed per user instruction (`"just do the code and audit, no tests or QA"`).
