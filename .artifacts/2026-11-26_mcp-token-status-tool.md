# Plan: MCP Token & Subagent Context Monitoring Tool (`token_tracker_status`)

**Date:** 2026-11-26
**Package Version:** `1.0.0` (unchanged)
**Pipeline Scope:** With Audit (`@team-coder` -> `@team-auditor` -> `node bin/cli.js install`)

---

## 1. Goal

Expose a zero-dependency MCP tool (`token_tracker_status`) from the Antigravity plugin so the main agent can inspect current conversation token usage, prompt cache efficiency, model-aware compaction headroom, optional quota summary, and child subagent context telemetry on demand without `PreInvocation` context bloat.

---

## 2. Implementation Phases

1. **`lib/subagent-tracker.js` (Created):**
   - Discover child subagent `.db` files linked to a `rootConversationId` by scanning `gen_metadata` row 0 trailers (and `trajectory_metadata_blob` fallback) for `root_cascade_id` / `parent_cascade_id` and `subagent_type`.
   - Enforce strict ID validation, read-only `DatabaseSync` handles closed in `finally`, presence `.lock` active status detection (`activeOnly` filter), bounded recent scan (`maxScan`), and clean summary counts.
2. **`mcp/server.js` & `mcp_config.json` (Created):**
   - Register `token-tracker` MCP server (`command: "node"`, `args: ["./mcp/server.js"]`) in `mcp_config.json`.
   - Implement JSON-RPC 2.0 stdio MCP server (`initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`) with `token_tracker_status` tool (`conversationId`, `includeSubagents`, `activeOnly`, `includeQuota`, `format`), strict argument validation, `stderr`-only diagnostics, and strict conversation isolation.
3. **Packaging, CLI & Docs (`package.json`, `bin/cli.js`, `README.md`):**
   - Add `"mcp_config.json"` and `"mcp"` to `package.json` `"files"` (keeping `"version": "1.0.0"`) and `bin/cli.js` `ESSENTIAL_FILES` / `ESSENTIAL_DIRS`.
   - Update `README.md` Architecture Overview and add concise user documentation for `token_tracker_status`.

---

## 3. Verification Strategy

- `node --check` on all JS/MJS files and `node scripts/audit-gate.js` (`0` errors, `0` warnings).
- Adversarial code & security audit by `@team-auditor` (`VERDICT: PASS`).
- Live plugin deployment via `node bin/cli.js install`.
