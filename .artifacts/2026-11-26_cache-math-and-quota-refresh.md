# Plan: Real API Prompt Cache Metrics, Auto-Refreshing Quotas & Audit Remediations

**Date:** 2026-11-26
**Package Version:** `1.0.0` (unchanged)
**Pipeline Scope:** With Audit (`@team-coder` -> `@team-auditor` -> `node bin/cli.js install`)

---

## 1. Root Causes & Scope

1. **Prompt Cache Hit Ratio stuck at `0.1%` (`315 hit`):**
   - Antigravity writes a single full `gen_metadata` context row alongside `~1.26 KB` stub rows, causing byte-length comparison across `ORDER BY idx DESC LIMIT 2` to treat the `~1.26 KB` (`~315` token) stub as `prevTokens`.
   - Meanwhile, Antigravity's Language Server `GetCascadeTrajectorySteps` returns exact `metadata.modelUsage` (`cacheReadTokens`, `inputTokens`, `cacheCreationTokens`, `outputTokens`) on the latest `CORTEX_STEP_TYPE_PLANNER_RESPONSE` step.
2. **Quota Limits not auto-updating without manual Refresh:**
   - `DEFAULT_CACHE_TTL_MS = 15000` (15s) stalled 3-second polls, and `/api/telemetry` lacked `Cache-Control: no-store` headers and `{ cache: "no-store" }` fetch options in Chromium/Sidecar.
3. **Pass-1 Audit Remediations (`DEF-01`–`DEF-06`):**
   - Chunk `readConversationTitleMap` `IN (...)` queries (`<= 500`) and extract from `lib/agent-tree.js`; fix `.main-body` narrow-width overflow in `styles.css`; guard arrays/whitespace/fallback names across `quota-service.js`, `app.js`, `styles.css`, and `mcp/format.js`.

---

## 2. Verification Strategy

- `node --check` on all `.js`/`.mjs` files, `node scripts/audit-gate.js`, and `node tests/test_quota_service.js`.
- Adversarial audit by `@team-auditor` (`VERDICT: PASS`).
- Live deployment via `node bin/cli.js install`.
