# Summary: Dense Compact Tree Dashboard & Live Active-Only Subagent Filtering

**Date:** 2026-11-26
**Package Version:** `1.0.0` (unchanged)

---

## Created & Modified Files

- `lib/ls-rpc.js` (Created, 194 lines): Shared Connect-RPC transport (`makeConnectRpcCall`) with fail-fast HTTP port/CSRF/path validation, 404 fallback, mid-response `error`/`close` settlement guards, and `try/catch` request error handling.
- `lib/quota-service.js` (Modified, 447 lines): Added cached `getCascadeStatuses()` (`GetAllCascadeTrajectories`) to detect live `RUNNING`/`BUSY` vs `IDLE`/`UNSPECIFIED` cascades, strict port (`1..65535`) and trimmed `csrfToken` validation, and `Array.isArray`/`Number.isFinite` response guards.
- `lib/active-status.js` (Created, 324 lines): Strict path/ID validation (`validateSafeConversationId`, `verifyConfinedRegularFile`, `readPresenceLocks` with `presence/` symlink confinement) and `resolveConversationActiveState` supporting live `cascadeStatuses` and 120s recency fallback.
- `lib/subagent-tracker.js` (Modified, 414 lines) & `lib/agent-tree.js` (Modified, 385 lines): Active-only subagent filtering (excluding idle subagents), bounded ancestor chain resolution, and enriched node metrics (`cachedTokensFormatted`, `hitRatioPercent`, `percentUsed`, `percentCompacted`).
- `sidecars/dashboard/server.mjs` (Modified, 396 lines): Serves `/`, `/styles.css`, `/app.js`, and `/preload.js` in both `SidecarApp` and standalone HTTP mode; defaults `includeAgents` to `true` (`GetAllCascadeTrajectories` + `findActiveAgentTree`); enforces 64 KB `Buffer` body limits and accurate `activePort` reporting.
- `sidecars/dashboard/index.html` (Modified, 74 lines), `sidecars/dashboard/styles.css` (Created, 304 lines), `sidecars/dashboard/app.js` (Created, 468 lines):
  - Top 4-across dense quota strip (`Gemini 5-Hour`, `Gemini Weekly`, `Claude/GPT 5-Hour`, `Claude/GPT Weekly`).
  - Default and only view: Active Agents Tree (Tree toggle removed), full words (`Context`, `Cache`, `Compaction`), main agent 3-ring + fixed-width 3-row metric stack (non-bold values on left, bold health-colored percentages on right, no `Safe`/`Warn`), fixed-width `214px` horizontal wrapping active subagent cards, and persisted `Subagents: Text` / `Subagents: Rings` either/or toggle.
  - Overlapping poll prevention (`setTimeout` chaining, `isPollInFlight`, `latestRequestId`, `clearTimeout` on manual refresh) and XSS-safe DOM rendering.
- `README.md` (Modified, 178 lines): Updated Synchronized Dual Interface description and directory tree.

---

## Verification & Deployment

- **Adversarial Audit (`@team-auditor`):** `VERDICT: PASS`.
- **Static Audit Gate (`node scripts/audit-gate.js`):** `GATE VERDICT: PASS` across all 39 project files (`0` errors, `0` warnings).
- **Syntax Check (`node --check`):** Passed across all 32 `.js`/`.mjs` files (exit `0`).
- **Live Plugin Install (`node bin/cli.js install`):** Deployed to `C:\Users\domus\.gemini\config\plugins\antigravity-plugin-token-tracker`.
