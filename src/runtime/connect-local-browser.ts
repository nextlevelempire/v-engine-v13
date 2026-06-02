/**
 * Local-browser takeover via Chrome DevTools Protocol.
 *
 * When this daemon runs as a `takeover:local_browser` RuntimeDevice it does NOT
 * spin up a throwaway Chromium — it drives the user's REAL, signed-in Chrome over
 * CDP (the browser-use pattern). Either the user already launched Chrome with
 * `--remote-debugging-port`, or we launch their Chrome with that flag against their
 * own profile so their existing logins are present.
 *
 * Credential safety (hard rule): we connect to a browser the user is ALREADY signed
 * into; the agent never types passwords. Login stays the human's responsibility.
 *
 * Opt-in only: gated by OMNI_TAKEOVER_BROWSER_CDP=1 so the default fresh-launch path
 * (used by the cloud runtime deployment of this same codebase) is unchanged.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";

const DEFAULT_CDP_PORT = 9222;

export function getCdpPort(): number {
  const raw = Number(process.env.OMNI_TAKEOVER_CDP_PORT ?? DEFAULT_CDP_PORT);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CDP_PORT;
}

/** True when this daemon should drive the user's real Chrome over CDP. */
export function isLocalBrowserCdpEnabled(): boolean {
  return process.env.OMNI_TAKEOVER_BROWSER_CDP === "1";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryConnect(port: number): Promise<Browser | null> {
  try {
    return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 4_000 });
  } catch {
    return null;
  }
}

function findChromeExecutable(): string | undefined {
  const candidates = [
    process.env.OMNI_CHROME_EXECUTABLE,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean) as string[];
  return candidates.find((target) => fs.existsSync(target));
}

/** The user's real Chrome profile dir, so the driven browser carries their logins. */
function defaultUserDataDir(): string {
  const explicit = process.env.OMNI_CHROME_USER_DATA_DIR?.trim();
  if (explicit) {
    return explicit;
  }
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "Google", "Chrome");
    case "win32":
      return path.join(
        process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"),
        "Google",
        "Chrome",
        "User Data",
      );
    default:
      return path.join(home, ".config", "google-chrome");
  }
}

export type LocalBrowserConnection = {
  browser: Browser;
  launchedChild: boolean;
};

/**
 * Connect to the user's Chrome over CDP, launching it with a remote-debugging port
 * if it is not already exposing one. Resolves with a connected Playwright Browser.
 */
export async function connectLocalBrowserOverCdp(): Promise<LocalBrowserConnection> {
  const port = getCdpPort();

  // 1) Already listening (user launched Chrome with --remote-debugging-port themselves).
  const existing = await tryConnect(port);
  if (existing) {
    return { browser: existing, launchedChild: false };
  }

  // 2) Launch the user's Chrome with remote debugging against their real profile.
  const executable = findChromeExecutable();
  if (!executable) {
    throw new Error(
      "Could not find Google Chrome to drive. Install Chrome or set OMNI_CHROME_EXECUTABLE.",
    );
  }
  const userDataDir = defaultUserDataDir();
  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--restore-last-session",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  // 3) Poll for the CDP endpoint to come up (Chrome must not already be running on
  //    this profile without the debug port — if it is, the user must quit it first).
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(500);
    const browser = await tryConnect(port);
    if (browser) {
      return { browser, launchedChild: true };
    }
  }

  throw new Error(
    `Could not connect to Chrome over CDP on port ${port}. If Chrome was already open, fully quit it ` +
      "and re-run so the daemon can launch it with a debugging port (your logins are preserved).",
  );
}
