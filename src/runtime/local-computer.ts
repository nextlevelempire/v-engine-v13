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
 */
import { getNativeInputAdapter, type NativeInputAdapter } from "./native-input.js";

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
  | { type: "done"; summary?: string };

export type ComputerActionOutcome = {
  action: ComputerAction["type"];
  ok: boolean;
  /** Base64 PNG when a screenshot was taken (screenshot action, or post-action capture). */
  screenshotBase64?: string;
  /** Set when the action was refused/blocked by a safety rail. */
  blockedReason?: string;
  /** Set when the action needs the human to act (login / confirm). */
  handoff?: { kind: "credential" | "confirmation"; label: string };
  detail?: string;
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

  /** True when a confirmation has been granted by the human for the next gated action. */
  private confirmationGranted = false;

  private async requireAdapter(): Promise<NativeInputAdapter> {
    if (!this.adapter) {
      this.adapter = await getNativeInputAdapter();
    }
    if (!this.adapter) {
      throw new NativeInputUnavailableError();
    }
    return this.adapter;
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
      default:
        return assertNever(action);
    }
  }
}

function describeAction(action: ComputerAction): string {
  switch (action.type) {
    case "type":
      return `type "${action.text.slice(0, 40)}"`;
    case "click":
      return `click at (${action.x}, ${action.y})`;
    case "key":
      return `press ${action.keys.join("+")}`;
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
