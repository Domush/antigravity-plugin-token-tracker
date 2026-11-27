# Changelog

All notable changes to `antigravity-plugin-token-tracker` will be documented in this file.

## [1.1.3] - 2026-11-27

### Improved
- **Automated Release Notes**: Updated the GitHub Actions release workflow to automatically extract and publish the matching `CHANGELOG.md` entry for each tagged release.

## [1.1.2] - 2026-11-27

### Added
- **Package Provenance & Runtime Alignment**: Aligned package and plugin manifest metadata with repository provenance, issue tracker, homepage links, and Node.js 22+ runtime compatibility.

## [1.1.1] - 2026-11-27

### Added
- **Live Lifecycle Hook Telemetry**: Synchronizes session startup summaries and proactive pre-turn compaction advisories with live Language Server token usage, displaying total context window utilization alongside cached-to-total prompt cache efficiency.
- **Resilient Model & Offline Cache Estimation**: Automatically enriches missing model metadata from live session telemetry when available and scans deeper into conversation history for accurate prompt cache ratios during offline operation.
- **Stable Subagent Ordering & Idle Grace Window**: Keeps subagent cards in consistent alphabetical order during concurrent activity and retains recently completed subagents in an idle state for two minutes before clearing them from the active agents tree.

## [1.1.0] - 2026-11-26

### Added
- **Streamlined Plugin Identity & Automatic Directory Migration**: Shortened the plugin identifier to `token-tracker` so global installs target `~/.gemini/config/plugins/token-tracker` (and workspace installs target `.gemini/plugins/token-tracker`) while automatically cleaning up any prior installation directory during install or uninstall.
- **Native Aux Pane Active Agents Tree Dashboard**: Redesigned the sidecar dashboard into an organized hierarchy grouping main sessions alongside their active subagents, with two-row main agent headers showing conversation titles, agent role badges (`main` or specialized roles), and model names cleanly without crowding.
- **Circular Progress Rings Default View**: Subagent cards now default to the circular SVG progress rings view for instant visual scanning across Context, Cache, and Compaction, with a header toggle (`Subagents: Rings` / `Subagents: Text`) to switch between rings and compact metrics.
- **Health Color-Coded Rings & Quota Bars**: Applied consistent green, amber, and red health thresholds across all quota bars and circular progress rings, anchored at the 6 o'clock orientation for clean visual alignment.
- **Mirrored Live Conversation Status & Clickable Navigation**: Displays live status indicators matching Antigravity's native states (processing spinner, waiting for response, error, and idle duration) alongside clickable conversation and subagent titles for one-click navigation.
- **Accurate Per-Model Compaction Thresholds**: Tailored automatic compaction countdowns to Antigravity's per-model checkpointer trigger limits (`512k` for Gemini 4, `256k` for Gemini 3.x Flash, `128k` for Gemini 2.5, `160k` for 200k Claude models, `512k` for 1M Claude models, and `80k` for GPT-OSS 120B).
- **Live Prompt Cache Accuracy & Auto-Refreshing Quotas**: Synchronizes exact prompt cache hits and auto-refreshes 5-hour and weekly quotas every poll cycle without requiring manual refreshes.
- **On-Demand Status Tool (`token_tracker_status`)**: Registered status tool allowing agents to inspect active context usage, prompt cache efficiency, subagent activity, and optional quota summaries on demand in Markdown or JSON.

## [1.0.0] - 2026-11-25

### Added
- **Hybrid Telemetry Architecture**: Initial release combining read-only conversation database monitoring, Language Server Connect-RPC quota telemetry, and a loopback telemetry server.
- **Comprehensive Model Catalog**: Context window sizing, display names, and quota group classification across Gemini, Claude, OpenAI, DeepSeek, and Grok models.
- **In-App Status Bar Pill**: Non-destructive Electron status pill mounted directly inside the agent input bar with hover/click telemetry popover.
- **Native Aux Pane Sidecar UI**: Real-time dashboard with 4-across Gemini and 3P quota telemetry cards and Antigravity light/dark theme synchronization.
- **Lifecycle Hooks & Unified CLI**: Automated session tracking, proactive compaction advisory warnings, and 1-click `npx` install/uninstall and injector setup commands.
