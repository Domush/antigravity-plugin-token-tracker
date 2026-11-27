# Antigravity Token Tracker Plugin

Production-grade Hybrid Token Tracker plugin for Antigravity providing real-time context window usage, prompt cache hit ratios, context compaction countdown, and Language Server quota telemetry via synchronized in-app UI and native Sidecar Aux Pane dashboard.

---

## Key Features

1. **Context Window Tracking**:
   - Real-time active tokens, maximum context window tokens, and percentage utilization.
   - Comprehensive model catalog covering Gemini 4, Gemini 3.x, and Gemini 2.5 (1M/2M context), Claude 5.5 and 4.x (200k/1M context), OpenAI GPT-5, GPT-4.1, o3/o4, and GPT-OSS, DeepSeek, and Grok.
2. **Prompt Cache Efficiency**:
   - Accurate tracking of cached prompt tokens vs. newly computed tokens.
   - Cache hit ratio percentage reflecting prefix caching gains.
3. **Context Compaction Headroom**:
   - Tracks active prompt context size relative to each model's context window capacity.
   - Calculates remaining tokens and KB headroom until Antigravity's per-model automatic compaction trigger is reached (such as 512k for Gemini 4, 256k for Gemini 3.x Flash, and 160k for 200k Claude models).
   - Generates proactive compaction advisory warnings as active context approaches the compaction trigger.
4. **Language Server Connect-RPC Quota Telemetry**:
   - Direct integration with local Language Server `RetrieveUserQuotaSummary` RPC over HTTP.
   - Auto-discovers active port and `x-codeium-csrf-token` from environment, daemon manifests (`~/.gemini/antigravity/daemon/hub_*.json`), and server logs.
   - Live 5-Hour and Weekly limits with human-readable reset countdowns (e.g. `1h 25m`, `5d 14h`) for both Gemini Models and Claude/GPT 3P models.
5. **Synchronized Dual Interface**:
   - **In-Input-Box Status Pill**: Injected directly into `#antigravity.agentSidePanelInputBox` to the left of the `Turbo ∨` Local Permissions selector. Displays live pill summary with color-coded status dot and interactive hover/click telemetry popover card.
   - **Native Aux Pane Sidecar Web UI**: Official `SIDECAR_UI_ENTRYPOINT_AUX_PANE` dashboard in `sidecars/dashboard/` displaying a compact 4-across health color-coded quota strip (`Gemini 5-Hour`, `Gemini Weekly`, `Claude/GPT 5-Hour`, `Claude/GPT Weekly`), a live Active Agents tree with mirrored conversation status icons (processing, waiting for response, error, and idle duration), clickable conversation and subagent titles for instant navigation, health color-coded circular progress rings (default view) and compact metrics, dark/light Antigravity theme synchronization, and a header toggle between ring and text views for active subagents.

---

## Architecture Overview

```
antigravity-plugin-token-tracker/
├── assets/
│   └── icon.svg                   # Plugin vector icon badge
├── bin/
│   └── cli.js                     # Unified NPX CLI entry point (install/injector)
├── package.json                   # Manifest & npm lifecycle scripts
├── plugin.json                    # Antigravity plugin descriptor
├── CHANGELOG.md                   # Release history and version notes
├── hooks.json                     # SessionStart & PreInvocation hook declarations
├── mcp_config.json                # On-demand Token Tracker status tool registration
├── hooks/
│   ├── session-start.js           # SessionStart hook recording active conversation
│   └── pre-invocation.js          # PreInvocation hook injecting compaction warnings
├── lib/
│   ├── model-catalog.js           # Immutable model context window catalog
│   ├── model-detector.js          # Binary & text model identifier extraction
│   ├── models.js                  # Model normalization & context window sizing
│   ├── compaction.js              # Active-context compaction threshold & headroom calculations
│   ├── ls-rpc.js                  # Loopback Connect-RPC HTTP transport helper
│   ├── quota-service.js           # Connect-RPC client for RetrieveUserQuotaSummary
│   ├── conversation-tracker.js    # Read-only SQLite parser for conversation telemetry
│   ├── subagent-tracker.js        # Child subagent discovery & context telemetry reader
│   ├── active-status.js           # Live active vs. idle session & path confinement helpers
│   ├── agent-tree.js              # Active main & subagent tree discovery
│   └── telemetry-server.js        # Loopback HTTP server (127.0.0.1:8976)
├── mcp/
│   ├── server.js                  # On-demand status tool server for Antigravity agents
│   ├── status-tool.js             # Status tool schema, validation, and handler
│   └── format.js                  # Markdown & JSON status output formatters
├── injector/
│   ├── status-bar.js              # Vanilla JS widget mounting to #antigravity.agentSidePanelInputBox
│   ├── install.js                 # Safe, non-destructive installer with backup & rollback
│   └── uninstall.js               # Pristine rollback uninstaller restoring app.asar
├── sidecars/
│   └── dashboard/
│       ├── sidecar.json           # Native Aux Pane sidecar descriptor
│       ├── server.mjs             # sidecar_sdk server with standalone fallback
│       ├── index.html             # Dense compact tree dashboard structure
│       ├── styles.css             # Theme-aware compact tree & quota strip styles
│       └── app.js                 # Live telemetry polling & DOM tree renderer
├── scripts/
│   └── audit-gate.js              # Deterministic P0 static audit gate
└── tests/
    └── run-all.js                 # Comprehensive unit & integration test runner
```

---

## Quick Install (npx)

Install the plugin directly into Google Antigravity using `npx`:

> **Note:** Antigravity requires a standard copied plugin directory rather than a symlink or Windows junction. Run the `npx` install command below to deploy a clean copy into your plugins folder.

```bash
# Install plugin into Antigravity plugins directory (~/.gemini/config/plugins/token-tracker/)
npx antigravity-plugin-token-tracker install

# Inject real-time status-bar pill into Antigravity input box
npx antigravity-plugin-token-tracker install-injector

# Uninstall plugin when no longer needed
npx antigravity-plugin-token-tracker uninstall
```

### CLI Commands & Options

| Command | Description |
| :--- | :--- |
| `npx antigravity-plugin-token-tracker install` | Installs plugin into global Antigravity config directory (`~/.gemini/config/plugins/token-tracker/`) |
| `npx antigravity-plugin-token-tracker install --workspace` | Installs plugin into current workspace (`.gemini/plugins/token-tracker/`) |
| `npx antigravity-plugin-token-tracker uninstall` | Removes plugin from global Antigravity config directory |
| `npx antigravity-plugin-token-tracker uninstall --workspace` | Removes plugin from current workspace directory |
| `npx antigravity-plugin-token-tracker install-injector` | Patches Electron `app.asar` to enable the status-bar pill |
| `npx antigravity-plugin-token-tracker install-injector --dry-run` | Validates ASAR patching integrity without mutating files |
| `npx antigravity-plugin-token-tracker uninstall-injector` | Restores pristine `app.asar` from backup and unlinks script |
| `npx antigravity-plugin-token-tracker --version` | Displays current version (`v1.1.0`) |
| `npx antigravity-plugin-token-tracker --help` | Displays CLI usage instructions and options |

---

## Installation & Setup

### 1. In-App Status Bar Pill (Electron Preload Injection)

To mount the status-bar pill inside Antigravity's agent side panel input box:

```bash
# Run safe installer (creates automatic backup app.asar.token_tracker_backup)
npm run install-injector

# Or test in dry-run mode
node injector/install.js --dry-run
```

To roll back at any time:

```bash
# Safely restores pristine app.asar and cleans up deployed files
npm run uninstall-injector
```

### 2. Native Sidecar Dashboard

The native Sidecar Web UI is declared in `sidecars/dashboard/sidecar.json` and runs automatically in Antigravity's right-hand Aux Pane when the plugin is active.

To run the dashboard in standalone browser mode for local inspection:

```bash
npm run sidecar
# Open http://127.0.0.1:8979 in your browser
```

### 3. Loopback Telemetry Server

The background telemetry server serves real-time JSON metrics to both interfaces:

```bash
npm run start-telemetry
```

Endpoints:
- `GET /api/telemetry?conversationId=<id>`: Consolidated live metrics.
- `GET /api/refresh`: Forces instant re-fetch from Connect-RPC and SQLite.
- `GET /api/health`: Health status, PID, and uptime.

### 4. On-Demand Agent Status & Subagent Monitoring

Antigravity Token Tracker includes a built-in status tool (`token_tracker_status`) registered automatically through `mcp_config.json`, allowing agents to check live telemetry whenever needed without extra prompt overhead:

- **Live Context & Cache Snapshot**: Inspect active model capacity, context usage, prompt cache hit efficiency, and compaction headroom on demand.
- **Subagent Visibility**: Monitor token usage, cache efficiency, and active status across child subagents spawned during a session.
- **Optional Quota Check**: Retrieve current 5-hour and weekly quota levels alongside conversation telemetry in either concise Markdown or structured JSON.

---

## Verification & Testing

Run unit and integration test suite:

```bash
npm test
```

Execute the deterministic static audit gate:

```bash
npm run audit-gate
```
