# Antigravity Token Tracker Plugin

Production-grade Hybrid Token Tracker plugin for Antigravity providing real-time context window usage, prompt cache hit ratios, context compaction countdown, and Language Server quota telemetry via synchronized in-app UI and native Sidecar Aux Pane dashboard.

---

## Key Features

1. **Context Window Tracking**:
   - Real-time active tokens, maximum context window tokens, and percentage utilization.
   - Comprehensive model catalog covering Gemini (1M/2M context), Claude 3.5/3.7 Sonnet (200k), GPT-4o (128k), and reasoning models.
2. **Prompt Cache Efficiency**:
   - Accurate tracking of cached prompt tokens vs. newly computed tokens.
   - Cache hit ratio percentage reflecting prefix caching gains.
3. **Context Compaction Headroom**:
   - Tracks cumulative trajectory byte volume from conversation SQLite tables.
   - Calculates exact KB remaining until automatic compaction is triggered (~180 KB standard trigger threshold).
   - Generates proactive compaction advisory warnings when headroom drops below 35 KB.
4. **Language Server Connect-RPC Quota Telemetry**:
   - Direct integration with local Language Server `RetrieveUserQuotaSummary` RPC over HTTP.
   - Auto-discovers active port and `x-codeium-csrf-token` from environment, daemon manifests (`~/.gemini/antigravity/daemon/hub_*.json`), and server logs.
   - Live 5-Hour and Weekly limits with human-readable reset countdowns (e.g. `1h 25m`, `5d 14h`) for both Gemini Models and Claude/GPT 3P models.
5. **Synchronized Dual Interface**:
   - **In-Input-Box Status Pill**: Injected directly into `#antigravity.agentSidePanelInputBox` to the left of the `Turbo ∨` Local Permissions selector. Displays live pill summary with color-coded status dot and interactive hover/click telemetry popover card.
   - **Native Aux Pane Sidecar Web UI**: Official `SIDECAR_UI_ENTRYPOINT_AUX_PANE` dashboard in `sidecars/dashboard/` rendering animated radial SVG rings and progress gauges with dark/light Antigravity theme synchronization.

---

## Architecture Overview

```
antigravity-plugin-token-tracker/
├── bin/
│   └── cli.js                     # Unified NPX CLI entry point (install/injector)
├── package.json                   # Manifest & npm lifecycle scripts
├── plugin.json                    # Antigravity plugin descriptor
├── hooks.json                     # SessionStart & PreInvocation hook declarations
├── hooks/
│   ├── session-start.js           # SessionStart hook recording active conversation
│   └── pre-invocation.js          # PreInvocation hook injecting compaction warnings
├── lib/
│   ├── models.js                  # Model catalog & context window sizing
│   ├── quota-service.js           # Connect-RPC client for RetrieveUserQuotaSummary
│   ├── conversation-tracker.js    # Read-only SQLite parser for conversation telemetry
│   └── telemetry-server.js        # Loopback HTTP server (127.0.0.1:8976)
├── injector/
│   ├── status-bar.js              # Vanilla JS widget mounting to #antigravity.agentSidePanelInputBox
│   ├── install.js                 # Safe, non-destructive installer with backup & rollback
│   └── uninstall.js               # Pristine rollback uninstaller restoring app.asar
├── sidecars/
│   └── dashboard/
│       ├── sidecar.json           # Native Aux Pane sidecar descriptor
│       ├── server.mjs             # sidecar_sdk server with standalone fallback
│       └── index.html             # Responsive dashboard with SVG radial rings
├── scripts/
│   └── audit-gate.js              # Deterministic P0 static audit gate
└── tests/
    └── run-all.js                 # Comprehensive unit & integration test runner
```

---

## Quick Install (npx)

Install the plugin directly into Google Antigravity using `npx`:

```bash
# Install plugin into Antigravity plugins directory (~/.gemini/config/plugins/)
npx antigravity-plugin-token-tracker install

# Inject real-time status-bar pill into Antigravity input box
npx antigravity-plugin-token-tracker install-injector

# Uninstall plugin when no longer needed
npx antigravity-plugin-token-tracker uninstall
```

### CLI Commands & Options

| Command | Description |
| :--- | :--- |
| `npx antigravity-plugin-token-tracker install` | Installs plugin into global Antigravity config directory (`~/.gemini/config/plugins/`) |
| `npx antigravity-plugin-token-tracker install --workspace` | Installs plugin into current workspace (`.gemini/plugins/`) |
| `npx antigravity-plugin-token-tracker uninstall` | Removes plugin from global Antigravity config directory |
| `npx antigravity-plugin-token-tracker uninstall --workspace` | Removes plugin from current workspace directory |
| `npx antigravity-plugin-token-tracker install-injector` | Patches Electron `app.asar` to enable the status-bar pill |
| `npx antigravity-plugin-token-tracker install-injector --dry-run` | Validates ASAR patching integrity without mutating files |
| `npx antigravity-plugin-token-tracker uninstall-injector` | Restores pristine `app.asar` from backup and unlinks script |
| `npx antigravity-plugin-token-tracker --version` | Displays current version (`v1.0.0`) |
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
