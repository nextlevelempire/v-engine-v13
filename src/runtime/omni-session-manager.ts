import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { getBrowserRecordSessionDir, getChromeProfileDir } from "../utils/omni-paths.js";
import { forceInjectOmniUi, registerOmniUiLayer, setOmniUiPageActive } from "./omni-ui-layer.js";
import { connectLocalBrowserOverCdp, isLocalBrowserCdpEnabled } from "./connect-local-browser.js";

export interface OmniSession {
  browser: Browser;
  context: BrowserContext;
  createdAt: number;
  currentPage: Page | null;
  headless: boolean;
  lastActiveAt: number;
  launchStrategy:
    | "channel:chrome"
    | "connect:cdp"
    | "executablePath"
    | "headless:channel:chrome"
    | "headless:executablePath";
  persistent: boolean;
  runtimeProvider: "standalone-runtime";
  sessionId: string;
  userDataDir: string;
  videoDir: string;
}

export class OmniSessionManager {
  private readonly idleCleanupInterval: NodeJS.Timeout;
  private readonly sessions = new Map<string, OmniSession>();

  constructor(
    private readonly options: {
      disableIdleCleanup?: boolean;
      allowHeadlessFallback?: boolean;
      idleTimeoutMs?: number;
      launchRetries?: number;
      maxParallelSessions?: number;
    } = {},
  ) {
    this.idleCleanupInterval = setInterval(
      () => void this.cleanupIdleSessions(),
      Math.min(this.getIdleTimeout(), 60_000),
    );
    this.idleCleanupInterval.unref?.();
  }

  async createSession(input: {
    persistent?: boolean;
    sessionId: string;
    userDataDir: string;
    userId?: string | null;
  }): Promise<OmniSession> {
    await this.enforceParallelLimit();

    const sessionId = sanitizeSegment(input.sessionId);
    const userDataDir = path.resolve(input.userDataDir);
    ensureDir(userDataDir);
    cleanupOmniLockFiles(userDataDir);

    const chromeProfileDir = getChromeProfileDir();
    const videoDir = path.join(getBrowserRecordSessionDir(sessionId, input.userId), "videos");
    ensureDir(videoDir);

// Cloud mode (OMNI_PROFILE_DIR): use launchPersistentContext so browser
    // cookies, localStorage, and login state survive container restarts.
    if (chromeProfileDir) {
      const persistentContext = await chromium.launchPersistentContext(chromeProfileDir, {
        acceptDownloads: true,
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage",
          "--disable-features=IsolateOrigins,site-per-process",
          "--disable-renderer-backgrounding",
          "--disable-search-engine-choice-screen",
          "--disable-setuid-sandbox",
          "--no-default-browser-check",
          "--no-first-run",
          "--no-sandbox",
          "--password-store=basic",
          "--use-mock-keychain",
        ],
        headless: false,
        recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
        viewport: { height: 800, width: 1280 },
      });

      await registerOmniUiLayer(persistentContext);

      const browser = persistentContext.browser()?.contexts()?.[0]?.browser();
      if (!browser) {
        throw new Error("[OMNI] Failed to obtain browser handle from persistent context");
      }

      const session: OmniSession = {
        browser,
        context: persistentContext,
        createdAt: Date.now(),
        currentPage: null,
        headless: false,
        lastActiveAt: Date.now(),
        launchStrategy: "executablePath",
        persistent: true,
        runtimeProvider: "standalone-runtime",
        sessionId,
        userDataDir: chromeProfileDir,
        videoDir,
      };

      persistentContext.on("page", (page) => {
        session.currentPage = page;
        session.lastActiveAt = Date.now();
        void this.syncPageActivity(session, page);
        page.on("domcontentloaded", () => {
          session.currentPage = page;
          session.lastActiveAt = Date.now();
          void this.syncPageActivity(session, page);
        });
        page.on("close", () => {
          if (session.currentPage === page) {
            const candidates = persistentContext
              .pages()
              .filter((candidate) => candidate !== page && !candidate.isClosed());
            const fallback = candidates.length > 0 ? candidates[candidates.length - 1] : null;
            session.currentPage = fallback;
            if (fallback) {
              session.lastActiveAt = Date.now();
            }
          }
          void this.syncPageActivity(session, session.currentPage);
        });
      });

      this.sessions.set(sessionId, session);
      return session;
    }

    // local_browser takeover: drive the user's REAL signed-in Chrome over CDP.
    // Opt-in (OMNI_TAKEOVER_BROWSER_CDP=1); default path below is unchanged.
    let browser: Browser;
    let context: BrowserContext;
    let headless: boolean;
    let launchStrategy: OmniSession["launchStrategy"];

    if (isLocalBrowserCdpEnabled()) {
      const connection = await connectLocalBrowserOverCdp();
      browser = connection.browser;
      // Reuse the user's existing context so their cookies/logins are present;
      // a connected (non-launched) browser has no recordVideo, which is fine.
      const existingContexts = browser.contexts();
      context =
        existingContexts[0] ??
        (await browser.newContext({
          acceptDownloads: true,
          viewport: { height: 800, width: 1280 },
        }));
      headless = false;
      launchStrategy = "connect:cdp";
    } else {
      const launched = await launchChromeWithFallback({
        allowHeadlessFallback:
          this.options.allowHeadlessFallback ?? process.env.OMNI_ALLOW_HEADLESS_FALLBACK === "1",
        launchRetries: this.options.launchRetries ?? 3,
      });
      browser = launched.browser;
      context = await launched.browser.newContext({
        acceptDownloads: true,
        recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
        storageState: undefined,
        viewport: { height: 800, width: 1280 },
      });
      headless = launched.headless;
      launchStrategy = launched.strategy;
    }

    await registerOmniUiLayer(context);

    const session: OmniSession = {
      browser,
      context,
      createdAt: Date.now(),
      currentPage: null,
      headless,
      lastActiveAt: Date.now(),
      launchStrategy,
      persistent: input.persistent === true,
      runtimeProvider: "standalone-runtime",
      sessionId,
      userDataDir,
      videoDir,
    };

    context.on("page", (page) => {
      session.currentPage = page;
      session.lastActiveAt = Date.now();
      void this.syncPageActivity(session, page);
      page.on("domcontentloaded", () => {
        session.currentPage = page;
        session.lastActiveAt = Date.now();
        void this.syncPageActivity(session, page);
      });
      page.on("close", () => {
        if (session.currentPage === page) {
          const candidates = session
            .context
            .pages()
            .filter((candidate) => candidate !== page && !candidate.isClosed());
          const fallback = candidates.length > 0 ? candidates[candidates.length - 1] : null;
          session.currentPage = fallback;
          if (fallback) {
            session.lastActiveAt = Date.now();
          }
        }
        void this.syncPageActivity(session, session.currentPage);
      });
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): OmniSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  listSessions(): OmniSession[] {
    return Array.from(this.sessions.values());
  }

  async openPage(sessionId: string): Promise<Page> {
    const session = this.requireSession(sessionId);
    const page = await session.context.newPage();
    session.currentPage = page;
    session.lastActiveAt = Date.now();
    await this.syncPageActivity(session, page);
    return page;
  }

  markActive(sessionId: string, page?: Page): void {
    const session = this.requireSession(sessionId);
    session.lastActiveAt = Date.now();
    if (page) {
      session.currentPage = page;
    }
    void this.syncPageActivity(session, session.currentPage);
  }

  async closeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    this.sessions.delete(sessionId);
    await session.context.close().catch(() => {});
    await session.browser.close().catch(() => {});
  }

  async closeAll(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      await this.closeSession(sessionId);
    }
    clearInterval(this.idleCleanupInterval);
  }

  dispose(): void {
    clearInterval(this.idleCleanupInterval);
  }

  private async cleanupIdleSessions(): Promise<void> {
    if (this.options.disableIdleCleanup) {
      return;
    }
    const threshold = Date.now() - this.getIdleTimeout();
    for (const session of Array.from(this.sessions.values())) {
      if (session.lastActiveAt < threshold) {
        await this.closeSession(session.sessionId);
      }
    }
  }

  private async enforceParallelLimit(): Promise<void> {
    const maxParallelSessions = this.options.maxParallelSessions ?? 3;
    if (this.sessions.size < maxParallelSessions) return;

    const oldest = Array.from(this.sessions.values()).sort(
      (a, b) => a.lastActiveAt - b.lastActiveAt,
    )[0];
    if (oldest) {
      await this.closeSession(oldest.sessionId);
    }
  }

  private getIdleTimeout(): number {
    return this.options.idleTimeoutMs ?? 15 * 60 * 1000;
  }

  private requireSession(sessionId: string): OmniSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown Omni session: ${sessionId}`);
    }
    return session;
  }

  private async syncPageActivity(session: OmniSession, activePage: Page | null): Promise<void> {
    const pages = session.context.pages().filter((page) => !page.isClosed());
    await Promise.all(
      pages.map(async (page) => {
        await setOmniUiPageActive(page, activePage === page);
      }),
    );
  }
}

async function launchChromeWithFallback(input: {
  allowHeadlessFallback: boolean;
  launchRetries: number;
}): Promise<{
  browser: Browser;
  headless: boolean;
  strategy: OmniSession["launchStrategy"];
}> {
  const candidates = buildLaunchCandidates(input.allowHeadlessFallback);
  let lastError: unknown = null;

  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= input.launchRetries; attempt += 1) {
      try {
        const browser = await chromium.launch({
          args: [
            "--disable-blink-features=AutomationControlled",
            "--disable-dev-shm-usage",
            "--disable-features=IsolateOrigins,site-per-process",
            "--disable-gpu",
            "--disable-renderer-backgrounding",
            "--disable-search-engine-choice-screen",
            "--disable-setuid-sandbox",
            "--disable-web-security",
            "--no-default-browser-check",
            "--no-first-run",
            "--no-sandbox",
            "--password-store=basic",
            "--use-mock-keychain",
          ],
          channel: candidate.channel,
          executablePath: candidate.executablePath,
          headless: candidate.headless,
        });
        return {
          browser,
          headless: candidate.headless,
          strategy: candidate.strategy,
        };
      } catch (error) {
        lastError = error;
        await delay(attempt * 250);
      }
    }
  }

  throw new Error(
    `[OMNI] Unable to launch Chrome/Chromium.${lastError instanceof Error ? ` ${lastError.message}` : ""}`,
  );
}

function buildLaunchCandidates(allowHeadlessFallback: boolean) {
  const executablePath = findChromeExecutable();
  const candidates: Array<{
    channel?: "chrome";
    executablePath?: string;
    headless: boolean;
    strategy: OmniSession["launchStrategy"];
  }> = [];

  if (executablePath) {
    candidates.push({
      executablePath,
      headless: false,
      strategy: "executablePath",
    });
  }

  candidates.push({
    channel: "chrome",
    headless: false,
    strategy: "channel:chrome",
  });

  if (allowHeadlessFallback && !isProductionRuntime()) {
    if (executablePath) {
      candidates.push({
        executablePath,
        headless: true,
        strategy: "headless:executablePath",
      });
    }
    candidates.push({
      channel: "chrome",
      headless: true,
      strategy: "headless:channel:chrome",
    });
  }

  return candidates;
}

function findChromeExecutable(): string | undefined {
  const candidates = [
    process.env.OMNI_CHROME_EXECUTABLE,
    "/opt/google/chrome/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean) as string[];

  return candidates.find((target) => fs.existsSync(target));
}

function isProductionRuntime(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    Boolean(process.env.RAILWAY_ENVIRONMENT) ||
    Boolean(process.env.RAILWAY_ENVIRONMENT_NAME) ||
    Boolean(process.env.RAILWAY_PROJECT_ID) ||
    Boolean(process.env.RAILWAY_SERVICE_ID)
  );
}

function cleanupOmniLockFiles(userDataDir: string): void {
  const lockTargets = [
    "SingletonCookie",
    "SingletonLock",
    "SingletonSocket",
    path.join("Default", "SingletonCookie"),
    path.join("Default", "SingletonLock"),
    path.join("Default", "SingletonSocket"),
  ];

  for (const relativePath of lockTargets) {
    const target = path.join(userDataDir, relativePath);
    if (fs.existsSync(target)) {
      try {
        fs.rmSync(target, { force: true, recursive: true });
      } catch {
        // ignore best effort cleanup
      }
    }
  }
}

function ensureDir(target: string): void {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function injectUiIntoExistingSession(input: {
  browser: Browser;
  preferredSessionId: string;
  userDataDir: string;
}): Promise<OmniSession> {
  const sessionId = sanitizeSegment(input.preferredSessionId);
  const context = input.browser.contexts()[0] ?? (await input.browser.newContext());
  await registerOmniUiLayer(context);

  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());
  await forceInjectOmniUi(page).catch(() => undefined);

  return {
    browser: input.browser,
    context,
    createdAt: Date.now(),
    currentPage: page,
    headless: false,
    lastActiveAt: Date.now(),
    launchStrategy: "executablePath",
    persistent: false,
    runtimeProvider: "standalone-runtime",
    sessionId,
    userDataDir: path.resolve(input.userDataDir),
    videoDir: path.join(input.userDataDir, "videos"),
  };
}
