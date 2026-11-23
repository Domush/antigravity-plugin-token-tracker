/**
 * Antigravity Token Tracker — Safe Injector Uninstaller.
 * Completely and non-destructively rolls back Electron preload registration
 * by restoring the pristine original app.asar from backup.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { findAntigravityResourcesDir } from "./install.js";

/**
 * Main uninstallation routine.
 * @param {Object} options
 * @returns {boolean}
 */
export function runUninstall({ overridePath = null, dryRun = false } = {}) {
  console.log("=== Antigravity Token Tracker: Injector Uninstaller ===");

  const home = os.homedir();
  const pluginDataDir = path.join(home, ".gemini", "antigravity", "plugin_data", "token-tracker");
  const manifestPath = path.join(pluginDataDir, "install-manifest.json");

  let asarPath = null;
  let backupPath = null;

  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      asarPath = manifest.asarPath;
      backupPath = manifest.backupPath;
    } catch {
      // Fall through to manual discovery
    }
  }

  if (!asarPath || !fs.existsSync(asarPath)) {
    try {
      const resourcesDir = findAntigravityResourcesDir(overridePath);
      asarPath = path.join(resourcesDir, "app.asar");
      backupPath = `${asarPath}.token_tracker_backup`;
    } catch (err) {
      console.warn(`[Warning] Could not locate Antigravity resources: ${err.message}`);
    }
  }

  // 1. Restore pristine app.asar from backup if present
  if (backupPath && fs.existsSync(backupPath)) {
    console.log(`[1/3] Found original backup at: ${backupPath}`);
    if (!dryRun) {
      try {
        fs.copyFileSync(backupPath, asarPath);
        fs.unlinkSync(backupPath);
        console.log(`[2/3] Restored pristine app.asar and removed backup.`);
      } catch (err) {
        if (err.code === "EBUSY" || err.code === "EPERM") {
          throw new Error(
            `Cannot restore "${asarPath}" because it is currently locked by a running Antigravity instance.\n` +
            `Please completely exit Antigravity before uninstalling.\n` +
            `Original error: ${err.message}`
          );
        }
        throw err;
      }
    } else {
      console.log(`[2/3] Dry-run: backup would be restored to ${asarPath}.`);
    }
  } else {
    console.log("[1/3] No app.asar.token_tracker_backup found (archive may already be pristine).");
  }

  // 2. Remove injected status-bar.js and manifest
  const destScript = path.join(pluginDataDir, "status-bar.js");
  if (fs.existsSync(destScript)) {
    if (!dryRun) {
      fs.unlinkSync(destScript);
      console.log(`[3/3] Removed deployed script: ${destScript}`);
    } else {
      console.log(`[3/3] Dry-run: script ${destScript} would be removed.`);
    }
  }

  if (fs.existsSync(manifestPath) && !dryRun) {
    fs.unlinkSync(manifestPath);
  }

  console.log("=== Uninstallation cleanly completed ===");
  return true;
}

const isMain = Boolean(
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
);

if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  let customPath = null;
  const pathIdx = args.indexOf("--path");
  if (pathIdx !== -1 && args[pathIdx + 1]) {
    customPath = args[pathIdx + 1];
  }

  try {
    runUninstall({ overridePath: customPath, dryRun });
  } catch (err) {
    console.error(`Uninstallation failed: ${err.message}`);
    process.exit(1);
  }
}
