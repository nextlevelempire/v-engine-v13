/**
 * omni-verifier.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * P0 Action Verifier — checks that every browser action (click, type, navigate)
 * actually had a measurable effect on the page.
 *
 * Design rules:
 *  - Inconclusive evidence ALWAYS returns pass: false. Never assume success.
 *  - Never embed screenshots or binary data in the result.
 *  - All evidence strings are sanitized before returning.
 *  - Verification is best-effort: if the page crashes, return pass: false.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Page } from "playwright";
import { hashAXTree } from "./omni-ax-observer.js";
import { sanitizeProtectedRuntimeText } from "../security/trade-secret-guard.js";

export type VerificationResult = {
  /** Whether the action produced a measurable effect. */
  pass: boolean;
  /** Human-readable reason for the pass/fail decision. */
  reason: string;
  /** The type of check that determined the result. */
  checkType: "url-changed" | "ax-changed" | "input-value-set" | "network-request" | "inconclusive";
  /** AX tree hash before the action. */
  axHashBefore: string;
  /** AX tree hash after the action. */
  axHashAfter: string;
  /** URL before the action. */
  urlBefore: string;
  /** URL after the action. */
  urlAfter: string;
  /** ISO timestamp of the verification. */
  verifiedAt: string;
};

export type ActionContext = {
  /** The type of action that was executed. */
  actionType: "click" | "type" | "navigate" | "scroll" | "key";
  /** The selector or URL that was targeted. */
  target: string;
  /** For type actions: the text that was typed. */
  typedText?: string;
  /** AX tree hash captured BEFORE the action was executed. */
  axHashBefore: string;
  /** URL captured BEFORE the action was executed. */
  urlBefore: string;
};

/**
 * Verify that a browser action produced a measurable effect.
 * Called immediately after every action in the P0 work loop.
 *
 * @param page - The Playwright page after the action.
 * @param context - Context captured before the action.
 * @returns VerificationResult — pass: false if inconclusive.
 */
export async function verifyAction(
  page: Page,
  context: ActionContext,
): Promise<VerificationResult> {
  const verifiedAt = new Date().toISOString();
  const urlBefore = context.urlBefore;
  let urlAfter = urlBefore;
  let axHashAfter = context.axHashBefore;

  try {
    // Give the page a brief moment to settle after the action.
    await page.waitForTimeout(400);

    urlAfter = sanitizeProtectedRuntimeText(page.url());
    axHashAfter = await hashAXTree(page);
  } catch {
    // Page may have navigated or closed — treat as inconclusive.
    return {
      pass: false,
      reason: "Page state unavailable after action — treating as inconclusive failure.",
      checkType: "inconclusive",
      axHashBefore: context.axHashBefore,
      axHashAfter,
      urlBefore,
      urlAfter,
      verifiedAt,
    };
  }

  // ── Check 1: URL changed (strongest signal for navigate/click actions) ──
  if (urlAfter !== urlBefore) {
    return {
      pass: true,
      reason: `URL changed from ${urlBefore.slice(0, 80)} → ${urlAfter.slice(0, 80)}`,
      checkType: "url-changed",
      axHashBefore: context.axHashBefore,
      axHashAfter,
      urlBefore,
      urlAfter,
      verifiedAt,
    };
  }

  // ── Check 2: For navigate actions, URL must have changed ──
  // If navigate didn't change the URL, it failed.
  if (context.actionType === "navigate") {
    return {
      pass: false,
      reason: `Navigate to ${context.target.slice(0, 80)} did not change the URL — action failed or page blocked.`,
      checkType: "inconclusive",
      axHashBefore: context.axHashBefore,
      axHashAfter,
      urlBefore,
      urlAfter,
      verifiedAt,
    };
  }

  // ── Check 3: AX tree changed (catches DOM mutations from clicks/types) ──
  if (axHashAfter !== context.axHashBefore) {
    return {
      pass: true,
      reason: `AX tree changed after ${context.actionType} on "${context.target.slice(0, 60)}" — DOM reacted.`,
      checkType: "ax-changed",
      axHashBefore: context.axHashBefore,
      axHashAfter,
      urlBefore,
      urlAfter,
      verifiedAt,
    };
  }

  // ── Check 4: For type actions, verify the input value was set ──
  if (context.actionType === "type" && context.typedText) {
    try {
      const inputValue = await page.evaluate((selector: string) => {
        const el = document.querySelector(selector) as HTMLInputElement | null;
        return el ? el.value : null;
      }, context.target);

      if (
        inputValue !== null &&
        inputValue.includes(context.typedText.slice(0, 20))
      ) {
        return {
          pass: true,
          reason: `Input "${context.target.slice(0, 60)}" has expected value after type action.`,
          checkType: "input-value-set",
          axHashBefore: context.axHashBefore,
          axHashAfter,
          urlBefore,
          urlAfter,
          verifiedAt,
        };
      }
    } catch {
      // Selector may not be valid — fall through to inconclusive.
    }
  }

  // ── Check 5: Inconclusive — no evidence of effect ──
  // Per P0 spec: inconclusive ALWAYS returns pass: false.
  // We never assume success without evidence.
  return {
    pass: false,
    reason: `No measurable effect detected after ${context.actionType} on "${context.target.slice(0, 60)}" — URL unchanged, AX tree unchanged.`,
    checkType: "inconclusive",
    axHashBefore: context.axHashBefore,
    axHashAfter,
    urlBefore,
    urlAfter,
    verifiedAt,
  };
}

/**
 * Capture pre-action context — call this BEFORE executing any action.
 * Pass the returned context to verifyAction() after the action completes.
 */
export async function capturePreActionContext(
  page: Page,
  actionType: ActionContext["actionType"],
  target: string,
  typedText?: string,
): Promise<ActionContext> {
  let axHashBefore = "unknown";
  let urlBefore = "";

  try {
    urlBefore = sanitizeProtectedRuntimeText(page.url());
    axHashBefore = await hashAXTree(page);
  } catch {
    // Page may not be ready yet — use safe defaults.
    urlBefore = "";
    axHashBefore = "unknown";
  }

  return {
    actionType,
    axHashBefore,
    target,
    typedText,
    urlBefore,
  };
}
