import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_OMNI_HOME = path.join(os.homedir(), ".omni-browser");

export function ensureDir(dir: string): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getOmniHome(): string {
  // OMNI_PROFILE_DIR, when set to an absolute path, overrides OMNI_HOME entirely.
  // Used in cloud mode: the control plane mounts an Azure Files volume and sets
  // this env var so ALL daemon state (browser cookies, daemon instance ID,
  // checkpoints, vault, recordings) lives on the persistent volume and survives
  // container restarts.
  const profileDir = process.env.OMNI_PROFILE_DIR?.trim();
  if (profileDir && path.isAbsolute(profileDir)) {
    return ensureDir(profileDir);
  }

  const configured = process.env.OMNI_HOME?.trim();
  const omniHome = configured
    ? path.isAbsolute(configured)
      ? configured
      : path.join(os.homedir(), configured)
    : DEFAULT_OMNI_HOME;
  return ensureDir(omniHome);
}

export function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function hasUserId(userId?: string | null): userId is string {
  return Boolean(userId && userId.trim());
}

export function getUserRootDir(userId?: string | null): string {
  if (!hasUserId(userId)) {
    return getOmniHome();
  }
  return ensureDir(path.join(getOmniHome(), sanitizeSegment(userId)));
}

export function getBrowserSessionsDir(userId?: string | null): string {
  if (!hasUserId(userId)) {
    return ensureDir(path.join(getOmniHome(), "browser-sessions"));
  }
  return ensureDir(path.join(getUserRootDir(userId), "browser-sessions"));
}

export function getBrowserSessionDir(sessionId: string, userId?: string | null): string {
  if (!hasUserId(userId)) {
    return ensureDir(path.join(getBrowserSessionsDir(), sanitizeSegment(sessionId)));
  }
  return ensureDir(path.join(getUserRootDir(userId), sanitizeSegment(sessionId)));
}

export function getBrowserRecordsRoot(userId?: string | null): string {
  if (!hasUserId(userId)) {
    return ensureDir(path.join(getOmniHome(), "browser-records"));
  }
  return ensureDir(path.join(getUserRootDir(userId), "browser-records"));
}

export function getBrowserRecordSessionDir(sessionId: string, userId?: string | null): string {
  return ensureDir(path.join(getBrowserRecordsRoot(userId), sanitizeSegment(sessionId)));
}

export function getMissionLogsDir(userId?: string | null): string {
  if (!hasUserId(userId)) {
    return ensureDir(path.join(getOmniHome(), "mission-logs"));
  }
  return ensureDir(path.join(getUserRootDir(userId), "mission-logs"));
}

export function getChromeProfileDir(): string | null {
  // When OMNI_PROFILE_DIR is set (cloud mode), the Chrome user data dir lives
  // under the persistent volume so cookies and login state survive restarts.
  const profileDir = process.env.OMNI_PROFILE_DIR?.trim();
  if (profileDir && path.isAbsolute(profileDir)) {
    return ensureDir(path.join(profileDir, "chrome-profile"));
  }
  return null;
}

export function getDaemonStateDir(userId?: string | null): string {
  if (!hasUserId(userId)) {
    return ensureDir(path.join(getOmniHome(), "daemon-state"));
  }
  return ensureDir(path.join(getUserRootDir(userId), "daemon-state"));
}

export function getSessionStateRootDir(userId?: string | null): string {
  return ensureDir(path.join(getDaemonStateDir(userId), "sessions"));
}

export function getSecretsDir(): string {
  return ensureDir(path.join(getOmniHome(), "secrets"));
}

export function getAuditDir(userId?: string | null): string {
  if (!hasUserId(userId)) {
    return ensureDir(path.join(getOmniHome(), "audit"));
  }
  return ensureDir(path.join(getUserRootDir(userId), "audit"));
}

export function getAuditExportDir(userId?: string | null): string {
  return ensureDir(path.join(getBrowserRecordsRoot(userId), "audit"));
}

export function getDashboardDir(userId?: string | null): string {
  return ensureDir(path.join(getBrowserRecordsRoot(userId), "dashboard"));
}

export function getCheckpointsDir(userId?: string | null): string {
  if (!hasUserId(userId)) {
    return ensureDir(path.join(getOmniHome(), "checkpoints"));
  }
  return ensureDir(path.join(getUserRootDir(userId), "checkpoints"));
}

export function getDownloadsDir(userId?: string | null): string {
  if (!hasUserId(userId)) {
    return ensureDir(path.join(getOmniHome(), "downloads"));
  }
  return ensureDir(path.join(getUserRootDir(userId), "downloads"));
}

export function getVaultDir(userId?: string | null): string {
  if (!hasUserId(userId)) {
    return ensureDir(path.join(getOmniHome(), "vault"));
  }
  return ensureDir(path.join(getUserRootDir(userId), "vault"));
}

export function getVaultEntryPath(service: string, userId?: string | null): string {
  return path.join(getVaultDir(userId), `${sanitizeSegment(service)}.json`);
}
