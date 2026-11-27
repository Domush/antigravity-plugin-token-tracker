# Plan: Model Catalog Update & Junction-Safe Plugin Installation

**Date:** 2026-11-26
**Package Version:** `1.0.0` (unchanged; pre-release)
**Pipeline Scope:** Full (`@team-coder` -> `@team-auditor` -> `@team-test` -> `@team-auditor` -> `@team-qa` -> `@team-planner`)

---

## 1. Goal

1. Update the outdated model catalog and identifier extraction logic (`lib/models.js`, `lib/conversation-tracker.js`) to support current Antigravity and third-party models (Gemini 4 Hydrogen/Argon/Carbon/Neon, Gemini 3.x/2.5, Claude 5.5/4.x, OpenAI GPT-5/GPT-4.1/o3/o4/GPT-OSS, DeepSeek, and xAI Grok).
2. Fix plugin installation edge cases when an existing Windows junction or symlink exists at the target plugin directory (`bin/cli.js`), and replace the active junction at `C:\Users\domus\.gemini\config\plugins\antigravity-plugin-token-tracker` with a clean directory copy.
3. Update `README.md` to reflect current supported models and explicitly note that Antigravity requires a copied installation (not a junction/symlink), while keeping package version at `1.0.0`.

---

## 2. Implementation Phases

### Phase 1: Model Catalog & Extraction (`@team-coder`)
- **`lib/models.js`** (or modular `lib/model-catalog.js` if needed to stay well under the 500-line ceiling):
  - Add current Google Gemini 4 models (`gemini-4-hydrogen`, `gemini-4-argon`, `gemini-4-carbon`, `gemini-4-neon` with `-low`, `-medium`, `-high`, `-xhigh`, `-sonar`, `-orchestrator` tiers), Gemini 3.8/3.7/3.6/3.5/3.1/3/2.5 models, and retain 1.5 legacy keys.
  - Add current Anthropic Claude models (`claude-opus-5-5`, `claude-sonnet-5-5` with `-low`, `-medium`, `-high`, `-max`, `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-opus-4-6`, `claude-sonnet-4-5`, `claude-opus-4-5`, `claude-haiku-4-5`, `claude-sonnet-4`, plus 1M context variants and `@default` / `@YYYYMMDD` suffix handling).
  - Add OpenAI (`gpt-5`, `gpt-5.1`, `gpt-5.2`, `gpt-5-mini`, `gpt-5-nano`, `gpt-4.1`, `gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-4.5`, `o3`, `o3-pro`, `o3-mini`, `o4-mini`, `gpt-oss-120b`, `gpt-oss-20b`, `openai/gpt-oss-*-maas`), DeepSeek (`deepseek-r1`, `deepseek-v3`, `deepseek-v3.1`, `deepseek-v3.2`), and xAI (`grok-4`, `grok-3`, `grok-3-mini`, `grok-2`).
  - Update `sanitizeModelKey`, `getModelContextWindow`, `normalizeModelName`, and `detectModelGroup` fuzzy matchers and normalization rules (handling `/`, `@` suffixes, dot/hyphen variants, and third-party prefixes like `grok`, `o4`, `openai/`).
- **`lib/conversation-tracker.js`**:
  - Update `extractModelIdentifier` regexes to detect Gemini 4, Gemini 3.x/2.5, Claude 5.5/4.x/3.x (Opus/Sonnet/Haiku with tiers), OpenAI GPT/o-series/GPT-OSS, DeepSeek, and Grok identifiers and display names.

### Phase 2: Junction-Safe CLI Install & Docs (`@team-coder`)
- **`bin/cli.js`**:
  - In `installPlugin`: inspect `targetDir` with `fs.lstatSync` (handling `ENOENT` safely). If `targetDir` is a symbolic link or Windows junction (`isSymbolicLink()`), remove it (`fs.rmSync(targetDir, { recursive: true, force: true })`) before `fs.mkdirSync(targetDir, { recursive: true })` and copying files/directories. Fail fast if `sourceDir` and non-symlink `targetDir` resolve to the same path.
  - In `uninstallPlugin`: use `fs.lstatSync` instead of `fs.existsSync` so broken symlinks/junctions are also removed cleanly.
- **`README.md`**:
  - Update the supported models bullet and add a note clarifying that Antigravity plugins must be installed as copied directories via the CLI (symlinks/junctions are unsupported).

### Phase 3: Adversarial Audit & Test Coverage (`@team-auditor` & `@team-test`)
- Audit production changes from line 1 to EOF.
- Author boundary, negative-path, and regression tests in `tests/test_models.js`, `tests/test_conversation_tracker.js`, and `tests/test_cli.js` (including symlink/junction replacement in `installPlugin`).
- Audit test changes from line 1 to EOF.

### Phase 4: QA Verification & Live Reinstall (`@team-qa`)
- Execute `npm test` and `npm run audit-gate`, capturing logs to `Logs/`.
- Run `node bin/cli.js install` to replace the junction at `C:\Users\domus\.gemini\config\plugins\antigravity-plugin-token-tracker` with a real directory copy and verify `LinkType` is empty.

---

## 3. Edge Cases

- Model identifiers containing `@default` or `@YYYYMMDD` version tags, `openai/` vendor prefixes, parentheses/spaces (`Gemini 4 Hydrogen (High)`), or dot vs. hyphen separators (`claude-opus-5.5` vs `claude-opus-5-5`).
- Broken or active Windows junctions/symlinks at `targetDir` where `fs.existsSync` or `fs.cpSync` would otherwise misbehave or fail with `EINVAL`/`EEXIST`.
- Source code files remaining under the 500-line ceiling.

---

## 4. Verification Strategy

- `node scripts/audit-gate.js -f "<modified files>"`
- `npm test` (logged to `Logs/`)
- `npm run audit-gate`
- `Get-Item "$env:USERPROFILE\.gemini\config\plugins\antigravity-plugin-token-tracker"` confirming `LinkType` is empty and files are present.
