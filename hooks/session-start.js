#!/usr/bin/env node
/**
 * Antigravity SessionStart Lifecycle Hook.
 * Records the active conversation ID, verifies telemetry server registry,
 * and emits initial token usage, quota, and compaction status.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { ConversationTracker, resolveSessionId, isSubagentPayload } from "../lib/conversation-tracker.js";
import { QuotaService } from "../lib/quota-service.js";

export { resolveSessionId, isSubagentPayload };

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      resolve(data);
    });
  });
}

function notifyTelemetryServer(port, conversationId) {
  if (!port || !conversationId) return;
  const postData = JSON.stringify({ conversationId });
  const req = http.request(
    {
      hostname: "127.0.0.1",
      port,
      path: "/api/set-conversation",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      },
      timeout: 1000
    },
    (res) => {
      res.resume();
    }
  );
  req.on("timeout", () => {
    req.destroy(new Error("Timeout notifying telemetry server"));
  });
  req.on("error", (err) => {
    console.error("[TokenTracker SessionStart] Telemetry notify non-fatal error:", err.message);
  });
  req.write(postData);
  req.end();
}

async function main() {
  const rawInput = await readStdin();
  let payload = {};
  try {
    if (rawInput && rawInput.trim()) {
      payload = JSON.parse(rawInput);
    }
  } catch {
    // Fallback to empty payload
  }

  const tracker = new ConversationTracker();
  const quotaService = new QuotaService();
  const rawConvId = resolveSessionId(payload);
  const convId = typeof rawConvId === "string" && rawConvId.trim() ? rawConvId.trim() : null;
  const isSubagent = isSubagentPayload(payload, convId);

  // Record active conversation in plugin data directory (skip for background subagents)
  if (!isSubagent && convId) {
    const home = os.homedir();
    const dataDir = path.join(home, ".gemini", "antigravity", "plugin_data", "token-tracker");
    try {
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const stateFile = path.join(dataDir, "active_conversation.json");
      fs.writeFileSync(stateFile, JSON.stringify({ conversationId: convId, updatedAt: new Date().toISOString() }, null, 2), "utf8");

      // Ping running telemetry server if registered
      const regFile = path.join(dataDir, "telemetry-server.json");
      if (fs.existsSync(regFile)) {
        const reg = JSON.parse(fs.readFileSync(regFile, "utf8"));
        if (reg.port) {
          notifyTelemetryServer(reg.port, convId);
        }
      }
    } catch {
      // Non-fatal filesystem recording error
    }
  }

  let metrics = null;
  let quota = null;

  try {
    metrics = tracker.getConversationMetrics(convId, { strict: Boolean(convId) });
  } catch {
    // First invocation may have empty db
  }

  try {
    quota = await quotaService.getQuotaSummary(false);
  } catch {
    // Language server may be initializing
  }

  const lines = ["[token-tracker active]"];
  if (metrics) {
    lines.push(`• Model: ${metrics.model.displayName} (${metrics.contextWindow.maxTokensFormatted} max context)`);
    lines.push(`• Context Usage: ${metrics.contextWindow.currentTokensFormatted} tokens (${metrics.contextWindow.percentUsed}%)`);
    lines.push(`• Cache Efficiency: ${metrics.cache.hitRatioPercent}% hit ratio (${metrics.cache.cachedTokensFormatted} cached / ${metrics.cache.uncachedTokensFormatted} uncached)`);
    const comp = metrics.compaction;
    const hasTokenHeadroom = Boolean(comp.tokensRemainingFormatted && comp.thresholdTokensFormatted);
    if (comp.isNearCompaction) {
      if (hasTokenHeadroom) {
        lines.push(`• ⚠️ Compaction Alert: Active Context ${comp.activeTokensFormatted || "0"} / Trigger ${comp.thresholdTokensFormatted} (${comp.percentCompacted}%, ${comp.tokensRemainingFormatted} tokens / ~${comp.kbRemaining} KB remaining)`);
      } else {
        lines.push(`• ⚠️ Compaction Alert: Active Context ${comp.trajectoryKb} KB / Trigger ${comp.thresholdKb} KB (${comp.kbRemaining} KB remaining)`);
      }
    } else if (hasTokenHeadroom) {
      lines.push(`• Compaction Headroom: ${comp.tokensRemainingFormatted} tokens (~${comp.kbRemaining} KB) remaining before automatic compaction (Trigger: ${comp.thresholdTokensFormatted})`);
    } else {
      lines.push(`• Compaction Headroom: ${comp.kbRemaining} KB remaining before automatic compaction`);
    }
  }

  if (quota) {
    const g5h = quota.gemini.fiveHour;
    const gWk = quota.gemini.weekly;
    lines.push(`• Gemini Quotas: 5h limit ${g5h.remainingPercent}% (resets ${g5h.countdown}), Weekly ${gWk.remainingPercent}% (resets ${gWk.countdown})`);
  }

  const response = {
    injectSteps: [
      {
        systemMessage: {
          systemMessage: lines.join("\n")
        }
      }
    ]
  };

  process.stdout.write(JSON.stringify(response) + "\n");
}

const isMain = Boolean(
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
);

if (isMain) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({}) + "\n");
  });
}
