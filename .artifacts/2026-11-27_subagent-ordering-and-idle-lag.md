# Plan: Alphabetical Subagent Ordering & 2-Minute Idle Subagent Retention

**Date:** 2026-11-27
**Status:** Planned

## Goal

Eliminate rapid subagent card reordering in the sidebar dashboard when multiple subagents run concurrently, and keep recently finished subagents visible in their idle state for a 2-minute (`120000` ms) grace period before hiding them.

## Root Cause Analysis

1. **Unstable Timestamp Sorting (`lib/agent-tree.js`):**
   - `findActiveAgentTree` sorts `root.children` using `compareDescIso(a.lastUpdatedAt, b.lastUpdatedAt)`. Because concurrent subagents continuously flush `.db`/`.db-wal` writes, their `lastUpdatedAt` timestamps leapfrog on every poll cycle, causing cards to jump positions rapidly.
2. **Immediate Idle Pruning (`lib/agent-tree.js`):**
   - When `cascadeStatuses` is provided (live Language Server), candidate selection skips every entry where `entry.isIdle !== false`, and tree pruning deletes every subagent node where `!node.isActive`. As soon as a subagent finishes (`CASCADE_RUN_STATUS_IDLE`), it vanishes immediately on the next poll instead of remaining visible for a 2-minute cooldown.

## Implementation Phases

### Phase 1 — Subagent Ordering & 2-Minute Idle Lag (`@team-coder`)
1. **`lib/agent-tree.js`** (must remain strictly under 500 lines; extract helpers if needed):
   - **Alphabetical Subagent Sorting:**
     - Sort `root.children` deterministically by display name (`subagentName` -> `subagentType` -> `conversationName` -> `conversationId`), case-insensitive (`localeCompare` with `{ sensitivity: "base", numeric: true }`), with secondary tie-breakers on `subagentType`, `conversationName`, and `conversationId` so identical role/name subagents never jitter.
   - **2-Minute (`120000` ms) Idle Subagent Grace Period:**
     - Add validated optional parameters `idleGraceMs = DEFAULT_ACTIVE_RECENCY_MS` (`120000`) and `nowMs = Date.now()` to `findActiveAgentTree(options)`.
     - Prioritize active `cascadeStatuses` entries first (`entry.isIdle === false`), then add recently-idle subagent entries (identified by `rootConversationId`, `parentConversationId`, `subagentType`, or `subagentRole`, and whose `lastModifiedTime` is within `idleGraceMs` of `nowMs`) up to `maxScan`.
     - Retain subagent nodes when `node.isActive || isWithinIdleGrace(node, nowMs, safeIdleGraceMs)` (using `lastActivityAt || lastUpdatedAt`), walk their ancestor chain so their main root stays visible via `activeParentIds`, and preserve accurate `isActive: false` / `runState: "idle"` (so the card's idle elapsed timer renders accurately).
     - After `> idleGraceMs` (`> 120000` ms) since last activity, prune the idle subagent normally.
2. **`sidecars/dashboard/app.js`** (check line count < 500):
   - Update the tree summary label (`countsEl.textContent`) if appropriate so visible subagents (active + recently-idle) are labeled clearly (e.g., `${mainCount} Main · ${subCount} Subagents`), or keep active vs visible count accurate.
3. **`CHANGELOG.md` & `README.md`:**
   - Add the stable alphabetical subagent ordering and 2-minute idle retention improvement under `## [1.1.1] - 2026-11-27` in `CHANGELOG.md` (and check `README.md` if needed), following `AGENTS.md` documentation rules.

### Phase 2 — Adversarial Code Audit (`@team-auditor`)
- Fresh line-1-to-EOF audit of all modified files (`lib/agent-tree.js`, `sidecars/dashboard/app.js`, `CHANGELOG.md`, `README.md`, plus the `1.1.1` bump files).

### Phase 3 — Adversarial Test Authoring & Audit (`@team-test`, `@team-auditor`)
- Author deterministic unit and negative-path tests in `tests/test_agent_tree.js` (registered in `tests/run-all.js`) covering:
  - Alphabetical ordering of `root.children` regardless of `lastUpdatedAt` order, including deterministic tie-breaking when two subagents share the same `subagentName`.
  - Retention of idle subagents within the 2-minute (`<= 120000` ms) grace window (preserving `isActive: false`, `runState: "idle"`, and parent main-root inclusion) and pruning once elapsed time exceeds `120000` ms.
  - Active subagents prioritized over idle subagents when `maxScan` is constrained.
  - Option validation (`idleGraceMs`, `nowMs`) negative paths.
- Audit the authored tests with a fresh `@team-auditor` pass.

### Phase 4 — QA Execution & Live Plugin Install (`@team-qa`)
- Execute `node tests/run-all.js`, `node --check`, and `node scripts/audit-gate.js` (logs saved in `Logs/`).
- Re-install the live plugin via `node bin/cli.js install`.

## Edge Cases

- **Identical subagent roles/names (e.g. two `team-auditor` instances):** Tie-break deterministically by `subagentType`, `conversationName`, and `conversationId`.
- **Clock skew / slightly ahead `lastModifiedTime`:** Small negative deltas (`nowMs - activityMs < 0` within e.g. 5000ms) should still count as within grace rather than dropping a just-finished subagent; large invalid timestamps return `false`.
- **`maxScan` saturation:** Active `cascadeStatuses` entries must be queued before recently-idle subagent entries so idle history never crowds out running agents.
- **Idle main conversations (non-subagents):** Idle main conversations without `isCurrent` or retained children remain pruned as before; the 2-minute retention applies specifically to idle subagents.

## Verification Strategy

1. `node scripts/audit-gate.js` -> `GATE VERDICT: PASS` (0 errors, 0 warnings).
2. `node --check` on all modified `.js`/`.mjs` files -> exit code 0.
3. `node tests/run-all.js` -> 100% pass, zero skipped tests, logs in `Logs/`.
4. `node bin/cli.js install` -> exit code 0.
