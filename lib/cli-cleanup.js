/**
 * CLI Path Canonicalization & Legacy Plugin Directory Cleanup Utilities.
 * Safely cleans up symlinks, Windows junctions, and legacy plugin installations
 * without mutating source bundles or symlink target contents.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Normalize a path and strip trailing path separators while preserving filesystem roots.
 * @param {string} targetPath
 * @returns {string}
 */
export function stripTrailingSeparators(targetPath) {
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  if (resolved === root) return resolved;
  return resolved.replace(/[\\/]+$/, "");
}

/**
 * Resolve canonical realpath (case-folded on Windows), handling non-existent leaf segments.
 * @param {string} targetPath
 * @returns {string}
 */
export function canonicalizePath(targetPath) {
  const resolved = stripTrailingSeparators(targetPath);
  let canonical = resolved;
  try {
    canonical = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      throw err;
    }
    const parent = path.dirname(resolved);
    if (parent !== resolved) {
      canonical = path.join(canonicalizePath(parent), path.basename(resolved));
    }
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/**
 * Normalize a path case-insensitively on Windows without resolving symlinks.
 * @param {string} targetPath
 * @returns {string}
 */
function normalizeLiteralPath(targetPath) {
  const resolved = stripTrailingSeparators(targetPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Check whether normalized child path equals or is nested inside normalized parent path.
 * @param {string} parentCanonical
 * @param {string} childCanonical
 * @returns {boolean}
 */
function isNormalizedPathSameOrNested(parentCanonical, childCanonical) {
  if (parentCanonical === childCanonical) return true;
  const prefix = parentCanonical.endsWith(path.sep) ? parentCanonical : parentCanonical + path.sep;
  return childCanonical.startsWith(prefix);
}

/**
 * Resolve canonical path for an entry without dereferencing a symbolic link/junction leaf.
 * @param {string} targetPath
 * @returns {string}
 */
export function canonicalizeEntryPath(targetPath) {
  const resolved = stripTrailingSeparators(targetPath);
  const parent = path.dirname(resolved);
  let canonical = resolved;
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isSymbolicLink()) {
      return canonicalizePath(resolved);
    }
    canonical = parent === resolved
      ? resolved
      : path.join(canonicalizePath(parent), path.basename(resolved));
  } catch (err) {
    if (!err || err.code !== "ENOENT") {
      throw err;
    }
    canonical = parent === resolved
      ? resolved
      : path.join(canonicalizePath(parent), path.basename(resolved));
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

/**
 * Check whether an entry path literally or canonically matches or encloses sourceDir.
 * @param {string} entryPath
 * @param {string} sourceDir
 * @returns {boolean}
 */
export function isEntrySameOrEnclosesSource(entryPath, sourceDir) {
  const entryCanonical = canonicalizeEntryPath(entryPath);
  return (
    isNormalizedPathSameOrNested(entryCanonical, canonicalizePath(sourceDir)) ||
    isNormalizedPathSameOrNested(entryCanonical, canonicalizeEntryPath(sourceDir)) ||
    isNormalizedPathSameOrNested(normalizeLiteralPath(entryPath), normalizeLiteralPath(sourceDir))
  );
}

/**
 * Check whether sourceDir literally or canonically matches or encloses an entry path.
 * @param {string} sourceDir
 * @param {string} entryPath
 * @returns {boolean}
 */
export function isSourceEnclosingEntry(sourceDir, entryPath) {
  const entryCanonical = canonicalizeEntryPath(entryPath);
  return (
    isNormalizedPathSameOrNested(canonicalizePath(sourceDir), entryCanonical) ||
    isNormalizedPathSameOrNested(canonicalizeEntryPath(sourceDir), entryCanonical)
  );
}

/**
 * Returns fs.lstatSync result or null when the path does not exist (ENOENT).
 * @param {string} targetPath
 * @returns {fs.Stats|null}
 */
export function lstatOrNull(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Safely remove a plugin directory or symlink/junction without deleting symlink targets.
 * @param {string} entryPath
 * @returns {boolean}
 */
export function removePluginEntry(entryPath) {
  if (typeof entryPath !== "string" || entryPath.trim().length === 0) {
    throw new TypeError("removePluginEntry requires a non-empty entryPath string");
  }

  const normalizedPath = stripTrailingSeparators(entryPath);
  if (normalizedPath === path.parse(normalizedPath).root) {
    throw new Error(`Refusing to remove filesystem root: ${normalizedPath}`);
  }

  const stat = lstatOrNull(normalizedPath);
  if (!stat) {
    return false;
  }

  if (stat.isSymbolicLink()) {
    try {
      fs.unlinkSync(normalizedPath);
    } catch (unlinkErr) {
      if (unlinkErr && (unlinkErr.code === "EPERM" || unlinkErr.code === "EISDIR")) {
        fs.rmdirSync(normalizedPath);
      } else {
        throw unlinkErr;
      }
    }
    return true;
  }

  fs.rmSync(normalizedPath, { recursive: true, force: true });
  return true;
}

/**
 * Safely cleans up/migrates a legacy plugin installation directory after installing
 * into targetDir, handling active locks (EPERM/EACCES/EBUSY/ENOTEMPTY) non-fatally.
 * @param {Object} params
 * @param {string} params.legacyDir
 * @param {string} params.targetDir
 * @param {string} params.sourceDir
 * @param {(line: string) => void} [params.stdout]
 * @param {(line: string) => void} [params.stderr]
 * @returns {{ removed: boolean, skipped: boolean, locked: boolean }}
 */
export function cleanupLegacyPluginDir({
  legacyDir,
  targetDir,
  sourceDir,
  stdout = console.log,
  stderr = console.error
}) {
  if (!legacyDir || canonicalizeEntryPath(legacyDir) === canonicalizeEntryPath(targetDir)) {
    return { removed: false, skipped: true, locked: false };
  }

  if (isEntrySameOrEnclosesSource(legacyDir, sourceDir)) {
    if (fs.existsSync(legacyDir)) {
      stdout(`ℹ Skipping automatic removal of active source directory: ${legacyDir}`);
    }
    return { removed: false, skipped: true, locked: false };
  }

  try {
    const removed = removePluginEntry(legacyDir);
    if (removed) {
      stdout(`🧹 Migrated legacy plugin directory (removed ${legacyDir})`);
    }
    return { removed, skipped: false, locked: false };
  } catch (legacyErr) {
    if (
      legacyErr?.code === "EPERM" ||
      legacyErr?.code === "EACCES" ||
      legacyErr?.code === "EBUSY" ||
      legacyErr?.code === "ENOTEMPTY"
    ) {
      stderr(
        `⚠ Could not remove legacy plugin directory (${legacyDir}) because it is currently in use by an active session (${legacyErr.code}). Restart Antigravity and remove it manually or re-run install/uninstall.`
      );
      return { removed: false, skipped: false, locked: true };
    }
    throw legacyErr;
  }
}
