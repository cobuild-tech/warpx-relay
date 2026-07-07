"use strict";

/**
 * Prevent the OS from sleeping while the relay daemon is running.
 *
 * macOS  — spawns `caffeinate -i -w <pid>`; tied to our process lifetime,
 *           exits automatically when we do (no cleanup needed).
 * Windows — spawns a PowerShell loop that calls SetThreadExecutionState every
 *           30s (ES_CONTINUOUS | ES_SYSTEM_REQUIRED). Killed on process exit.
 * Linux  — no-op; system sleep is uncommon for active desktop/server processes.
 *
 * Returns a `release()` function. Call it (or let `process.on("exit")` do it)
 * to clean up the background process on Windows.
 */
function preventSleep() {
  const { spawn } = require("child_process");
  const plat = process.platform;
  let child = null;

  try {
    if (plat === "darwin") {
      // -i  prevent idle sleep
      // -w  tie caffeinate lifetime to our PID — auto-exits when we do
      child = spawn("caffeinate", ["-i", "-w", String(process.pid)], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    } else if (plat === "win32") {
      // SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) every 30s
      const psCmd = [
        "Add-Type -TypeDefinition '",
        "using System.Runtime.InteropServices;",
        "public class WarpXSleep {",
        "  [DllImport(\"kernel32.dll\")]",
        "  public static extern uint SetThreadExecutionState(uint f);",
        "}';",
        "while ($true) {",
        "  [WarpXSleep]::SetThreadExecutionState(0x80000003) | Out-Null;",
        "  Start-Sleep 30",
        "}",
      ].join(" ");

      child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", psCmd], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }
    // Linux: no-op
  } catch {
    // Non-fatal — sleep prevention is best-effort
  }

  return function release() {
    if (child) {
      try { child.kill(); } catch {}
      child = null;
    }
  };
}

module.exports = { preventSleep };
