/**
 * Antigravity Token Tracker — CLI Integration & Unit Test Suite.
 * Validates CLI argument parsing, --help, --version, workspace/global install & uninstall,
 * isolated dry-run injector execution, and negative-path error contracts.
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
import { computeFileHash } from "../injector/install.js";
import { buildSyntheticAsar } from "./test_injector_offset.js";
import { registerCliSymlinkTests } from "./test_cli_symlinks.js";

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

  // 1. Argument Parser Unit & Boundary Tests
  test("cli: parseCliArgs parses commands, flags, empty argv, and dangling --path", () => {
    const resEmpty = parseCliArgs([]);
    assert.deepStrictEqual(resEmpty.commands, []);
    assert.deepStrictEqual(resEmpty.flags, {
      workspace: false,
      global: false,
      dryRun: false,
      help: false,
      version: false,
      path: null,
      unknownFlag: null
    });

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

    const resDanglingPath = parseCliArgs(["install-injector", "--path"]);
    assert.deepStrictEqual(resDanglingPath.commands, ["install-injector"]);
    assert.strictEqual(resDanglingPath.flags.path, null);
    assert.strictEqual(resDanglingPath.flags.unknownFlag, "--path");

    const res6 = parseCliArgs(["--unknown-flag"]);
    assert.strictEqual(res6.flags.unknownFlag, "--unknown-flag");
  });

  // 2. Target Directory Resolution & Env Precedence
  test("cli: resolveTargetDir respects workspace, USERPROFILE precedence, HOME, and os.homedir fallback", () => {
    const customCwd = path.join(os.tmpdir(), "ag-custom-workspace");
    const workspaceTarget = resolveTargetDir({ workspace: true, cwd: customCwd });
    assert.strictEqual(workspaceTarget, path.join(customCwd, ".gemini", "plugins", "antigravity-plugin-token-tracker"));

    const savedUserProfile = process.env.USERPROFILE;
    const savedHome = process.env.HOME;
    const fakeProfile = path.join(os.tmpdir(), "ag-fake-profile");
    const fakeHome = path.join(os.tmpdir(), "ag-fake-home");

    try {
      process.env.USERPROFILE = fakeProfile;
      process.env.HOME = fakeHome;
      assert.strictEqual(
        resolveTargetDir({ workspace: false }),
        path.join(fakeProfile, ".gemini", "config", "plugins", "antigravity-plugin-token-tracker")
      );

      delete process.env.USERPROFILE;
      process.env.HOME = fakeHome;
      assert.strictEqual(
        resolveTargetDir({ workspace: false }),
        path.join(fakeHome, ".gemini", "config", "plugins", "antigravity-plugin-token-tracker")
      );

      delete process.env.USERPROFILE;
      delete process.env.HOME;
      assert.strictEqual(
        resolveTargetDir({ workspace: false }),
        path.join(os.homedir(), ".gemini", "config", "plugins", "antigravity-plugin-token-tracker")
      );
    } finally {
      if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
      else delete process.env.USERPROFILE;
      if (savedHome !== undefined) process.env.HOME = savedHome;
      else delete process.env.HOME;
    }
  });

  // 3. Package Version Extraction & Malformed Fallback
  test("cli: getPackageVersion extracts version and falls back on missing or malformed package.json", () => {
    const version = getPackageVersion(rootDir);
    assert.strictEqual(typeof version, "string");
    assert.strictEqual(/^\d+\.\d+\.\d+/.test(version), true);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-tt-pkg-"));
    try {
      const emptyDir = path.join(tempDir, "empty");
      const malformedDir = path.join(tempDir, "malformed");
      fs.mkdirSync(emptyDir, { recursive: true });
      fs.mkdirSync(malformedDir, { recursive: true });
      fs.writeFileSync(path.join(malformedDir, "package.json"), "{invalid-json", "utf8");

      assert.strictEqual(getPackageVersion(emptyDir), "1.0.0");
      assert.strictEqual(getPackageVersion(malformedDir), "1.0.0");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 4. CLI Process Invocation: --help, -h, and No-Arg Default
  test("cli: process invocation for --help, -h, and no-arg prints help and exits 0", () => {
    for (const args of [["--help"], ["-h"], []]) {
      const res = spawnSync(process.execPath, [cliPath, ...args], { encoding: "utf8" });
      assert.strictEqual(res.status, 0, `expected exit 0 for args [${args.join(" ")}]: ${res.stderr}`);
      assert.strictEqual(res.stdout.includes("Antigravity Token Tracker CLI"), true);
      assert.strictEqual(res.stdout.includes("Commands:"), true);
      assert.strictEqual(res.stdout.includes("install"), true);
    }
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

  // 6. CLI Process Invocation: Invalid Command & Unknown Flag
  test("cli: invalid command and unknown flag exit with code 1 and stderr diagnostic", () => {
    const runInvalid = spawnSync(process.execPath, [cliPath, "nonexistent-command"], { encoding: "utf8" });
    assert.strictEqual(runInvalid.status, 1);
    assert.strictEqual(runInvalid.stderr.includes("Unknown command or option: nonexistent-command"), true);

    const runUnknownFlag = spawnSync(process.execPath, [cliPath, "--unknown-flag"], { encoding: "utf8" });
    assert.strictEqual(runUnknownFlag.status, 1);
    assert.strictEqual(runUnknownFlag.stderr.includes("Unknown command or option: --unknown-flag"), true);
  });

  // 7. CLI Workspace & Global Install/Uninstall Lifecycles (Isolated)
  test("cli: install/uninstall --workspace and --global lifecycles with strict directory isolation", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-tt-cli-test-"));

    try {
      const workspaceDir = path.join(tempDir, "workspace");
      const fakeHome = path.join(tempDir, "home");
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.mkdirSync(fakeHome, { recursive: true });

      const expectedWorkspaceInstall = path.join(workspaceDir, ".gemini", "plugins", "antigravity-plugin-token-tracker");
      const expectedGlobalInstall = path.join(fakeHome, ".gemini", "config", "plugins", "antigravity-plugin-token-tracker");
      const childEnv = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
      // Workspace lifecycle
      const installRes = spawnSync(process.execPath, [cliPath, "install", "--workspace"], {
        cwd: workspaceDir,
        encoding: "utf8"
      });
      assert.strictEqual(installRes.status, 0, `Install failed: ${installRes.stderr}`);
      for (const file of ESSENTIAL_FILES) {
        assert.strictEqual(fs.existsSync(path.join(expectedWorkspaceInstall, file)), true, `Missing file: ${file}`);
      }
      for (const dir of ESSENTIAL_DIRS) {
        assert.strictEqual(fs.existsSync(path.join(expectedWorkspaceInstall, dir)), true, `Missing dir: ${dir}`);
      }

      const reinstallRes = spawnSync(process.execPath, [cliPath, "install", "-w"], { cwd: workspaceDir, encoding: "utf8" });
      assert.strictEqual(reinstallRes.status, 0);

      const uninstallRes = spawnSync(process.execPath, [cliPath, "uninstall", "--workspace"], { cwd: workspaceDir, encoding: "utf8" });
      assert.strictEqual(uninstallRes.status, 0, `Uninstall failed: ${uninstallRes.stderr}`);
      assert.strictEqual(fs.existsSync(expectedWorkspaceInstall), false);

      const reUninstallRes = spawnSync(process.execPath, [cliPath, "uninstall", "-w"], { cwd: workspaceDir, encoding: "utf8" });
      assert.strictEqual(reUninstallRes.status, 0);
      assert.strictEqual(reUninstallRes.stdout.includes("Plugin not found"), true);

      // Isolated Global lifecycle
      const globalInstall = spawnSync(process.execPath, [cliPath, "install", "--global"], {
        env: childEnv,
        encoding: "utf8"
      });
      assert.strictEqual(globalInstall.status, 0, `Global install failed: ${globalInstall.stderr}`);
      assert.strictEqual(fs.existsSync(path.join(expectedGlobalInstall, "lib", "models.js")), true);

      const globalUninstall = spawnSync(process.execPath, [cliPath, "uninstall", "-g"], {
        env: childEnv,
        encoding: "utf8"
      });
      assert.strictEqual(globalUninstall.status, 0, `Global uninstall failed: ${globalUninstall.stderr}`);
      assert.strictEqual(fs.existsSync(expectedGlobalInstall), false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 8. Isolated CLI Injector Dry-Run Verification
  test("cli: install-injector and uninstall-injector --dry-run operate non-destructively in isolated temp dirs", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ag-tt-cli-dryrun-"));

    try {
      const fakeHome = path.join(tempRoot, "home");
      const resourcesDir = path.join(tempRoot, "resources");
      fs.mkdirSync(fakeHome, { recursive: true });
      fs.mkdirSync(resourcesDir, { recursive: true });

      const childEnv = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome };
      const asarPath = path.join(resourcesDir, "app.asar");
      const backupPath = `${asarPath}.token_tracker_backup`;
      const pluginDataDir = path.join(fakeHome, ".gemini", "antigravity", "plugin_data", "token-tracker");
      const statusBarDest = path.join(pluginDataDir, "status-bar.js");
      const manifestPath = path.join(pluginDataDir, "install-manifest.json");
      fs.writeFileSync(asarPath, buildSyntheticAsar({ "dist/preload.js": "console.log('preload');" }));
      const initialHash = computeFileHash(asarPath);

      const installDry = spawnSync(
        process.execPath,
        [cliPath, "install-injector", "--dry-run", "--path", resourcesDir],
        { env: childEnv, encoding: "utf8" }
      );
      assert.strictEqual(installDry.status, 0, `install-injector --dry-run failed: ${installDry.stderr}`);
      assert.strictEqual(installDry.stdout.includes("Dry-run complete: app.asar can be cleanly patched."), true);
      assert.strictEqual(computeFileHash(asarPath), initialHash);
      assert.strictEqual(fs.existsSync(backupPath), false);
      assert.strictEqual(fs.existsSync(statusBarDest), false);
      assert.strictEqual(fs.existsSync(manifestPath), false);

      // Seed fake backup & script to verify uninstall --dry-run preserves both
      fs.mkdirSync(pluginDataDir, { recursive: true });
      fs.writeFileSync(backupPath, "pristine-backup-bytes");
      fs.writeFileSync(statusBarDest, "// deployed script");
      fs.writeFileSync(manifestPath, JSON.stringify({ asarPath, backupPath }));

      const uninstallDry = spawnSync(
        process.execPath,
        [cliPath, "uninstall-injector", "--dry-run", "--path", resourcesDir],
        { env: childEnv, encoding: "utf8" }
      );
      assert.strictEqual(uninstallDry.status, 0, `uninstall-injector --dry-run failed: ${uninstallDry.stderr}`);
      assert.strictEqual(uninstallDry.stdout.includes(`Dry-run: backup would be restored to ${asarPath}.`), true);
      assert.strictEqual(uninstallDry.stdout.includes(`Dry-run: script ${statusBarDest} would be removed.`), true);
      assert.strictEqual(computeFileHash(asarPath), initialHash);
      assert.strictEqual(fs.existsSync(backupPath), true);
      assert.strictEqual(fs.existsSync(statusBarDest), true);
      assert.strictEqual(fs.existsSync(manifestPath), true);

      // Negative path: invalid --path fails fast with exit 1
      const badPathRes = spawnSync(
        process.execPath,
        [cliPath, "install-injector", "--dry-run", "--path", path.join(tempRoot, "missing-resources")],
        { env: childEnv, encoding: "utf8" }
      );
      assert.strictEqual(badPathRes.status, 1);
      assert.strictEqual(badPathRes.stderr.includes("Specified Antigravity resources path does not exist"), true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  // 9. Negative Path: Install from Corrupted/Missing Source or Invalid Target
  test("cli: installPlugin fails fast on invalid source, missing files/dirs, or empty target", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ag-tt-install-neg-"));
    try {
      const missingSrc = path.join(tempRoot, "missing-source");
      const tempTarget = path.join(tempRoot, "target");
      fs.mkdirSync(tempTarget, { recursive: true });

      assert.throws(() => {
        installPlugin({ sourceDir: missingSrc, targetDir: tempTarget });
      }, /Source directory does not exist/);

      assert.throws(() => {
        installPlugin({ sourceDir: rootDir, targetDir: "" });
      }, /Target installation directory must be specified/);

      const tempEmptySource = path.join(tempRoot, "empty-source");
      fs.mkdirSync(tempEmptySource, { recursive: true });
      assert.throws(() => {
        installPlugin({ sourceDir: tempEmptySource, targetDir: tempTarget });
      }, /Required file missing from source/);

      const tempMissingDirSource = path.join(tempRoot, "missing-dir-source");
      fs.mkdirSync(tempMissingDirSource, { recursive: true });
      for (const file of ESSENTIAL_FILES) {
        fs.writeFileSync(path.join(tempMissingDirSource, file), `dummy ${file}`);
      }
      assert.throws(() => {
        installPlugin({ sourceDir: tempMissingDirSource, targetDir: tempTarget });
      }, /Required directory missing from source: lib/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  // 10. Negative Path: Uninstall Plugin Validation
  test("cli: uninstallPlugin returns removed false when directory does not exist", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ag-tt-uninstall-neg-"));
    try {
      const nonExistent = path.join(tempRoot, "does-not-exist");
      const res = uninstallPlugin({ targetDir: nonExistent });
      assert.strictEqual(res.removed, false);
      assert.strictEqual(res.targetDir, nonExistent);

      assert.throws(() => {
        uninstallPlugin({ targetDir: "" });
      }, /Target uninstallation directory must be specified/);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  // 11-12. Symlink & Windows Junction Isolation Sub-Suite
  registerCliSymlinkTests(test);

  return { passed, failed };
}

const isMain = Boolean(
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
);

if (isMain) {
  runCliTests()
    .then(({ failed }) => {
      process.exit(failed === 0 ? 0 : 1);
    })
    .catch((err) => {
      console.error("[FATAL] CLI test runner failed:", err);
      process.exit(1);
    });
}
