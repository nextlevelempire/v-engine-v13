import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { getDaemonStateDir } from "../utils/omni-paths.js";
import { atomicWriteFile } from "../runtime/session-persistence.js";
import { getEnabledTakeoverCapabilities } from "./takeover-config.js";

const INSTANCE_PATH = path.join(getDaemonStateDir(), "daemon-instance.json");
const CAPABILITIES = ["browser"];

export function getDaemonInstanceId(): string {
  try {
    if (fs.existsSync(INSTANCE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(INSTANCE_PATH, "utf8")) as { daemonInstanceId?: string };
      if (parsed.daemonInstanceId) {
        return parsed.daemonInstanceId;
      }
    }
  } catch {
    // ignore and regenerate
  }

  const daemonInstanceId = randomUUID();
  atomicWriteFile(INSTANCE_PATH, JSON.stringify({ daemonInstanceId }, null, 2), { mode: 0o600 });
  return daemonInstanceId;
}

export function getRuntimeCapabilities(): string[] {
  // Base "browser" execution capability + whatever local-takeover modes this
  // machine offers (takeover:local_browser / takeover:local_computer). The control
  // plane reads these from /api/health to decide which RuntimeMode this device serves.
  return Array.from(new Set<string>([...CAPABILITIES, ...getEnabledTakeoverCapabilities()]));
}
