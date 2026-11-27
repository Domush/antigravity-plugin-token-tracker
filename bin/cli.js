#!/usr/bin/env node

/**
 * Antigravity Token Tracker — Unified NPX CLI.
 * Provides installation, uninstallation, status-bar Electron ASAR injection,
 * and workspace/global management for Google Antigravity.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runInstall } from "../injector/install.js";
import { runUninstall } from "../injector/uninstall.js";
import {
  lstatOrNull,
  canonicalizeEntryPath,
  removePluginEntry,
  isEntrySameOrEnclosesSource,
  isSourceEnclosingEntry,
  cleanupLegacyPluginDir
} from "../lib/cli-cleanup.js";

export const PLUGIN_DIR_NAME = "token-tracker";
export const LEGACY_PLUGIN_DIR_NAME = "antigravity-plugin-token-tracker";

export const ESSENTIAL_FILES = [
  "plugin.json",
  "hooks.json",
  "mcp_config.json",
  "package.json",
  "CHANGELOG.md",
  "README.md",
  "LICENSE"
];

export const ESSENTIAL_DIRS = [
  "lib",
  "hooks",
  "injector",
  "mcp",
  "sidecars",
  "assets"
];

function resolvePluginDir(pluginDirName, { workspace = false, cwd = process.cwd() } = {}) {
  if (workspace) {
    return path.join(cwd, ".gemini", "plugins", pluginDirName);
  }
  const homeDir = process.env.USERPROFILE || process.env.HOME || os.homedir() || "";
  if (!homeDir) {
    throw new Error("Could not determine user home directory for global installation.");
  }
  return path.join(homeDir, ".gemini", "config", "plugins", pluginDirName);
}

/**
 * Resolves the target installation directory based on flags.
 * @param {Object} options
 * @param {boolean} [options.workspace]
 * @param {string} [options.cwd]
 * @returns {string}
 */
export function resolveTargetDir({ workspace = false, cwd = process.cwd() } = {}) {
  return resolvePluginDir(PLUGIN_DIR_NAME, { workspace, cwd });
}

/**
 * Resolves the legacy installation directory path for safe cleanup/migration.
 * @param {Object} options
 * @param {boolean} [options.workspace]
 * @param {string} [options.cwd]
 * @returns {string}
 */
export function resolveLegacyTargetDir({ workspace = false, cwd = process.cwd() } = {}) {
  return resolvePluginDir(LEGACY_PLUGIN_DIR_NAME, { workspace, cwd });
}

/**
 * Installs essential plugin files and directories into target directory.
 * @param {Object} options
 * @param {string} options.sourceDir
 * @param {string} options.targetDir
 * @param {string|null} [options.legacyDir]
 * @returns {string} Target directory path.
 */
export function installPlugin({ sourceDir, targetDir, legacyDir = null }) {
  if (!sourceDir || !fs.existsSync(sourceDir)) {
    throw new Error(`Source directory does not exist: ${sourceDir}`);
  }
  if (!targetDir) {
    throw new Error("Target installation directory must be specified.");
  }

  for (const file of ESSENTIAL_FILES) {
    const srcFile = path.join(sourceDir, file);
    if (!fs.existsSync(srcFile)) {
      throw new Error(`Required file missing from source: ${file}`);
    }
  }
  for (const dir of ESSENTIAL_DIRS) {
    const srcSubDir = path.join(sourceDir, dir);
    if (!fs.existsSync(srcSubDir)) {
      throw new Error(`Required directory missing from source: ${dir}`);
    }
  }

  const targetStat = lstatOrNull(targetDir);
  if (targetStat) {
    if (targetStat.isSymbolicLink()) {
      removePluginEntry(targetDir);
    } else if (!targetStat.isDirectory()) {
      throw new Error(`Target installation path exists and is not a directory: ${targetDir}`);
    } else {
      const resolvedSource = fs.realpathSync(sourceDir);
      const resolvedTarget = fs.realpathSync(targetDir);
      const isSamePath =
        process.platform === "win32"
          ? resolvedSource.toLowerCase() === resolvedTarget.toLowerCase()
          : resolvedSource === resolvedTarget;
      if (isSamePath) {
        throw new Error(`Target installation directory resolves to the same path as source: ${targetDir}`);
      }
    }
  }

  if (isEntrySameOrEnclosesSource(targetDir, sourceDir)) {
    throw new Error(`Target directory (${targetDir}) matches or encloses source directory (${sourceDir}); refusing self-overwrite.`);
  }
  for (const dir of ESSENTIAL_DIRS) {
    if (isSourceEnclosingEntry(path.join(sourceDir, dir), targetDir)) {
      throw new Error(`Target directory (${targetDir}) cannot be inside source bundle directory (${dir}).`);
    }
  }

  fs.mkdirSync(targetDir, { recursive: true });

  for (const file of ESSENTIAL_FILES) {
    const src = path.join(sourceDir, file);
    const dest = path.join(targetDir, file);
    const destStat = lstatOrNull(dest);
    if (destStat && destStat.isSymbolicLink()) {
      removePluginEntry(dest);
    }
    fs.copyFileSync(src, dest);
  }

  for (const dir of ESSENTIAL_DIRS) {
    const src = path.join(sourceDir, dir);
    const dest = path.join(targetDir, dir);
    const destStat = lstatOrNull(dest);
    if (destStat && destStat.isSymbolicLink()) {
      removePluginEntry(dest);
    }
    fs.cpSync(src, dest, { recursive: true, force: true });
  }

  if (legacyDir) {
    cleanupLegacyPluginDir({ legacyDir, targetDir, sourceDir });
  }

  return targetDir;
}

/**
 * Removes the installed plugin from target directory and optional legacy directory.
 * @param {Object} options
 * @param {string} options.targetDir
 * @param {string|null} [options.legacyDir]
 * @returns {{ removed: boolean, targetDir: string, removedTarget?: boolean, removedLegacy?: boolean, legacyDir?: string }}
 */
export function uninstallPlugin({ targetDir, legacyDir = null }) {
  if (!targetDir) {
    throw new Error("Target uninstallation directory must be specified.");
  }

  const removedTarget = removePluginEntry(targetDir);
  if (!legacyDir || canonicalizeEntryPath(legacyDir) === canonicalizeEntryPath(targetDir)) {
    return { removed: removedTarget, targetDir };
  }

  const removedLegacy = removePluginEntry(legacyDir);
  return {
    removed: removedTarget || removedLegacy,
    removedTarget,
    removedLegacy,
    targetDir,
    legacyDir
  };
}

/**
 * Safely reads version from package.json in root directory.
 * @param {string} rootDir
 * @returns {string}
 */
export function getPackageVersion(rootDir) {
  try {
    const pkgPath = path.join(rootDir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.version) return pkg.version;
    }
  } catch (err) {
    console.debug("[CLI] Unable to read package.json version:", err.message);
  }
  return "1.1.0";
}

/**
 * Returns formatted CLI usage instructions.
 * @param {string} version
 * @returns {string}
 */
export function getHelpText(version) {
  return `
Token Tracker CLI (v${version})

Usage:
  npx antigravity-plugin-token-tracker <command> [options]

Commands:
  install             Install plugin into Antigravity
  uninstall           Remove installed plugin from Antigravity
  install-injector    Patch Electron app.asar to enable in-app status bar pill
  uninstall-injector  Restore pristine app.asar and remove status bar injector

Options:
  --global, -g        Target global plugins directory (~/.gemini/config/plugins/token-tracker) [default]
  --workspace, -w     Target current workspace (.gemini/plugins/token-tracker)
  --dry-run           Simulate injector installation/uninstallation without modifying files
  --path <path>       Specify custom Antigravity resources directory for injector
  --help, -h          Show this help message
  --version, -v       Display version number
`;
}

/**
 * Parses raw command-line arguments into structured commands and flags.
 * @param {Array<string>} argv
 * @returns {{ commands: Array<string>, flags: Object }}
 */
export function parseCliArgs(argv = process.argv.slice(2)) {
  const flags = {
    workspace: false,
    global: false,
    dryRun: false,
    help: false,
    version: false,
    path: null,
    unknownFlag: null
  };
  const commands = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workspace" || arg === "-w") {
      flags.workspace = true;
    } else if (arg === "--global" || arg === "-g") {
      flags.global = true;
    } else if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else if (arg === "--version" || arg === "-v") {
      flags.version = true;
    } else if (arg === "--path" && i + 1 < argv.length) {
      flags.path = argv[++i];
    } else if (!arg.startsWith("-")) {
      commands.push(arg);
    } else {
      flags.unknownFlag = arg;
    }
  }

  return { commands, flags };
}

/**
 * Main CLI execution routine.
 * @param {Array<string>} argv
 * @param {Object} [options]
 * @param {boolean} [options.exitProcess]
 * @returns {Promise<number>} Exit code.
 */
export async function main(argv = process.argv.slice(2), { exitProcess = true } = {}) {
  const exit = (code) => {
    if (exitProcess) {
      process.exit(code);
    }
    return code;
  };

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const rootDir = path.resolve(__dirname, "..");
  const version = getPackageVersion(rootDir);

  const { commands, flags } = parseCliArgs(argv);
  const command = commands[0];

  if (flags.version) {
    console.log(`antigravity-plugin-token-tracker v${version}`);
    return exit(0);
  }

  if (flags.help || command === "help" || (!command && !flags.unknownFlag)) {
    console.log(getHelpText(version));
    return exit(0);
  }

  const VALID_COMMANDS = ["install", "uninstall", "install-injector", "uninstall-injector"];
  if (flags.unknownFlag || !VALID_COMMANDS.includes(command)) {
    const unknown = flags.unknownFlag || command;
    console.error(`\n❌ Unknown command or option: ${unknown}`);
    console.log(`Run 'npx antigravity-plugin-token-tracker --help' for usage.\n`);
    return exit(1);
  }

  if (command === "install") {
    console.log(`\n📦 Installing Token Tracker v${version}...`);
    try {
      const targetDir = resolveTargetDir({ workspace: flags.workspace });
      const legacyDir = resolveLegacyTargetDir({ workspace: flags.workspace });
      installPlugin({ sourceDir: rootDir, targetDir, legacyDir });
      console.log(`\n✨ Installation complete!`);
      console.log(`📍 Location: ${targetDir}`);
      console.log(`🚀 Restart or reload Antigravity to activate the plugin.\n`);
      return exit(0);
    } catch (err) {
      console.error(`\n❌ Installation failed: ${err.message}\n`);
      return exit(1);
    }
  }

  if (command === "uninstall") {
    try {
      const targetDir = resolveTargetDir({ workspace: flags.workspace });
      const legacyDir = resolveLegacyTargetDir({ workspace: flags.workspace });
      const { removedTarget, removedLegacy } = uninstallPlugin({ targetDir, legacyDir });
      if (removedTarget) {
        console.log(`\n✔ Token Tracker successfully removed from:`);
        console.log(`  ${targetDir}\n`);
      }
      if (removedLegacy) {
        console.log(`\n🧹 Removed legacy plugin directory:`);
        console.log(`  ${legacyDir}\n`);
      }
      if (!removedTarget && !removedLegacy) {
        console.log(`\nℹ Plugin not found at:`);
        console.log(`  ${targetDir}\n`);
      }
      return exit(0);
    } catch (err) {
      console.error(`\n❌ Uninstallation failed: ${err.message}\n`);
      return exit(1);
    }
  }

  if (command === "install-injector") {
    try {
      runInstall({ overridePath: flags.path, dryRun: flags.dryRun });
      return exit(0);
    } catch (err) {
      console.error(`\n❌ Injector installation failed: ${err.message}\n`);
      return exit(1);
    }
  }

  if (command === "uninstall-injector") {
    try {
      runUninstall({ overridePath: flags.path, dryRun: flags.dryRun });
      return exit(0);
    } catch (err) {
      console.error(`\n❌ Injector uninstallation failed: ${err.message}\n`);
      return exit(1);
    }
  }

  return exit(0);
}

function checkIfMain() {
  if (!process.argv[1]) return false;
  const scriptPath = fileURLToPath(import.meta.url);
  const argPath = process.argv[1];

  if (path.resolve(scriptPath).toLowerCase() === path.resolve(argPath).toLowerCase()) {
    return true;
  }

  try {
    if (fs.existsSync(argPath) && fs.realpathSync(argPath).toLowerCase() === fs.realpathSync(scriptPath).toLowerCase()) {
      return true;
    }
  } catch (err) {
    console.debug("[CLI] Error resolving symlinks for entry check:", err.message);
  }

  return false;
}

const isMain = checkIfMain();

if (isMain) {
  main(process.argv.slice(2), { exitProcess: true }).catch((err) => {
    console.error(`\n❌ CLI execution error: ${err.message}\n`);
    process.exit(1);
  });
}
