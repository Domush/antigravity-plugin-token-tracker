/**
 * Antigravity Token Tracker — Adversarial Injector & ASAR Offset Test Suite.
 * Validates Electron ASAR Chromium pickle header byte math, payload offset shifting,
 * dry-run / real patching idempotency, and error recovery on corrupt or missing archives.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  patchAppAsar,
  computeFileHash,
  findAntigravityResourcesDir,
  INJECTION_TAG_START,
  INJECTION_TAG_END
} from "../injector/install.js";

/**
 * Builds a synthetically valid Electron ASAR archive buffer.
 * @param {Object} filesMap Object mapping relative paths to Buffer/string contents.
 * @returns {Buffer}
 */
export function buildSyntheticAsar(filesMap) {
  const header = { files: {} };
  let currentOffset = 0;
  const payloadBuffers = [];

  for (const [relPath, content] of Object.entries(filesMap)) {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const parts = relPath.split("/").filter(Boolean);

    let cur = header.files;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!cur[parts[i]]) cur[parts[i]] = { files: {} };
      cur = cur[parts[i]].files;
    }

    const fileName = parts[parts.length - 1];
    cur[fileName] = {
      offset: String(currentOffset),
      size: buf.length
    };

    payloadBuffers.push(buf);
    currentOffset += buf.length;
  }

  const jsonStr = JSON.stringify(header);
  const jsonBuf = Buffer.from(jsonStr, "utf8");
  const jsonLen = jsonBuf.length;

  const rem = jsonLen % 4;
  const padLen = rem === 0 ? 0 : 4 - rem;
  const picklePayloadLen = jsonLen + padLen + 4;

  const headerBuf = Buffer.alloc(16);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(picklePayloadLen + 4, 4);
  headerBuf.writeUInt32LE(picklePayloadLen, 8);
  headerBuf.writeUInt32LE(jsonLen, 12);

  const paddingBuf = Buffer.alloc(padLen, 0);
  return Buffer.concat([headerBuf, jsonBuf, paddingBuf, ...payloadBuffers]);
}

/**
 * Runs the injector offset test suite.
 * @returns {Promise<{ passed: number, failed: number }>}
 */
export async function runInjectorOffsetTests() {
  console.log("--- Running test_injector_offset.js ---");
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

  // 1. ASAR Pickle Header Math & Padding Invariants
  test("injector: ASAR pickle header byte math alignment calculations", () => {
    // Test 4-byte alignment padding for varying JSON payload lengths
    const testCases = [
      { jsonLen: 100, expectedRem: 0, expectedPad: 0, expectedPicklePayload: 104 },
      { jsonLen: 101, expectedRem: 1, expectedPad: 3, expectedPicklePayload: 108 },
      { jsonLen: 102, expectedRem: 2, expectedPad: 2, expectedPicklePayload: 108 },
      { jsonLen: 103, expectedRem: 3, expectedPad: 1, expectedPicklePayload: 108 }
    ];

    for (const tc of testCases) {
      const rem = tc.jsonLen % 4;
      const padLen = rem === 0 ? 0 : 4 - rem;
      const picklePayloadLen = tc.jsonLen + padLen + 4;
      const pickleHeaderSize = picklePayloadLen + 4;
      const payloadStart = 8 + pickleHeaderSize;

      assert.strictEqual(rem, tc.expectedRem);
      assert.strictEqual(padLen, tc.expectedPad);
      assert.strictEqual(picklePayloadLen, tc.expectedPicklePayload);
      // Payload start must exactly equal 16 + jsonLen + padLen
      assert.strictEqual(payloadStart, 16 + tc.jsonLen + padLen);
    }
  });

  // 2. Synthetic ASAR Dry-Run Patching
  test("injector: patchAppAsar dryRun calculates modifications without mutating archive", () => {
    const tempDir = path.join(os.tmpdir(), `token-tracker-asar-dry-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      const asarPath = path.join(tempDir, "app.asar");
      const originalPreload = 'console.log("preload-original");';
      const originalMain = 'console.log("main-original");';

      const asarBuf = buildSyntheticAsar({
        "dist/preload.js": originalPreload,
        "dist/main.js": originalMain
      });
      fs.writeFileSync(asarPath, asarBuf);

      const hashBefore = computeFileHash(asarPath);

      // Execute dry-run
      const res = patchAppAsar(asarPath, true);
      assert.strictEqual(res.dryRun, true);
      assert.strictEqual(res.modified, true);
      assert.strictEqual(res.backupCreated, false);

      // Verify file was not modified and no backup was created
      const hashAfter = computeFileHash(asarPath);
      assert.strictEqual(hashBefore, hashAfter);
      assert.strictEqual(fs.existsSync(`${asarPath}.token_tracker_backup`), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 3. Real ASAR Patching, Offset Shifting, and File Integrity Verification
  test("injector: patchAppAsar creates backup, updates preload, and shifts succeeding offsets cleanly", () => {
    const tempDir = path.join(os.tmpdir(), `token-tracker-asar-real-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      const asarPath = path.join(tempDir, "app.asar");
      const originalPreload = 'console.log("preload-original");';
      const originalMain = 'console.log("main-code-payload-at-subsequent-offset");';
      const originalHelper = 'console.log("helper-code-payload");';

      const asarBuf = buildSyntheticAsar({
        "dist/preload.js": originalPreload,
        "dist/main.js": originalMain,
        "dist/helper.js": originalHelper
      });
      fs.writeFileSync(asarPath, asarBuf);
      const originalHash = computeFileHash(asarPath);

      // Execute real patch
      const patchResult = patchAppAsar(asarPath, false);
      assert.strictEqual(patchResult.backupCreated, true);
      assert.strictEqual(patchResult.modified, true);

      // 1. Verify backup archive matches original unpatched file hash
      const backupPath = `${asarPath}.token_tracker_backup`;
      assert.strictEqual(fs.existsSync(backupPath), true);
      const backupHash = computeFileHash(backupPath);
      assert.strictEqual(backupHash, originalHash);

      // 2. Read patched ASAR and inspect header pickle
      const fd = fs.openSync(asarPath, "r");
      try {
        const headerBuf = Buffer.alloc(16);
        fs.readSync(fd, headerBuf, 0, 16, 0);

        assert.strictEqual(headerBuf.readUInt32LE(0), 4);
        const pickleSize = headerBuf.readUInt32LE(4);
        const payloadStart = 8 + pickleSize;

        const jsonLen = headerBuf.readUInt32LE(12);
        const jsonBuf = Buffer.alloc(jsonLen);
        fs.readSync(fd, jsonBuf, 0, jsonLen, 16);

        const patchedHeader = JSON.parse(jsonBuf.toString("utf8"));
        const preloadEntry = patchedHeader.files.dist.files["preload.js"];
        const mainEntry = patchedHeader.files.dist.files["main.js"];
        const helperEntry = patchedHeader.files.dist.files["helper.js"];

        // 3. Verify preload entry size increased by injection code length
        const preloadDelta = preloadEntry.size - originalPreload.length;
        assert.strictEqual(preloadDelta > 0, true);

        // 4. Verify succeeding file offsets shifted by exact preload delta
        const originalPreloadLen = Buffer.byteLength(originalPreload);
        const originalMainOffset = originalPreloadLen;
        const expectedMainOffset = originalMainOffset + preloadDelta;
        assert.strictEqual(parseInt(mainEntry.offset, 10), expectedMainOffset);

        const originalHelperOffset = originalMainOffset + Buffer.byteLength(originalMain);
        const expectedHelperOffset = originalHelperOffset + preloadDelta;
        assert.strictEqual(parseInt(helperEntry.offset, 10), expectedHelperOffset);

        // 5. Read patched preload payload and verify injection tags exist
        const patchedPreloadBuf = Buffer.alloc(preloadEntry.size);
        fs.readSync(fd, patchedPreloadBuf, 0, preloadEntry.size, payloadStart + parseInt(preloadEntry.offset, 10));
        const patchedPreloadStr = patchedPreloadBuf.toString("utf8");
        assert.strictEqual(patchedPreloadStr.includes(INJECTION_TAG_START), true);
        assert.strictEqual(patchedPreloadStr.includes(INJECTION_TAG_END), true);
        assert.strictEqual(patchedPreloadStr.includes(originalPreload), true);

        // 6. Read main.js at its shifted offset and verify verbatim content match
        const mainBuf = Buffer.alloc(mainEntry.size);
        fs.readSync(fd, mainBuf, 0, mainEntry.size, payloadStart + parseInt(mainEntry.offset, 10));
        assert.strictEqual(mainBuf.toString("utf8"), originalMain);

        // 7. Read helper.js at its shifted offset and verify verbatim content match
        const helperBuf = Buffer.alloc(helperEntry.size);
        fs.readSync(fd, helperBuf, 0, helperEntry.size, payloadStart + parseInt(helperEntry.offset, 10));
        assert.strictEqual(helperBuf.toString("utf8"), originalHelper);
      } finally {
        fs.closeSync(fd);
      }

      // 8. Idempotency test: second run on already patched archive is a no-op
      const idempotentResult = patchAppAsar(asarPath, false);
      assert.strictEqual(idempotentResult.alreadyInstalled, true);
      assert.strictEqual(idempotentResult.modified, false);
      assert.strictEqual(idempotentResult.backupCreated, false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 4. Error Handling & Negative-Path Tests for Missing/Corrupted Archives
  test("injector: error recovery for missing, truncated, or invalid ASAR archives", () => {
    const tempDir = path.join(os.tmpdir(), `token-tracker-asar-err-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      // 1. Target asar does not exist
      assert.throws(
        () => patchAppAsar(path.join(tempDir, "non_existent.asar")),
        (err) => err.message.includes("Target app.asar not found")
      );

      // 2. Truncated file (< 16 bytes)
      const truncatedPath = path.join(tempDir, "truncated.asar");
      fs.writeFileSync(truncatedPath, Buffer.from([0x01, 0x02, 0x03]));
      assert.throws(
        () => patchAppAsar(truncatedPath),
        (err) => err !== null
      );

      // 3. Corrupt JSON header
      const corruptJsonPath = path.join(tempDir, "corrupt.asar");
      const badHeader = Buffer.alloc(32);
      badHeader.writeUInt32LE(4, 0);
      badHeader.writeUInt32LE(20, 4);
      badHeader.writeUInt32LE(16, 8);
      badHeader.writeUInt32LE(12, 12);
      badHeader.write("NOT_A_JSON!!", 16, "utf8");
      fs.writeFileSync(corruptJsonPath, badHeader);

      assert.throws(
        () => patchAppAsar(corruptJsonPath),
        (err) => err instanceof SyntaxError || err.message.includes("JSON")
      );

      // 4. Archive missing dist/preload.js entry
      const missingPreloadPath = path.join(tempDir, "no_preload.asar");
      const noPreloadBuf = buildSyntheticAsar({
        "dist/other_file.js": 'console.log("other");'
      });
      fs.writeFileSync(missingPreloadPath, noPreloadBuf);

      assert.throws(
        () => patchAppAsar(missingPreloadPath),
        (err) => err.message.includes("Could not find dist/preload.js in app.asar archive")
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 5. Utility Functions: Hash and Path Discovery
  test("injector: computeFileHash and findAntigravityResourcesDir overrides", () => {
    const tempDir = path.join(os.tmpdir(), `token-tracker-util-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      // SHA-256 validation
      const testFile = path.join(tempDir, "hash_test.txt");
      fs.writeFileSync(testFile, "Antigravity Token Tracker Deterministic Hash Test", "utf8");
      const expectedHash = crypto.createHash("sha256").update("Antigravity Token Tracker Deterministic Hash Test").digest("hex");
      assert.strictEqual(computeFileHash(testFile), expectedHash);

      // Valid override path
      const resolved = findAntigravityResourcesDir(tempDir);
      assert.strictEqual(resolved, path.resolve(tempDir));

      // Non-existent override path throws
      assert.throws(
        () => findAntigravityResourcesDir(path.join(tempDir, "does-not-exist")),
        (err) => err.message.includes("Specified Antigravity resources path does not exist")
      );
    } finally {
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
  runInjectorOffsetTests().then(({ failed }) => {
    process.exit(failed > 0 ? 1 : 0);
  });
}
