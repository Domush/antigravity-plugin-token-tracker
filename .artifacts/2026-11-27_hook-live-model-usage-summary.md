# Summary: Live Language Server `modelUsage` Enrichment for Lifecycle Hooks

**Date:** 2026-11-27
**Plan:** `.artifacts/2026-11-27_hook-live-model-usage.md`

---

## Root Cause

`hooks/pre-invocation.js` and `hooks/session-start.js` were still computing metrics exclusively from `ConversationTracker.getConversationMetrics()` (raw SQLite `gen_metadata` protobuf blob lengths divided by 4), instead of enriching with live Language Server `modelUsage` via `QuotaService.getCascadeUsage()` and `applyModelUsageMetrics()` like the sidebar (`sidecars/dashboard/telemetry-payload.mjs`), telemetry server (`lib/telemetry-server.js`), and MCP status tool (`mcp/status-tool.js`). That caused `PreInvocation` advisories to report inflated SQLite byte heuristics (e.g., `500k / 512k = 98%`, `12.4k` headroom) and `0%` prompt cache hit ratios when the actual session had `415k / 1.05M (39.6%)` context, `98.9%` cache efficiency, and `415k / 512k (81%)` compaction.

---

## Created & Modified Files

- `hooks/pre-invocation.js` (Modified, 279 lines):
  - Extracted dependency-injectable `runPreInvocation({ payload, tracker, quotaService, dataDir, nowMs })`.
  - Queries `quotaService.getCascadeUsage(metrics.conversationId, metrics.stepCount, false)` and applies `applyModelUsageMetrics(metrics, mainUsage, tracker?.compactionThresholdBytes ?? null)` with non-fatal fallback to SQLite metrics when the Language Server is offline or returns `null`.
  - Updated `[token-tracker compaction advisory]` output to include `Context Window` (`currentTokensFormatted / maxTokensFormatted (percentUsed%)`) and `Prompt Cache` (`hitRatioPercent% hit ratio (cachedTokensFormatted cached / totalTokensFormatted total)`).
  - Preserved subagent `active_conversation.json` isolation and advisory cooldown/delta deduplication.
- `hooks/session-start.js` (Modified, 186 lines):
  - Extracted dependency-injectable `runSessionStart({ payload, tracker, quotaService, dataDir })`.
  - Runs `quotaService.getQuotaSummary(false)` and `quotaService.getCascadeUsage(metrics.conversationId, metrics.stepCount, false)` in parallel via `Promise.all` and enriches `metrics` with `applyModelUsageMetrics`.
- `lib/models.js` (Modified, 300 lines):
  - Added `hasCatalogMatch(modelIdentifier)` to verify whether a model identifier resolves to a known catalog entry.
- `lib/compaction.js` (Modified, 290 lines):
  - Added `resolveEnrichedModel(currentModel, candidateModelId)` inside `applyModelUsageMetrics` so `modelUsage.model` enriches `metrics.model` when `metrics.model` is missing/fallback (`isFallback === true`) or lacks a catalog match, without clobbering already catalog-matched models.
- `lib/conversation-tracker.js` (Modified, 484 lines):
  - Hardened offline `gen_metadata` fallback (`idx < ? AND data IS NOT NULL AND length(data) > 2048 ORDER BY idx DESC LIMIT 1`) when >9 consecutive metadata stubs (`<= 2048` bytes) precede a substantial row, and added `model.isFallback`.
- `tests/test_hooks_live_usage.js` (Created, 486 lines) & `tests/test_hooks_live_fallback.js` (Created, 268 lines):
  - Added 10 comprehensive tests covering live LS enrichment overriding SQLite heuristics, threshold suppression below 80%, offline/null/zero-token fallbacks, subagent isolation, cooldown/critical override, parallel `SessionStart` RPC calls, `hasCatalogMatch` / `resolveEnrichedModel`, >10-stub SQLite fallback, and corrupt/missing DB negative paths.
- `tests/run-all.js` (Modified, 218 lines):
  - Registered `runHooksLiveUsageTests` (Suite 8), isolated the CLI `hooks/pre-invocation.js` subprocess check with a temporary `HOME`/`USERPROFILE` directory (`try/finally` cleanup), tightened its assertion to `assert.deepStrictEqual(parsedHook, {})`, and updated the suite header comment.
- `README.md` (137 lines) & `CHANGELOG.md` (25 lines):
  - Updated end-user hook descriptions and `[1.1.0]` changelog entry.

---

## Verification & Deployment

- **Stage 2 Adversarial Code Audit (`@team-auditor`):** `VERDICT: PASS` (0 defects).
- **Stage 3b Test Suite Audit (`@team-auditor`):** `VERDICT: PASS` (0 defects after remediation of isolation, corrupt DB coverage, and assertion strength).
- **Stage 4 QA Execution (`@team-qa`):** `VERDICT: PASS`
  - `node tests/run-all.js`: **74 passed, 0 failed, 0 skipped** (log: `Logs/test-results.log`).
  - `node --check`: Exit code `0` across all 8 modified/created `.js` files.
  - `node scripts/audit-gate.js`: `GATE VERDICT: PASS` across all 47 project files (`0` errors, `0` warnings; log: `Logs/audit-gate.log`).
- **Live Plugin Install (`node bin/cli.js install`):** Installed to `C:\Users\domus\.gemini\config\plugins\token-tracker` (exit code `0`).
