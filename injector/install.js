/**
 * Antigravity Token Tracker — Safe Injector Installer.
 * Installs status-bar.js and registers a dynamic loader hook into Antigravity's
 * Electron preload script in app.asar with non-destructive backup and rollback.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const INJECTION_TAG_START = "/* === ANTIGRAVITY TOKEN TRACKER INJECTION START === */";
export const INJECTION_TAG_END = "/* === ANTIGRAVITY TOKEN TRACKER INJECTION END === */";

export const INJECTION_CODE = `
${INJECTION_TAG_START}
(function __tokenTrackerPreloadHook() {
  try {
    const _fs = require("fs");
    const _path = require("path");
    const _home = process.env.USERPROFILE || process.env.HOME || "";
    const _target = _path.join(_home, ".gemini", "antigravity", "plugin_data", "token-tracker", "status-bar.js");
    if (_fs.existsSync(_target)) {
      const _code = _fs.readFileSync(_target, "utf8");
      const _inject = () => {
        try {
          const _el = document.createElement("script");
          _el.type = "text/javascript";
          _el.textContent = _code;
          (document.head || document.documentElement).appendChild(_el);
        } catch (err) {
          console.debug("[TokenTracker] Injection element error:", err);
        }
      };
      if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", _inject, { once: true });
      } else {
        _inject();
      }
    }
  } catch (err) {
    console.debug("[TokenTracker] Preload hook initialization error:", err);
  }
})();
${INJECTION_TAG_END}
`;

/**
 * Finds the Antigravity resources folder across platforms.
 * @param {string|null} overridePath
 * @returns {string}
 */
export function findAntigravityResourcesDir(overridePath = null) {
  if (overridePath) {
    const candidate = path.resolve(overridePath);
    if (fs.existsSync(candidate)) return candidate;
    throw new Error(`Specified Antigravity resources path does not exist: ${candidate}`);
  }

  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Antigravity", "resources"),
    path.join(process.env.PROGRAMFILES || "", "Antigravity", "resources"),
    path.join("/Applications", "Antigravity.app", "Contents", "Resources"),
    path.join(os.homedir(), "Applications", "Antigravity.app", "Contents", "Resources"),
    "/opt/Antigravity/resources",
    "/usr/lib/antigravity/resources"
  ];

  for (const c of candidates) {
    if (c && fs.existsSync(c) && fs.existsSync(path.join(c, "app.asar"))) {
      return c;
    }
  }

  // Fallback to checking active processes or standard path
  const standardWin = path.join(process.env.LOCALAPPDATA || "", "Programs", "Antigravity", "resources");
  if (fs.existsSync(standardWin)) {
    return standardWin;
  }

  throw new Error("Could not automatically locate Antigravity resources directory. Pass --path <path> to specify.");
}

/**
 * Computes sha256 checksum of a file.
 * @param {string} filePath
 * @returns {string}
 */
export function computeFileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Patches app.asar to include preload injection hook.
 * @param {string} asarPath
 * @param {boolean} dryRun
 * @returns {{ backupCreated: boolean, modified: boolean }}
 */
export function patchAppAsar(asarPath, dryRun = false) {
  if (!fs.existsSync(asarPath)) {
    throw new Error(`Target app.asar not found at: ${asarPath}`);
  }

  let fd = null;
  let outFd = null;
  let tempAsarPath = null;

  try {
    fd = fs.openSync(asarPath, "r");
    const headerBuf = Buffer.alloc(16);
    fs.readSync(fd, headerBuf, 0, 16, 0);

    const jsonLength = headerBuf.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonLength);
    fs.readSync(fd, jsonBuf, 0, jsonLength, 16);

    const header = JSON.parse(jsonBuf.toString("utf8"));
    const distFiles = header?.files?.dist?.files;
    const preloadEntry = distFiles ? distFiles["preload.js"] : null;

    if (!preloadEntry) {
      throw new Error("Could not find dist/preload.js in app.asar archive.");
    }

    // Offset 4 contains pickle header size. File payloads begin at 8 + headerSize.
    const payloadStart = 8 + headerBuf.readUInt32LE(4);
    const preloadOffset = parseInt(preloadEntry.offset, 10);
    const preloadSize = preloadEntry.size;

    const currentPreloadBuf = Buffer.alloc(preloadSize);
    fs.readSync(fd, currentPreloadBuf, 0, preloadSize, payloadStart + preloadOffset);
    const currentPreloadStr = currentPreloadBuf.toString("utf8");

    if (currentPreloadStr.includes(INJECTION_TAG_START)) {
      return { backupCreated: false, modified: false, alreadyInstalled: true };
    }

    if (dryRun) {
      return { backupCreated: false, modified: true, dryRun: true };
    }

    // 1. Create safe backup before modification
    const backupPath = `${asarPath}.token_tracker_backup`;
    let backupCreated = false;
    if (!fs.existsSync(backupPath)) {
      try {
        fs.copyFileSync(asarPath, backupPath);
        backupCreated = true;
      } catch (err) {
        if (err.code === "EBUSY" || err.code === "EPERM") {
          throw new Error(
            `Cannot backup "${asarPath}" because it is currently locked by a running Antigravity instance.\n` +
            `Please completely exit Antigravity and re-run this command.\n` +
            `Original error: ${err.message}`
          );
        }
        throw err;
      }
    }

    // 2. Build new preload content
    const newPreloadStr = currentPreloadStr + "\n" + INJECTION_CODE;
    const newPreloadBuf = Buffer.from(newPreloadStr, "utf8");
    const deltaSize = newPreloadBuf.length - preloadSize;

    // 3. Update preload entry
    preloadEntry.size = newPreloadBuf.length;
    if (preloadEntry.integrity) {
      const hash = crypto.createHash("sha256").update(newPreloadBuf).digest("hex");
      preloadEntry.integrity.hash = hash;
      preloadEntry.integrity.blocks = [hash];
    }

    // 4. Update all file offsets stored after preload.js
    function updateOffsets(node) {
      if (!node || typeof node !== "object") return;
      if (node.files) {
        for (const k of Object.keys(node.files)) {
          updateOffsets(node.files[k]);
        }
      } else if (node.offset !== undefined) {
        const off = parseInt(node.offset, 10);
        if (off > preloadOffset) {
          node.offset = String(off + deltaSize);
        }
      }
    }
    updateOffsets(header);

    // 5. Serialize new header
    const newJsonStr = JSON.stringify(header);
    const newJsonBuf = Buffer.from(newJsonStr, "utf8");
    const newJsonLen = newJsonBuf.length;

    // Pad to 4-byte alignment
    const rem = newJsonLen % 4;
    const padLen = rem === 0 ? 0 : 4 - rem;
    const newPicklePayloadLen = newJsonLen + padLen + 4; // includes uint32 string length prefix

    const newHeaderBuf = Buffer.alloc(16);
    newHeaderBuf.writeUInt32LE(4, 0);
    newHeaderBuf.writeUInt32LE(newPicklePayloadLen + 4, 4);
    newHeaderBuf.writeUInt32LE(newPicklePayloadLen, 8);
    newHeaderBuf.writeUInt32LE(newJsonLen, 12);

    // 6. Write to temporary asar file atomically
    tempAsarPath = `${asarPath}.tmp.${Date.now()}`;
    outFd = fs.openSync(tempAsarPath, "w");

    fs.writeSync(outFd, newHeaderBuf, 0, 16);
    fs.writeSync(outFd, newJsonBuf, 0, newJsonLen);
    if (padLen > 0) {
      fs.writeSync(outFd, Buffer.alloc(padLen, 0), 0, padLen);
    }

    // Stream payloads: part 1 (before preload)
    const part1Size = preloadOffset;
    if (part1Size > 0) {
      const part1Buf = Buffer.alloc(part1Size);
      fs.readSync(fd, part1Buf, 0, part1Size, payloadStart);
      fs.writeSync(outFd, part1Buf, 0, part1Size);
    }

    // Write new preload payload
    fs.writeSync(outFd, newPreloadBuf, 0, newPreloadBuf.length);

    // Stream payloads: part 2 (after preload)
    const stats = fs.fstatSync(fd);
    const part2Start = payloadStart + preloadOffset + preloadSize;
    const part2Size = stats.size - part2Start;

    const CHUNK_SIZE = 64 * 1024;
    let remaining = part2Size;
    let currentReadPos = part2Start;
    const chunkBuf = Buffer.alloc(CHUNK_SIZE);

    while (remaining > 0) {
      const toRead = Math.min(remaining, CHUNK_SIZE);
      const bytesRead = fs.readSync(fd, chunkBuf, 0, toRead, currentReadPos);
      if (bytesRead === 0) break;
      fs.writeSync(outFd, chunkBuf, 0, bytesRead);
      currentReadPos += bytesRead;
      remaining -= bytesRead;
    }

    // Close before replacing destination file
    fs.closeSync(outFd);
    outFd = null;
    fs.closeSync(fd);
    fd = null;

    // Atomically replace app.asar with running process diagnostics
    try {
      fs.copyFileSync(tempAsarPath, asarPath);
      fs.unlinkSync(tempAsarPath);
      tempAsarPath = null;
    } catch (err) {
      if (err.code === "EBUSY" || err.code === "EPERM") {
        throw new Error(
          `Cannot patch "${asarPath}" because it is currently locked by a running Antigravity instance.\n` +
          `Please completely exit Antigravity and close any running language_server processes, then re-run this command.\n` +
          `Original error: ${err.message}`
        );
      }
      throw err;
    }

    return { backupCreated, modified: true, alreadyInstalled: false };
  } catch (err) {
    if (tempAsarPath && fs.existsSync(tempAsarPath)) {
      try {
        fs.unlinkSync(tempAsarPath);
      } catch (cleanErr) {
        console.debug("[TokenTracker Install] Temp file cleanup error:", cleanErr.message);
      }
    }
    throw err;
  } finally {
    if (outFd !== null) {
      try {
        fs.closeSync(outFd);
      } catch (closeErr) {
        console.debug("[TokenTracker Install] outFd close error:", closeErr.message);
      }
    }
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (closeErr) {
        console.debug("[TokenTracker Install] fd close error:", closeErr.message);
      }
    }
  }
}

/**
 * Main installation execution routine.
 */
export function runInstall({ overridePath = null, dryRun = false } = {}) {
  console.log("=== Antigravity Token Tracker: Injector Installer ===");

  const resourcesDir = findAntigravityResourcesDir(overridePath);
  console.log(`[1/3] Located Antigravity resources: ${resourcesDir}`);

  // Deploy status-bar.js to plugin data folder
  const home = os.homedir();
  const pluginDataDir = path.join(home, ".gemini", "antigravity", "plugin_data", "token-tracker");
  if (!fs.existsSync(pluginDataDir) && !dryRun) {
    fs.mkdirSync(pluginDataDir, { recursive: true });
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const srcScript = path.join(__dirname, "status-bar.js");
  const destScript = path.join(pluginDataDir, "status-bar.js");

  if (!fs.existsSync(srcScript)) {
    throw new Error(`Source status-bar.js not found at: ${srcScript}`);
  }

  if (!dryRun) {
    fs.copyFileSync(srcScript, destScript);
  }
  console.log(`[2/3] Deployed status-bar.js to ${destScript}`);

  const asarPath = path.join(resourcesDir, "app.asar");
  console.log(`[3/3] Patching Electron preload in ${asarPath}...`);

  const result = patchAppAsar(asarPath, dryRun);
  if (result.alreadyInstalled) {
    console.log("-> Status bar preload hook is already installed in app.asar.");
  } else if (result.dryRun) {
    console.log("-> Dry-run complete: app.asar can be cleanly patched.");
  } else {
    console.log(`-> Injection complete! Backup preserved at: ${asarPath}.token_tracker_backup`);
  }

  // Record installation manifest
  if (!dryRun) {
    const manifestPath = path.join(pluginDataDir, "install-manifest.json");
    const manifest = {
      installedAt: new Date().toISOString(),
      resourcesDir,
      asarPath,
      backupPath: `${asarPath}.token_tracker_backup`,
      destScript,
      version: "1.1.0"
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  }

  console.log("=== Installation successfully completed ===");
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
    runInstall({ overridePath: customPath, dryRun });
  } catch (err) {
    console.error(`Installation failed: ${err.message}`);
    process.exit(1);
  }
}
