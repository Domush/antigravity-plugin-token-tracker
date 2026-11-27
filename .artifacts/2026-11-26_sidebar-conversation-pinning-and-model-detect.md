# Plan: Pin Sidebar Telemetry to Current Conversation & Fix Model Detection

**Date:** 2026-11-26
**Package Version:** `1.0.0` (unchanged)
**Pipeline Scope:** Full (`@team-coder` -> `@team-auditor` -> `@team-test` -> `@team-auditor` -> `@team-qa` -> `@team-planner`)

---

## 1. Root Cause Analysis

1. **Sidebar jumping between conversations while idle:**
   - Antigravity's `sidecar_sdk/preload.js` exposes the active pane's `conversationId` via `window.location.search` (`?conversationId=...`) and `window.sidecar.conversationId`.
   - `sidecars/dashboard/index.html` did not load `/preload.js` or forward `conversationId` on `/api/telemetry` and `/api/refresh` requests.
   - `sidecars/dashboard/server.mjs` therefore received `preferredConvId = undefined` and fell back to `active_conversation.json`, which `hooks/session-start.js` and `hooks/pre-invocation.js` overwrite globally on every turn of every conversation and background subagent.
   - Additionally, `ConversationTracker.resolveConversationDbPath(preferredId)` silently fell back to scanning `presence/` and all `.db` files if `<preferredId>.db` did not exist yet, leaking another conversation's metrics even when `preferredId` was specified.

2. **Wrong model detected (`Gemini 4 Hydrogen (Sonar)` / raw `gemini-4-hydrogen-tiered-high`):**
   - `ConversationTracker.getConversationMetrics` scanned `trajectory_metadata_blob` before `gen_metadata` and scanned large `gen_metadata` blobs from byte 0, matching `model_name_override: "gemini-4-hydrogen-sonar"` or quoted strings in tool outputs instead of the protobuf trailer at the tail of `gen_metadata` (e.g., `Gemini 4 Hydrogen (High)`).
   - `lib/model-catalog.js` lacked `gemini-4-*-tiered-*` aliases.

---

## 2. Implementation Plan

1. **`sidecars/dashboard/index.html`:**
   - Include `<script src="/preload.js"></script>` and resolve `conversationId` dynamically from `window.sidecar?.conversationId || new URLSearchParams(window.location.search).get("conversationId")`.
   - Pass `?conversationId=<id>` on every `/api/telemetry` and `/api/refresh` request (using `window.sidecar?.fetch || fetch`).
2. **`sidecars/dashboard/server.mjs` & `lib/telemetry-server.js`:**
   - When an explicit `preferredConvId` is supplied, call `tracker.getConversationMetrics(convId, { strict: true })` so missing `.db` files never fall back to another conversation.
   - Serve `/preload.js` as a benign no-op JS script in standalone HTTP mode to prevent 404s.
3. **`lib/conversation-tracker.js` & `lib/model-catalog.js`:**
   - Add `{ strict = false }` option to `resolveConversationDbPath` and `getConversationMetrics` (preserving default `strict = false` for non-pinned fallback callers/tests).
   - Add `isSubagentPayload(payload, convId)` helper to identify subagent hook invocations.
   - Prioritize the protobuf trailer (last 2048 bytes) of `gen_metadata` rows (`0`, `1`) before `trajectory_metadata_blob` (ignoring `model_name_override: "..."` monitor config snippets) and full `gen_metadata`.
   - Register `gemini-4-{hydrogen,argon,carbon,neon}-tiered-{low,medium,high,xhigh}` variants in `lib/model-catalog.js`.
4. **`hooks/session-start.js` & `hooks/pre-invocation.js`:**
   - Guard `active_conversation.json` writes and `/api/set-conversation` notifications with `!isSubagentPayload(payload, convId)` so background subagents do not hijack the fallback active conversation state.

---

## 3. Verification Strategy

- Adversarial code & test audits (`@team-auditor`)
- Comprehensive unit, negative-path, and integration tests (`@team-test`)
- `npm test`, `npm run audit-gate`, and live `node bin/cli.js install` (`@team-qa`)
