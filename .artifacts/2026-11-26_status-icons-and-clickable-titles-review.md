# Code Audit Review: Status Icons, Clickable Titles, Health Colors & Compaction Math

**Date:** 2026-11-26
**Reviewer:** `@team-auditor` (`0993ded3`, follow-up to `a44002ed`)
**Verdict:** `VERDICT: PASS`

---

## 1. Prior Findings Resolved (`DEF-01`–`DEF-07` from `a44002ed`)

1. **[DEF-01] Resolved — [sidecars/dashboard/server.mjs](file:///c:/GitHub/antigravity-plugin-token-tracker/sidecars/dashboard/server.mjs#L160-L195):** Passing `null` for `stepCount` on live polling `getCascadeUsage` calls ensures the 3s TTL (`DEFAULT_USAGE_CACHE_TTL_MS`) governs `isWaitingForUser` re-evaluation when steps transition in-place.
2. **[DEF-02] Resolved — [sidecars/dashboard/server.mjs](file:///c:/GitHub/antigravity-plugin-token-tracker/sidecars/dashboard/server.mjs#L196-L200):** Guarded waiting promotion with `usage.isWaitingForUser && node.runState !== "error"` across both top-level and tree-node paths so error states are never concealed.
3. **[DEF-03] Resolved — [sidecars/dashboard/server.mjs](file:///c:/GitHub/antigravity-plugin-token-tracker/sidecars/dashboard/server.mjs#L231-L240) & [sidecars/dashboard/app.js](file:///c:/GitHub/antigravity-plugin-token-tracker/sidecars/dashboard/app.js#L127-L137):** Fallback `runState` follows `error -> waiting -> running -> idle`, `isActive` aligns with `running || waiting`, and `lastActivityAt` never fabricates `new Date().toISOString()`.
4. **[DEF-04] Resolved — [sidecars/dashboard/cards.js](file:///c:/GitHub/antigravity-plugin-token-tracker/sidecars/dashboard/cards.js#L283-L330):** Only validated `conversationId` (or `""`) is passed to `buildConversationLinkButton`, never `shortId`.
5. **[DEF-05] Resolved — [sidecars/dashboard/cards.js](file:///c:/GitHub/antigravity-plugin-token-tracker/sidecars/dashboard/cards.js#L115-L260) & [sidecars/dashboard/styles.css](file:///c:/GitHub/antigravity-plugin-token-tracker/sidecars/dashboard/styles.css#L239-L254):** Invalid/empty links render disabled with descriptive `title` and `.conv-link:disabled` styling; clickable buttons include `aria-label`; navigation preserves query parameters via `new URL(window.location.href)`.
6. **[DEF-06] Resolved — [sidecars/dashboard/cards.js](file:///c:/GitHub/antigravity-plugin-token-tracker/sidecars/dashboard/cards.js#L36) & [lib/agent-tree.js](file:///c:/GitHub/antigravity-plugin-token-tracker/lib/agent-tree.js#L183):** Rejected `ms <= 0` in `formatIdleElapsed` and replaced `new Date(0).toISOString()` fallback with `null`.
7. **[DEF-07] Resolved — [lib/agent-tree.js](file:///c:/GitHub/antigravity-plugin-token-tracker/lib/agent-tree.js#L184-L187):** Preserved `running` state for active non-error cascade entries so step-level `waiting` overrides apply reliably.

---

## 2. Final Pass Verification Findings (Zero Open Defects)

- **Color Coding & Ring Orientation ([cards.js](file:///c:/GitHub/antigravity-plugin-token-tracker/sidecars/dashboard/cards.js#L127-L214), [app.js](file:///c:/GitHub/antigravity-plugin-token-tracker/sidecars/dashboard/app.js#L92-L117), [styles.css](file:///c:/GitHub/antigravity-plugin-token-tracker/sidecars/dashboard/styles.css#L299)):** Verified unified `--tt-success` / `--tt-warning` / `--tt-danger` health thresholds across all 3 SVG rings and all 4 quota bars, plus `transform: rotate(90deg)` on `.mini-ring svg` for bottom (6 o'clock) start.
- **Per-Model Compaction Thresholds ([model-catalog.js](file:///c:/GitHub/antigravity-plugin-token-tracker/lib/model-catalog.js), [models.js](file:///c:/GitHub/antigravity-plugin-token-tracker/lib/models.js), [compaction.js](file:///c:/GitHub/antigravity-plugin-token-tracker/lib/compaction.js)):** Verified empirical Antigravity `CASCADE_USE_EXPERIMENT_CHECKPOINTER` `max_token_limit` bindings (`512k` Gemini 4 / Claude 1M, `256k` Gemini 3.x Flash, `160k` Claude 200k, `128k` Gemini 2.5, `80k` GPT-OSS 120B, `Math.min(512000, Math.round(maxTokens * 0.80))` fallback) across both SQLite fallback and Language Server paths.
- **P0 Static Gate & Constraints:** All 11 audited files remain strictly under 500 lines (`server.mjs` at 497 lines); `node scripts/audit-gate.js` passed with `0` errors and `0` warnings; `package.json`, `plugin.json`, and `tests/*` remain untouched.

- **Main Agent 2-Row Header Layout (`@team-auditor` `b7fcec4c`, `VERDICT: PASS`):** Verified [cards.js](file:///c:/GitHub/antigravity-plugin-token-tracker/sidecars/dashboard/cards.js#L262-L362), [styles.css](file:///c:/GitHub/antigravity-plugin-token-tracker/sidecars/dashboard/styles.css#L360-L395), [app.js](file:///c:/GitHub/antigravity-plugin-token-tracker/sidecars/dashboard/app.js#L127-L141), and [server.mjs](file:///c:/GitHub/antigravity-plugin-token-tracker/sidecars/dashboard/server.mjs#L223-L242) place only status/current/title on Row 1 and move the agent role badge (`subagentType` or `"main"`) + model name onto Row 2 via shared `buildMetaRow`, with `0` orphaned CSS classes and `server.mjs` at 491 lines.

## 3. Recommended Next Steps

1. Reload Antigravity (`Ctrl+Shift+P` -> Reload Window) to pick up the newly installed sidecar dashboard assets and compaction thresholds.
2. Visually inspect the refreshed Aux Pane for status icons, clickable titles, bottom-starting health-colored rings/bars, and `512k` compaction headroom on Gemini 4 sessions.
