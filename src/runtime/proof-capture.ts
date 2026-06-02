import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { sanitizeProtectedRuntimeText, sanitizeProtectedRuntimeValue } from "../security/trade-secret-guard.js";
import { getBrowserRecordsRoot, getMissionLogsDir } from "../utils/omni-paths.js";
import { atomicWriteFile } from "./session-persistence.js";

export interface OmniArtifactPaths {
  jsonDir: string;
  logDir: string;
  reportDir: string;
  rootDir: string;
  screenshotDir: string;
  videoDir: string;
}

export interface ComparisonReportInput {
  cloneImagePath: string;
  cloneLabel: string;
  notes?: string[];
  originalImagePath: string;
  originalLabel: string;
  title: string;
}

/** Per-session maximum artifact size in bytes. Override with OMNI_MAX_ARTIFACT_MB. */
const DEFAULT_MAX_ARTIFACT_MB = 500;
/** Maximum age for artifacts before they are eligible for cleanup. */
const DEFAULT_MAX_ARTIFACT_AGE_HOURS = 24;

function maxArtifactBytes(): number {
  const mb = Number(process.env.OMNI_MAX_ARTIFACT_MB ?? DEFAULT_MAX_ARTIFACT_MB);
  return Math.max(50, mb) * 1024 * 1024;
}

function maxArtifactAgeMs(): number {
  const hours = Number(process.env.OMNI_MAX_ARTIFACT_AGE_HOURS ?? DEFAULT_MAX_ARTIFACT_AGE_HOURS);
  return Math.max(1, hours) * 60 * 60 * 1000;
}

export class ProofCapture {
  constructor(
    private readonly baseDir: string = getBrowserRecordsRoot(),
    private readonly missionLogDir: string = getMissionLogsDir(),
  ) {
    ensureDir(this.baseDir);
    ensureDir(this.missionLogDir);
  }

  /**
   * Enforce per-session disk quota. If the session directory exceeds the
   * configured cap, delete the oldest files (by mtime) until it fits.
   * Also unconditionally removes files older than the TTL.
   */
  enforceQuota(sessionId: string): { deleted: number; sizeBytes: number } {
    const paths = this.getSessionPaths(sessionId);
    const ttlCutoff = Date.now() - maxArtifactAgeMs();
    const sizeCap = maxArtifactBytes();

    const allFiles = collectFilesRecursive(paths.rootDir);
    let deleted = 0;

    // Pass 1 — TTL-based cleanup.
    for (const entry of allFiles) {
      if (entry.mtimeMs < ttlCutoff) {
        try {
          fs.unlinkSync(entry.path);
          deleted += 1;
        } catch {
          // best-effort
        }
      }
    }

    // Pass 2 — size-based cleanup (oldest first).
    let remaining = collectFilesRecursive(paths.rootDir);
    let totalSize = remaining.reduce((acc, entry) => acc + entry.size, 0);
    if (totalSize <= sizeCap) {
      return { deleted, sizeBytes: totalSize };
    }

    remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of remaining) {
      if (totalSize <= sizeCap) break;
      try {
        fs.unlinkSync(entry.path);
        totalSize -= entry.size;
        deleted += 1;
      } catch {
        // best-effort
      }
    }

    return { deleted, sizeBytes: totalSize };
  }

  getSessionPaths(sessionId: string): OmniArtifactPaths {
    const safeId = sanitizeSegment(sessionId);
    const rootDir = path.join(this.baseDir, safeId);
    const screenshotDir = path.join(rootDir, "screenshots");
    const reportDir = path.join(rootDir, "reports");
    const jsonDir = path.join(rootDir, "json");
    const logDir = path.join(rootDir, "logs");
    const videoDir = path.join(rootDir, "videos");

    [rootDir, screenshotDir, reportDir, jsonDir, logDir, videoDir].forEach(ensureDir);

    return { jsonDir, logDir, reportDir, rootDir, screenshotDir, videoDir };
  }

  getMissionLogPath(missionId: string): string {
    ensureDir(this.missionLogDir);
    return path.join(this.missionLogDir, `${sanitizeSegment(missionId)}.json`);
  }

  async captureScreenshot(
    page: Page,
    sessionId: string,
    label: string,
    options: { fullPage?: boolean; type?: "jpeg" | "png" } = {},
  ): Promise<string> {
    reportQuotaCleanup(sessionId, this.enforceQuota(sessionId));
    const artifactPaths = this.getSessionPaths(sessionId);
    const ext = options.type === "jpeg" ? "jpg" : "png";
    const target = path.join(
      artifactPaths.screenshotDir,
      `${timestampPrefix()}-${sanitizeSegment(label)}.${ext}`,
    );
    const maskToken = `proof-mask-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await applySensitiveDomMask(page, maskToken).catch(() => undefined);
    try {
      await page.screenshot({
        animations: "disabled",
        fullPage: options.fullPage ?? false,
        path: target,
        scale: "css",
        type: options.type ?? "png",
      });
    } finally {
      await clearSensitiveDomMask(page, maskToken).catch(() => undefined);
    }
    return target;
  }

  writeJsonReport(sessionId: string, label: string, payload: unknown): string {
    reportQuotaCleanup(sessionId, this.enforceQuota(sessionId));
    const artifactPaths = this.getSessionPaths(sessionId);
    const target = path.join(
      artifactPaths.jsonDir,
      `${timestampPrefix()}-${sanitizeSegment(label)}.json`,
    );
    atomicWriteFile(target, JSON.stringify(sanitizeProtectedRuntimeValue(payload), null, 2), {
      mode: 0o600,
    });
    return target;
  }

  writeTextLog(sessionId: string, label: string, content: string): string {
    reportQuotaCleanup(sessionId, this.enforceQuota(sessionId));
    const artifactPaths = this.getSessionPaths(sessionId);
    const target = path.join(
      artifactPaths.logDir,
      `${timestampPrefix()}-${sanitizeSegment(label)}.log`,
    );
    atomicWriteFile(target, sanitizeProtectedRuntimeText(content), { mode: 0o600 });
    return target;
  }

  writeHtmlReport(
    sessionId: string,
    label: string,
    title: string,
    summary: string,
    details: Array<{ label: string; value: string }> = [],
    imagePaths: string[] = [],
  ): string {
    reportQuotaCleanup(sessionId, this.enforceQuota(sessionId));
    const artifactPaths = this.getSessionPaths(sessionId);
    const target = path.join(
      artifactPaths.reportDir,
      `${timestampPrefix()}-${sanitizeSegment(label)}.html`,
    );

    const detailMarkup = details
      .map(
        (detail) =>
          `<div class="detail"><div class="detail-label">${escapeHtml(sanitizeProtectedRuntimeText(detail.label))}</div><pre>${escapeHtml(
            sanitizeProtectedRuntimeText(detail.value),
          )}</pre></div>`,
      )
      .join("");
    const imageMarkup = imagePaths
      .map((imagePath) => `<figure><img src="file://${imagePath}" alt="${escapeHtml(path.basename(imagePath))}" /></figure>`)
      .join("");

    atomicWriteFile(
      target,
      `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(sanitizeProtectedRuntimeText(title))}</title>
  <style>
    body { margin: 0; padding: 32px; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif; background: #0b1020; color: #eef2ff; }
    h1 { margin-top: 0; font-size: 28px; }
    p.summary { color: #cbd5e1; max-width: 860px; line-height: 1.6; }
    .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); margin-top: 24px; }
    .detail, figure { background: rgba(15, 23, 42, 0.85); border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 18px; overflow: hidden; box-shadow: 0 20px 50px rgba(2, 6, 23, 0.35); }
    .detail-label { padding: 14px 16px; font-weight: 700; border-bottom: 1px solid rgba(148, 163, 184, 0.15); background: rgba(30, 41, 59, 0.7); }
    pre { margin: 0; padding: 16px; white-space: pre-wrap; word-break: break-word; color: #dbeafe; font-family: "SF Mono", "JetBrains Mono", monospace; font-size: 12px; }
    figure { margin: 0; }
    img { width: 100%; display: block; background: #020617; }
  </style>
</head>
<body>
  <h1>${escapeHtml(sanitizeProtectedRuntimeText(title))}</h1>
  <p class="summary">${escapeHtml(sanitizeProtectedRuntimeText(summary))}</p>
  <section class="grid">${detailMarkup}${imageMarkup}</section>
</body>
 </html>`,
      { mode: 0o600 },
    );

    return target;
  }

  writeComparisonReport(sessionId: string, input: ComparisonReportInput): string {
    reportQuotaCleanup(sessionId, this.enforceQuota(sessionId));
    const artifactPaths = this.getSessionPaths(sessionId);
    const target = path.join(artifactPaths.reportDir, `${timestampPrefix()}-ui-comparison.html`);
    const notesMarkup = (input.notes ?? [])
      .map((note) => `<li>${escapeHtml(sanitizeProtectedRuntimeText(note))}</li>`)
      .join("");

    atomicWriteFile(
      target,
      `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(sanitizeProtectedRuntimeText(input.title))}</title>
  <style>
    body { margin: 0; padding: 28px; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", Inter, sans-serif; background: #020617; color: #e2e8f0; }
    h1 { margin-top: 0; }
    p { color: #cbd5e1; max-width: 920px; line-height: 1.6; }
    .comparison { display: grid; grid-template-columns: repeat(2, minmax(320px, 1fr)); gap: 18px; margin-top: 24px; }
    .panel { background: rgba(15, 23, 42, 0.92); border: 1px solid rgba(148, 163, 184, 0.18); border-radius: 18px; overflow: hidden; }
    .panel h2 { margin: 0; padding: 14px 16px; font-size: 15px; border-bottom: 1px solid rgba(148, 163, 184, 0.16); }
    .panel img { width: 100%; display: block; background: #000; }
    ul { margin-top: 20px; color: #cbd5e1; }
  </style>
</head>
<body>
  <h1>${escapeHtml(sanitizeProtectedRuntimeText(input.title))}</h1>
  <p>Original Omni Kernel and the cloned Phase 2 build captured on the same fixed harness for fidelity review.</p>
  <div class="comparison">
    <section class="panel">
      <h2>${escapeHtml(sanitizeProtectedRuntimeText(input.originalLabel))}</h2>
      <img src="file://${input.originalImagePath}" alt="${escapeHtml(sanitizeProtectedRuntimeText(input.originalLabel))}" />
    </section>
    <section class="panel">
      <h2>${escapeHtml(sanitizeProtectedRuntimeText(input.cloneLabel))}</h2>
      <img src="file://${input.cloneImagePath}" alt="${escapeHtml(sanitizeProtectedRuntimeText(input.cloneLabel))}" />
    </section>
  </div>
  ${notesMarkup ? `<ul>${notesMarkup}</ul>` : ""}
</body>
 </html>`,
      { mode: 0o600 },
    );

    return target;
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  }
}

async function applySensitiveDomMask(page: Page, token: string): Promise<void> {
  await page.evaluate((maskToken) => {
    const styleId = `nle-proof-mask-style-${maskToken}`;
    const attrName = "data-nle-proof-mask";
    const metaPattern = /(pass(word)?|secret|token|cookie|session|email|phone|auth|key)/i;
    const contentPattern =
      /(Bearer\s+[A-Za-z0-9._-]+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+|[A-Fa-f0-9]{24,}|[A-Za-z0-9_-]{32,})/;

    const mark = (element: Element) => {
      if (element instanceof HTMLElement) {
        element.setAttribute(attrName, maskToken);
      }
    };

    document
      .querySelectorAll(
        'input, textarea, [contenteditable="true"], [type="password"], [autocomplete*="password"], [data-private="true"]',
      )
      .forEach(mark);

    document.querySelectorAll("body *").forEach((element) => {
      if (!(element instanceof HTMLElement)) {
        return;
      }
      if (element.closest("script, style, noscript")) {
        return;
      }
      const rect = element.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) {
        return;
      }
      const meta = [
        element.getAttribute("aria-label") ?? "",
        element.getAttribute("autocomplete") ?? "",
        element.getAttribute("data-testid") ?? "",
        element.getAttribute("name") ?? "",
        element.getAttribute("placeholder") ?? "",
        element.id ?? "",
      ].join(" ");
      const text = (element.innerText || element.textContent || "").trim().slice(0, 400);
      if (metaPattern.test(meta) || contentPattern.test(text)) {
        mark(element);
      }
    });

    document.getElementById(styleId)?.remove();
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = `[${attrName}="${maskToken}"]{filter:blur(16px)!important;color:transparent!important;text-shadow:none!important;caret-color:transparent!important;}`;
    document.head.appendChild(style);
  }, token);
}

async function clearSensitiveDomMask(page: Page, token: string): Promise<void> {
  await page.evaluate((maskToken) => {
    document.getElementById(`nle-proof-mask-style-${maskToken}`)?.remove();
    document
      .querySelectorAll(`[data-nle-proof-mask="${maskToken}"]`)
      .forEach((element) => element.removeAttribute("data-nle-proof-mask"));
  }, token);
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

function reportQuotaCleanup(
  sessionId: string,
  input: { deleted: number; sizeBytes: number },
): void {
  if (input.deleted <= 0) {
    return;
  }

  console.warn(
    `[OMNI] ProofCapture quota cleanup removed ${input.deleted} artifact(s) for ${sessionId}; remaining ${(input.sizeBytes / (1024 * 1024)).toFixed(1)} MB.`,
  );
}

function timestampPrefix(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

interface FileEntry {
  mtimeMs: number;
  path: string;
  size: number;
}

function collectFilesRecursive(root: string): FileEntry[] {
  if (!fs.existsSync(root)) return [];
  const out: FileEntry[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(full);
          out.push({ mtimeMs: stat.mtimeMs, path: full, size: stat.size });
        } catch {
          // best-effort
        }
      }
    }
  }
  return out;
}
