# warpx-relay

A lightweight local daemon that bridges [WarpX](https://warpx.dev) workspace chat with your local **Claude Code** session — no Anthropic API key required.

When a team member sends a message in WarpX chat, the relay receives it over WebSocket, forwards it to the `claude` CLI running on your machine, and streams the response back in real time. Tool calls (MCP actions) execute natively inside Claude Code, so your local context, MCP connections, and file system are all available.

---

## How it works

```
WarpX chat  ──WebSocket──▶  warpx-relay  ──stdin──▶  claude CLI
                                │                          │
                                │◀──── stream-json ────────┘
                                │
                         (token / action / done events)
                                │
                         ──WebSocket──▶  WarpX backend  ──▶  chat UI
```

1. **Connect** — the relay opens a persistent WebSocket to the WarpX API Gateway, authenticating with your Supabase JWT.
2. **Receive** — when a `request` message arrives it contains the conversation history and a workspace context system prompt (tasks, pages, members).
3. **Run** — the relay spawns `claude --print --output-format stream-json` and writes the prompt to `stdin`.
4. **Stream** — JSON events from Claude Code are parsed line by line and forwarded to the WarpX backend as `token`, `action` (tool call progress), and `done` messages.
5. **Reconnect** — if the connection drops or the access token expires the daemon automatically refreshes the token and reconnects.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| **Node.js ≥ 18** | Uses native `fetch` (no polyfill needed) |
| **Claude Code CLI** | Install from [claude.ai/code](https://claude.ai/code) — must be authenticated (`claude auth`) |
| **WarpX account** | [warpx.dev](https://warpx.dev) — workspace ID and auth tokens come from Settings |

Verify the Claude Code CLI is installed and authenticated before starting the relay:

```bash
claude --version
claude auth status
```

---

## Installation

### Option A — run directly with npx (no install)

```bash
npx warpx-relay --workspace <id> --token <access> --refresh-token <refresh>
```

### Option B — install globally

```bash
npm install -g warpx-relay
warpx-relay --workspace <id> --token <access> --refresh-token <refresh>
```

### Option C — clone and run locally

```bash
git clone https://github.com/cobuild-tech/cbx-notes
cd cbx-notes/warpx-relay
npm install
node bin/relay.js --workspace <id> --token <access> --refresh-token <refresh>
```

---

## Getting your credentials

1. Go to **warpx.dev → Settings → Connections → Local Claude Code**
2. Click **"Copy start command"** — this copies a pre-filled command with your workspace ID and both tokens read directly from your browser session.

Paste and run it. You're done.

To find the values individually:

| Value | Location |
|---|---|
| `WARPX_WORKSPACE_ID` | Settings → Connections → Workspace ID |
| `WARPX_TOKEN` | Copied from "Copy start command" (access JWT, valid ~1 hour) |
| `WARPX_REFRESH_TOKEN` | Copied from "Copy start command" (refresh JWT, auto-renewed) |

---

## Usage

### Environment variables (recommended)

```bash
export WARPX_WORKSPACE_ID=<your-workspace-uuid>
export WARPX_TOKEN=<supabase-access-jwt>
export WARPX_REFRESH_TOKEN=<supabase-refresh-jwt>

warpx-relay
```

### CLI flags

```bash
warpx-relay \
  --workspace   <uuid>          \   # workspace ID
  --token       <access-jwt>    \   # Supabase access token (valid ~1 hour)
  --refresh-token <refresh-jwt> \   # Supabase refresh token (auto-renewed)
  --model       <model-id>      \   # Claude model (default: claude-sonnet-4-6)
  --url         <ws-url>            # WebSocket base URL (default: production)
```

Flags take precedence over environment variables. You can mix both.

### Token combinations

| Tokens provided | Behaviour |
|---|---|
| Access + refresh | Uses access token immediately; auto-refreshes with the refresh token when it expires |
| Refresh only | Exchanges the refresh token for an access token on startup |
| Access only | Works until the access token expires (~1 hour); exits with an error after that |

The refresh token is rotated on every use (Supabase behaviour) — the relay tracks the latest one in memory automatically.

---

## Configuration reference

| Environment variable | CLI flag | Default | Description |
|---|---|---|---|
| `WARPX_WORKSPACE_ID` | `--workspace` | — | **Required.** Your WarpX workspace UUID |
| `WARPX_TOKEN` | `--token` | — | Supabase access JWT |
| `WARPX_REFRESH_TOKEN` | `--refresh-token` | — | Supabase refresh JWT (enables auto-renewal) |
| `WARPX_MODEL` | `--model` | `claude-sonnet-4-6` | Claude model passed to the `claude` CLI |
| `WARPX_WS_URL` | `--url` | Production AWS API Gateway URL | WebSocket endpoint override (for local dev) |

---

## Startup output

A successful start looks like this:

```
[warpx-relay] claude 1.x.x (Claude Code)
[warpx-relay] Workspace : xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
[warpx-relay] Backend   : wss://…execute-api.ap-south-1.amazonaws.com/prod
[warpx-relay] Auth      : access token + refresh (auto-renews)
[warpx-relay] No API key needed — using your local Claude Code session

[warpx-relay] Connected — waiting for chat requests…
```

When a request arrives:

```
[warpx-relay] Request a1b2c3d4… — 3 messages
[warpx-relay] Request a1b2c3d4… done
```

---

## Sleep prevention

While the relay is running the daemon prevents the OS from sleeping so long AI tasks are not interrupted:

- **macOS** — spawns `caffeinate -i -w <pid>` tied to the relay's PID (exits automatically)
- **Windows** — spawns a PowerShell loop calling `SetThreadExecutionState` every 30 seconds
- **Linux** — no-op (system sleep is uncommon for active servers)

---

## Reconnection and error handling

| Condition | Behaviour |
|---|---|
| Network drop or clean disconnect | Reconnects after 3 seconds |
| WebSocket close code `4001` (token expired) | Exchanges refresh token and reconnects immediately |
| WebSocket close code `4003` (not a workspace member) | Logs an error and exits — check `WARPX_WORKSPACE_ID` |
| No refresh token and access token expires | Logs an error and exits — re-run with fresh tokens |

---

## Local development

Override the WebSocket URL to point at a local backend:

```bash
WARPX_WS_URL=ws://localhost:8000/relay/ws \
WARPX_WORKSPACE_ID=<uuid> \
WARPX_TOKEN=<jwt> \
node bin/relay.js
```

### Project structure

```
warpx-relay/
├── bin/
│   └── relay.js        # Entry point — parses args, validates env, starts daemon
└── src/
    ├── daemon.js        # WebSocket connection loop, reconnect logic
    ├── claude.js        # Spawns `claude` CLI, parses stream-json output
    ├── auth.js          # Supabase refresh-token exchange
    └── sleep.js         # OS sleep prevention (macOS / Windows / Linux)
```

---

## Troubleshooting

**`Error: \`claude\` CLI not found`**
Install Claude Code from [claude.ai/code](https://claude.ai/code) and ensure it is on your `PATH`.

**`Token exchange failed`**
Your refresh token has expired or been revoked. Go to **warpx.dev → Settings → Connections** and copy a new start command.

**`Not a member of this workspace`**
The `WARPX_WORKSPACE_ID` does not match your account. Verify it in **Settings → Connections → Workspace ID**.

**Relay connects but no responses appear in chat**
Check that the `claude` CLI is authenticated (`claude auth status`). The relay runs Claude Code with `--dangerously-skip-permissions` so non-interactive MCP tool calls work — make sure your Claude Code session has the WarpX MCP server configured if you want workspace tool access from within Claude Code.

**Responses cut off on long tasks**
The OS may have put your machine to sleep. Sleep prevention should handle this automatically (see above), but if you are on Linux or sleep prevention failed, adjust your system power settings manually.

---

## License

MIT
