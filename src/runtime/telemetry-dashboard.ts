import fs from "node:fs";
import path from "node:path";
import type { OmniAuditTrail } from "./audit-trail.js";
import type { OmniSessionPersistence } from "./session-persistence.js";
import { atomicWriteFile } from "./session-persistence.js";
import { sanitizeProtectedRuntimeValue } from "../security/trade-secret-guard.js";
import { getDashboardDir } from "../utils/omni-paths.js";

export class OmniTelemetryDashboard {
  constructor(
    private readonly auditTrail: OmniAuditTrail,
    private readonly sessionPersistence: OmniSessionPersistence,
    private readonly targetDir: string = getDashboardDir(),
  ) {
    ensureDir(this.targetDir);
  }

  export(sessionId: string | null = null): {
    csvPath: string;
    htmlPath: string;
    jsonPath: string;
  } {
    const exportDir = path.join(this.targetDir, sanitizeSegment(sessionId ?? "all"));
    ensureDir(exportDir);

    const sessionEntries = this.auditTrail.exportSession(sessionId, exportDir);
    const manifests = sessionId
      ? [this.sessionPersistence.loadManifest(sessionId)].filter(Boolean)
      : this.sessionPersistence.listManifests();

    const htmlPath = path.join(exportDir, "index.html");
    const safeManifests = sanitizeProtectedRuntimeValue(manifests);
    const safeEntries = sanitizeProtectedRuntimeValue(sessionEntries.entries);
    atomicWriteFile(
      htmlPath,
      `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Omni Telemetry Dashboard</title>
    <style>
      body { margin: 0; padding: 28px; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif; background: #020617; color: #e2e8f0; }
      h1 { margin-top: 0; }
      .grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
      .panel { background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(148, 163, 184, 0.18); border-radius: 18px; padding: 18px; }
      pre { white-space: pre-wrap; word-break: break-word; color: #cbd5e1; font-size: 12px; }
    </style>
  </head>
  <body>
    <h1>Omni Telemetry Dashboard</h1>
    <p>Static export scaffold for local operator review. Live telemetry continues on the managed runtime bridge.</p>
    <section class="grid">
      <article class="panel">
        <h2>Session Manifests</h2>
        <pre>${escapeHtml(JSON.stringify(safeManifests, null, 2))}</pre>
      </article>
      <article class="panel">
        <h2>Audit Summary</h2>
        <pre>${escapeHtml(JSON.stringify(safeEntries, null, 2))}</pre>
      </article>
    </section>
  </body>
</html>`,
      { mode: 0o644 },
    );

    return {
      csvPath: sessionEntries.csvPath,
      htmlPath,
      jsonPath: sessionEntries.jsonPath,
    };
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}
