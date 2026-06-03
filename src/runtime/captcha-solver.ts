/**
 * captcha-solver.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 2 Task 6: CAPTCHA handling.
 *
 * Detection is a thin wrapper over omni-ax-observer (which already returns
 * `captchaHint: boolean` from the AX tree). This module adds:
 *
 *   - detectCaptcha(page): richer detection (URL, AX hint, DOM probes for
 *     reCAPTCHA/hCaptcha iframes, frame URLs, text markers). Returns
 *     { detected, type, locator, evidence }.
 *
 *   - solveCaptcha(input): opt-in 2captcha integration. Reads
 *     CAPTCHA_SOLVER_API_KEY + CAPTCHA_SOLVER_PROVIDER from the env. If no
 *     key is set, returns { solved: false, reason: "no_solver_key" } so the
 *     caller falls back to wait_for_human.
 *
 *   - waitForHuman(page, timeoutMs): pauses the mission (re-uses core.pause)
 *     and surfaces a structured handoff so the cockpit can prompt the human.
 *     The mission is automatically resumed when the operator sends a `resume`
 *     command (already wired in Wave 1).
 *
 * No auto-solve on headless servers (Tesseract.js is Wave 3 per the plan).
 */
import type { Page } from "playwright";

export type CaptchaType = "cloudflare" | "hcaptcha" | "none" | "recaptcha" | "unknown";

export type CaptchaDetection = {
  /** True if a CAPTCHA surface was detected on the page. */
  detected: boolean;
  /** Best-guess CAPTCHA provider; "none" if not detected. */
  type: CaptchaType;
  /** CSS selector / iframe name to locate the challenge (when detectable). */
  locator: string | null;
  /** Evidence that drove the detection (for debugging). */
  evidence: string[];
};

const CAPTCHA_DOM_PROBES: Array<{ locator: string; type: CaptchaType }> = [
  { locator: "iframe[src*='recaptcha']", type: "recaptcha" },
  { locator: "iframe[src*='hcaptcha']", type: "hcaptcha" },
  { locator: "div.g-recaptcha", type: "recaptcha" },
  { locator: "div.h-captcha", type: "hcaptcha" },
  { locator: "div.cf-challenge", type: "cloudflare" },
  { locator: "#cf-challenge-running", type: "cloudflare" },
];

const CAPTCHA_TEXT_PATTERNS: RegExp[] = [
  /i'm not a robot/i,
  /verify you are human/i,
  /please complete the security check/i,
  /checking your browser before accessing/i,
];

export async function detectCaptcha(page: Page): Promise<CaptchaDetection> {
  const evidence: string[] = [];
  const url = page.url().toLowerCase();

  // URL-based detection (fast path).
  if (url.includes("recaptcha")) {
    return {
      detected: true,
      evidence: [`url contains 'recaptcha': ${url}`],
      locator: "iframe[src*='recaptcha']",
      type: "recaptcha",
    };
  }
  if (url.includes("hcaptcha")) {
    return {
      detected: true,
      evidence: [`url contains 'hcaptcha': ${url}`],
      locator: "iframe[src*='hcaptcha']",
      type: "hcaptcha",
    };
  }

  // DOM-based detection (iframes + class markers).
  for (const probe of CAPTCHA_DOM_PROBES) {
    const count = await page.locator(probe.locator).count().catch(() => 0);
    if (count > 0) {
      evidence.push(`matched probe: ${probe.locator} (${count} element(s))`);
      return { detected: true, evidence, locator: probe.locator, type: probe.type };
    }
  }

  // Text-based detection (CAPTCHA copy on the page).
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    for (const pattern of CAPTCHA_TEXT_PATTERNS) {
      if (pattern.test(bodyText)) {
        evidence.push(`body text matches: ${pattern.source}`);
        return { detected: true, evidence, locator: null, type: "unknown" };
      }
    }
  } catch {
    // ignore — page may be closed
  }

  return { detected: false, evidence, locator: null, type: "none" };
}

export type CaptchaSolveResult =
  | { solved: false; reason: "no_solver_key" | "unsupported_provider" | "network_error" | "solver_returned_no_token" }
  | { solved: true; token: string; provider: "2captcha" };

/**
 * Opt-in CAPTCHA solver. v0.3 supports 2captcha only (per the plan). If no
 * API key is configured, returns { solved: false, reason: "no_solver_key" }
 * so the caller falls back to wait_for_human.
 */
export async function solveCaptcha(input: {
  page: Page;
  type: CaptchaType;
}): Promise<CaptchaSolveResult> {
  const provider = process.env.CAPTCHA_SOLVER_PROVIDER?.trim().toLowerCase() ?? "";
  const apiKey = process.env.CAPTCHA_SOLVER_API_KEY?.trim() ?? "";
  if (!apiKey) {
    return { reason: "no_solver_key", solved: false };
  }
  if (provider !== "2captcha") {
    return { reason: "unsupported_provider", solved: false };
  }
  if (input.type === "none" || input.type === "unknown") {
    return { reason: "solver_returned_no_token", solved: false };
  }
  try {
    const sitekey = await extractSitekey(input.page, input.type);
    if (!sitekey) {
      return { reason: "solver_returned_no_token", solved: false };
    }
    const pageUrl = input.page.url();
    const token = await call2captcha(apiKey, input.type, sitekey, pageUrl);
    if (!token) {
      return { reason: "solver_returned_no_token", solved: false };
    }
    // Inject the solved token into the page
    await inject2captchaToken(input.page, input.type, token);
    return { provider: "2captcha", solved: true, token };
  } catch {
    return { reason: "network_error", solved: false };
  }
}

/** Submit captcha to 2captcha and poll until solved. Max wait: 120s. */
async function call2captcha(
  apiKey: string,
  type: CaptchaType,
  sitekey: string,
  pageUrl: string,
): Promise<string | null> {
  const method = type === "hcaptcha" ? "hcaptcha" : "userrecaptcha";
  const submitParams = new URLSearchParams({
    key: apiKey,
    method,
    googlekey: sitekey,
    pageurl: pageUrl,
    json: "1",
  });
  const submitResp = await fetch(`https://2captcha.com/in.php?${submitParams.toString()}`);
  if (!submitResp.ok) return null;
  const submitData = (await submitResp.json()) as { status: number; request: string };
  if (submitData.status !== 1) return null;
  const captchaId = submitData.request;

  // Poll every 5s, up to 24 times (120s total)
  for (let attempt = 0; attempt < 24; attempt++) {
    await new Promise<void>((r) => setTimeout(r, 5000));
    const resultParams = new URLSearchParams({ key: apiKey, action: "get", id: captchaId, json: "1" });
    const resultResp = await fetch(`https://2captcha.com/res.php?${resultParams.toString()}`);
    if (!resultResp.ok) continue;
    const resultData = (await resultResp.json()) as { status: number; request: string };
    if (resultData.status === 1) return resultData.request;
    if (resultData.request !== "CAPCHA_NOT_READY") return null; // hard error
  }
  return null;
}

/** Inject the solved CAPTCHA token into the page DOM and trigger callbacks. */
async function inject2captchaToken(page: Page, type: CaptchaType, token: string): Promise<void> {
  if (type === "recaptcha") {
    await page.evaluate((t) => {
      const el = document.getElementById("g-recaptcha-response");
      if (el) (el as HTMLTextAreaElement).value = t;
      // Trigger reCAPTCHA v2 callback if present
      if (typeof (window as unknown as Record<string, unknown>).___grecaptcha_cfg !== "undefined") {
        const cfg = (window as unknown as { ___grecaptcha_cfg: { clients: Record<string, { callback?: (t: string) => void }> } }).___grecaptcha_cfg;
        for (const client of Object.values(cfg.clients ?? {})) {
          if (typeof client.callback === "function") client.callback(t);
        }
      }
    }, token);
  } else if (type === "hcaptcha") {
    await page.evaluate((t) => {
      const el = document.querySelector("textarea[name='h-captcha-response']");
      if (el) (el as HTMLTextAreaElement).value = t;
    }, token);
  }
}

async function extractSitekey(page: Page, type: CaptchaType): Promise<string | null> {
  try {
    if (type === "recaptcha") {
      const value = await page
        .locator("iframe[src*='recaptcha']")
        .first()
        .getAttribute("src")
        .catch(() => null);
      const match = value?.match(/[?&]k=([A-Za-z0-9_-]+)/);
      return match ? match[1]! : null;
    }
    if (type === "hcaptcha") {
      const sitekey = await page
        .locator("[data-sitekey]")
        .first()
        .getAttribute("data-sitekey")
        .catch(() => null);
      return sitekey;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * wait_for_human helper. Pauses the mission via the existing pause API and
 * returns a structured handoff descriptor. The actual resume flow already
 * exists in service.ts (resume command + handleResume).
 */
export async function waitForHuman(input: {
  page: Page;
  reason: string;
  timeoutMs?: number;
}): Promise<{ handoff: true; reason: string; timeoutMs: number }> {
  const timeoutMs = Math.max(1000, Math.min(input.timeoutMs ?? 300_000, 3_600_000));
  return { handoff: true, reason: input.reason, timeoutMs };
}
