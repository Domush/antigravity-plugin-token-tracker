# Plan: Subagent Card Row Reorder, Animated Active Status Dots & Language Server `forceRefresh`

**Date:** 2026-11-26
**Package Version:** `1.0.0` (unchanged)
**Pipeline Scope:** With Audit (`@team-coder` -> `@team-auditor` -> `node bin/cli.js install`)

---

## 1. Goal

1. Move the base agent badge (`team-auditor`, etc.) to Row 2 to the left of the model name so the given subagent name fills the entire top row alongside the status dot.
2. Animate the status dot (`@keyframes tt-dot-pulse`) with its health color when an agent is active (`isActive === true`) and render a static gray dot (`dot-muted`) when inactive/waiting (`isActive === false`).
3. Fix slow/stale Language Server quota updates by passing `{ forceRefresh: true }` in `RetrieveUserQuotaSummary` on manual refresh (`forceRefresh === true`) and periodically every 15s during live polling (`DEFAULT_SERVER_FORCE_REFRESH_MS = 15000`).

---

## 2. Implementation

- **`lib/quota-service.js`:** Pass `{ forceRefresh: true }` on `RetrieveUserQuotaSummary` when `forceRefresh` is `true` or `now - this.lastServerForceRefreshTime >= 15000` (initializing `lastServerForceRefreshTime = Date.now()` in constructor).
- **`sidecars/dashboard/app.js` & `styles.css`** (and extract a small module under `sidecars/dashboard/` if `app.js` approaches 500 lines, serving it in `server.mjs`):
  - Update `resolveStatusDotClass` to return `"dot-muted"` whenever `!node?.isActive`, and `"dot-active"` + health class (`dot-green`/`dot-amber`/`dot-red`) when `node?.isActive === true`.
  - Add `@keyframes tt-dot-pulse` animation on `.status-dot.dot-active` in `styles.css`.
  - Update `buildSubagentCard` so Row 1 (`.sub-head`) displays `[statusDot] [subagentName || shortId]` across the full width, and Row 2 (`.sub-meta-row`) displays `[sub-role badge]` + `[modelName]`.
