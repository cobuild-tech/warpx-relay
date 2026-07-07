#!/usr/bin/env node
/**
 * warpx-relay — routes WarpX chat through your local Claude Code session.
 * No API key needed. Uses the `claude` CLI you already have authenticated.
 *
 * Usage (recommended — access token used immediately, refresh token stored for auto-renewal):
 *   WARPX_WORKSPACE_ID=<uuid>  WARPX_TOKEN=<access_token>  WARPX_REFRESH_TOKEN=<refresh_token>  node bin/relay.js
 *
 * Get the start command from warpx.dev → Settings → AI → Local Claude Code → "Copy start command"
 * That button reads both tokens from your browser session automatically.
 *
 * WARPX_WS_URL: defaults to the warpx.dev production WebSocket (API Gateway base URL).
 *               override for local dev: WARPX_WS_URL=ws://localhost:8000/relay/ws
 */
"use strict";

const { startDaemon } = require("../src/daemon");
const { exchangeRefreshToken } = require("../src/auth");
const { preventSleep } = require("../src/sleep");

const args = process.argv.slice(2);
const get  = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };

const workspaceId   = get("--workspace")     || process.env.WARPX_WORKSPACE_ID;
const rawToken      = get("--token")         || process.env.WARPX_TOKEN;
const refreshToken  = get("--refresh-token") || process.env.WARPX_REFRESH_TOKEN;
const wsUrl         = get("--url")           || process.env.WARPX_WS_URL  || "wss://1loeh729of.execute-api.ap-south-1.amazonaws.com/prod";
const model         = get("--model")         || process.env.WARPX_MODEL   || "claude-sonnet-4-6";

if (!workspaceId) {
  console.error("Error: WARPX_WORKSPACE_ID or --workspace required");
  console.error("  Find it: warpx.dev → Settings → Connections → Workspace ID");
  process.exit(1);
}
if (!rawToken && !refreshToken) {
  console.error("Error: WARPX_REFRESH_TOKEN or WARPX_TOKEN required");
  console.error("  Get it: warpx.dev → Settings → Connections → Copy start command");
  process.exit(1);
}

// Verify claude CLI is available before connecting
const { spawnSync } = require("child_process");
const check = spawnSync("claude", ["--version"], { encoding: "utf8" });
if (check.error) {
  console.error("Error: `claude` CLI not found.");
  console.error("  Install Claude Code: https://claude.ai/code");
  process.exit(1);
}

console.log(`[warpx-relay] ${check.stdout.trim()}`);
console.log(`[warpx-relay] Workspace : ${workspaceId}`);
console.log(`[warpx-relay] Backend   : ${wsUrl}`);
const authDesc = rawToken && refreshToken ? "access token + refresh (auto-renews)"
               : refreshToken            ? "refresh token only (auto-renews)"
               :                           "access token (1h)";
console.log(`[warpx-relay] Auth      : ${authDesc}`);
console.log(`[warpx-relay] No API key needed — using your local Claude Code session`);
console.log();

async function main() {
  let token = rawToken;

  if (!token && refreshToken) {
    // No access token — exchange refresh token to get one
    process.stdout.write("[warpx-relay] Exchanging refresh token… ");
    try {
      const result = await exchangeRefreshToken(refreshToken);
      token = result.accessToken;
      main._currentRefreshToken = result.refreshToken;
      console.log("ok");
    } catch (err) {
      console.error(`\n[warpx-relay] Token exchange failed: ${err.message}`);
      process.exit(1);
    }
  } else if (token && refreshToken) {
    // Access token provided — use it directly, store refresh token for renewal
    main._currentRefreshToken = refreshToken;
  }

  await startDaemon({
    workspaceId,
    token,
    wsUrl,
    model,
    // Called by daemon.js when a 4001 (token expired) is received and refresh is needed
    refreshToken: refreshToken ? () => main._currentRefreshToken : null,
    onTokenRefreshed: refreshToken ? (newRefresh) => { main._currentRefreshToken = newRefresh; } : null,
  });
}

main._currentRefreshToken = refreshToken;

// Keep the machine awake while the relay is running so long AI tasks aren't
// interrupted by system sleep. macOS: caffeinate tied to our PID (auto-exits).
// Windows: PowerShell SetThreadExecutionState loop. Linux: no-op.
const releaseSleep = preventSleep();
process.on("exit", () => releaseSleep());

main().catch((err) => {
  console.error("[warpx-relay] Fatal:", err.message);
  process.exit(1);
});
