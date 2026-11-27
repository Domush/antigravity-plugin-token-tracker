# Summary: v1.1.1 Version Bump, CHANGELOG Restoration, Alphabetical Subagent Ordering & 2-Minute Idle Retention

**Date:** 2026-11-27
**Version:** `1.1.1`
**Plans:**
- `.artifacts/2026-11-27_hook-live-model-usage.md`
- `.artifacts/2026-11-27_subagent-ordering-and-idle-lag.md`

---

## Created & Modified Files

### Version Bump (`1.1.1`) & Changelog Restoration
- `package.json` (47 lines) & `plugin.json` (13 lines): Bumped `"version"` from `"1.1.0"` to `"1.1.1"`.
- `CHANGELOG.md` (31 lines): Restored `## [1.1.0] - 2026-11-26` to match published commit `7ae9857` verbatim and added `## [1.1.1] - 2026-11-27` documenting live lifecycle hook telemetry synchronization and stable subagent ordering with the 2-minute idle grace window.
- `README.md` (137 lines): Updated `--version` example to `v1.1.1`.
- `bin/cli.js` (412 lines), `injector/install.js` (378 lines), `mcp/server.js` (353 lines), `sidecars/dashboard/server.mjs` (316 lines): Bumped fallback/manifest version strings to `"1.1.1"`, strengthened `getPackageVersion` string/whitespace validation in `bin/cli.js` and `sidecars/dashboard/server.mjs`, and added `console.debug` diagnostics to fallback `catch` blocks in `sidecars/dashboard/server.mjs`.
- `tests/test_cli.js` (382 lines): Updated `1.1.0` / `v1.1.0` version assertions to `1.1.1` / `v1.1.1`.

### Subagent Ordering & 2-Minute Idle Retention
- `lib/active-status.js` (494 lines):
  - Exported `validateNonNegativeNumber`.
  - Added `isWithinIdleGrace(node, nowMs, idleGraceMs)` (2-minute default `120000` ms, `5000` ms future clock-skew tolerance), `isCascadeSubagentEntry(entry)`, and `compareSubagentNodes(a, b)` (case-insensitive, numeric-aware `localeCompare` over `subagentName` -> `subagentType` -> `conversationName` -> `conversationId` with raw ID tie-breaker).
- `lib/agent-tree.js` (476 lines):
  - Added validated `idleGraceMs` (default `120000`) and `nowMs` options to `findActiveAgentTree`.
  - Queues active `cascadeStatuses` entries before recently-idle subagent entries so `maxScan` never crowds out running agents.
  - Retains idle subagent nodes within `idleGraceMs` (keeping `isActive: false` and `runState: "idle"` accurate and keeping their main root visible via `activeParentIds`), prunes expired idle subagents (`> idleGraceMs`) and standalone idle main conversations, and sorts `root.children` via `compareSubagentNodes`.
- `sidecars/dashboard/app.js` (249 lines):
  - Updated `renderAgentTree` to label subagent counts as `${mainCount} Main · ${subCount} Subagents` and render both active and retained idle subagent cards.
- `tests/test_agent_tree.js` (Created, 341 lines) & `tests/run-all.js` (232 lines):
  - Added 5 tests (Suite 9: `Agent Tree`) covering alphabetical ordering with reversed mtimes, 4-way identical-name tie-breaking, 2-minute (`120000` ms) idle grace boundaries & clock skew, idle orphan main pruning, `maxScan` active-first prioritization, and negative option validation.

---

## Verification & Deployment

- **Adversarial Audits (`@team-auditor`):** `VERDICT: PASS` across all production, documentation, and test files.
- **Stage 4 QA (`@team-qa`):** `VERDICT: PASS`
  - `node tests/run-all.js`: **79 passed, 0 failed, 0 skipped** across all 9 suites (`Logs/test-results.log`).
  - `node --check`: Exit code `0` across all 17 modified/created `.js`/`.mjs` files.
  - `node scripts/audit-gate.js`: `GATE VERDICT: PASS` across all 48 project files (`0` errors, `0` warnings; `Logs/audit-gate.log`).
- **Live Plugin Install (`node bin/cli.js install`):** Installed Token Tracker `v1.1.1` to `C:\Users\domus\.gemini\config\plugins\token-tracker` (exit code `0`).
