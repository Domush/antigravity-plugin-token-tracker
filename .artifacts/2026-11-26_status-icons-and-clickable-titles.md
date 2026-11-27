# Plan: Mirror Conversation List Status Icons & Clickable Conversation Titles

**Date:** 2026-11-26
**Package Version:** `1.0.0` (unchanged)
**Pipeline Scope:** With Audit (`@team-coder` -> `@team-auditor` -> `node bin/cli.js install`)

---

## 1. Goal

1. Replace the green/gray status dots on main and subagent cards with Antigravity-style status indicators:
   - **Processing / Running:** Animated spinning indicator (`running` / `busy` / `canceling`).
   - **Waiting / Question:** Question/input-needed indicator when a step is in `CORTEX_STEP_STATUS_WAITING` (e.g. `ask_question` or permission approval).
   - **Error:** Alert indicator when `latestExecutorTerminationReason === "EXECUTOR_TERMINATION_REASON_ERROR"`.
   - **Idle:** Compact clock/idle indicator with elapsed idle time (`<1m`, `4m`, `2h`, `1d`) derived from `lastModifiedTime` / `lastUpdatedAt`.
2. Make main conversation titles and subagent names clickable buttons that jump directly to that conversation via `window.sidecar.ui.toggleConversation(conversationId)` (with standalone URL `?conversationId=` navigation fallback).

---

## 2. Implementation

- **`lib/ls-cascade.js`:**
  - Extract `latestTerminationReason` on `parseCascadeStatuses` entries.
  - Extract `isWaitingForUser` (`CORTEX_STEP_STATUS_WAITING`) and `waitingToolName` (e.g. `ask_question`) in `extractLatestModelUsage` (or companion `extractCascadeStepState`) when scanning `GetCascadeTrajectorySteps`.
- **`lib/agent-tree.js` & `sidecars/dashboard/server.mjs`:**
  - Populate `runState` (`"running" | "waiting" | "error" | "idle"`) and `idleSinceMs` / `lastModifiedTime` on each condensed tree node (updating `runState = "waiting"` when `usage.isWaitingForUser === true`!).
- **`sidecars/dashboard/cards.js`, `app.js`, `styles.css`:**
  - Replace the status dot element with `buildStatusIndicator(node)` rendering crisp inline SVG icons (`createElementNS`, zero `innerHTML`) for `running` (animated CSS spin), `waiting` (question circle `?`), `error` (alert icon), and `idle` (elapsed duration badge like `3m` + subtle clock icon).
  - Render main conversation titles and subagent names as accessible `<button type="button" class="conv-link ...">` elements wired to `window.sidecar?.ui?.toggleConversation(conversationId)` (with standalone fallback).
