# Repository Agent Guidelines

## Rules Overview

- **PACKAGE ISOLATION:** This package is for retail consumption. System-specific code/references/values are PROHIBITED.
- **ZERO LEGACY CODE:** When making code changes, change ALL related code. NEVER create compatibility layers or aliases or legacy fallbacks. ALL changes must be universally applied. If a change may break existing configurations or databases, create background migration support.

## Mandatory Artifact Workflow (`.artifacts/`)

All plans, reviews, and final implementation summaries **must** be saved as Markdown artifacts inside the `.artifacts/` directory at the repository root.

- **Filename template:**
  - Plans: `YYYY-MM-DD_<topic>.md`
  - Reviews: `YYYY-MM-DD_<topic>-review.md`
  - Final implementation summaries: `YYYY-MM-DD_<topic>-summary.md`
- **Plan artifacts** must document the goal, detailed implementation steps/phases, edge cases, and verification strategy before implementation begins.
- **Review artifacts** must list concrete findings (with file paths and line references, if applicable), and a list of recommended next steps.
- **Final implementation summary artifacts** must list all created/modified files, implemented/changed behavior.

## Mandatory Logs & Test Outputs (`Logs/`)

All command logs, Unity Editor/batchmode logs, and test result reports (such as NUnit or Unity Test Runner `.xml` / `.log` files) **must** be written to the `Logs/` directory at the repository root (e.g., `Logs/test-results.xml`, `Logs/unity-test.log`).

- Do **not** write test result files or log dumps to the repository root, `Assets/`, or `Packages/`.

## Documentation updates

Whenever making code changes that alter existing behavior or add/change/remove features, you MUST update the related documentation, store description, CHANGELOG, and README files to match the new behavior and/or functionality.

- **ZERO HISTORICAL REFERENCES:** Documentation must reflect the *current* state of Infinity, not what it used to be. Never refer to past functionality or removed features.
- **END-USER FRIENDLY:** All README, CHANGELOG, and store descriptions must target end users and be general in nature. NEVER add ultra-specific details such as method names or variables or overly-technical terms.
- **SALES APPROPRIATE:** Frame all changes as positive improvements. Never list ongoing issues or errors or problems, the goal is to sell this package, not scare people away with red flags.
- **TARGETED CHANGES:** When making changes to documents, limit updates to what is directly related. NEVER make large-scale changes or modify existing wording to unrelated sections unless explicitly directed by the user.