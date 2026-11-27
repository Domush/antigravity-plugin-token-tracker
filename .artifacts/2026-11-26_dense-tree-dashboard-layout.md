# Plan: Dense Compact Tree Dashboard & Live Active-Only Subagent Filtering

**Date:** 2026-11-26
**Package Version:** `1.0.0` (unchanged)
**Pipeline Scope:** With Audit (`@team-coder` -> `@team-auditor` -> `node bin/cli.js install`)

---

## 1. Goal

Replace the verbose stacked dashboard cards and raw `.lock`-based tree list with the approved dense compact tree layout:
1. Move quotas to the top as 4-across compact cards (`Gemini 5-Hour`, `Gemini Weekly`, `Claude/GPT 5-Hour`, `Claude/GPT Weekly`).
2. Make the tree view the default and only view (removing the Tree toggle).
3. Render main agent cards with all 3 circular progress rings (`Context`, `Cache`, `Compaction`) plus a fixed-width 3-line metric stack (`value` non-bold on left, health-colored bold `%` on right — no `Safe`/`Warn` text, full words throughout).
4. Filter subagents strictly to **active (non-idle)** subagents using live Language Server `GetAllCascadeTrajectories` status (with recent `.db`/`.db-wal` activity fallback) and render them as fixed-width (`214px`) horizontal auto-wrapping cards with an either/or `Subagents: Text` / `Subagents: Rings` toggle persisted in `localStorage`.

---

## 2. Implementation Phases

1. **`lib/quota-service.js`:** Add cached `getCascadeStatuses()` calling `/exa.language_server_pb.LanguageServerService/GetAllCascadeTrajectories` to distinguish `CASCADE_RUN_STATUS_IDLE` from active (`RUNNING`/`BUSY`) cascades and subagents.
2. **`lib/agent-tree.js` & `lib/subagent-tracker.js`:** Incorporate live `cascadeStatuses` (plus recent activity fallback when LS is unavailable) so idle subagents and stale `.lock` files are excluded, and include cache/context/compaction metrics needed by the compact cards.
3. **`sidecars/dashboard/` (`index.html`, `styles.css`, `app.js`, `server.mjs`):**
   - Split dashboard styling and client logic into `styles.css` and `app.js` served alongside `index.html` in `server.mjs` (both `SidecarApp` and standalone HTTP mode).
   - Always include `agentTree` by default in `/api/telemetry` and `/api/refresh`.
   - Implement the finalized 4-across quota strip, full-word labels (`Context`, `Cache`, `Compaction`), 3-ring + fixed-width grid main cards, fixed-width `214px` horizontal wrapping active subagent cards, and persisted `Subagents: Text` / `Subagents: Rings` either/or toggle.
4. **`README.md`:** Update Synchronized Dual Interface description and `sidecars/dashboard/` directory tree.

---

## 3. Verification Strategy

- `node --check` on all `.js`/`.mjs` files and `node scripts/audit-gate.js` (`0` errors, `0` warnings).
- Adversarial code audit by `@team-auditor` (`VERDICT: PASS`).
- Live deployment via `node bin/cli.js install`.
