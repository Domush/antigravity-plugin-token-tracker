# Review: Subagent Card Row Reorder, Animated Active Status Dots & Language Server `forceRefresh`

**Date:** 2026-11-26
**Scope:** Code + Adversarial Audit (`With Audit` — tests and QA omitted per user instruction)
**Verdict:** PASS

---

## Audit Trail

1. **Stage 2 Adversarial Audit (`ed53df78-e7ca-4623-a606-9be2af1e0676` — PASS):**
   - Verified `lib/quota-service.js` (`423` lines): `DEFAULT_SERVER_FORCE_REFRESH_MS = 15000`, `{ forceRefresh: true }` RPC payload on manual refresh and 15s auto-refresh interval, updating `lastServerForceRefreshTime` only after RPC + normalization succeed.
   - Verified `sidecars/dashboard/cards.js` (`274` lines), `app.js` (`242` lines), `styles.css` (`365` lines), `index.html` (`74` lines), `server.mjs` (`468` lines): `/cards.js` served cleanly in `SidecarApp` and standalone modes, `buildSubagentCard` 2-row header/meta layout (`[dot] [subagentName]` on Row 1, `[sub-role] [modelName]` on Row 2), `resolveStatusDotClass` returning `"dot-muted"` when `!node?.isActive` and pulsing `"dot-active"` (`@keyframes tt-dot-pulse`) when active, `node --check` exit 0, `node scripts/audit-gate.js` `GATE VERDICT: PASS` across 42 project files, and `"version": "1.0.0"` unchanged.
   - Two non-blocking P1 suggestions noted (explicit contract checks on `window.TokenTrackerCards` in `app.js` and parameter validation in `buildMainCard`/`buildSubagentCard`).

---

## Next Steps

- Reload or restart Antigravity to activate the updated sidecar dashboard and `forceRefresh` quota polling.
- Optionally add clickable conversation links (`window.sidecar.ui.toggleConversation`) and mirrored conversation-list status icons (idle elapsed time, running spinner, waiting indicator).
