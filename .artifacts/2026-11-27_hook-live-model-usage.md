# Plan: Live Language Server `modelUsage` Enrichment for Lifecycle Hooks

**Date:** 2026-11-27
**Status:** Planned

## Goal

Eliminate inaccurate context, compaction, and prompt-cache numbers emitted by the `PreInvocation` and `SessionStart` lifecycle hooks (`hooks/pre-invocation.js`, `hooks/session-start.js`) so their reported metrics match the live Language Server `modelUsage` displayed in the sidebar dashboard, telemetry server, and MCP status tool.

## Root Cause Analysis

1. **Missing Language Server `modelUsage` Enrichment in Hooks:**
   - `sidecars/dashboard/telemetry-payload.mjs`, `lib/telemetry-server.js`, and `mcp/status-tool.js` enrich `ConversationTracker.getConversationMetrics()` with `QuotaService.getCascadeUsage()` + `applyModelUsageMetrics()`.
   - `hooks/pre-invocation.js` and `hooks/session-start.js` were omitted from that integration and still rely exclusively on `ConversationTracker.getConversationMetrics()`, which uses raw SQLite `gen_metadata` protobuf blob lengths (`bytes / 4`).
   - Raw `gen_metadata` blob lengths overestimate active tokens (e.g., reporting `500k / 512k (98%)` and `12.4k` remaining instead of actual `415k / 512k (81%)` and `97k` remaining) and fall back to `0%` prompt cache hit ratio when recent `gen_metadata` rows contain metadata stubs (`<= 2048` bytes) or lack prior-step delta data.
2. **Incomplete Advisory Context Breakdown (`hooks/pre-invocation.js`):**
   - The `PreInvocation` advisory message omits overall context window usage (`currentTokens / maxTokens (percentUsed%)`) and displays `currentTokensFormatted active tokens in context` instead of `cachedTokensFormatted cached / totalTokensFormatted total` on the Prompt Cache line.
3. **Offline SQLite Fallback Fragility (`lib/conversation-tracker.js`):**
   - When querying `gen_metadata` (`ORDER BY idx DESC LIMIT 10`), more than 9 consecutive small metadata stub rows (`<= 2048` bytes) cause `prevContextBytes` to drop to `0`, forcing an artificial `0%` cache hit ratio whenever the Language Server is offline.

## Implementation Phases

### Phase 1 — Hook Live Enrichment & Formatting (`@team-coder`)
1. **`hooks/pre-invocation.js`:**
   - Instantiate `QuotaService` and query `quotaService.getCascadeUsage(metrics.conversationId, metrics.stepCount, false)` (catching errors gracefully so offline LS falls back cleanly to SQLite metrics).
   - When usage is returned, enrich metrics via `applyModelUsageMetrics(metrics, usage, tracker.compactionThresholdBytes ?? null)`.
   - Extract a clean, dependency-injectable helper (e.g., `evaluatePreInvocation` / `runPreInvocation`) accepting `{ payload, tracker, quotaService, dataDir, nowMs }` so unit tests can exercise live enrichment, offline fallback, cooldown suppression, and subagent isolation without touching `~/.gemini`.
   - Update the advisory message lines to also report overall `Context Window` (`currentTokensFormatted / maxTokensFormatted (percentUsed%)`) and clear `Prompt Cache` breakdown (`hitRatioPercent% hit ratio (cachedTokensFormatted cached / totalTokensFormatted total)`).
2. **`hooks/session-start.js`:**
   - Run `quotaService.getCascadeUsage(metrics.conversationId, metrics.stepCount, false)` in parallel (`Promise.all`) with `quotaService.getQuotaSummary(false)` when `metrics?.conversationId` is resolved.
   - Apply `applyModelUsageMetrics(metrics, mainUsage, tracker.compactionThresholdBytes ?? null)` when usage is available.
   - Extract a testable, dependency-injectable helper (`runSessionStart`) while preserving existing CLI/stdin behavior and `resolveSessionId` / `isSubagentPayload` exports.
3. **`lib/conversation-tracker.js`:**
   - Harden the offline `gen_metadata` substantial-row lookup: if `genRows.slice(2).find(len > 2048)` finds nothing within the initial `LIMIT 10`, query the most recent prior row with `length(data) > 2048 AND idx < ?` so offline cache hit estimation does not collapse to `0%` when >9 metadata stubs exist.
4. **Documentation Check (`README.md`, `CHANGELOG.md`):**
   - Apply minimal, targeted updates if hook descriptions need alignment, following repository documentation standards.

### Phase 2 — Adversarial Code Audit (`@team-auditor`)
- Full line-1-to-EOF audit of all modified production files against `coding-standards.md`, `audit-standards.md`, and `AGENTS.md` (500-line ceiling, zero stubs, fail-fast validation, static gate verification).

### Phase 3 — Adversarial Test Authoring & Audit (`@team-test`, `@team-auditor`)
- Author unit and negative-path tests covering:
  - `hooks/pre-invocation.js`: LS `modelUsage` enrichment overriding inflated SQLite bytes and `0%` cache; graceful fallback when LS is offline/returns null; subagent payload handling; Context Window + Prompt Cache formatting; cooldown suppression with enriched metrics.
  - `hooks/session-start.js`: parallel `getCascadeUsage` + `getQuotaSummary` enrichment and offline fallback.
  - `lib/conversation-tracker.js`: offline `gen_metadata` fallback finding a prior substantial row even when >10 small stub rows precede it.
- Audit the authored tests with a fresh `@team-auditor` pass.

### Phase 4 — QA Execution & Plugin Deployment (`@team-qa`)
- Execute full test suite (`node tests/run-all.js`), syntax validation (`node --check`), and static gate (`node scripts/audit-gate.js`), logging outputs under `Logs/`.
- Run `node bin/cli.js install` to deploy the verified fix to the live Antigravity plugin directory.

## Edge Cases

- **Language Server offline / initializing:** `getCascadeUsage` rejects or returns `null`; hooks must catch non-fatally and fall back to SQLite metrics without crashing or delaying beyond RPC timeout.
- **Brand-new conversation (0 steps / missing DB):** `metrics` is `null` or has `0` tokens; hooks must return `{}` (for `PreInvocation`) or graceful baseline status (for `SessionStart`).
- **Corrupt / empty `modelUsage` (`totalPromptTokens <= 0`):** `applyModelUsageMetrics` returns `metrics` unchanged without `NaN` or division-by-zero.
- **Subagent `PreInvocation`:** `active_conversation.json` must NOT be overwritten by subagents, while `getCascadeUsage` still enriches the subagent's own `convId` accurately.
- **Advisory cooldown state:** Persisted `advisories/<safeConvId>.json` uses the enriched `percentCompacted` / `trajectoryKb` / `kbRemaining`.

## Verification Strategy

1. `node scripts/audit-gate.js -f "<modified files>"` -> `GATE VERDICT: PASS` (0 errors, 0 warnings).
2. `node --check` on all modified `.js` files -> exit code 0.
3. Full test run via `node tests/run-all.js` (and targeted new test suite) -> 100% pass, logs saved in `Logs/`.
4. Re-install live plugin via `node bin/cli.js install` -> exit code 0.
