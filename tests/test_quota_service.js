/**
 * Antigravity Token Tracker — Adversarial Quota Service Test Suite.
 * Validates reset duration formatting boundaries, raw RPC normalization edge cases,
 * port/CSRF discovery fail-safes, and mock Connect-RPC network handling.
 */

import assert from "node:assert";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { QuotaService, formatCountdown } from "../lib/quota-service.js";

/**
 * Runs the quota service test suite.
 * @returns {Promise<{ passed: number, failed: number }>}
 */
export async function runQuotaServiceTests() {
  console.log("--- Running test_quota_service.js ---");
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  [PASS] ${name}`);
      passed++;
    } catch (err) {
      console.error(`  [FAIL] ${name}: ${err.message}`);
      failed++;
    }
  }

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

  // 1. formatCountdown Boundary & Negative-Path Tests
  test("quota-service: formatCountdown invalid, missing, and non-parseable inputs", () => {
    assert.strictEqual(formatCountdown(null), "N/A");
    assert.strictEqual(formatCountdown(undefined), "N/A");
    assert.strictEqual(formatCountdown(""), "N/A");
    assert.strictEqual(formatCountdown("invalid-timestamp-xyz"), "N/A");
    assert.strictEqual(formatCountdown(NaN), "N/A");
  });

  test("quota-service: formatCountdown past and exact zero boundary conditions", () => {
    const now = Date.now();
    // Past timestamps should indicate immediate readiness
    assert.strictEqual(formatCountdown(new Date(now - 60000).toISOString()), "Ready");
    assert.strictEqual(formatCountdown(new Date(now - 1000).toISOString()), "Ready");
    assert.strictEqual(formatCountdown(new Date(now).toISOString()), "Ready");
  });

  test("quota-service: formatCountdown minute thresholds", () => {
    const now = Date.now();
    // Sub-minute future duration (< 30s rounds to 0m)
    assert.strictEqual(formatCountdown(new Date(now + 20000).toISOString()), "0m");
    // >= 30s rounds to 1m
    assert.strictEqual(formatCountdown(new Date(now + 45000).toISOString()), "1m");
    // Exactly 1 minute
    assert.strictEqual(formatCountdown(new Date(now + 60000).toISOString()), "1m");
    // Multi-minute durations
    assert.strictEqual(formatCountdown(new Date(now + 30 * 60000).toISOString()), "30m");
    assert.strictEqual(formatCountdown(new Date(now + 59 * 60000).toISOString()), "59m");
  });

  test("quota-service: formatCountdown hour and day durations", () => {
    const now = Date.now();
    // Exactly 1 hour
    assert.strictEqual(formatCountdown(new Date(now + 3600000).toISOString()), "1h 0m");
    // Hours and minutes
    assert.strictEqual(formatCountdown(new Date(now + (2 * 3600 + 15 * 60) * 1000).toISOString()), "2h 15m");
    assert.strictEqual(formatCountdown(new Date(now + (23 * 3600 + 45 * 60) * 1000).toISOString()), "23h 45m");
    // Exactly 1 day
    assert.strictEqual(formatCountdown(new Date(now + 86400000).toISOString()), "1d 0h");
    // Days and hours
    assert.strictEqual(formatCountdown(new Date(now + (3 * 86400 + 5 * 3600) * 1000).toISOString()), "3d 5h");
    assert.strictEqual(formatCountdown(new Date(now + (7 * 86400 + 12 * 3600) * 1000).toISOString()), "7d 12h");
    // Accepts direct Date object instance
    assert.strictEqual(formatCountdown(new Date(now + 120000)), "2m");
  });

  // 2. normalizeQuotaResponse Structural & Malformed Input Tests
  test("quota-service: normalizeQuotaResponse handles null, empty, and partial payloads", () => {
    const qs = new QuotaService();

    const expectedDefaultBucket = {
      remainingFraction: 1,
      remainingPercent: 100,
      usedPercent: 0,
      resetTime: null,
      countdown: "Ready"
    };

    const emptyCases = [null, undefined, {}, { response: null }, { response: { groups: null } }, { response: { groups: [] } }];

    for (const emptyCase of emptyCases) {
      const normalized = qs.normalizeQuotaResponse(emptyCase);
      assert.deepStrictEqual(normalized.gemini.weekly, expectedDefaultBucket);
      assert.deepStrictEqual(normalized.gemini.fiveHour, expectedDefaultBucket);
      assert.deepStrictEqual(normalized.thirdParty.weekly, expectedDefaultBucket);
      assert.deepStrictEqual(normalized.thirdParty.fiveHour, expectedDefaultBucket);
      assert.strictEqual(Array.isArray(normalized.rawGroups), true);
      assert.strictEqual(normalized.rawGroups.length, 0);
      assert.strictEqual(typeof normalized.timestamp, "number");
    }
  });

  test("quota-service: normalizeQuotaResponse handles corrupt groups and bucket fractions", () => {
    const qs = new QuotaService();
    const futureDate = new Date(Date.now() + 3600000).toISOString();

    const raw = {
      response: {
        groups: [
          // Corrupt group without buckets or displayName
          {},
          { displayName: null, buckets: null },
          // Group with unknown vendor (ignored cleanly)
          {
            displayName: "Local Models",
            buckets: [{ window: "weekly", remainingFraction: 0.5 }]
          },
          // Gemini group with edge-case fractions
          {
            displayName: "Gemini Models",
            buckets: [
              // Fraction > 1 clamped to 1
              { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 1.5, resetTime: futureDate },
              // Fraction < 0 clamped to 0
              { bucketId: "gemini-5h", window: "5h", remainingFraction: -0.5, resetTime: futureDate }
            ]
          },
          // Third-Party group with non-numeric fraction and precision rounding
          {
            displayName: "Claude and GPT Models",
            buckets: [
              { bucketId: "claude-weekly", window: "weekly", remainingFraction: "invalid-fraction" },
              { bucketId: "claude-5h", window: "5h", remainingFraction: 0.7356 }
            ]
          }
        ]
      }
    };

    const result = qs.normalizeQuotaResponse(raw);

    // Gemini weekly clamped to 100%
    assert.strictEqual(result.gemini.weekly.remainingFraction, 1);
    assert.strictEqual(result.gemini.weekly.remainingPercent, 100);
    assert.strictEqual(result.gemini.weekly.usedPercent, 0);
    assert.strictEqual(result.gemini.weekly.countdown, "1h 0m");

    // Gemini 5h clamped to 0%
    assert.strictEqual(result.gemini.fiveHour.remainingFraction, 0);
    assert.strictEqual(result.gemini.fiveHour.remainingPercent, 0);
    assert.strictEqual(result.gemini.fiveHour.usedPercent, 100);

    // Third-party non-numeric defaults to fraction 1
    assert.strictEqual(result.thirdParty.weekly.remainingFraction, 1);
    assert.strictEqual(result.thirdParty.weekly.remainingPercent, 100);
    assert.strictEqual(result.thirdParty.weekly.usedPercent, 0);
    assert.strictEqual(result.thirdParty.weekly.countdown, "N/A");

    // Third-party fractional percentage precision
    assert.strictEqual(result.thirdParty.fiveHour.remainingFraction, 0.7356);
    assert.strictEqual(result.thirdParty.fiveHour.remainingPercent, 73.6);
    assert.strictEqual(result.thirdParty.fiveHour.usedPercent, 26.4);
  });

  // 3. Port / CSRF Discovery Tests
  test("quota-service: discoverLsConfig constructor override takes precedence", () => {
    const qs = new QuotaService({ customPort: 48999, customCsrfToken: "test-token-fixed" });
    const config = qs.discoverLsConfig();
    assert.strictEqual(config.port, 48999);
    assert.strictEqual(config.csrfToken, "test-token-fixed");
  });

  test("quota-service: discoverLsConfig resolves environment variable addresses", () => {
    const savedAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
    const savedCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;

    try {
      // With http scheme
      process.env.ANTIGRAVITY_LS_ADDRESS = "http://127.0.0.1:41234";
      process.env.ANTIGRAVITY_CSRF_TOKEN = "env-token-1";
      const qs1 = new QuotaService();
      const cfg1 = qs1.discoverLsConfig();
      assert.strictEqual(cfg1.port, 41234);
      assert.strictEqual(cfg1.csrfToken, "env-token-1");

      // Without http scheme
      process.env.ANTIGRAVITY_LS_ADDRESS = "127.0.0.1:41235";
      process.env.ANTIGRAVITY_CSRF_TOKEN = "env-token-2";
      const qs2 = new QuotaService();
      const cfg2 = qs2.discoverLsConfig();
      assert.strictEqual(cfg2.port, 41235);
      assert.strictEqual(cfg2.csrfToken, "env-token-2");
    } finally {
      if (savedAddr !== undefined) process.env.ANTIGRAVITY_LS_ADDRESS = savedAddr;
      else delete process.env.ANTIGRAVITY_LS_ADDRESS;

      if (savedCsrf !== undefined) process.env.ANTIGRAVITY_CSRF_TOKEN = savedCsrf;
      else delete process.env.ANTIGRAVITY_CSRF_TOKEN;
    }
  });

  test("quota-service: discoverLsConfig daemon JSON resolution and error recovery", () => {
    const tempHome = path.join(os.tmpdir(), `token-tracker-test-daemon-${Date.now()}`);
    const daemonDir = path.join(tempHome, "daemon");
    fs.mkdirSync(daemonDir, { recursive: true });

    const savedAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
    const savedCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;

    try {
      // 1. Corrupt JSON file (should be skipped without throwing)
      fs.writeFileSync(path.join(daemonDir, "hub_corrupt.json"), "{ invalid-json }", "utf8");

      // 2. Incomplete JSON file missing csrfToken
      fs.writeFileSync(path.join(daemonDir, "hub_missing_token.json"), JSON.stringify({ httpPort: 49111 }), "utf8");

      // 3. Valid JSON file with port
      const validHub = path.join(daemonDir, "hub_valid.json");
      fs.writeFileSync(validHub, JSON.stringify({ port: 49222, csrfToken: "daemon-token-xyz" }), "utf8");

      const qs = new QuotaService();
      // Temporarily override getAntigravityHomeDir
      qs.getAntigravityHomeDir = () => tempHome;

      const cfg = qs.discoverLsConfig();
      assert.strictEqual(cfg.port, 49222);
      assert.strictEqual(cfg.csrfToken, "daemon-token-xyz");
    } finally {
      if (savedAddr !== undefined) process.env.ANTIGRAVITY_LS_ADDRESS = savedAddr;
      else delete process.env.ANTIGRAVITY_LS_ADDRESS;

      if (savedCsrf !== undefined) process.env.ANTIGRAVITY_CSRF_TOKEN = savedCsrf;
      else delete process.env.ANTIGRAVITY_CSRF_TOKEN;

      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test("quota-service: discoverLsConfig falls back to default when logs and files missing", () => {
    const tempHome = path.join(os.tmpdir(), `token-tracker-test-empty-${Date.now()}`);
    fs.mkdirSync(tempHome, { recursive: true });

    const savedAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
    const savedCsrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
    delete process.env.ANTIGRAVITY_LS_ADDRESS;
    delete process.env.ANTIGRAVITY_CSRF_TOKEN;

    try {
      const qs = new QuotaService();
      qs.getAntigravityHomeDir = () => tempHome;
      const cfg = qs.discoverLsConfig();
      assert.strictEqual(cfg.port, 50995);
      assert.strictEqual(cfg.csrfToken, "");
    } finally {
      if (savedAddr !== undefined) process.env.ANTIGRAVITY_LS_ADDRESS = savedAddr;
      if (savedCsrf !== undefined) process.env.ANTIGRAVITY_CSRF_TOKEN = savedCsrf;
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  // 4. RPC Client Network & Caching Integration
  await testAsync("quota-service: RPC client successfully requests and parses Connect-RPC endpoint", async () => {
    let receivedCsrf = "";
    const mockServer = http.createServer((req, res) => {
      receivedCsrf = req.headers["x-codeium-csrf-token"] || "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          response: {
            groups: [
              {
                displayName: "Gemini",
                buckets: [{ window: "weekly", remainingFraction: 0.9 }]
              }
            ]
          }
        })
      );
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const port = mockServer.address().port;

    try {
      const qs = new QuotaService({ customPort: port, customCsrfToken: "test-auth-rpc" });
      const summary = await qs.getQuotaSummary();

      assert.strictEqual(receivedCsrf, "test-auth-rpc");
      assert.strictEqual(summary.gemini.weekly.remainingPercent, 90);
      assert.strictEqual(summary.gemini.weekly.usedPercent, 10);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  await testAsync("quota-service: RPC client handles fallback path on 404", async () => {
    let pathsHit = [];
    const mockServer = http.createServer((req, res) => {
      pathsHit.push(req.url);
      if (req.url === "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary") {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }
      if (req.url === "/LanguageServerService/RetrieveUserQuotaSummary") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ response: { groups: [] } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const port = mockServer.address().port;

    try {
      const qs = new QuotaService({ customPort: port, customCsrfToken: "tok" });
      const summary = await qs.getQuotaSummary();
      assert.strictEqual(pathsHit.length, 2);
      assert.strictEqual(pathsHit[0], "/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary");
      assert.strictEqual(pathsHit[1], "/LanguageServerService/RetrieveUserQuotaSummary");
      assert.strictEqual(summary.gemini.weekly.remainingPercent, 100);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  await testAsync("quota-service: RPC client handles server error, malformed JSON, and stale cache fallback", async () => {
    let mode = "500";
    const mockServer = http.createServer((req, res) => {
      if (mode === "500") {
        res.writeHead(500);
        res.end("Internal Server Error");
      } else if (mode === "malformed") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{ invalid json");
      } else if (mode === "ok") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            response: {
              groups: [{ displayName: "Gemini", buckets: [{ window: "weekly", remainingFraction: 0.65 }] }]
            }
          })
        );
      }
    });

    await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
    const port = mockServer.address().port;

    try {
      const qs = new QuotaService({ customPort: port, customCsrfToken: "tok", cacheTtlMs: 60000 });

      // 1. Initial 500 error throws
      await assert.rejects(
        async () => {
          await qs.getQuotaSummary();
        },
        (err) => err.message.includes("status code 500")
      );

      // 2. Initial malformed JSON throws
      mode = "malformed";
      await assert.rejects(
        async () => {
          await qs.getQuotaSummary();
        },
        (err) => err.message.includes("Malformed JSON")
      );

      // 3. Successful fetch caches result
      mode = "ok";
      const validSummary = await qs.getQuotaSummary();
      assert.strictEqual(validSummary.gemini.weekly.remainingPercent, 65);

      // 4. Repeated call returns cached without network request
      mode = "500"; // Server is now failing
      const cachedSummary = await qs.getQuotaSummary(false);
      assert.strictEqual(cachedSummary.gemini.weekly.remainingPercent, 65);
      assert.strictEqual(cachedSummary.isStale, undefined);

      // 5. Force refresh with failing server returns stale cached data with error flag
      const staleSummary = await qs.getQuotaSummary(true);
      assert.strictEqual(staleSummary.gemini.weekly.remainingPercent, 65);
      assert.strictEqual(staleSummary.isStale, true);
      assert.strictEqual(typeof staleSummary.error, "string");
      assert.strictEqual(staleSummary.error.includes("status code 500"), true);
    } finally {
      await new Promise((resolve) => mockServer.close(resolve));
    }
  });

  return { passed, failed };
}

const isMain = Boolean(
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
);

if (isMain) {
  runQuotaServiceTests().then(({ failed }) => {
    process.exit(failed > 0 ? 1 : 0);
  });
}
