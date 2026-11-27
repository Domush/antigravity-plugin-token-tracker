# Summary: Subagent Card Row Reorder, Animated Active Status Dots & Language Server `forceRefresh`

**Date:** 2026-11-26
**Package Version:** `1.0.0` (unchanged)

---

## Created & Modified Files

- `lib/quota-service.js` (Modified, 423 lines): Added `DEFAULT_SERVER_FORCE_REFRESH_MS = 15000` and `{ forceRefresh: true }` support in `makeRpcRequest` / `getQuotaSummary` so quota limits refresh live from Google's backend on manual Refresh and automatically every 15s during polling.
- `sidecars/dashboard/cards.js` (Created, 274 lines), `sidecars/dashboard/app.js` (Modified, 242 lines), `sidecars/dashboard/index.html` (Modified, 74 lines), `sidecars/dashboard/server.mjs` (Modified, 468 lines), `sidecars/dashboard/styles.css` (Modified, 365 lines):
  - Extracted card/ring/dot DOM builders into `cards.js` and served `/cards.js` in both `SidecarApp` and standalone HTTP modes.
  - Reordered subagent cards so `[statusDot] [subagentName || shortId]` fills Row 1 and `[sub-role badge] [modelName]` appears on Row 2.
  - Updated `resolveStatusDotClass` and `styles.css` so active agents pulse (`@keyframes tt-dot-pulse`, respecting `prefers-reduced-motion`) and inactive/waiting agents display solid gray (`dot-muted`).

---

## Verification & Deployment

- **Adversarial Audit (`@team-auditor`):** `VERDICT: PASS`.
- **Static Audit Gate (`node scripts/audit-gate.js`):** `GATE VERDICT: PASS` across all 42 project files (`0` errors, `0` warnings).
- **Syntax Check (`node --check`):** Passed across modified JS/MJS files (exit `0`).
- **Live Plugin Install (`node bin/cli.js install`):** Deployed to `C:\Users\domus\.gemini\config\plugins\antigravity-plugin-token-tracker`.
