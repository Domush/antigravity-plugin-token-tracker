/**
 * Antigravity Static Audit Gate.
 * Enforces non-negotiable P0 standards across workspace:
 * - 500-Line Source Ceiling
 * - Zero Stubs & Placeholders (no TODO, FIXME, unimplemented, mock facades)
 * - Required Module Manifest Integrity
 * - Non-empty Error Handling
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LINE_LIMIT = 500;

const FORBIDDEN_PATTERNS = [
  { regex: new RegExp("/[/\\*]\\s*T" + "ODO\\b", "i"), name: "TODO comment" },
  { regex: new RegExp("/[/\\*]\\s*F" + "IXME\\b", "i"), name: "FIXME comment" },
  { regex: new RegExp("/[/\\*]\\s*S" + "TUB\\b", "i"), name: "STUB comment" },
  { regex: new RegExp("\\bthrow\\s+new\\s+Error\\s*\\(\\s*[\"'](?:Not\\s*implemented|T" + "ODO|stub)[\"']\\s*\\)", "i"), name: "Unimplemented error throw" },
  { regex: new RegExp("\\bNot" + "ImplementedException\\b", "i"), name: "NotImplementedException" },
  { regex: new RegExp("\\bun" + "implemented!\\s*\\(", "i"), name: "Rust unimplemented macro" },
  { regex: /catch\s*\([^)]*\)\s*\{\s*\}/i, name: "Empty silent catch block" }
];

const REQUIRED_FILES = [
  "package.json",
  "plugin.json",
  "hooks.json",
  "LICENSE",
  "bin/cli.js",
  "lib/models.js",
  "lib/quota-service.js",
  "lib/conversation-tracker.js",
  "lib/telemetry-server.js",
  "hooks/session-start.js",
  "hooks/pre-invocation.js",
  "injector/status-bar.js",
  "injector/install.js",
  "injector/uninstall.js",
  "sidecars/dashboard/sidecar.json",
  "sidecars/dashboard/server.mjs",
  "sidecars/dashboard/index.html"
];

const AUDITABLE_EXTENSIONS = new Set([".js", ".mjs", ".json", ".html", ".css"]);

/**
 * Scans a file for P0 violations.
 * @param {string} filePath
 * @param {string} workspaceRoot
 * @returns {Array<string>}
 */
export function auditFile(filePath, workspaceRoot) {
  const violations = [];
  const relPath = path.relative(workspaceRoot, filePath).replace(/\\/g, "/");

  if (!fs.existsSync(filePath)) {
    violations.push(`File missing: ${relPath}`);
    return violations;
  }

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  // 1. Line count ceiling check
  if (lines.length > MAX_LINE_LIMIT) {
    violations.push(`[${relPath}] Exceeds ${MAX_LINE_LIMIT}-line ceiling (current: ${lines.length} lines)`);
  }

  // Skip deep pattern analysis for JSON files and the gate itself
  if (filePath.endsWith(".json") || filePath.endsWith("audit-gate.js")) {
    return violations;
  }

  // 2. Pattern check
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    for (const pat of FORBIDDEN_PATTERNS) {
      if (pat.regex.test(line)) {
        violations.push(`[${relPath}:${lineNum}] Forbidden pattern detected: ${pat.name} -> "${line.trim()}"`);
      }
    }
  }

  return violations;
}

/**
 * Runs the static audit gate.
 * @param {Array<string>|null} targetFiles
 * @returns {boolean}
 */
export function runAuditGate(targetFiles = null) {
  const __filename = fileURLToPath(import.meta.url);
  const workspaceRoot = path.resolve(path.dirname(__filename), "..");

  console.log("==================================================");
  console.log("   ANTIGRAVITY DETERMINISTIC STATIC AUDIT GATE    ");
  console.log("==================================================");

  const allViolations = [];

  // 1. Verify all required files exist
  for (const reqFile of REQUIRED_FILES) {
    const absPath = path.join(workspaceRoot, reqFile);
    if (!fs.existsSync(absPath)) {
      allViolations.push(`Missing mandatory project file: ${reqFile}`);
    }
  }

  // 2. Determine file list to audit
  let filesToAudit = [];
  if (targetFiles && targetFiles.length > 0) {
    filesToAudit = targetFiles.map((f) => path.resolve(workspaceRoot, f.trim()));
  } else {
    function walk(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (AUDITABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
          filesToAudit.push(full);
        }
      }
    }
    walk(workspaceRoot);
  }

  console.log(`Auditing ${filesToAudit.length} project file(s)...`);

  for (const file of filesToAudit) {
    const fileViolations = auditFile(file, workspaceRoot);
    if (fileViolations.length > 0) {
      allViolations.push(...fileViolations);
    }
  }

  if (allViolations.length === 0) {
    console.log("\nAll P0 standards successfully validated (0 errors, 0 warnings).");
    console.log("GATE VERDICT: PASS\n");
    return true;
  } else {
    console.error(`\nFound ${allViolations.length} P0 violation(s):`);
    for (const v of allViolations) {
      console.error(`  - ${v}`);
    }
    console.error("\nGATE VERDICT: REJECT\n");
    return false;
  }
}

const isMain = Boolean(
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)).toLowerCase() === path.resolve(process.argv[1]).toLowerCase()
);

if (isMain) {
  let fileList = null;
  const fIdx = process.argv.indexOf("-f");
  const filesIdx = process.argv.indexOf("--files");
  const idx = fIdx !== -1 ? fIdx : filesIdx;
  if (idx !== -1 && process.argv[idx + 1]) {
    fileList = process.argv[idx + 1].split(",").map((s) => s.trim()).filter(Boolean);
  }

  const passed = runAuditGate(fileList);
  process.exit(passed ? 0 : 1);
}
