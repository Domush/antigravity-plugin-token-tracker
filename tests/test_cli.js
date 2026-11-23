/**
 * Antigravity Token Tracker — CLI Integration & Unit Test Suite.
 * Validates CLI arguments parsing, --help, --version, --workspace install/uninstall,
 * dry-run injector execution, and negative-path invalid commands with strict cleanup.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseCliArgs,
  resolveTargetDir,
  installPlugin,
  uninstallPlugin,
  getPackageVersion,
  ESSENTIAL_FILES,
  ESSENTIAL_DIRS
} from "../bin/cli.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const cliPath = path.resolve(rootDir, "bin", "cli.js");

/**
 * Runs the CLI test suite.
 * @returns {Promise<{ passed: number, failed: number }>}
 */
export async function runCliTests() {
  console.log("--- Running test_cli.js ---");
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

  // 1. Argument Parser Unit Tests
  test("cli: parseCliArgs parses commands and flags accurately", () => {
    const res1 = parseCliArgs(["install", "--workspace"]);
    assert.deepStrictEqual(res1.commands, ["install"]);
    assert.strictEqual(res1.flags.workspace, true);
    assert.strictEqual(res1.flags.global, false);

    const res2 = parseCliArgs(["uninstall", "-g"]);
    assert.deepStrictEqual(res2.commands, ["uninstall"]);
    assert.strictEqual(res2.flags.global, true);
    assert.strictEqual(res2.flags.workspace, false);

    const res3 = parseCliArgs(["--version"]);
    assert.strictEqual(res3.flags.version, true);

    const res4 = parseCliArgs(["--help"]);
    assert.strictEqual(res4.flags.help, true);

    const res5 = parseCliArgs(["install-injector", "--dry-run", "--path", "C:/test/path"]);
    assert.deepStrictEqual(res5.commands, ["install-injector"]);
    assert.strictEqual(res5.flags.dryRun, true);
    assert.strictEqual(res5.flags.path, "C:/test/path");

    const res6 = parseCliArgs(["--unknown-flag"]);
    assert.strictEqual(res6.flags.unknownFlag, "--unknown-flag");
  });

  // 2. Target Directory Resolution
  test("cli: resolveTargetDir respects workspace and global paths", () => {
    const customCwd = path.join(os.tmpdir(), "ag-custom-workspace");
    const workspaceTarget = resolveTargetDir({ workspace: true, cwd: customCwd });
    assert.strictEqual(workspaceTarget, path.join(customCwd, ".gemini", "plugins", "antigravity-plugin-token-tracker"));

    const globalTarget = resolveTargetDir({ workspace: false });
    assert.strictEqual(globalTarget.includes(".gemini"), true);
    assert.strictEqual(globalTarget.endsWith("antigravity-plugin-token-tracker"), true);
  });

  // 3. Package Version Extraction
  test("cli: getPackageVersion retrieves version from package.json", () => {
    const version = getPackageVersion(rootDir);
    assert.strictEqual(typeof version, "string");
    assert.strictEqual(/^\d+\.\d+\.\d+/.test(version), true);

    const fallback = getPackageVersion(os.tmpdir());
    assert.strictEqual(fallback, "1.0.0");
  });

  // 4. CLI Process Invocation: --help and -h
  test("cli: process invocation for --help and -h exits with code 0", () => {
    const runHelp = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
    assert.strictEqual(runHelp.status, 0);
    assert.strictEqual(runHelp.stdout.includes("Antigravity Token Tracker CLI"), true);
    assert.strictEqual(runHelp.stdout.includes("Commands:"), true);
    assert.strictEqual(runHelp.stdout.includes("install"), true);

    const runShortHelp = spawnSync(process.execPath, [cliPath, "-h"], { encoding: "utf8" });
    assert.strictEqual(runShortHelp.status, 0);
    assert.strictEqual(runShortHelp.stdout.includes("Antigravity Token Tracker CLI"), true);
  });

  // 5. CLI Process Invocation: --version and -v
  test("cli: process invocation for --version and -v exits with code 0", () => {
    const runVersion = spawnSync(process.execPath, [cliPath, "--version"], { encoding: "utf8" });
    assert.strictEqual(runVersion.status, 0);
    assert.strictEqual(runVersion.stdout.trim().startsWith("antigravity-plugin-token-tracker v"), true);

    const runShortVersion = spawnSync(process.execPath, [cliPath, "-v"], { encoding: "utf8" });
    assert.strictEqual(runShortVersion.status, 0);
    assert.strictEqual(runShortVersion.stdout.trim().startsWith("antigravity-plugin-token-tracker v"), true);
  });

  // 6. CLI Process Invocation: Invalid Command
  test("cli: invalid command exits with code 1 and error message", () => {
    const runInvalid = spawnSync(process.execPath, [cliPath, "nonexistent-command"], { encoding: "utf8" });
    assert.strictEqual(runInvalid.status, 1);
    assert.strictEqual(runInvalid.stderr.includes("Unknown command"), true);
  });

  // 7. CLI Workspace Install and Uninstall Lifecycle
  test("cli: install --workspace and uninstall --workspace lifecycle with clean directory isolation", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-tt-cli-test-"));
    const expectedInstallDir = path.join(tempDir, ".gemini", "plugins", "antigravity-plugin-token-tracker");

    try {
      // Step A: Install into workspace
      const installRes = spawnSync(process.execPath, [cliPath, "install", "--workspace"], {
        cwd: tempDir,
        encoding: "utf8"
      });
      assert.strictEqual(installRes.status, 0, `Install failed: ${installRes.stderr}`);
      assert.strictEqual(fs.existsSync(expectedInstallDir), true);

      // Verify all essential files were copied
      for (const file of ESSENTIAL_FILES) {
        const filePath = path.join(expectedInstallDir, file);
        assert.strictEqual(fs.existsSync(filePath), true, `Missing installed file: ${file}`);
      }

      // Verify essential directories were copied
      for (const dir of ESSENTIAL_DIRS) {
        const dirPath = path.join(expectedInstallDir, dir);
        assert.strictEqual(fs.existsSync(dirPath), true, `Missing installed directory: ${dir}`);
      }

      assert.strictEqual(fs.existsSync(path.join(expectedInstallDir, "lib", "models.js")), true);
      assert.strictEqual(fs.existsSync(path.join(expectedInstallDir, "hooks", "session-start.js")), true);
      assert.strictEqual(fs.existsSync(path.join(expectedInstallDir, "injector", "install.js")), true);
      assert.strictEqual(fs.existsSync(path.join(expectedInstallDir, "sidecars", "dashboard", "index.html")), true);

      // Step B: Re-run install to verify idempotency and clean overwrite
      const reinstallRes = spawnSync(process.execPath, [cliPath, "install", "-w"], {
        cwd: tempDir,
        encoding: "utf8"
      });
      assert.strictEqual(reinstallRes.status, 0);

      // Step C: Uninstall from workspace
      const uninstallRes = spawnSync(process.execPath, [cliPath, "uninstall", "--workspace"], {
        cwd: tempDir,
        encoding: "utf8"
      });
      assert.strictEqual(uninstallRes.status, 0, `Uninstall failed: ${uninstallRes.stderr}`);
      assert.strictEqual(fs.existsSync(expectedInstallDir), false);

      // Step D: Re-run uninstall when already removed (should report not found and exit 0)
      const reUninstallRes = spawnSync(process.execPath, [cliPath, "uninstall", "-w"], {
        cwd: tempDir,
        encoding: "utf8"
      });
      assert.strictEqual(reUninstallRes.status, 0);
      assert.strictEqual(reUninstallRes.stdout.includes("Plugin not found"), true);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (cleanErr) {
        console.debug("[CLI Test] Cleanup warning:", cleanErr.message);
      }
    }
  });

  // 8. CLI Injector Subcommands Dry-Run Invocation
  test("cli: install-injector and uninstall-injector support --dry-run", () => {
    const installDry = spawnSync(process.execPath, [cliPath, "install-injector", "--dry-run"], { encoding: "utf8" });
    assert.strictEqual(installDry.status, 0, `install-injector --dry-run failed: ${installDry.stderr}`);

    const uninstallDry = spawnSync(process.execPath, [cliPath, "uninstall-injector", "--dry-run"], { encoding: "utf8" });
    assert.strictEqual(uninstallDry.status, 0, `uninstall-injector --dry-run failed: ${uninstallDry.stderr}`);
  });

  // 9. Negative Path: Install from Corrupted/Missing Source
  test("cli: installPlugin throws when source directory is invalid", () => {
    assert.throws(() => {
      installPlugin({ sourceDir: "/nonexistent/invalid/dir", targetDir: os.tmpdir() });
    }, /Source directory does not exist/);

    const tempEmptySource = fs.mkdtempSync(path.join(os.tmpdir(), "ag-tt-empty-src-"));
    const tempTarget = fs.mkdtempSync(path.join(os.tmpdir(), "ag-tt-empty-tgt-"));
    try {
      assert.throws(() => {
        installPlugin({ sourceDir: tempEmptySource, targetDir: tempTarget });
      }, /Required file missing from source/);
    } finally {
      try {
        fs.rmSync(tempEmptySource, { recursive: true, force: true });
        fs.rmSync(tempTarget, { recursive: true, force: true });
      } catch (cleanErr) {
        console.debug("[CLI Test] Empty dir cleanup warning:", cleanErr.message);
      }
    }
  });

  // 10. Negative Path: Uninstall Plugin Validation
  test("cli: uninstallPlugin returns removed false when directory does not exist", () => {
    const nonExistent = path.join(os.tmpdir(), "ag-tt-nonexistent-" + Date.now());
    const res = uninstallPlugin({ targetDir: nonExistent });
    assert.strictEqual(res.removed, false);
    assert.strictEqual(res.targetDir, nonExistent);

    assert.throws(() => {
      uninstallPlugin({ targetDir: "" });
    }, /Target uninstallation directory must be specified/);
  });

  return { passed, failed };
}

const isMain = Boolean(
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
);

if (isMain) {
  runCliTests()
    .then(({ passed, failed }) => {
      process.exit(failed === 0 ? 0 : 1);
    })
    .catch((err) => {
      console.error("[FATAL] CLI test runner failed:", err);
      process.exit(1);
    });
}
