/**
 * Antigravity Token Tracker — CLI Symlink & Windows Junction Isolation Sub-Suite.
 * Validates installPlugin and uninstallPlugin behavior across active/broken
 * junctions, stale destination symlinks, same-realpath collisions, and file collisions.
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  installPlugin,
  uninstallPlugin,
  ESSENTIAL_FILES,
  ESSENTIAL_DIRS
} from "../bin/cli.js";

/**
 * Registers symlink and junction tests onto the CLI test runner.
 * @param {(name: string, fn: () => void) => void} test
 */
export function registerCliSymlinkTests(test) {
  // 1. Symlink / Windows Junction Replacement & Collision Guard Tests
  test("cli: installPlugin replaces active/broken junctions and stale destination symlinks safely", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-tt-symlink-install-"));
    const linkType = process.platform === "win32" ? "junction" : "dir";

    try {
      const dummySrc = path.join(tempDir, "dummy-source");
      fs.mkdirSync(dummySrc, { recursive: true });
      for (const file of ESSENTIAL_FILES) {
        fs.writeFileSync(path.join(dummySrc, file), `dummy ${file}`);
      }
      for (const dir of ESSENTIAL_DIRS) {
        const subDir = path.join(dummySrc, dir);
        fs.mkdirSync(subDir, { recursive: true });
        fs.writeFileSync(path.join(subDir, "marker.txt"), `marker-${dir}`);
      }

      // Case A: Active junction/symlink at targetDir leaves original target untouched
      const originalTarget = path.join(tempDir, "original-junction-target");
      fs.mkdirSync(originalTarget, { recursive: true });
      fs.writeFileSync(path.join(originalTarget, "sentinel.txt"), "do-not-delete");

      const activeTargetLink = path.join(tempDir, "installed-active-link");
      fs.symlinkSync(originalTarget, activeTargetLink, linkType);
      assert.strictEqual(fs.lstatSync(activeTargetLink).isSymbolicLink(), true);

      const installedActive = installPlugin({ sourceDir: dummySrc, targetDir: activeTargetLink });
      assert.strictEqual(installedActive, activeTargetLink);
      assert.strictEqual(fs.lstatSync(activeTargetLink).isSymbolicLink(), false);
      assert.strictEqual(fs.lstatSync(activeTargetLink).isDirectory(), true);
      assert.strictEqual(fs.readFileSync(path.join(activeTargetLink, "plugin.json"), "utf8"), "dummy plugin.json");
      assert.strictEqual(fs.readFileSync(path.join(activeTargetLink, "lib", "marker.txt"), "utf8"), "marker-lib");
      assert.strictEqual(fs.existsSync(path.join(activeTargetLink, "sentinel.txt")), false);
      assert.strictEqual(fs.readFileSync(path.join(originalTarget, "sentinel.txt"), "utf8"), "do-not-delete");

      // Case B: Broken junction/symlink at targetDir is cleanly replaced
      const deletedTarget = path.join(tempDir, "deleted-junction-target");
      fs.mkdirSync(deletedTarget, { recursive: true });
      const brokenTargetLink = path.join(tempDir, "installed-broken-link");
      fs.symlinkSync(deletedTarget, brokenTargetLink, linkType);
      fs.rmSync(deletedTarget, { recursive: true, force: true });
      assert.strictEqual(fs.lstatSync(brokenTargetLink).isSymbolicLink(), true);

      installPlugin({ sourceDir: dummySrc, targetDir: brokenTargetLink });
      assert.strictEqual(fs.lstatSync(brokenTargetLink).isSymbolicLink(), false);
      assert.strictEqual(fs.readFileSync(path.join(brokenTargetLink, "package.json"), "utf8"), "dummy package.json");

      // Case C: Stale symlinks/junctions at ESSENTIAL_FILES and ESSENTIAL_DIRS destinations
      const staleParent = path.join(tempDir, "stale-dest-target");
      const externalLib = path.join(tempDir, "external-lib");
      const deletedHooks = path.join(tempDir, "deleted-hooks");
      const staleFileTargetDir = path.join(tempDir, "stale-file-dir");
      fs.mkdirSync(staleParent, { recursive: true });
      fs.mkdirSync(externalLib, { recursive: true });
      fs.mkdirSync(deletedHooks, { recursive: true });
      fs.mkdirSync(staleFileTargetDir, { recursive: true });
      fs.writeFileSync(path.join(externalLib, "keep-lib.txt"), "untouched-lib");

      const readmeDest = path.join(staleParent, "README.md");
      try {
        fs.symlinkSync(path.join(tempDir, "missing-readme.md"), readmeDest, "file");
      } catch (err) {
        if (err.code !== "EPERM") throw err;
        fs.symlinkSync(staleFileTargetDir, readmeDest, "junction");
      }
      fs.symlinkSync(externalLib, path.join(staleParent, "lib"), linkType);
      fs.symlinkSync(deletedHooks, path.join(staleParent, "hooks"), linkType);
      fs.rmSync(deletedHooks, { recursive: true, force: true });

      installPlugin({ sourceDir: dummySrc, targetDir: staleParent });
      assert.strictEqual(fs.lstatSync(readmeDest).isSymbolicLink(), false);
      assert.strictEqual(fs.readFileSync(readmeDest, "utf8"), "dummy README.md");
      assert.strictEqual(fs.lstatSync(path.join(staleParent, "lib")).isSymbolicLink(), false);
      assert.strictEqual(fs.readFileSync(path.join(staleParent, "lib", "marker.txt"), "utf8"), "marker-lib");
      assert.strictEqual(fs.readFileSync(path.join(externalLib, "keep-lib.txt"), "utf8"), "untouched-lib");
      assert.strictEqual(fs.lstatSync(path.join(staleParent, "hooks")).isSymbolicLink(), false);
      assert.strictEqual(fs.readFileSync(path.join(staleParent, "hooks", "marker.txt"), "utf8"), "marker-hooks");

      // Case D: Same-realpath non-symlink collision fails fast
      assert.throws(
        () => installPlugin({ sourceDir: dummySrc, targetDir: dummySrc }),
        /Target installation directory resolves to the same path as source/
      );

      // Case E: Target exists as a regular file fails fast
      const regularFileTarget = path.join(tempDir, "regular-file-target");
      fs.writeFileSync(regularFileTarget, "not-a-directory");
      assert.throws(
        () => installPlugin({ sourceDir: dummySrc, targetDir: regularFileTarget }),
        /Target installation path exists and is not a directory/
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // 2. Uninstall Plugin Symlink / Windows Junction Isolation Tests
  test("cli: uninstallPlugin removes active and broken junctions without touching target contents", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ag-tt-symlink-uninstall-"));
    const linkType = process.platform === "win32" ? "junction" : "dir";

    try {
      const keepDir = path.join(tempDir, "keep-target");
      fs.mkdirSync(keepDir, { recursive: true });
      fs.writeFileSync(path.join(keepDir, "keep.txt"), "preserve-me");

      const activeLink = path.join(tempDir, "active-uninstall-link");
      fs.symlinkSync(keepDir, activeLink, linkType);

      const resActive = uninstallPlugin({ targetDir: activeLink });
      assert.deepStrictEqual(resActive, { removed: true, targetDir: activeLink });
      assert.throws(() => fs.lstatSync(activeLink), { code: "ENOENT" });
      assert.strictEqual(fs.readFileSync(path.join(keepDir, "keep.txt"), "utf8"), "preserve-me");

      const ghostDir = path.join(tempDir, "ghost-target");
      fs.mkdirSync(ghostDir, { recursive: true });
      const brokenLink = path.join(tempDir, "broken-uninstall-link");
      fs.symlinkSync(ghostDir, brokenLink, linkType);
      fs.rmSync(ghostDir, { recursive: true, force: true });

      const resBroken = uninstallPlugin({ targetDir: brokenLink });
      assert.deepStrictEqual(resBroken, { removed: true, targetDir: brokenLink });
      assert.throws(() => fs.lstatSync(brokenLink), { code: "ENOENT" });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}
