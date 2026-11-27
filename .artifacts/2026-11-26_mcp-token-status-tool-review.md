# Review: MCP Token Status Tool, Theme Contrast Fix & Active Agents Tree-View

**Date:** 2026-11-26
**Scope:** Code + Adversarial Audit (`With Audit` — tests and QA omitted per user instruction)
**Verdict:** PASS

---

## Audit Trail

1. **Pass 1 (MCP `token_tracker_status`, Subagent Tracker, Packaging/CLI & Dashboard Theme — REJECT):**
   - Identified `DEF-01` (`mcp/server.js` `rl.on("close")` exiting before async `tools/call` promises settle), `DEF-02` (symlink/`realpathSync` confinement and pre-open `validateSafeConversationId`), `DEF-03` (`matchesRootConversationId` protobuf lookahead collision with field tags 6–15), `DEF-04` (`extractSubagentType` mixed-case, `Struct`/`Value`, and escaped JSON), `DEF-05` & `DEF-07` (JSON-RPC 2.0 `id: null` / missing `method` / `jsonrpc: "2.0"` validation and `rl.on("line")` error boundary), `DEF-06` (Windows case-insensitive root `.db` exclusion), `DEF-08` (`--tt-success-text` contrast & neutral alpha fallbacks), and `DEF-09` (`mcp/format.js` fallback & `README.md` tree).
2. **Pass 2 (All 9 Remediations + Active Agents Tree-View Toggle across 12 Files — PASS):**
   - Verified 0 P0 blockers, 0 regressions, XSS-free DOM tree construction, `lstatSync`/`realpathSync` confinement, `DatabaseSync` `finally` cleanup, all 12 files < 500 lines, `node --check` exit 0 across 29 JS/MJS files, `node scripts/audit-gate.js` `GATE VERDICT: PASS` across 35 project files, and `package.json` & `plugin.json` unchanged at `v1.0.0`.

---

## Next Steps

- Restart or reload Antigravity so the newly registered `token-tracker` MCP server (`mcp_config.json`) and updated Aux Pane sidecar load.
- Optionally split `sidecars/dashboard/index.html` into `index.html` + `styles.css` + `app.js` if adding more UI features, and run `npm test` to update/verify automated tests.
