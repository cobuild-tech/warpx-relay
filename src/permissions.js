"use strict";
/**
 * First-run permission setup for the warpX relay daemon.
 *
 * On first start (no config saved), prompts the user to choose how much of the
 * local file system Claude can READ for workspace chat context.
 *
 * Code changes (Bash, Write, Edit) are ALWAYS blocked in relay/workspace chat
 * regardless of read scope. Use local Claude Code + WarpX MCP for code work.
 *
 * Config is stored in ~/.warpx-relay.json so subsequent starts skip the prompt.
 */

const os       = require("os");
const fs       = require("fs");
const path     = require("path");
const readline = require("readline");

const CONFIG_PATH = path.join(os.homedir(), ".warpx-relay.json");

// These tools are always blocked — workspace chat does not do code changes.
const ALWAYS_DISALLOWED = ["Bash", "Write", "Edit", "NotebookEdit"];

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(data) {
  const current = loadConfig();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...current, ...data }, null, 2));
}

async function ensurePermissionsConfigured() {
  const cfg = loadConfig();
  if (cfg.readScope) return cfg;

  console.log("\n[warpX relay] First-time setup");
  console.log("─".repeat(60));
  console.log("Code changes (edit files, run commands) are always disabled");
  console.log("in workspace chat. Use local Claude Code + WarpX MCP instead.\n");
  console.log("Choose how much of your file system Claude can READ for context:\n");
  console.log("  1) Home directory  (recommended) — reads files under ~/");
  console.log("  2) Project directory only         — reads one folder you choose");
  console.log("  3) System-wide                    — reads any file on the system\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const choice = await new Promise((resolve) =>
    rl.question("Enter 1, 2, or 3 [default: 1]: ", resolve)
  );
  rl.close();

  let readScope = "home";
  let projectDir = null;

  if (choice.trim() === "2") {
    readScope = "project";
    const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const raw = await new Promise((resolve) =>
      rl2.question("Project directory path (e.g. ~/projects/my-app): ", resolve)
    );
    rl2.close();
    const rawPath = raw.trim().replace(/^~/, os.homedir());
    // Resolve relative paths against the home directory so "cbx-notes" → "~/cbx-notes"
    projectDir = path.isAbsolute(rawPath) ? rawPath : path.join(os.homedir(), rawPath);
    if (!fs.existsSync(projectDir)) {
      console.log(`\n[warpX relay] Warning: directory not found: ${projectDir}`);
      console.log("[warpX relay] Check the path is correct. Continuing with home directory scope.\n");
      readScope = "home";
      projectDir = null;
    }
  } else if (choice.trim() === "3") {
    readScope = "system";
  }

  saveConfig({ readScope, projectDir });
  const scopeLabel = readScope === "project" ? `project (${projectDir})` : readScope;
  console.log(`\n[warpX relay] Saved: read scope = ${scopeLabel}`);
  console.log("[warpX relay] Edit ~/.warpx-relay.json to change, or delete it to re-run setup.\n");
  return { readScope, projectDir };
}

module.exports = { ensurePermissionsConfigured, ALWAYS_DISALLOWED, loadConfig };
