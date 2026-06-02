/**
 * Structured JSON logger for V-Engine runtime.
 * Replaces console.log/warn/error with consistent JSON output suitable
 * for log aggregation (Loki, Datadog, CloudWatch, etc).
 *
 * Format: one JSON object per line, fields: ts, level, msg, ...data.
 *
 * Usage:
 *   log.info("session.created", { sessionId, userId, orgId });
 *   log.warn("auth.failed", { ip, reason });
 *   log.error("chrome.launch_failed", { err: String(err) });
 *
 * The destination is stdout for info/warn and stderr for error, matching
 * the 12-factor app convention.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, error: 40, info: 20, warn: 30 };

// Default: info. Set OMNI_LOG_LEVEL=debug for verbose output.
const MIN_LEVEL: LogLevel = (process.env.OMNI_LOG_LEVEL as LogLevel | undefined) || "info";
const MIN_RANK = LEVEL_RANK[MIN_LEVEL] ?? LEVEL_RANK.info;

function emit(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < MIN_RANK) return;
  const line = JSON.stringify({
    data: data ?? {},
    level,
    msg,
    ts: new Date().toISOString(),
  });
  if (level === "error" || level === "warn") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

export const log = {
  debug(msg: string, data?: Record<string, unknown>) {
    emit("debug", msg, data);
  },
  info(msg: string, data?: Record<string, unknown>) {
    emit("info", msg, data);
  },
  warn(msg: string, data?: Record<string, unknown>) {
    emit("warn", msg, data);
  },
  error(msg: string, data?: Record<string, unknown>) {
    emit("error", msg, data);
  },
};
