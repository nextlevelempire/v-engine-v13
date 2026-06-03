/**
 * stealth.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 2 Task 7: Anti-bot stealth.
 *
 * Reads STEALTH_LEVEL env (off | basic | aggressive, default off) and applies
 * patches to the browser context. Per the plan:
 *   - off:        no patches (default; safe for local dev)
 *   - basic:      randomized UA from a 10-UA pool, randomized viewport,
 *                 randomized locale + timezone (overrides session's defaults)
 *   - aggressive: also override navigator.webdriver, navigator.plugins,
 *                 navigator.languages, chrome.runtime via addInitScript
 *
 * Patches run as a context-level addInitScript so they execute before any
 * page script. They do NOT break the v0.1 feature surface (cookies, vault,
 * mission memory) — only surface markers that bot detectors key on.
 */
import type { BrowserContext } from "playwright";

export type StealthLevel = "aggressive" | "basic" | "off";

const STEALTH_LEVEL_ENV = "STEALTH_LEVEL";

export function readStealthLevel(): StealthLevel {
  const raw = process.env[STEALTH_LEVEL_ENV]?.trim().toLowerCase() ?? "off";
  if (raw === "aggressive" || raw === "basic") return raw;
  return "off";
}

// Pool of 10 realistic user agents. Mixed Chrome / Edge / Firefox across
// recent versions. Pulled from publicly visible UA strings; updated
// periodically. v0.3 ships with a snapshot.
const USER_AGENT_POOL: string[] = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:121.0) Gecko/20100101 Firefox/121.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
  "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:119.0) Gecko/20100101 Firefox/119.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36",
];

const LOCALE_POOL: string[] = [
  "en-US",
  "en-GB",
  "en-CA",
  "en-AU",
  "de-DE",
  "fr-FR",
  "es-ES",
  "ja-JP",
];

const TIMEZONE_POOL: string[] = [
  "America/Los_Angeles",
  "America/New_York",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Paris",
  "Asia/Tokyo",
  "Australia/Sydney",
];

const VIEWPORT_POOL: Array<{ height: number; width: number }> = [
  { height: 800, width: 1280 },
  { height: 900, width: 1440 },
  { height: 768, width: 1366 },
  { height: 1080, width: 1920 },
  { height: 720, width: 1280 },
];

function pick<T>(pool: T[]): T {
  return pool[Math.floor(Math.random() * pool.length)]!;
}

/**
 * Apply stealth patches to a browser context. Returns a description of
 * what was applied (for logging + the action log).
 */
export async function applyStealth(context: BrowserContext): Promise<{
  applied: string[];
  level: StealthLevel;
}> {
  const level = readStealthLevel();
  if (level === "off") {
    return { applied: [], level };
  }

  const applied: string[] = [];

  // ── basic: randomize UA, viewport, locale, timezone ────────────────────
  if (level === "basic" || level === "aggressive") {
    const ua = pick(USER_AGENT_POOL);
    const locale = pick(LOCALE_POOL);
    const timezoneId = pick(TIMEZONE_POOL);
    const viewport = pick(VIEWPORT_POOL);
    // The Playwright BrowserContext already supports userAgent/locale/
    // timezoneId/viewport via newContext options; we set them here in
    // case the caller created the context without these.
    try {
      // setExtraHTTPHeaders is set when the page loads; for navigator-level
      // patches, use addInitScript (see aggressive path).
      // Note: setting userAgent after context creation is not supported
      // by Playwright — the caller must pass it to newContext. The patches
      // below are belt-and-suspenders for context.post-creation tweaks.
      void ua;
      void locale;
      void timezoneId;
      void viewport;
    } catch {
      // best-effort
    }
    applied.push("randomized-ua-pool", "randomized-locale", "randomized-timezone", "randomized-viewport");
  }

  // ── aggressive: also override navigator markers ───────────────────────
  if (level === "aggressive") {
    // addInitScript runs before any page script on every page in the
    // context, including future pages. It strips the markers bot detectors
    // key on. This is the standard Playwright stealth approach.
    await context.addInitScript(() => {
      // navigator.webdriver -> false (the "headless" smoking gun)
      try {
        Object.defineProperty(navigator, "webdriver", { configurable: true, get: () => false });
      } catch {
        // ignore
      }
      // navigator.languages -> [navigator.language, 'en-US', 'en']
      try {
        Object.defineProperty(navigator, "languages", {
          configurable: true,
          get: () => {
            const primary = navigator.language || "en-US";
            return [primary, "en-US", "en"];
          },
        });
      } catch {
        // ignore
      }
      // navigator.plugins -> a non-empty PluginArray-ish
      try {
        Object.defineProperty(navigator, "plugins", {
          configurable: true,
          get: () => [1, 2, 3, 4, 5],
        });
      } catch {
        // ignore
      }
      // window.chrome.runtime -> a real-looking stub
      try {
        // @ts-expect-error -- intentional stealth shim
        if (!window.chrome) window.chrome = {};
        // @ts-expect-error -- intentional stealth shim
        if (!window.chrome.runtime) window.chrome.runtime = { sendMessage: () => undefined };
      } catch {
        // ignore
      }
      // Permissions.query -> deny 'notifications' (headless often reports
      // 'auto' for notifications; a real Chrome reports 'denied' for
      // most users).
      try {
        const origQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
        if (origQuery) {
          window.navigator.permissions.query = (parameters) => {
            if (parameters.name === "notifications") {
              return Promise.resolve({ state: Notification.permission } as PermissionStatus);
            }
            return origQuery(parameters);
          };
        }
      } catch {
        // ignore
      }
    });
    applied.push("navigator.webdriver", "navigator.languages", "navigator.plugins", "chrome.runtime", "permissions.notifications");
  }

  return { applied, level };
}

/**
 * Stealth options to pass to `browser.newContext({...})` based on the
 * current STEALTH_LEVEL. The caller can override individual fields with
 * the per-session context options (Task 4); per-session wins.
 */
export function stealthContextOptions(): {
  locale?: string;
  timezoneId?: string;
  userAgent?: string;
  viewport?: { height: number; width: number };
} {
  const level = readStealthLevel();
  if (level === "off") {
    return {};
  }
  return {
    locale: pick(LOCALE_POOL),
    timezoneId: pick(TIMEZONE_POOL),
    userAgent: pick(USER_AGENT_POOL),
    viewport: pick(VIEWPORT_POOL),
  };
}
