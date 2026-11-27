#!/usr/bin/env node
/**
 * Antigravity Token Tracker — Zero-Dependency MCP Stdio Server.
 * Exposes the `token_tracker_status` tool over newline-delimited JSON-RPC 2.0.
 * All diagnostics and non-protocol logs are written strictly to stderr (console.error).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { ConversationTracker } from "../lib/conversation-tracker.js";
import { QuotaService } from "../lib/quota-service.js";
import { formatStatusMarkdown, formatStatusReport } from "./format.js";
import {
  VALID_FORMATS,
  TOOL_DEFINITIONS,
  isPlainObject,
  readActiveConversationId,
  resolveTargetConversationId,
  validateStatusArguments,
  executeTokenTrackerStatus
} from "./status-tool.js";

export const PROTOCOL_VERSION = "2024-11-05";

export {
  VALID_FORMATS,
  TOOL_DEFINITIONS,
  isPlainObject,
  readActiveConversationId,
  resolveTargetConversationId,
  validateStatusArguments,
  executeTokenTrackerStatus,
  formatStatusMarkdown,
  formatStatusReport
};

/**
 * Safely reads the package version from package.json.
 * @param {string} rootDir
 * @returns {string}
 */
export function loadPackageVersion(rootDir) {
  try {
    const pkgPath = path.join(rootDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (typeof parsed?.version === "string" && parsed.version.trim()) {
        return parsed.version.trim();
      }
    }
  } catch (err) {
    console.error(`[TokenTracker MCP] Failed to read package.json version: ${err.message}`);
  }
  return "1.0.0";
}

/**
 * Validates and handles an `initialize` JSON-RPC request.
 * @param {string|number} id
 * @param {*} params
 * @param {Object} state
 * @param {Object} deps
 */
function handleInitialize(id, params, state, { sendResponse, sendError, pkgVersion }) {
  if (params !== undefined && !isPlainObject(params)) {
    sendError(id, -32602, "Invalid params: expected plain object");
    return;
  }
  if (
    params?.rootPath !== undefined &&
    (typeof params.rootPath !== "string" || params.rootPath.trim().length === 0)
  ) {
    sendError(id, -32602, "Invalid params: rootPath must be a non-empty string");
    return;
  }
  if (
    params?.sessionId !== undefined &&
    (typeof params.sessionId !== "string" || params.sessionId.trim().length === 0)
  ) {
    sendError(id, -32602, "Invalid params: sessionId must be a non-empty string");
    return;
  }
  if (params?.sessionId !== undefined) {
    state.initSessionId = params.sessionId.trim();
  }
  sendResponse(id, {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: "token-tracker", version: pkgVersion }
  });
}

/**
 * Validates and handles a `tools/call` JSON-RPC request.
 * @param {string|number} id
 * @param {*} params
 * @param {Object} state
 * @param {Object} deps
 * @returns {Promise<void>}
 */
async function handleToolsCall(id, params, state, { sendResponse, sendError, tracker, quotaService, pluginDataDir }) {
  if (!isPlainObject(params)) {
    sendError(id, -32602, "Invalid params: expected plain object");
    return;
  }

  const toolName = params.name;
  if (typeof toolName !== "string" || toolName.trim().length === 0) {
    sendError(id, -32602, "Invalid params: name must be a non-empty string");
    return;
  }

  if (toolName !== "token_tracker_status") {
    sendError(id, -32601, `Unknown tool: ${toolName}`);
    return;
  }

  if (params._meta !== undefined && !isPlainObject(params._meta)) {
    sendError(id, -32602, "Invalid params: _meta must be a plain object");
    return;
  }

  const rawArgs = params.arguments;
  if (rawArgs !== undefined && !isPlainObject(rawArgs)) {
    sendError(id, -32602, "Invalid params: arguments must be a plain object");
    return;
  }

  let validatedArgs;
  try {
    validatedArgs = validateStatusArguments(rawArgs || {});
  } catch (validationErr) {
    sendError(id, -32602, `Invalid params: ${validationErr.message}`);
    return;
  }

  try {
    const { text } = await executeTokenTrackerStatus(validatedArgs, {
      params,
      initSessionId: state.initSessionId,
      tracker,
      quotaService,
      pluginDataDir
    });
    sendResponse(id, {
      content: [{ type: "text", text }],
      isError: false
    });
  } catch (toolErr) {
    const message = toolErr?.message || String(toolErr);
    console.error(`[TokenTracker MCP] Tool execution error (${toolName}): ${message}`);
    sendResponse(id, {
      content: [{ type: "text", text: `Tool error (${toolName}): ${message}` }],
      isError: true
    });
  }
}

function isValidJsonRpcId(id) {
  return id === null || typeof id === "string" || (typeof id === "number" && Number.isFinite(id));
}

/**
 * Processes a single parsed JSON-RPC 2.0 message and writes the response if required.
 * @param {*} msg
 * @param {Object} state
 * @param {Object} deps
 * @returns {Promise<void>}
 */
export async function handleJsonRpcMessage(msg, state, deps) {
  const { sendResponse, sendError } = deps;

  if (!isPlainObject(msg)) {
    sendError(null, -32600, "Invalid Request: expected JSON-RPC object");
    return;
  }

  const hasId = Object.hasOwn(msg, "id") && msg.id !== undefined;
  const rawId = hasId ? msg.id : null;
  if (hasId && !isValidJsonRpcId(rawId)) {
    sendError(null, -32600, "Invalid Request: id must be a string, finite number, or null");
    return;
  }

  if (msg.jsonrpc !== "2.0") {
    sendError(hasId ? rawId : null, -32600, 'Invalid Request: jsonrpc must be "2.0"');
    return;
  }

  const { method, params } = msg;
  if (typeof method !== "string" || method.trim().length === 0) {
    sendError(hasId ? rawId : null, -32600, "Invalid Request: method must be a non-empty string");
    return;
  }

  // Notifications carry no id member and require no JSON-RPC response
  if (!hasId) {
    return;
  }

  const id = rawId;
  if (method.startsWith("notifications/")) {
    sendResponse(id, {});
    return;
  }

  try {
    switch (method) {
      case "initialize":
        handleInitialize(id, params, state, deps);
        return;
      case "ping":
        sendResponse(id, {});
        return;
      case "tools/list":
        sendResponse(id, { tools: TOOL_DEFINITIONS });
        return;
      case "tools/call":
        await handleToolsCall(id, params, state, deps);
        return;
      default:
        sendError(id, -32601, `Method not found: ${method}`);
        return;
    }
  } catch (handlerErr) {
    console.error(`[TokenTracker MCP] Handler error for ${method}: ${handlerErr?.message || String(handlerErr)}`);
    sendError(id, -32603, "Internal server error", String(handlerErr));
  }
}

/**
 * Starts the newline-delimited JSON-RPC 2.0 MCP stdio server loop.
 */
export function startMcpServer() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const rootDir = path.resolve(__dirname, "..");
  const pkgVersion = loadPackageVersion(rootDir);
  const tracker = new ConversationTracker();
  const quotaService = new QuotaService();
  const pluginDataDir = path.join(os.homedir(), ".gemini", "antigravity", "plugin_data", "token-tracker");

  const state = { initSessionId: null };

  const sendJsonRpc = (obj) => {
    try {
      process.stdout.write(JSON.stringify(obj) + "\n");
    } catch (err) {
      console.error(`[TokenTracker MCP] Failed writing JSON-RPC response to stdout: ${err.message}`);
    }
  };

  const sendResponse = (id, result) => {
    sendJsonRpc({ jsonrpc: "2.0", id, result });
  };

  const sendError = (id, code, message, data) => {
    sendJsonRpc({
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data !== undefined ? { data } : {})
      }
    });
  };

  const deps = { sendResponse, sendError, pkgVersion, tracker, quotaService, pluginDataDir };

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false
  });

  const inFlight = new Set();
  let isClosing = false;
  let lineQueue = Promise.resolve();

  const maybeExit = () => {
    if (isClosing && inFlight.size === 0) {
      process.exit(0);
    }
  };

  rl.on("line", (line) => {
    const task = (lineQueue = lineQueue.then(async () => {
      try {
        const trimmed = line.trim();
        if (!trimmed) return;

        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch (err) {
          sendError(null, -32700, "Parse error", String(err));
          return;
        }

        await handleJsonRpcMessage(msg, state, deps);
      } catch (err) {
        console.error(`[TokenTracker MCP] Unexpected line processing error: ${err?.message || String(err)}`);
      }
    }));

    inFlight.add(task);
    task.finally(() => {
      inFlight.delete(task);
      maybeExit();
    });
  });

  rl.on("close", () => {
    isClosing = true;
    maybeExit();
  });

  process.on("SIGINT", () => {
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    process.exit(0);
  });
}

function checkIfMain() {
  if (!process.argv[1]) return false;
  const scriptPath = fileURLToPath(import.meta.url);
  const argPath = process.argv[1];

  if (path.resolve(scriptPath).toLowerCase() === path.resolve(argPath).toLowerCase()) {
    return true;
  }

  try {
    if (fs.existsSync(argPath) && fs.realpathSync(argPath).toLowerCase() === fs.realpathSync(scriptPath).toLowerCase()) {
      return true;
    }
  } catch (err) {
    console.error(`[TokenTracker MCP] Entrypoint symlink resolution check failed: ${err.message}`);
  }

  return false;
}

export const isMain = checkIfMain();

if (isMain) {
  startMcpServer();
}
