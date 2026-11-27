# Plan: Display Conversation & Subagent Names and Side-by-Side Main Card Layout

**Date:** 2026-11-26
**Package Version:** `1.0.0` (unchanged)
**Pipeline Scope:** With Audit (`@team-coder` -> `@team-auditor` -> `node bin/cli.js install`)

---

## 1. Goal

1. Replace short conversation IDs in the sidebar tree cards with human-readable names:
   - **Main agents:** Display the conversation name (`summary` from `GetAllCascadeTrajectories`, with `conversation_summaries.db` `title` fallback and `shortId` final fallback).
   - **Subagents:** Display the given subagent name/role (`subagentSpec.role` from `GetAllCascadeTrajectories`, with `conversation_summaries.db` `preview`/DB fallback and `shortId` final fallback) immediately after the base agent badge (`subagentType`).
2. Keep the 3 circular rings and 3-row metric stack side-by-side at standard sidebar width (~410–490px) by tightening main card widths and adjusting the wrap breakpoint to `<= 395px`.

---

## 2. Implementation Phases

1. **`lib/quota-service.js`:** Include `title: summary.summary` and `subagentRole: meta.subagentSpec?.role` in `parseCascadeStatuses`.
2. **`lib/agent-tree.js`:** Attach `conversationName` (main conversation title) and `subagentName` (given subagent role) on condensed tree nodes, with safe read-only fallback lookup from `conversation_summaries.db` (`title`) when Language Server summaries are unavailable.
3. **`sidecars/dashboard/app.js` & `styles.css`:**
   - Render `node.conversationName || node.shortId` in main agent headers (with `title` attribute showing full name + ID).
   - Render `sub.subagentName || sub.shortId` right after the `sub.subagentType` badge in subagent cards (with `title` attribute showing full subagent name + ID).
   - Tighten `.mini-ring` (`38px` in main card) and `.metrics-stack` (`216px`) and lower `@media (max-width: 460px)` to `@media (max-width: 395px)` so rings and stats stay side-by-side at standard sidebar width.
4. **`mcp/format.js` & `README.md`:** Optionally show `subagentRole`/`conversationName` when present in MCP markdown/JSON output and keep `README.md` accurate.

---

## 3. Verification Strategy

- `node --check` on all `.js`/`.mjs` files and `node scripts/audit-gate.js` (`0` errors, `0` warnings).
- Adversarial code audit by `@team-auditor` (`VERDICT: PASS`).
- Live deployment via `node bin/cli.js install`.
