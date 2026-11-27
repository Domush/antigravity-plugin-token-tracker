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
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { ConversationTracker, resolveSessionId, isSubagentPayload } from "../lib/conversation-tracker.js";

export const ADVISORY_COOLDOWN_MS = 120000;
export const MIN_PERCENT_DELTA = 5;
export const MIN_KB_DELTA = 32;

/**
 * Evaluates whether a compaction advisory should be emitted for the current turn,
 * enforcing per-conversation deduplication, a 2-minute cooldown, and a minimal-change guard.
 * @param {Object|null|undefined} metrics
 * @param {Object|null|undefined} [prevState=null]
 * @param {number} [nowMs=Date.now()]
 * @returns {{ emit: boolean, nextState: Object|null }}
 */
export function shouldEmitCompactionAdvisory(metrics, prevState = null, nowMs = Date.now()) {
  const currentNow = typeof nowMs === "number" && Number.isFinite(nowMs) ? nowMs : Date.now();
  const compaction = metrics?.compaction;

  if (!compaction || !compaction.isNearCompaction) {
    if (prevState && prevState.wasNearCompaction) {
      return {
        emit: false,
        nextState: {
          ...prevState,
          wasNearCompaction: false
        }
      };
    }
    return { emit: false, nextState: null };
  }

  const percentCompacted = Number.isFinite(compaction.percentCompacted) ? compaction.percentCompacted : 0;
  const trajectoryKb = Number.isFinite(compaction.trajectoryKb) ? compaction.trajectoryKb : 0;
  const kbRemaining = Number.isFinite(compaction.kbRemaining) ? compaction.kbRemaining : 0;

  const emittedState = {
    lastSentAt: currentNow,
    lastPercentCompacted: percentCompacted,
    lastTrajectoryKb: trajectoryKb,
    lastKbRemaining: kbRemaining,
    wasNearCompaction: true
  };

  if (!prevState || !prevState.wasNearCompaction) {
    return { emit: true, nextState: emittedState };
  }

  const lastSentAt = typeof prevState.lastSentAt === "number" && Number.isFinite(prevState.lastSentAt)
    ? prevState.lastSentAt
    : 0;
  if (currentNow >= lastSentAt && currentNow - lastSentAt < ADVISORY_COOLDOWN_MS) {
    return { emit: false, nextState: null };
  }

  const prevPercent = Number.isFinite(prevState.lastPercentCompacted) ? prevState.lastPercentCompacted : 0;
  const prevTrajectoryKb = Number.isFinite(prevState.lastTrajectoryKb) ? prevState.lastTrajectoryKb : 0;
  const prevKbRemaining = Number.isFinite(prevState.lastKbRemaining) ? prevState.lastKbRemaining : 0;

  const percentDelta = Math.abs(percentCompacted - prevPercent);
  const kbDelta = Math.abs(trajectoryKb - prevTrajectoryKb);
  const remainingDelta = Math.abs(kbRemaining - prevKbRemaining);
  const crossedCritical = percentCompacted >= 95 && prevPercent < 95;

  if (!crossedCritical && percentDelta < MIN_PERCENT_DELTA && kbDelta < MIN_KB_DELTA && remainingDelta < MIN_KB_DELTA) {
    return { emit: false, nextState: null };
  }

  return { emit: true, nextState: emittedState };
}

function resolveAdvisoryStatePath(advisoriesDir, rawConversationId) {
  const raw = typeof rawConversationId === "string" && rawConversationId.trim()
    ? rawConversationId.trim()
    : "default";
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  const needsHash =
    !sanitized ||
    sanitized !== raw ||
    sanitized.length > 80 ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(sanitized);
  const safeName = needsHash
    ? `${(sanitized || "conv").slice(0, 32)}_${crypto.createHash("sha256").update(raw).digest("hex").slice(0, 12)}`
    : sanitized;
  const resolvedDir = path.resolve(advisoriesDir);
  const targetPath = path.resolve(resolvedDir, `${safeName}.json`);
  if (path.dirname(targetPath) !== resolvedDir) {
    throw new Error("Invalid advisory state path.");
  }
  return targetPath;
}

function readAdvisoryState(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeAdvisoryState(filePath, state) {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Non-fatal advisory persistence error
  }
}

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

  const rawConvId = resolveSessionId(payload);
  const convId = typeof rawConvId === "string" && rawConvId.trim() ? rawConvId.trim() : null;
  const isSubagent = isSubagentPayload(payload, convId);
  const home = os.homedir();
  const dataDir = path.join(home, ".gemini", "antigravity", "plugin_data", "token-tracker");

  // Keep active conversation state updated (skip for background subagents)
  if (!isSubagent && convId) {
    try {
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      const stateFile = path.join(dataDir, "active_conversation.json");
      fs.writeFileSync(stateFile, JSON.stringify({ conversationId: convId, updatedAt: new Date().toISOString() }, null, 2), "utf8");
    } catch {
      // Non-fatal filesystem recording error
    }
  }

  const tracker = new ConversationTracker();
  let metrics = null;
  try {
    metrics = tracker.getConversationMetrics(convId, { strict: Boolean(convId) });
  } catch {
    // If conversation cannot be queried yet, proceed without injection
  }

  // Only inject warning if approaching compaction and not suppressed by cooldown/delta guard
  if (metrics) {
    const advisoriesDir = path.join(dataDir, "advisories");
    const advisoryConvId = convId || metrics.conversationId || "default";
    const advisoryPath = resolveAdvisoryStatePath(advisoriesDir, advisoryConvId);
    const prevState = readAdvisoryState(advisoryPath);
    const { emit, nextState } = shouldEmitCompactionAdvisory(metrics, prevState, Date.now());
    if (nextState) {
      writeAdvisoryState(advisoryPath, nextState);
    }

    if (emit && metrics.compaction) {
      const comp = metrics.compaction;
      const hasTokenHeadroom = Boolean(comp.tokensRemainingFormatted && comp.thresholdTokensFormatted);
      const activeSummary = hasTokenHeadroom
        ? `Active Context: ${comp.activeTokensFormatted || "0"} / Trigger: ${comp.thresholdTokensFormatted} (${comp.percentCompacted}%, ~${comp.trajectoryKb} / ${comp.thresholdKb} KB)`
        : `Active Context: ${comp.trajectoryKb} KB / Trigger: ${comp.thresholdKb} KB (${comp.percentCompacted}%)`;
      const headroomSummary = hasTokenHeadroom
        ? `${comp.tokensRemainingFormatted} tokens (~${comp.kbRemaining} KB) remaining before automatic context compaction occurs.`
        : `~${comp.kbRemaining} KB remaining before automatic context compaction occurs.`;

      const lines = [
        `[token-tracker compaction advisory]`,
        `• ${activeSummary}`,
        `• Compaction Headroom: ${headroomSummary}`,
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
