/**
 * Antigravity Token Tracker — CLI Legacy Migration, Enclosure & Lock-Handling Sub-Suite.
 * Validates legacy plugin directory migration, symlink/junction target preservation,
 * source-enclosure/self-overwrite guards, dual uninstall, and active-lock handling.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  installPlugin,
  uninstallPlugin,
  PLUGIN_DIR_NAME,
  LEGACY_PLUGIN_DIR_NAME,
  ESSENTIAL_FILES,
  ESSENTIAL_DIRS
} from "../bin/cli.js";
import { cleanupLegacyPluginDir } from "../lib/cli-cleanup.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cliPath = path.resolve(__dirname, "..", "bin", "cli.js");

function createDummySource(sourceDir) {
  fs.mkdirSync(sourceDir, { recursive: true });
  for (const file of ESSENTIAL_FILES) {
    fs.writeFileSync(path.join(sourceDir, file), `dummy ${file}`, "utf8");
  }
  for (const dir of ESSENTIAL_DIRS) {
    const subDir = path.join(sourceDir, dir);
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, "marker.txt"), `marker-${dir}`, "utf8");
  }
}

function assertInstalledBundle(installDir) {
  for (const file of ESSENTIAL_FILES) {
    assert.strictEqual(fs.existsSync(path.join(installDir, file)), true, `Missing file: ${file}`);
  }
  for (const dir of ESSENTIAL_DIRS) {
    assert.strictEqual(fs.existsSync(path.join(installDir, dir)), true, `Missing dir: ${dir}`);
  }
}

function waitForChildMarker(child, marker, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for lock-holder marker "${marker}"`));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes(marker)) {
        cleanup();
        resolve();
      }
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`Lock-holder child exited prematurely with code ${code}`));
    };

    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function terminateChildProcess(child) {
  if (!child || (child.exitCode !== null || child.signalCode !== null)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killTimer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch (killErr) {
        if (killErr?.code !== "ESRCH") {
          console.error("[test_cli_migration] Failed to SIGKILL lock-holder child:", killErr.message);
        }
      }
      resolve();
    }, 3000);

    child.once("close", () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill();
  });
}

/**
 * Registers legacy migration, enclosure protection, and lock-handling tests.
 * @param {(name: string, fn: () => void | Promise<void>) => void} test
 */
export function registerCliMigrationTests(test) {
  // 1. Legacy Plugin Migration, Symlink Target Preservation & Dual Uninstall
  test("cli: install migrates legacy directory safely without deleting symlink targets, and uninstall removes both", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-tt-legacy-"));
    const linkType = process.platform === "win32" ? "junction" : "dir";

    try {
      const wsDir = path.join(tempDir, "ws");
      const wsLegacy = path.join(wsDir, ".gemini", "plugins", LEGACY_PLUGIN_DIR_NAME);
      const wsTarget = path.join(wsDir, ".gemini", "plugins", PLUGIN_DIR_NAME);
      fs.mkdirSync(wsLegacy, { recursive: true });
      fs.writeFileSync(path.join(wsLegacy, "stale.txt"), "legacy-data", "utf8");

      const wsInstall = spawnSync(process.execPath, [cliPath, "install", "--workspace"], { cwd: wsDir, encoding: "utf8" });
      assert.strictEqual(wsInstall.status, 0, `Workspace migration failed: ${wsInstall.stderr}`);
      assertInstalledBundle(wsTarget);
      assert.strictEqual(fs.existsSync(wsLegacy), false);

      const fakeHome = path.join(tempDir, "home");
      const globalLegacy = path.join(fakeHome, ".gemini", "config", "plugins", LEGACY_PLUGIN_DIR_NAME);
      const globalTarget = path.join(fakeHome, ".gemini", "config", "plugins", PLUGIN_DIR_NAME);
      fs.mkdirSync(globalLegacy, { recursive: true });
      fs.writeFileSync(path.join(globalLegacy, "stale-global.txt"), "legacy-global", "utf8");
      const gInstall = spawnSync(process.execPath, [cliPath, "install", "--global"], {
        env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
        encoding: "utf8"
      });
      assert.strictEqual(gInstall.status, 0, `Global migration failed: ${gInstall.stderr}`);
      assertInstalledBundle(globalTarget);
      assert.strictEqual(fs.existsSync(globalLegacy), false);

      fs.mkdirSync(wsLegacy, { recursive: true });
      fs.writeFileSync(path.join(wsLegacy, "stale-again.txt"), "legacy", "utf8");
      const wsUninstall = spawnSync(process.execPath, [cliPath, "uninstall", "--workspace"], { cwd: wsDir, encoding: "utf8" });
      assert.strictEqual(wsUninstall.status, 0, `Dual uninstall failed: ${wsUninstall.stderr}`);
      assert.strictEqual(fs.existsSync(wsTarget), false);
      assert.strictEqual(fs.existsSync(wsLegacy), false);
      assert.strictEqual(wsUninstall.stdout.includes("Removed legacy plugin directory"), true);

      const dummySrc = path.join(tempDir, "src");
      createDummySource(dummySrc);
      const symlinkTarget = path.join(tempDir, "linked-legacy-target");
      fs.mkdirSync(symlinkTarget, { recursive: true });
      fs.writeFileSync(path.join(symlinkTarget, "keep.txt"), "do-not-delete", "utf8");

      const legacyLink = path.join(tempDir, "plugins", LEGACY_PLUGIN_DIR_NAME);
      fs.mkdirSync(path.dirname(legacyLink), { recursive: true });
      fs.symlinkSync(symlinkTarget, legacyLink, linkType);
      const directTarget = path.join(tempDir, "plugins", PLUGIN_DIR_NAME);

      installPlugin({ sourceDir: dummySrc, targetDir: directTarget, legacyDir: legacyLink });
      assertInstalledBundle(directTarget);
      assert.throws(() => fs.lstatSync(legacyLink), { code: "ENOENT" });
      assert.strictEqual(fs.readFileSync(path.join(symlinkTarget, "keep.txt"), "utf8"), "do-not-delete");

      fs.symlinkSync(symlinkTarget, legacyLink, linkType);
      const resBoth = uninstallPlugin({ targetDir: directTarget, legacyDir: legacyLink });
      assert.deepStrictEqual(resBoth, { removed: true, removedTarget: true, removedLegacy: true, targetDir: directTarget, legacyDir: legacyLink });
      assert.throws(() => fs.lstatSync(legacyLink), { code: "ENOENT" });
      assert.strictEqual(fs.readFileSync(path.join(symlinkTarget, "keep.txt"), "utf8"), "do-not-delete");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 2. Source-Enclosure & Self-Overwrite Protection
  test("cli: source-enclosure and self-overwrite guards preserve sourceDir and targetDir", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-tt-enclosure-"));
    try {
      const outerDir = path.join(tempDir, "outer");
      const dummySrc = path.join(outerDir, "bundle");
      const targetDir = path.join(tempDir, "installed", PLUGIN_DIR_NAME);
      createDummySource(dummySrc);

      installPlugin({ sourceDir: dummySrc, targetDir, legacyDir: dummySrc });
      assert.strictEqual(fs.existsSync(path.join(dummySrc, "plugin.json")), true);
      assert.strictEqual(fs.existsSync(path.join(targetDir, "plugin.json")), true);

      installPlugin({ sourceDir: dummySrc, targetDir, legacyDir: outerDir });
      assert.strictEqual(fs.existsSync(path.join(dummySrc, "CHANGELOG.md")), true);

      installPlugin({ sourceDir: dummySrc, targetDir, legacyDir: targetDir });
      assert.strictEqual(fs.existsSync(path.join(targetDir, "CHANGELOG.md")), true);

      const logs = [];
      const expectedSkip = { removed: false, skipped: true, locked: false };
      assert.deepStrictEqual(cleanupLegacyPluginDir({ legacyDir: targetDir, targetDir, sourceDir: dummySrc, stdout: (m) => logs.push(m) }), expectedSkip);
      assert.deepStrictEqual(cleanupLegacyPluginDir({ legacyDir: outerDir, targetDir, sourceDir: dummySrc, stdout: (m) => logs.push(m) }), expectedSkip);
      assert.strictEqual(logs.some((l) => l.includes("Skipping automatic removal of active source directory")), true);

      assert.throws(() => installPlugin({ sourceDir: dummySrc, targetDir: outerDir }), /matches or encloses source directory/);
      assert.throws(() => installPlugin({ sourceDir: dummySrc, targetDir: path.join(dummySrc, "lib", "nested") }), /cannot be inside source bundle directory \(lib\)/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 3. Active Lock Handling (EPERM / EBUSY / ENOTEMPTY)
  test("cli: cleanupLegacyPluginDir handles locked legacy directory non-fatally", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-tt-lock-"));
    const pluginsDir = path.join(tempDir, "plugins");
    const legacyDir = path.join(pluginsDir, LEGACY_PLUGIN_DIR_NAME);
    const targetDir = path.join(pluginsDir, PLUGIN_DIR_NAME);
    const dummySrc = path.join(tempDir, "src");
    let lockChild = null;
    let lockedPluginsDir = false;

    try {
      createDummySource(dummySrc);
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.mkdirSync(targetDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, "active.lock"), "in-use", "utf8");

      const outLogs = [];
      const errLogs = [];

      if (process.platform === "win32") {
        lockChild = spawn(
          process.execPath,
          ["-e", "process.stdout.write('LOCKED\\n'); setInterval(() => {}, 60000);"],
          { cwd: legacyDir, stdio: ["ignore", "pipe", "pipe"] }
        );
        await waitForChildMarker(lockChild, "LOCKED");

        const res = cleanupLegacyPluginDir({
          legacyDir,
          targetDir,
          sourceDir: dummySrc,
          stdout: (m) => outLogs.push(m),
          stderr: (m) => errLogs.push(m)
        });
        assert.deepStrictEqual(res, { removed: false, skipped: false, locked: true });
        assert.strictEqual(outLogs.length, 0);
        assert.strictEqual(errLogs.length, 1);
        assert.strictEqual(errLogs[0].includes(`Could not remove legacy plugin directory (${legacyDir})`), true);
        assert.strictEqual(errLogs[0].includes("currently in use by an active session"), true);
        assert.strictEqual(fs.existsSync(legacyDir), true);
      } else if (typeof process.getuid !== "function" || process.getuid() !== 0) {
        fs.chmodSync(pluginsDir, 0o555);
        lockedPluginsDir = true;

        const res = cleanupLegacyPluginDir({
          legacyDir,
          targetDir,
          sourceDir: dummySrc,
          stdout: (m) => outLogs.push(m),
          stderr: (m) => errLogs.push(m)
        });
        assert.deepStrictEqual(res, { removed: false, skipped: false, locked: true });
        assert.strictEqual(outLogs.length, 0);
        assert.strictEqual(errLogs.length, 1);
        assert.strictEqual(errLogs[0].includes(`Could not remove legacy plugin directory (${legacyDir})`), true);
        assert.strictEqual(fs.existsSync(legacyDir), true);
      }
    } finally {
      await terminateChildProcess(lockChild);
      if (lockedPluginsDir) {
        fs.chmodSync(pluginsDir, 0o755);
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}
