# Summary: MCP Token Status Tool, Theme Contrast Fix & Active Agents Tree-View

**Date:** 2026-11-26
**Package Version:** `1.0.0` (unchanged)

---

## Created & Modified Files

- `mcp_config.json` (Created, 8 lines): Registers `"token-tracker"` MCP server (`node ./mcp/server.js`).
- `mcp/server.js` (Created, 353 lines), `mcp/status-tool.js` (Created, 250 lines), `mcp/format.js` (Created, 122 lines): Zero-dependency JSON-RPC 2.0 stdio MCP server exposing `token_tracker_status` (`conversationId`, `includeSubagents`, `activeOnly`, `includeQuota`, `format`) with strict input validation, graceful async close draining, stderr-only diagnostics, and Markdown/JSON formatting.
- `lib/subagent-tracker.js` (Created, 483 lines): Symlink-confined child subagent discovery linking `root_cascade_id` / `parent_cascade_id` and `subagent_type` across `gen_metadata` / `trajectory_metadata_blob` trailers.
- `lib/agent-tree.js` (Created, 284 lines): Discovers active `presence/*.lock` main and subagent conversations into a condensed parent/child tree (`findActiveAgentTree`).
- `lib/conversation-tracker.js` (Modified, 457 lines): Added `resolveRegularFileInDir` (`lstatSync` + `realpathSync`) confinement for strict conversation lookups.
- `sidecars/dashboard/server.mjs` (Modified, 322 lines): Added `includeAgents` support on `/api/telemetry` and `/api/refresh` for both `SidecarApp` and standalone HTTP mode.
- `sidecars/dashboard/index.html` (Modified, 499 lines): Namespaced all theme CSS custom properties under `--tt-*` (resolving Antigravity `--muted` dark-surface collision and light-theme contrast) and added the persisted `Agents` tree-view toggle (`#tt-agents-toggle`, `#tt-agents-card`) with XSS-safe DOM rendering.
- `package.json` (Modified, 45 lines) & `bin/cli.js` (Modified, 396 lines): Included `mcp_config.json` and `mcp/` in package files and CLI install/uninstall lists while keeping `"version": "1.0.0"`.
- `README.md` (Modified, 173 lines): Documented the `token_tracker_status` MCP tool, Active Agents tree-view toggle, and updated Architecture Overview.

---

## Verification Status

- **Adversarial Audit (`@team-auditor`):** `VERDICT: PASS` across all 12 files.
- **Static Audit Gate (`node scripts/audit-gate.js`):** `GATE VERDICT: PASS` across all 35 project files (`0` errors, `0` warnings).
- **Syntax Check (`node --check`):** Passed across all 29 JS/MJS files (exit `0`).
- **Live Plugin Install (`node bin/cli.js install`):** Deployed updated files (including `mcp_config.json` and `mcp/`) to `C:\Users\domus\.gemini\config\plugins\antigravity-plugin-token-tracker`.
- **Tests / QA:** Skipped per user instruction (`"just do the code and audit, no tests or QA"`).
