/**
 * Antigravity Token Tracker — Adversarial Telemetry Server Test Suite.
 * Validates loopback HTTP server routes, CORS headers, registry lifecycle,
 * invalid routes/methods error handling, and component error isolation.
 */

import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { TelemetryServer } from "../lib/telemetry-server.js";

/**
 * Runs the telemetry server test suite.
 * @returns {Promise<{ passed: number, failed: number }>}
 */
export async function runTelemetryServerTests() {
  console.log("--- Running test_telemetry_server.js ---");
  let passed = 0;
  let failed = 0;

  async function testAsync(name, fn) {
    try {
      await fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }

  // 1. Server Registry Lifecycle & Deterministic Teardown
  await testAsync("telemetry-server: writes registry file on boot and removes on shutdown", async () => {
    const tempDir = path.join(os.tmpdir(), `token-tracker-server-reg-${Date.now()}`);
    const srv = new TelemetryServer({ port: 0, pluginDataDir: tempDir });

    try {
      const port = await srv.start();
      assert.strictEqual(typeof port, "number");
      assert.strictEqual(port > 0, true);

      // Verify registry file exists
      const regPath = path.join(tempDir, "telemetry-server.json");
      assert.strictEqual(fs.existsSync(regPath), true);

      const regContent = JSON.parse(fs.readFileSync(regPath, "utf8"));
      assert.strictEqual(regContent.port, port);
      assert.strictEqual(regContent.pid, process.pid);
      assert.strictEqual(regContent.url, `http://127.0.0.1:${port}`);
      assert.strictEqual(regContent.activeConversationId, null);
      assert.strictEqual(typeof regContent.updatedAt, "string");

      // Verify clean shutdown removes registry
      await srv.stop();
      assert.strictEqual(fs.existsSync(regPath), false);
    } finally {
      await srv.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 2. HTTP Routes: Health & CORS
  await testAsync("telemetry-server: GET /api/health and OPTIONS CORS pre-flight", async () => {
    const tempDir = path.join(os.tmpdir(), `token-tracker-server-health-${Date.now()}`);
    const srv = new TelemetryServer({ port: 0, pluginDataDir: tempDir });

    try {
      const port = await srv.start();

      // Health endpoint
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get("access-control-allow-origin"), "*");
      assert.strictEqual(res.headers.get("content-type"), "application/json");

      const body = await res.json();
      assert.strictEqual(body.status, "ok");
      assert.strictEqual(typeof body.uptime, "number");
      assert.strictEqual(body.pid, process.pid);
      assert.strictEqual(body.port, port);

      // OPTIONS pre-flight
      const optRes = await fetch(`http://127.0.0.1:${port}/api/health`, { method: "OPTIONS" });
      assert.strictEqual(optRes.status, 204);
      assert.strictEqual(optRes.headers.get("access-control-allow-origin"), "*");
      assert.strictEqual(optRes.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
    } finally {
      await srv.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 3. HTTP Routes: Telemetry & Refresh
  await testAsync("telemetry-server: GET /api/telemetry and GET /api/refresh contracts", async () => {
    const tempDir = path.join(os.tmpdir(), `token-tracker-server-telem-${Date.now()}`);

    const mockTracker = {
      getConversationMetrics: (convId) => ({
        conversationId: convId || "mock-conv-123",
        stepCount: 12,
        model: { id: "gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash (High)", maxTokens: 1048576, group: "gemini" },
        contextWindow: { currentTokens: 5000, maxTokens: 1048576, percentUsed: 0.5, contextBytes: 20000, currentTokensFormatted: "5k", maxTokensFormatted: "1.05M" },
        cache: { cachedTokens: 2500, uncachedTokens: 2500, totalTokens: 5000, hitRatio: 0.5, hitRatioPercent: 50.0, cachedTokensFormatted: "2.5k", uncachedTokensFormatted: "2.5k" },
        compaction: { trajectoryBytes: 51200, trajectoryKb: 50.0, thresholdBytes: 184320, thresholdKb: 180, kbRemaining: 130, percentCompacted: 28, isNearCompaction: false }
      })
    };

    let refreshCalled = false;
    const mockQuota = {
      getQuotaSummary: async (forceRefresh) => {
        if (forceRefresh) refreshCalled = true;
        return {
          gemini: { weekly: { remainingFraction: 0.8, remainingPercent: 80, usedPercent: 20, countdown: "1d 2h" } },
          thirdParty: { weekly: { remainingFraction: 1, remainingPercent: 100, usedPercent: 0, countdown: "Ready" } }
        };
      }
    };

    const srv = new TelemetryServer({ port: 0, tracker: mockTracker, quotaService: mockQuota, pluginDataDir: tempDir });

    try {
      const port = await srv.start();

      // Standard telemetry query
      const res = await fetch(`http://127.0.0.1:${port}/api/telemetry?conversationId=custom-query-id`);
      assert.strictEqual(res.status, 200);
      const data = await res.json();

      assert.strictEqual(data.ok, true);
      assert.strictEqual(data.conversationId, "custom-query-id");
      assert.strictEqual(data.stepCount, 12);
      assert.strictEqual(data.model.id, "gemini-3.8-flash-high");
      assert.strictEqual(data.contextWindow.currentTokens, 5000);
      assert.strictEqual(data.cache.hitRatioPercent, 50.0);
      assert.strictEqual(data.compaction.trajectoryKb, 50.0);
      assert.strictEqual(data.quota.gemini.weekly.remainingPercent, 80);
      assert.strictEqual(data.errors.tracker, null);
      assert.strictEqual(data.errors.quota, null);

      // Refresh endpoint forces quota update
      assert.strictEqual(refreshCalled, false);
      const refRes = await fetch(`http://127.0.0.1:${port}/api/refresh`);
      assert.strictEqual(refRes.status, 200);
      assert.strictEqual(refreshCalled, true);
    } finally {
      await srv.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 4. HTTP Routes: Active Conversation Setting & Error Handling
  await testAsync("telemetry-server: POST /api/set-conversation payload validation", async () => {
    const tempDir = path.join(os.tmpdir(), `token-tracker-server-set-${Date.now()}`);
    const srv = new TelemetryServer({ port: 0, pluginDataDir: tempDir });

    try {
      const port = await srv.start();

      // Valid conversation update
      const validRes = await fetch(`http://127.0.0.1:${port}/api/set-conversation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: "active-session-alpha" })
      });
      assert.strictEqual(validRes.status, 200);
      const validBody = await validRes.json();
      assert.strictEqual(validBody.ok, true);
      assert.strictEqual(validBody.activeConversationId, "active-session-alpha");

      // Verify registry was updated with active session
      const regContent = JSON.parse(fs.readFileSync(path.join(tempDir, "telemetry-server.json"), "utf8"));
      assert.strictEqual(regContent.activeConversationId, "active-session-alpha");

      // Invalid JSON payload returns 400
      const invalidRes = await fetch(`http://127.0.0.1:${port}/api/set-conversation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "NOT_VALID_JSON_STRING"
      });
      assert.strictEqual(invalidRes.status, 400);
      const invalidBody = await invalidRes.json();
      assert.strictEqual(invalidBody.ok, false);
      assert.strictEqual(typeof invalidBody.error, "string");
    } finally {
      await srv.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 5. Route Catalog Boundaries & Unsupported Methods (Negative-Path)
  await testAsync("telemetry-server: returns 404 for unknown routes and unsupported methods", async () => {
    const tempDir = path.join(os.tmpdir(), `token-tracker-server-routes-${Date.now()}`);
    const srv = new TelemetryServer({ port: 0, pluginDataDir: tempDir });

    try {
      const port = await srv.start();

      // Route /api/quota is not a standalone route (quota is served via /api/telemetry)
      const quotaRes = await fetch(`http://127.0.0.1:${port}/api/quota`);
      assert.strictEqual(quotaRes.status, 404);
      const quotaBody = await quotaRes.json();
      assert.strictEqual(quotaBody.error, "Endpoint not found");

      // Arbitrary unknown path
      const notFoundRes = await fetch(`http://127.0.0.1:${port}/api/non-existent-route`);
      assert.strictEqual(notFoundRes.status, 404);

      // Unsupported methods on GET routes (POST / PUT / DELETE)
      const postHealthRes = await fetch(`http://127.0.0.1:${port}/api/health`, { method: "POST" });
      assert.strictEqual(postHealthRes.status, 404);

      const putTelemRes = await fetch(`http://127.0.0.1:${port}/api/telemetry`, { method: "PUT" });
      assert.strictEqual(putTelemRes.status, 404);

      const delTelemRes = await fetch(`http://127.0.0.1:${port}/api/telemetry`, { method: "DELETE" });
      assert.strictEqual(delTelemRes.status, 404);
    } finally {
      await srv.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 6. Subsystem Failure Isolation (Tracker / Quota failure resilience)
  await testAsync("telemetry-server: isolates tracker and quota service failures gracefully", async () => {
    const tempDir = path.join(os.tmpdir(), `token-tracker-server-isolation-${Date.now()}`);

    // Tracker throws unexpected error
    const faultyTracker = {
      getConversationMetrics: () => {
        throw new Error("Disk I/O failure accessing conversation database");
      }
    };

    // Quota service throws unexpected error
    const faultyQuota = {
      getQuotaSummary: async () => {
        throw new Error("Language server daemon unavailable");
      }
    };

    const srv = new TelemetryServer({ port: 0, tracker: faultyTracker, quotaService: faultyQuota, pluginDataDir: tempDir });

    try {
      const port = await srv.start();
      const res = await fetch(`http://127.0.0.1:${port}/api/telemetry`);
      assert.strictEqual(res.status, 200);

      const data = await res.json();
      // ok flag remains false when neither subsystem returned valid data
      assert.strictEqual(data.ok, false);
      assert.strictEqual(data.errors.tracker, "Disk I/O failure accessing conversation database");
      assert.strictEqual(data.errors.quota, "Language server daemon unavailable");

      // Default safe metrics structures are still returned
      assert.strictEqual(data.model.id, "gemini-3.8-flash-high");
      assert.strictEqual(data.contextWindow.currentTokens, 0);
      assert.strictEqual(data.cache.hitRatio, 0);
      assert.strictEqual(data.compaction.trajectoryBytes, 0);
      assert.strictEqual(data.quota.gemini.weekly.remainingPercent, 100);
    } finally {
      await srv.stop();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  return { passed, failed };
}

const isMain = Boolean(
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
);

if (isMain) {
  runTelemetryServerTests().then(({ failed }) => {
    process.exit(failed > 0 ? 1 : 0);
  });
}
