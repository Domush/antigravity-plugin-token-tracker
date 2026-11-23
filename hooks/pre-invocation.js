#!/usr/bin/env node
/**
 * Antigravity PreInvocation Lifecycle Hook.
 * Evaluates active trajectory volume against compaction thresholds
 * before each LLM turn, injecting proactive compaction headroom warnings
 * when near the compaction trigger.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { ConversationTracker, resolveSessionId } from "../lib/conversation-tracker.js";

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

async function main() {
  const rawInput = await readStdin();
  let payload = {};
  try {
    if (rawInput && rawInput.trim()) {
      payload = JSON.parse(rawInput);
    }
  } catch {
    // Non-fatal parse error
  }

  const convId = resolveSessionId(payload);
  const home = os.homedir();
  const dataDir = path.join(home, ".gemini", "antigravity", "plugin_data", "token-tracker");

  // Keep active conversation state updated
  try {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const stateFile = path.join(dataDir, "active_conversation.json");
    fs.writeFileSync(stateFile, JSON.stringify({ conversationId: convId, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  } catch {
    // Non-fatal filesystem recording error
  }

  const tracker = new ConversationTracker();
  let metrics = null;
  try {
    metrics = tracker.getConversationMetrics(convId);
  } catch {
    // If conversation cannot be queried yet, proceed without injection
  }

  // Only inject warning if approaching compaction or high context utilization
  if (metrics && metrics.compaction && metrics.compaction.isNearCompaction) {
    const lines = [
      `[token-tracker compaction advisory]`,
      `• Trajectory Volume: ${metrics.compaction.trajectoryKb} KB (${metrics.compaction.percentCompacted}% of ${metrics.compaction.thresholdKb} KB threshold)`,
      `• Compaction Headroom: ~${metrics.compaction.kbRemaining} KB remaining before automatic context compaction occurs.`,
      `• Prompt Cache: ${metrics.cache.hitRatioPercent}% hit ratio (${metrics.contextWindow.currentTokensFormatted} active tokens in context)`
    ];

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
    return;
  }

  // No injection needed for normal turns
  process.stdout.write(JSON.stringify({}) + "\n");
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
