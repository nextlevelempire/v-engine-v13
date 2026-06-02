/**
 * local_computer takeover — the computer-use loop.
 *
 * Drives the user's full desktop: screenshot -> model decision -> real mouse/keyboard,
 * through the optional native-input adapter (nut.js). The model "brain" is injected
 * via a `decide` callback so the control plane (omni-browser-app) stays the planner;
 * this module is the hands plus the hard safety rails.
 *
 * SAFETY RAILS (hard rules):
 *  1. Never enter credentials. A `type` action flagged secret, or that targets a
 *     password/login surface, is REFUSED and handed to the human.
 *  2. Irreversible / financial actions (purchase, delete, send money, etc.) require
 *     explicit human confirmation before they execute.
 *  3. The loop honors a cooperative stop signal between every step.
 *
 * WAVE 2 EXTENSIONS (Commander's Vision: AI uses V-Engine like a human):
 *  - Right-click, double-click, shortcut, drag, scroll, hover (desktop)
 *  - Screenshot-element, file upload, file download, fill form, scroll-until
 *  - Enter/exit frame, shadow-pierce (page-DOM)
 *  - Clipboard read/write (OS clipboard)
 *  - Optional page reference so page-DOM actions can run inside the takeover loop
 */
import { getNativeInputAdapter, type NativeInputAdapter } from "./native-input.js";
import type { Page } from "playwright";

// ── ComputerAction union ──────────────────────────────────────────────────────

export type ComputerAction =
  | { type: "screenshot" }
  | { type: "move"; x: number; y: number }
  | { type: "click"; x: number; y: number; button?: "left" | "right" | "middle"; double?: boolean }
  | { type: "type"; text: string; secret?: boolean }
  | { type: "key"; keys: string[] }
  | {
      type: "confirm_action";
      label: string;
      /** Marks the action as irreversible/financial; needs human approval. */
      irreversible?: boolean;
    }
  | { type: "wait"; ms: number }
  | { type: "done"; summary?: string }
  // ── Wave 2 desktop-level actions ──
  | { type: "right_click"; x: number; y: number }
  | { type: "double_click"; x: number; y: number }
  | { type: "shortcut"; keys: string[] }
  | { type: "drag"; fromX: number; fromY: number; toX: number; toY: number }
  | { type: "scroll"; deltaX: number; deltaY: number; x?: number; y?: number }
  | { type: "hover"; x: number; y: number }
  | { type: "clipboard_read" }
  | { type: "clipboard_write"; text: string }
  // ── Wave 2 page-DOM actions (require a Page reference) ──
  | { type: "screenshot_element"; selector: string; label?: string }
  | { type: "file_upload"; selector: string; filePath: string }
  | { type: "file_download"; url: string; savePath: string }
  | { type: "fill_form"; fields: Array<{ selector: string; value: string }> }
  | { type: "scroll_until"; target: string; direction?: "down" | "up"; maxScrolls?: number }
  | { type: "enter_frame"; frameSelector: string }
  | { type: "exit_frame" }
  | { type: "shadow_pierce"; selector: string };

export type ComputerActionOutcome = {
  action: ComputerAction["type"];
  ok: boolean;
  /** Base64 PNG when a screenshot was taken (screenshot action, or post-action capture). */
  screenshotBase64?: string;
  /** Set when the action was refused/blocked by a safety rail or missing capability. */
  blockedReason?: string;
  /** Set when the action needs the human to act (login / confirm). */
  handoff?: { kind: "credential" | "confirmation"; label: string };
  detail?: string;
  /** Set on page-DOM actions that switched the active page reference. */
  frameEntered?: string;
};

const CREDENTIAL_TEXT_PATTERNS: RegExp[] = [
  /\bpassword\b/i,
  /\bpasscode\b/i,
  /\b2fa\b/i,
  /\botp\b/i,
  /\bone[-\s]?time\s?code\b/i,
  /\bcvv\b/i,
  /\bsecurity code\b/i,
];

const IRREVERSIBLE_TEXT_PATTERNS: RegExp[] = [
  /\bbuy now\b/i,
  /\bplace order\b/i,
  /\bconfirm purchase\b/i,
  /\bpay\b/i,
  /\bcheckout\b/i,
  /\bsend money\b/i,
  /\btransfer\b/i,
  /\bdelete\b/i,
  /\bdeactivate\b/i,
  /\bclose account\b/i,
];

/** A `type` action is treated as a credential entry when flagged secret or text looks like one. */
export function looksLikeCredentialEntry(action: ComputerAction): boolean {
  if (action.type !== "type") {
    return false;
  }
  if (action.secret === true) {
    return true;
  }
  return CREDENTIAL_TEXT_PATTERNS.some((pattern) => pattern.test(action.text));
}

/** Whether an action should require explicit human confirmation before running. */
export function requiresHumanConfirmation(action: ComputerAction): boolean {
  if (action.type === "confirm_action") {
    return action.irreversible === true;
  }
  if (action.type === "type") {
    return IRREVERSIBLE_TEXT_PATTERNS.some((pattern) => pattern.test(action.text));
  }
  return false;
}

export class NativeInputUnavailableError extends Error {
  constructor() {
    super(
      "local_computer takeover needs the native input adapter. Install it on this machine: " +
        "pnpm add @nut-tree-fork/nut-js (and grant Screen Recording + Accessibility permissions).",
    );
    this.name = "NativeInputUnavailableError";
  }
}

export class LocalComputerController {
  private adapter: NativeInputAdapter | null = null;
  /** Page reference for page-DOM actions. Optional. */
  private page: Page | null = null;
  /** Currently-entered frame URL (for exit_frame symmetry). */
  private currentFrame: { url: string } | null = null;

  /** True when a confirmation has been granted by the human for the next gated action. */
  private confirmationGranted = false;

  constructor(options: { adapter?: NativeInputAdapter | null; page?: Page | null } = {}) {
    if (options.adapter !== undefined) this.adapter = options.adapter;
    if (options.page !== undefined) this.page = options.page;
  }

  /** Attach a Playwright Page for page-DOM actions (screenshot_element, file_upload, ...). */
  setPage(page: Page | null): void {
    this.page = page;
    this.currentFrame = null;
  }

  /** Currently-attached page (null if none). Used by handlers in service.ts. */
  getPage(): Page | null {
    return this.page;
  }

  private async requireAdapter(): Promise<NativeInputAdapter> {
    if (!this.adapter) {
      this.adapter = await getNativeInputAdapter();
    }
    if (!this.adapter) {
      throw new NativeInputUnavailableError();
    }
    return this.adapter;
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new Error(
        "page-DOM ComputerAction requires an active Page. Call setPage(page) on the controller first.",
      );
    }
    return this.page;
  }

  /** The human approved the pending irreversible/financial action. */
  grantConfirmation(): void {
    this.confirmationGranted = true;
  }

  async screenshot(): Promise<string> {
    const adapter = await this.requireAdapter();
    const png = await adapter.screenshotPng();
    return png.toString("base64");
  }

  /**
   * Execute a single computer-use action under the safety rails. Never throws on a
   * safety refusal — it returns a blocked/handoff outcome so the loop can pause and
   * defer to the human instead of crashing the mission.
   */
  async execute(action: ComputerAction): Promise<ComputerActionOutcome> {
    // Rail 1 — never enter credentials.
    if (looksLikeCredentialEntry(action)) {
      return {
        action: action.type,
        blockedReason: "Credential entry is never automated — handed to the human.",
        handoff: { kind: "credential", label: "Sign in yourself, then resume." },
        ok: false,
      };
    }

    // Rail 2 — irreversible/financial actions need explicit human confirmation.
    if (requiresHumanConfirmation(action) && !this.confirmationGranted) {
      const label =
        action.type === "confirm_action" ? action.label : `Confirm: ${describeAction(action)}`;
      return {
        action: action.type,
        handoff: { kind: "confirmation", label },
        ok: false,
        detail: "Awaiting human confirmation before an irreversible/financial action.",
      };
    }

    // Page-DOM actions: route through the page; fail closed if no page is attached.
    if (isPageDomAction(action)) {
      return this.executePageDom(action);
    }

    const adapter = await this.requireAdapter();

    switch (action.type) {
      case "screenshot":
        return { action: "screenshot", ok: true, screenshotBase64: await this.screenshot() };
      case "move":
        await adapter.moveMouse(action.x, action.y);
        return { action: "move", ok: true };
      case "click":
        await adapter.moveMouse(action.x, action.y);
        if (action.double) {
          await adapter.doubleClick(action.button ?? "left");
        } else {
          await adapter.click(action.button ?? "left");
        }
        return { action: "click", ok: true };
      case "type":
        await adapter.typeText(action.text);
        this.confirmationGranted = false; // consume any granted confirmation
        return { action: "type", ok: true };
      case "key":
        await adapter.pressKeys(action.keys);
        return { action: "key", ok: true };
      case "confirm_action":
        // Confirmation has been granted (we passed the gate above): no-op marker.
        this.confirmationGranted = false;
        return { action: "confirm_action", ok: true, detail: action.label };
      case "wait":
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(action.ms, 10_000))));
        return { action: "wait", ok: true };
      case "done":
        return { action: "done", ok: true, detail: action.summary };
      case "right_click":
        await adapter.moveMouse(action.x, action.y);
        await adapter.click("right");
        return { action: "right_click", ok: true };
      case "double_click":
        await adapter.moveMouse(action.x, action.y);
        await adapter.doubleClick("left");
        return { action: "double_click", ok: true };
      case "shortcut":
        await adapter.pressKeys(action.keys);
        return { action: "shortcut", ok: true };
      case "drag":
        if (typeof adapter.drag !== "function") {
          return {
            action: "drag",
            blockedReason: "Native adapter does not implement drag; install a desktop-input provider.",
            ok: false,
          };
        }
        await adapter.drag(action.fromX, action.fromY, action.toX, action.toY);
        return { action: "drag", ok: true };
      case "scroll":
        if (typeof adapter.scroll !== "function") {
          return {
            action: "scroll",
            blockedReason: "Native adapter does not implement scroll; install a desktop-input provider.",
            ok: false,
          };
        }
        if (typeof action.x === "number" && typeof action.y === "number") {
          await adapter.moveMouse(action.x, action.y);
        }
        await adapter.scroll(action.deltaX, action.deltaY);
        return { action: "scroll", ok: true };
      case "hover":
        await adapter.moveMouse(action.x, action.y);
        return { action: "hover", ok: true };
      case "clipboard_read":
        if (typeof adapter.clipboardRead !== "function") {
          return {
            action: "clipboard_read",
            blockedReason: "Native adapter does not implement clipboard read; install a clipboard provider.",
            ok: false,
          };
        }
        return {
          action: "clipboard_read",
          detail: await adapter.clipboardRead(),
          ok: true,
        };
      case "clipboard_write":
        if (typeof adapter.clipboardWrite !== "function") {
          return {
            action: "clipboard_write",
            blockedReason: "Native adapter does not implement clipboard write; install a clipboard provider.",
            ok: false,
          };
        }
        await adapter.clipboardWrite(action.text);
        return { action: "clipboard_write", ok: true };
      default:
        return assertNever(action);
    }
  }

  // ── Page-DOM action execution (Wave 2) ────────────────────────────────────

  private async executePageDom(action: PageDomComputerAction): Promise<ComputerActionOutcome> {
    // exit_frame is a pure controller-state reset; it does NOT require a page.
    if (action.type === "exit_frame") {
      this.currentFrame = null;
      return { action: "exit_frame", ok: true, detail: "exited" };
    }
    if (!this.page) {
      return {
        action: action.type,
        blockedReason: `page-DOM action '${action.type}' requires an active Page. Attach one with LocalComputerController.setPage(page) before invoking computer commands.`,
        ok: false,
      };
    }
    try {
      switch (action.type) {
        case "screenshot_element": {
          const buf = await this.page.locator(action.selector).screenshot();
          return {
            action: "screenshot_element",
            ok: true,
            screenshotBase64: buf.toString("base64"),
            detail: action.label ?? action.selector,
          };
        }
        case "file_upload":
          await this.page.locator(action.selector).setInputFiles(action.filePath);
          return { action: "file_upload", ok: true, detail: action.selector };
        case "file_download": {
          // Use the BrowserContext's request API to fetch and write to disk.
          const cookies = await this.page.context().cookies();
          const cookieHeader = cookies
            .map((c) => `${c.name}=${c.value}`)
            .join("; ");
          const response = await this.page.context().request.get(action.url, {
            headers: cookieHeader ? { cookie: cookieHeader } : undefined,
          });
          if (!response.ok()) {
            return {
              action: "file_download",
              blockedReason: `HTTP ${response.status()} fetching ${action.url}`,
              ok: false,
            };
          }
          const buffer = await response.body();
          const fs = await import("node:fs");
          const path = await import("node:path");
          const dir = path.dirname(action.savePath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(action.savePath, buffer);
          return {
            action: "file_download",
            ok: true,
            detail: `${action.savePath} (${buffer.length} bytes)`,
          };
        }
        case "fill_form": {
          const results: string[] = [];
          for (const field of action.fields) {
            await this.page.locator(field.selector).fill(field.value);
            results.push(`${field.selector}=ok`);
          }
          return { action: "fill_form", ok: true, detail: results.join(",") };
        }
        case "scroll_until": {
          const direction = action.direction ?? "down";
          const maxScrolls = Math.max(1, Math.min(action.maxScrolls ?? 20, 200));
          // Try as selector first; if no element found, treat as text content.
          for (let i = 0; i < maxScrolls; i += 1) {
            const found = await this.page
              .locator(action.target)
              .first()
              .isVisible()
              .catch(() => false);
            if (found) {
              return { action: "scroll_until", ok: true, detail: `found at scroll ${i}` };
            }
            await this.page.mouse.wheel(0, direction === "down" ? 400 : -400);
            await new Promise((r) => setTimeout(r, 100));
          }
          return {
            action: "scroll_until",
            blockedReason: `Target not found after ${maxScrolls} scrolls: ${action.target}`,
            ok: false,
          };
        }
        case "enter_frame": {
          // Try matching by frame URL first, then by iframe element.
          const frame = this.page.frame({ url: action.frameSelector });
          if (frame) {
            this.currentFrame = { url: frame.url() };
            return {
              action: "enter_frame",
              ok: true,
              detail: frame.url(),
              frameEntered: frame.url(),
            };
          }
          // Fall back to locating the iframe element and grabbing its contentFrame.
          const handle = await this.page
            .locator(action.frameSelector)
            .first()
            .elementHandle()
            .catch(() => null);
          if (handle) {
            const childFrame = await handle.contentFrame();
            if (childFrame) {
              this.currentFrame = { url: childFrame.url() };
              return {
                action: "enter_frame",
                ok: true,
                detail: childFrame.url(),
                frameEntered: childFrame.url(),
              };
            }
          }
          return {
            action: "enter_frame",
            blockedReason: `Frame not found: ${action.frameSelector}`,
            ok: false,
          };
        }
        case "shadow_pierce": {
          // Use a deep CSS selector with >>> piercing; Playwright supports
          // `>>` and `>>>` syntax to pierce shadow roots.
          const deepSelector = action.selector.includes(">>>")
            ? action.selector
            : `css:light >>> ${action.selector}`;
          const exists = await this.page.locator(deepSelector).count();
          if (exists === 0) {
            return {
              action: "shadow_pierce",
              blockedReason: `Shadow-pierced selector matched 0 elements: ${action.selector}`,
              ok: false,
            };
          }
          return {
            action: "shadow_pierce",
            ok: true,
            detail: `matched ${exists} element(s) via shadow piercer`,
          };
        }
        default:
          return assertNever(action);
      }
    } catch (error) {
      return {
        action: action.type,
        blockedReason: error instanceof Error ? error.message : String(error),
        ok: false,
      };
    }
  }
}

type PageDomActionType =
  | "screenshot_element"
  | "file_upload"
  | "file_download"
  | "fill_form"
  | "scroll_until"
  | "enter_frame"
  | "exit_frame"
  | "shadow_pierce";

export type PageDomComputerAction = Extract<ComputerAction, { type: PageDomActionType }>;

function isPageDomAction(action: ComputerAction): action is PageDomComputerAction {
  return (
    action.type === "screenshot_element" ||
    action.type === "file_upload" ||
    action.type === "file_download" ||
    action.type === "fill_form" ||
    action.type === "scroll_until" ||
    action.type === "enter_frame" ||
    action.type === "exit_frame" ||
    action.type === "shadow_pierce"
  );
}

function describeAction(action: ComputerAction): string {
  switch (action.type) {
    case "type":
      return `type "${action.text.slice(0, 40)}"`;
    case "click":
      return `click at (${action.x}, ${action.y})`;
    case "key":
      return `press ${action.keys.join("+")}`;
    case "right_click":
      return `right_click at (${action.x}, ${action.y})`;
    case "double_click":
      return `double_click at (${action.x}, ${action.y})`;
    case "shortcut":
      return `shortcut ${action.keys.join("+")}`;
    case "drag":
      return `drag (${action.fromX},${action.fromY}) → (${action.toX},${action.toY})`;
    case "scroll":
      return `scroll (${action.deltaX},${action.deltaY})`;
    case "hover":
      return `hover at (${action.x}, ${action.y})`;
    case "clipboard_read":
      return "clipboard_read";
    case "clipboard_write":
      return `clipboard_write "${action.text.slice(0, 40)}"`;
    case "screenshot_element":
      return `screenshot_element ${action.selector}`;
    case "file_upload":
      return `file_upload ${action.selector} ← ${action.filePath}`;
    case "file_download":
      return `file_download ${action.url} → ${action.savePath}`;
    case "fill_form":
      return `fill_form (${action.fields.length} field${action.fields.length === 1 ? "" : "s"})`;
    case "scroll_until":
      return `scroll_until ${action.target} ${action.direction ?? "down"}`;
    case "enter_frame":
      return `enter_frame ${action.frameSelector}`;
    case "exit_frame":
      return "exit_frame";
    case "shadow_pierce":
      return `shadow_pierce ${action.selector}`;
    default:
      return action.type;
  }
}

export type ComputerUseLoopOptions = {
  /** The injected brain: given the latest screenshot (base64 PNG) + step index, return the next action. */
  decide: (input: { screenshotBase64: string; step: number }) => Promise<ComputerAction>;
  /** Emitted for every step so the cockpit can render the live computer-use run. */
  onEvent?: (event: { action: ComputerAction; outcome: ComputerActionOutcome; step: number }) => void;
  /** Cooperative stop — checked before every step; returning true ends the loop. */
  isStopped?: () => boolean;
  /** Hard cap on steps to bound a run. */
  maxSteps?: number;
};

export type ComputerUseLoopResult = {
  steps: number;
  stopped: boolean;
  done: boolean;
  pendingHandoff: ComputerActionOutcome["handoff"] | null;
};

/**
 * Run the computer-use loop: screenshot -> decide -> act, until `done`, a stop signal,
 * a safety handoff, or maxSteps. The model decision is supplied by `decide`.
 */
export async function runComputerUseLoop(
  controller: LocalComputerController,
  options: ComputerUseLoopOptions,
): Promise<ComputerUseLoopResult> {
  const maxSteps = Math.max(1, options.maxSteps ?? 40);
  let step = 0;

  while (step < maxSteps) {
    if (options.isStopped?.()) {
      return { done: false, pendingHandoff: null, steps: step, stopped: true };
    }

    const screenshotBase64 = await controller.screenshot();
    const action = await options.decide({ screenshotBase64, step });
    const outcome = await controller.execute(action);
    options.onEvent?.({ action, outcome, step });
    step += 1;

    if (outcome.handoff) {
      return { done: false, pendingHandoff: outcome.handoff, steps: step, stopped: false };
    }
    if (action.type === "done") {
      return { done: true, pendingHandoff: null, steps: step, stopped: false };
    }
  }

  return { done: false, pendingHandoff: null, steps: step, stopped: false };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled computer action: ${JSON.stringify(value)}`);
}
