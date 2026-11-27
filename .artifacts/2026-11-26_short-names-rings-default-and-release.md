# Plan: Short Plugin Naming, Rings Default Display & v1.1.0 Release

**Date:** 2026-11-26
**Target Version:** `1.1.0` (bumped from `1.0.0`)
**Pipeline Scope:** Full with Audit + CLI Tests + QA (`@team-coder` -> `@team-test` -> `@team-auditor` -> `@team-qa` -> install, commit & tag `v1.1.0`)

---

## 1. Goal

1. Align plugin short naming and install directory with the `context-mode` template:
   - `plugin.json`: `"name": "token-tracker"`, `"displayName": "Token Tracker"`, `"version": "1.1.0"`.
   - `package.json`: preserve npm package `"name": "antigravity-plugin-token-tracker"` and bin key, update `"displayName": "Token Tracker"`, `"version": "1.1.0"`, and add `"CHANGELOG.md"` to `"files"`.
   - `bin/cli.js`: install/uninstall targeting `token-tracker` (`~/.gemini/config/plugins/token-tracker` global, `.gemini/plugins/token-tracker` workspace), include `CHANGELOG.md` in `ESSENTIAL_FILES`, and safely clean up / migrate legacy `antigravity-plugin-token-tracker` directories on install and uninstall (handling junctions/symlinks without touching targets and handling active Windows file locks gracefully).
2. Set `"rings"` (`"graphic"`) as the default subagent card display mode (`sidecars/dashboard/app.js` and initial button state in `sidecars/dashboard/index.html`).
3. Create `CHANGELOG.md`, apply targeted `README.md` updates for the new install directory and `v1.1.0`, update `tests/test_cli.js` for `token-tracker` paths and legacy cleanup tests, deploy with `node bin/cli.js install`, commit, and tag `v1.1.0`.

---

## 2. Edge Cases & Guards

- **Symlink / Junction Safety:** Never dereference or delete contents of a symlinked legacy directory target during migration.
- **Self-Overwrite Protection:** Never remove `legacyDir` when `legacyDir === targetDir` or when `legacyDir` equals/encloses `sourceDir`.
- **Windows File Locks:** Active Antigravity sessions may hold `EPERM` / `EBUSY` / `ENOTEMPTY` locks on the legacy directory; emit an actionable `stderr` notice while exiting `0` after installing into `token-tracker`.
- **LocalStorage & Sandbox Safety:** `readSubagentDisplayMode()` defaults to `"graphic"` when storage is unset or inaccessible, and switches to `"text"` only when explicitly stored as `"text"`.

---

## 3. Verification Strategy

- Static Audit Gate: `node scripts/audit-gate.js` on all modified source files (< 500 lines each, zero warnings/errors).
- Adversarial Test Authoring (`@team-test`): update `tests/test_cli.js` for `token-tracker`, legacy migration/cleanup, and `CHANGELOG.md` bundle checks.
- Adversarial Audit (`@team-auditor`): full line-1-to-EOF audit of production files, manifests, docs, and test changes.
- QA Execution (`@team-qa`): run `node tests/test_cli.js`, `node tests/test_models.js`, `node tests/test_quota_service.js`, `node --check`, and `node bin/cli.js install`, logging results to `Logs/`.
