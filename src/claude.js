/**
 * Runs one round of a chat request through the local `claude` CLI.
 *
 * How it works:
 *   1. Build a prompt from the workspace system context + conversation history
 *   2. Spawn `claude --print --output-format stream-json` with the prompt via stdin
 *   3. Parse streamed JSON events and forward text tokens to WarpX backend
 *   4. Claude Code uses its already-configured MCP connections (including WarpX MCP
 *      if the user has it set up) to make tool calls natively — no API key needed
 *
 * The backend agentic loop completes after one round because tool calls happen
 * entirely inside Claude Code (visible in the local terminal, result included in
 * the text response sent back to WarpX chat).
 */
"use strict";

const { spawn } = require("child_process");

/**
 * Build a prompt string from the OpenAI-format messages + system prompt.
 * The system prompt contains the full WarpX workspace context (tasks, pages, members).
 * Claude Code reads this and can also call WarpX MCP tools if configured.
 */
function buildPrompt(messages, system) {
  const lines = [];

  // Inject workspace context as a clearly bounded section
  lines.push("=== WARPX WORKSPACE CONTEXT ===");
  lines.push(system);
  lines.push("=== END CONTEXT ===\n");

  // Conversation history (skip system messages, they're already above)
  const convo = messages.filter((m) => m.role !== "system");

  // All turns except the last
  const history = convo.slice(0, -1);
  if (history.length > 0) {
    lines.push("Previous conversation:");
    for (const m of history) {
      if (m.role === "user") {
        lines.push(`User: ${m.content}`);
      } else if (m.role === "assistant" && m.content) {
        lines.push(`Assistant: ${m.content}`);
      }
      // tool result messages: skip (they're embedded in assistant turns)
    }
    lines.push("");
  }

  // Latest user message
  const latest = convo[convo.length - 1];
  if (latest?.role === "user") {
    lines.push(latest.content);
  }

  return lines.join("\n");
}

/**
 * Parse one JSON line from claude's stream-json output and emit events.
 * Claude Code stream-json (--verbose) emits a mix of Claude Code events and
 * raw Anthropic streaming API events:
 *
 *   {type:"content_block_start", content_block:{type:"tool_use", name:"..."}}
 *       → tool call starting (emit "action" event so frontend shows progress)
 *   {type:"content_block_delta", delta:{type:"text_delta", text:"..."}}
 *       → incremental text token (preferred path)
 *   {type:"assistant", message:{content:[...]}}
 *       → full assistant turn — only used as fallback if no deltas streamed yet
 *   {type:"result", ...}
 *       → ignored; text is already covered by delta/assistant events
 *   {type:"system", ...}  — ignored
 *
 * state.emittedAnyText — set true when any text has been streamed; never reset
 * so that neither the assistant message nor the result event re-emits text
 * that content_block_delta already delivered.
 */
function handleLine(line, requestId, send, state) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  // Tool call starting — emit action event so the frontend shows a progress indicator
  if (msg.type === "content_block_start" && msg.content_block?.type === "tool_use") {
    const toolName = msg.content_block.name || "tool";
    send({ type: "action", request_id: requestId, tool: toolName });
    return;
  }

  // Incremental text deltas (preferred path — fastest, most granular)
  if (msg.type === "content_block_delta" && msg.delta?.type === "text_delta" && msg.delta.text) {
    state.emittedAnyText = true;
    send({ type: "token", request_id: requestId, content: msg.delta.text });
    return;
  }

  // Full assistant message — fallback only if content_block_delta was never emitted
  if (msg.type === "assistant" && Array.isArray(msg.message?.content)) {
    for (const block of msg.message.content) {
      if (block.type === "text" && block.text && !state.emittedAnyText) {
        state.emittedAnyText = true;
        send({ type: "token", request_id: requestId, content: block.text });
      }
      if (block.type === "tool_use" && block.name) {
        // Fallback tool action detection if content_block_start wasn't emitted
        send({ type: "action", request_id: requestId, tool: block.name });
      }
    }
    return;
  }

  // result event intentionally ignored — text is always covered above
}

/**
 * @param {object} opts
 * @param {string}   opts.requestId
 * @param {Array}    opts.messages   OpenAI-format conversation
 * @param {string}   opts.system     WarpX workspace system prompt
 * @param {string}   opts.model      e.g. "claude-sonnet-4-6" (--model flag to claude CLI)
 * @param {Function} opts.send       (payload) => void — sends back to WarpX backend
 */
async function runClaudeRound({ requestId, messages, system, model, send }) {
  const prompt = buildPrompt(messages, system);

  return new Promise((resolve, reject) => {
    const cliArgs = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",   // needed for non-interactive MCP tool calls
      "--model", model,
    ];

    const proc = spawn("claude", cliArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env:   { ...process.env },
    });

    // Write prompt to stdin
    proc.stdin.write(prompt, "utf8");
    proc.stdin.end();

    let lineBuffer = "";
    // Shared mutable state passed into handleLine across chunks
    const state = { emittedAnyText: false };

    proc.stdout.on("data", (chunk) => {
      lineBuffer += chunk.toString("utf8");
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? "";         // keep last incomplete line
      for (const line of lines) {
        if (line.trim()) handleLine(line, requestId, send, state);
      }
    });

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error("[relay claude stderr]", text);
    });

    proc.on("error", (err) => {
      if (err.code === "ENOENT") {
        reject(new Error("`claude` CLI not found — install Claude Code: https://claude.ai/code"));
      } else {
        reject(err);
      }
    });

    proc.on("close", (code) => {
      // Flush any remaining buffered line
      if (lineBuffer.trim()) handleLine(lineBuffer, requestId, send, state);

      if (code !== 0) {
        console.error(`[relay] claude exited with code ${code}`);
      }
      send({ type: "done", request_id: requestId });
      resolve();
    });
  });
}

module.exports = { runClaudeRound };
