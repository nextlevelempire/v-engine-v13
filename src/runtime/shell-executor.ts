/**
 * shell-executor.ts — Sandboxed shell command execution.
 *
 * Opt-in: requires OMNI_SHELL_ENABLED=1.
 * Safety: blocked path list, 10s default timeout, no root/sudo.
 *
 * New command: { type: "shell", command: "ls ~/Downloads", timeout_ms?: number }
 * Returns: { ok: boolean, stdout: string, stderr: string, exitCode: number }
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const BLOCKED_PATTERNS = [
  /\/etc\/(?:passwd|shadow|sudoers)/,
  /\/private\/etc/,
  /~?\/?\.ssh\//,
  /\bsudo\b/,
  /\brm\s+-rf\s+\//,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bchmod\s+777/,
];

function isSafeCommand(cmd: string): boolean {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) return false;
  }
  return true;
}

export interface ShellResult {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
}

export async function runShellCommand(
  command: string,
  timeoutMs = 10_000,
): Promise<ShellResult> {
  if (process.env.OMNI_SHELL_ENABLED !== "1") {
    return { ok: false, command, stdout: "", stderr: "", exitCode: -1, error: "Shell execution disabled. Set OMNI_SHELL_ENABLED=1 to enable." };
  }

  if (!isSafeCommand(command)) {
    return { ok: false, command, stdout: "", stderr: "", exitCode: -1, error: "Command blocked by safety policy." };
  }

  const clampedTimeout = Math.min(Math.max(timeoutMs, 500), 30_000);

  try {
    const { stdout, stderr } = await execFileAsync("/bin/sh", ["-c", command], {
      timeout: clampedTimeout,
      maxBuffer: 512 * 1024, // 512KB output cap
      env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin" },
    });
    return { ok: true, command, stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 2000), exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    return {
      ok: false,
      command,
      stdout: (e.stdout ?? "").slice(0, 8000),
      stderr: (e.stderr ?? "").slice(0, 2000),
      exitCode: e.code ?? 1,
      error: e.message?.slice(0, 200),
    };
  }
}
