"use strict";

const WebSocket = require("ws");
const { runClaudeRound } = require("./claude");
const { exchangeRefreshToken } = require("./auth");

const RECONNECT_DELAY_MS = 3000;
const PING_INTERVAL_MS   = 25000;

/**
 * @param {object} config
 * @param {string}        config.workspaceId
 * @param {string}        config.token           Current Supabase access JWT
 * @param {string}        config.wsUrl           Base WS URL e.g. wss://mcp.warpx.dev
 * @param {string}        config.model           e.g. claude-sonnet-4-6
 * @param {Function|null} config.refreshToken    () => currentRefreshToken string, or null if not using refresh
 * @param {Function|null} config.onTokenRefreshed (newRefreshToken) => void
 */
async function startDaemon(config) {
  let stopped = false;
  let currentToken = config.token;

  process.on("SIGINT",  () => { stopped = true; process.exit(0); });
  process.on("SIGTERM", () => { stopped = true; process.exit(0); });

  while (!stopped) {
    try {
      const result = await connect({ ...config, token: currentToken });
      if (result?.newToken) currentToken = result.newToken; // updated after refresh
    } catch (err) {
      if (stopped) break;

      // 4001 = token expired — try to refresh before reconnecting
      if (err.code === "TOKEN_EXPIRED" && config.refreshToken) {
        console.log("[warpx-relay] Access token expired — refreshing…");
        try {
          const refreshed = await exchangeRefreshToken(config.refreshToken());
          currentToken = refreshed.accessToken;
          if (config.onTokenRefreshed) config.onTokenRefreshed(refreshed.refreshToken);
          console.log("[warpx-relay] Token refreshed — reconnecting…");
        } catch (refreshErr) {
          console.error(`[warpx-relay] Token refresh failed: ${refreshErr.message}`);
          console.error("[warpx-relay] Get a new token from Settings → Connections → Copy start command");
          process.exit(1);
        }
        continue; // reconnect immediately with new token
      }

      // 4003 = wrong workspace — fatal, no point retrying
      if (err.code === "NOT_MEMBER") {
        console.error(`[warpx-relay] ${err.message}`);
        process.exit(1);
      }

      console.error(`[warpx-relay] Connection error: ${err.message}`);
      console.log(`[warpx-relay] Reconnecting in ${RECONNECT_DELAY_MS / 1000}s…`);
      await sleep(RECONNECT_DELAY_MS);
    }
  }
}

async function connect(config) {
  const url = `${config.wsUrl}?workspace_id=${encodeURIComponent(config.workspaceId)}&token=${encodeURIComponent(config.token)}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let pingTimer = null;

    ws.on("open", () => {
      console.log("[warpx-relay] Connected — waiting for chat requests…");
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, PING_INTERVAL_MS);
    });

    ws.on("message", async (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type !== "request") return;

      const { request_id, messages, system } = msg;
      console.log(`[warpx-relay] Request ${request_id.slice(0, 8)}… — ${messages.length} messages`);

      try {
        await runClaudeRound({
          requestId:  request_id,
          messages,
          system,
          model:      config.model,
          readScope:  config.relayConfig?.readScope  || "home",
          projectDir: config.relayConfig?.projectDir || null,
          send: (payload) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
          },
        });
        console.log(`[warpx-relay] Request ${request_id.slice(0, 8)}… done`);
      } catch (err) {
        console.error(`[warpx-relay] Request ${request_id.slice(0, 8)}… error:`, err.message);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "error", request_id, message: err.message }));
        }
      }
    });

    ws.on("close", (code, reason) => {
      clearInterval(pingTimer);
      const msg = reason?.toString() || "";

      if (code === 4001) {
        const err = new Error("Access token expired or invalid");
        err.code = "TOKEN_EXPIRED";
        reject(err);
      } else if (code === 4003) {
        const err = new Error("Not a member of this workspace — check WARPX_WORKSPACE_ID");
        err.code = "NOT_MEMBER";
        reject(err);
      } else {
        if (code !== 1000 && code !== 1001) {
          console.log(`[warpx-relay] Disconnected (${code}${msg ? ": " + msg : ""})`);
        }
        resolve();
      }
    });

    ws.on("error", (err) => {
      clearInterval(pingTimer);
      reject(err);
    });
  });
}

function sleep(ms) { return new Promise((res) => setTimeout(res, ms)); }

module.exports = { startDaemon };
