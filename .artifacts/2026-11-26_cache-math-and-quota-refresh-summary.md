# Summary: Real API Prompt Cache Metrics, Auto-Refreshing Quotas, Display Names & Subagent Ring Parity

**Date:** 2026-11-26
**Package Version:** `1.0.0` (unchanged)

---

## Created & Modified Files

- `lib/ls-cascade.js` (Created, 176 lines): Parses `GetAllCascadeTrajectories` (`title`, `subagentRole`, `subagentType`, ancestor IDs) and extracts `metadata.modelUsage` (`inputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `outputTokens`) from `GetCascadeTrajectorySteps`.
- `lib/ls-quota-normalize.js` (Created, 134 lines): Quota response normalization, `formatCountdown`, and `refreshQuotaCountdowns` for live countdown ticks on cached hits.
- `lib/ls-rpc.js` (Modified, 211 lines): Generalized Connect-RPC helper accepting `{ body, timeoutMs }` with fail-fast HTTP validation.
- `lib/quota-service.js` (Modified, 411 lines): Lowered `DEFAULT_CACHE_TTL_MS` to `3000` (3s), recomputes countdowns on cache hits, and added bounded `getCascadeUsage(conversationId, stepCount, forceRefresh)`.
- `lib/compaction.js` (Modified, 220 lines): Added `applyModelUsageMetrics` and `applyModelUsageToTreeNode` to compute real prompt cache hit ratios and exact token context/compaction metrics from API `modelUsage`.
- `lib/conversation-tracker.js` (Modified, 469 lines): Updated offline SQLite fallback (`ORDER BY idx DESC LIMIT 10`) to skip `~1.26 KB` (`<= 2048` byte) metadata stubs when `currentContextBytes > 16384`, and added `cache.totalTokensFormatted`.
- `lib/active-status.js` (Modified, 413 lines) & `lib/agent-tree.js` (Modified, 434 lines): Extracted `readConversationTitleMap` with `MAX_SQL_VARIABLES = 500` batching and symlink confinement, resolved `conversationName` + `subagentName`, and exposed `XX / YY` formatted fields on condensed tree nodes.
- `lib/telemetry-server.js` (Modified, 322 lines), `mcp/status-tool.js` (Modified, 275 lines), & `mcp/format.js` (Modified, 141 lines): Enriched live metrics with `getCascadeUsage` and guarded optional display names via `normalizeDisplayText`.
- `sidecars/dashboard/server.mjs` (Modified, 453 lines), `sidecars/dashboard/app.js` (Modified, 496 lines), & `sidecars/dashboard/styles.css` (Modified, 330 lines):
  - Enriched main and active subagent tree nodes with real `modelUsage` and `Cache-Control: no-store` headers (`SidecarApp` + standalone) + `{ cache: "no-store" }` fetch options.
  - Displayed conversation names on main cards and given subagent names after the base role badge, matched subagent ring size (`38px`) to main agent rings, fixed `.main-body` narrow overflow (`@media (max-width: 410px)`), and unified all 3 rows (`Context`, `Cache`, `Compaction`) to `XX / YY` format.

---

## Verification & Deployment

- **Adversarial Audit (`@team-auditor`):** `VERDICT: PASS` across all 14 files.
- **Static Audit Gate (`node scripts/audit-gate.js`):** `GATE VERDICT: PASS` across all 41 project files (`0` errors, `0` warnings).
- **Syntax Check (`node --check`):** Passed across all `.js` and `.mjs` files (exit `0`).
- **Live Plugin Install (`node bin/cli.js install`):** Deployed to `C:\Users\domus\.gemini\config\plugins\antigravity-plugin-token-tracker`.
