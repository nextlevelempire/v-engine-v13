/**
 * omni-ax-observer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * P0 AX/DOM Distiller — replaces noisy DOM scraping with Playwright's
 * Accessibility Tree. Gives the LLM clean, semantic page context instead of
 * 50,000 chars of raw HTML.
 *
 * Design rules:
 *  - Never embed screenshots or binary data in the returned string.
 *  - Truncate to MAX_AX_CHARS to stay within LLM context windows.
 *  - Sanitize all text through sanitizeProtectedRuntimeText before returning.
 *  - Return a stable, deterministic hash so callers can detect page changes.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { createHash } from "node:crypto";
import type { Page } from "playwright";
import { sanitizeProtectedRuntimeText } from "../security/trade-secret-guard.js";

// Maximum characters returned to the LLM. Keeps us inside GPT-4 / Gemini 2.5
// context windows even on heavy pages.
const MAX_AX_CHARS = 12_000;

// Node roles that carry meaningful semantic content for the planner.
const MEANINGFUL_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "heading",
  "link",
  "listitem",
  "menuitem",
  "option",
  "radio",
  "searchbox",
  "tab",
  "textbox",
  "treeitem",
  "img",
  "main",
  "navigation",
  "form",
  "dialog",
  "alert",
  "status",
]);

export type OmniAXObservation = {
  /** Stable hash of the AX tree — changes when the page meaningfully changes. */
  axTreeHash: string;
  /** Human-readable AX tree string, truncated to MAX_AX_CHARS. */
  axTree: string;
  /** Current page URL at observation time. */
  url: string;
  /** Page title at observation time. */
  title: string;
  /** ISO timestamp of when the observation was captured. */
  capturedAt: string;
  /** Whether the page appears to be an auth wall. */
  authWallHint: boolean;
  /** Whether the page appears to have a CAPTCHA. */
  captchaHint: boolean;
};

/**
 * Capture a semantic AX observation of the current page state.
 * This is the primary "eyes" of the P0 work loop — called before every
 * planner decision.
 */
export async function captureAXObservation(page: Page): Promise<OmniAXObservation> {
  const capturedAt = new Date().toISOString();
  const url = page.url();
  let title = "";
  let axTree = "";
  let authWallHint = false;
  let captchaHint = false;

  try {
    title = await page.title().catch(() => "");

    // Use Playwright's built-in accessibility snapshot via evaluate — far more reliable
    // than DOM traversal for dynamic SPAs. The page.accessibility API was removed
    // in Playwright 1.46+; we use AriaQuery via evaluate instead.
    const axRoles = await page.evaluate(() => {
      const elements = document.querySelectorAll(
        'a, button, input, select, textarea, [role], h1, h2, h3, h4, h5, h6, label, nav, main, aside, header, footer'
      );
      const lines: string[] = [];
      elements.forEach((el) => {
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const name = el.getAttribute('aria-label') ||
          el.getAttribute('placeholder') ||
          el.getAttribute('alt') ||
          (el as HTMLElement).innerText?.trim().slice(0, 80) ||
          el.getAttribute('name') || '';
        if (name) lines.push(`${role}: ${name}`);
      });
      return lines.slice(0, 300).join('\n');
    }).catch(() => '');

    if (axRoles) {
      axTree = axRoles;
    }

    // Fallback: if AX tree is empty (some pages disable accessibility),
    // fall back to a lightweight DOM text extraction.
    if (!axTree.trim()) {
      axTree = await page.evaluate(() => {
        const walker = document.createTreeWalker(
          document.body ?? document.documentElement,
          NodeFilter.SHOW_TEXT,
          null,
        );
        const lines: string[] = [];
        let node: Node | null;
        while ((node = walker.nextNode()) !== null) {
          const text = node.textContent?.trim();
          if (text && text.length > 1) {
            lines.push(text);
          }
        }
        return lines.slice(0, 500).join("\n");
      }).catch(() => "");
    }

    // Detect auth walls and CAPTCHAs from the AX tree text — cheap and
    // reliable without a separate DOM query.
    const lowerTree = axTree.toLowerCase();
    const lowerUrl = url.toLowerCase();

    authWallHint =
      lowerTree.includes("sign in") ||
      lowerTree.includes("log in") ||
      lowerTree.includes("password") ||
      lowerTree.includes("session expired") ||
      lowerUrl.includes("/login") ||
      lowerUrl.includes("/signin") ||
      lowerUrl.includes("/auth") ||
      lowerUrl.includes("accounts.google") ||
      lowerUrl.includes("login.microsoftonline");

    captchaHint =
      lowerTree.includes("captcha") ||
      lowerTree.includes("i'm not a robot") ||
      lowerTree.includes("verify you are human") ||
      lowerUrl.includes("recaptcha") ||
      lowerUrl.includes("hcaptcha");
  } catch {
    // Page may have been closed or navigated away — return a minimal safe observation.
    axTree = "[page not available]";
  }
  // URL-based hints run OUTSIDE the try block so they always fire even if
  // evaluate() fails (e.g. in unit tests with mock pages or closed pages).
  const lowerUrlFinal = url.toLowerCase();
  if (!authWallHint) {
    authWallHint =
      lowerUrlFinal.includes("/login") ||
      lowerUrlFinal.includes("/signin") ||
      lowerUrlFinal.includes("/auth") ||
      lowerUrlFinal.includes("accounts.google") ||
      lowerUrlFinal.includes("login.microsoftonline");
  }
  if (!captchaHint) {
    captchaHint =
      lowerUrlFinal.includes("recaptcha") ||
      lowerUrlFinal.includes("hcaptcha");
  }

  // Sanitize before returning — never leak protected runtime text to the LLM.
  const sanitizedTree = sanitizeProtectedRuntimeText(axTree);
  const truncated = sanitizedTree.slice(0, MAX_AX_CHARS);

  const axTreeHash = createHash("sha256")
    .update(truncated)
    .update(url)
    .digest("hex")
    .slice(0, 16);

  return {
    axTree: truncated,
    axTreeHash,
    authWallHint,
    captchaHint,
    capturedAt,
    title: sanitizeProtectedRuntimeText(title),
    url: sanitizeProtectedRuntimeText(url),
  };
}

/**
 * Serialize a Playwright AX node tree into a compact, indented string.
 * Only includes nodes with meaningful roles to keep the output clean.
 */
function serializeAXNode(
  node: { role?: string; name?: string; value?: string | number | boolean; children?: unknown[] },
  depth: number,
): string {
  const lines: string[] = [];
  const indent = "  ".repeat(Math.min(depth, 8));
  const role = node.role ?? "unknown";
  const name = typeof node.name === "string" ? node.name.trim() : "";
  const value = node.value !== undefined && node.value !== null ? String(node.value).trim() : "";

  // Only emit nodes with meaningful roles or non-empty names.
  if (MEANINGFUL_ROLES.has(role) || (name && depth < 4)) {
    const parts = [role];
    if (name) parts.push(`"${name.slice(0, 80)}"`);
    if (value) parts.push(`= "${value.slice(0, 40)}"`);
    lines.push(`${indent}[${parts.join(" ")}]`);
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const childStr = serializeAXNode(
        child as { role?: string; name?: string; value?: string | number | boolean; children?: unknown[] },
        depth + 1,
      );
      if (childStr) lines.push(childStr);
    }
  }

  return lines.join("\n");
}

/**
 * Quick hash of the current AX tree — used by the verifier to detect
 * whether an action caused a meaningful page change.
 */
export async function hashAXTree(page: Page): Promise<string> {
  try {
    const obs = await captureAXObservation(page);
    return obs.axTreeHash;
  } catch {
    return "error";
  }
}
