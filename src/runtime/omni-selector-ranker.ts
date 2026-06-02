/**
 * omni-selector-ranker.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * P1 Browser Action Power — Target Candidate Ranking + Click Confidence Scoring
 *
 * Design rules:
 *  - Prefer resilient Playwright semantic locators over brittle CSS/XPath.
 *  - Never blindly click a low-confidence target — trigger fallback or handoff.
 *  - Modal detection: if a modal is active, only consider modal-contained targets.
 *  - Iframe detection: detect frame context before acting; emit frameContext metadata only.
 *  - Type verification: verify input value changed; never log secret/password values.
 *  - Screenshot fallback: proof capture only (artifactId emitted, no base64 in events).
 *  - No vision/model calls — screenshot fallback is proof-only.
 *  - No credential capture, no CAPTCHA solving.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import type { Page, Frame } from "playwright";
import { sanitizeProtectedRuntimeText } from "../security/trade-secret-guard.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum confidence score (0–1) required to proceed with a click without fallback. */
export const MIN_CLICK_CONFIDENCE = 0.5;

/** Maximum candidates to evaluate per ranking pass. */
const MAX_CANDIDATES = 20;

// ── Types ─────────────────────────────────────────────────────────────────────

export type TargetCandidate = {
  /** Playwright locator string (role/label/placeholder/text/css). */
  locator: string;
  /** Locator strategy used. */
  strategy: "role" | "label" | "placeholder" | "text" | "css" | "xpath";
  /** Accessible name or visible text of the candidate. */
  accessibleName: string;
  /** Semantic role of the candidate. */
  role: string;
  /** Confidence score 0–1 based on visibility, uniqueness, semantic match. */
  confidence: number;
  /** Whether the candidate is inside an active modal. */
  inModal: boolean;
  /** Frame context if the candidate is inside an iframe (null = main frame). */
  frameContext: FrameContext | null;
  /** Whether the candidate is visible and enabled. */
  visible: boolean;
  /** Whether the candidate is covered by another element. */
  covered: boolean;
  /** Whether the candidate is disabled. */
  disabled: boolean;
  /** Risk classification for this click target. */
  clickRisk: "safe" | "moderate" | "destructive";
};

export type FrameContext = {
  /** Frame index in the page (0 = main). */
  frameIndex: number;
  /** Frame URL (safe — no sensitive content). */
  frameUrl: string;
  /** Frame title if available. */
  frameTitle: string;
};

export type RankingResult = {
  /** The best candidate found, or null if none qualify. */
  best: TargetCandidate | null;
  /** All candidates evaluated (for cockpit display). */
  candidates: TargetCandidate[];
  /** Whether a modal was active during ranking. */
  modalActive: boolean;
  /** Whether ranking was performed inside an iframe. */
  iframeContext: FrameContext | null;
  /** Total candidates found before filtering. */
  totalFound: number;
};

export type TypeVerificationResult = {
  /** Whether the typed value was accepted. */
  accepted: boolean;
  /** Whether the field was visible and enabled. */
  fieldReady: boolean;
  /** Whether form validation rejected the value. */
  validationError: boolean;
  /** Human-readable reason. */
  reason: string;
};

export type ModalState = {
  /** Whether a modal/dialog/popover is currently active. */
  active: boolean;
  /** Semantic type of the modal if detected. */
  kind: "dialog" | "alert" | "popover" | "sheet" | "unknown" | null;
  /** Whether the modal has a close/cancel button. */
  hasClose: boolean;
  /** Whether the modal has a confirm/continue button. */
  hasConfirm: boolean;
};

// ── Modal Detection ───────────────────────────────────────────────────────────

/**
 * Detect whether a modal/dialog/popover is currently active on the page.
 * Uses AX roles and common CSS patterns — no raw DOM exposure.
 */
export async function detectModalState(page: Page): Promise<ModalState> {
  try {
    const result = await page.evaluate((): {
      active: boolean;
      kind: "dialog" | "alert" | "popover" | "sheet" | "unknown" | null;
      hasClose: boolean;
      hasConfirm: boolean;
    } => {
      // Check ARIA dialog/alert roles
      const dialogs = document.querySelectorAll('[role="dialog"],[role="alertdialog"]');
      const visibleDialog = Array.from(dialogs).find((el) => {
        const rect = (el as HTMLElement).getBoundingClientRect();
        const style = window.getComputedStyle(el as HTMLElement);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0"
        );
      });

      if (!visibleDialog) {
        // Fallback: check for common modal CSS patterns
        const modalSelectors = [
          '[class*="modal"][class*="open"]',
          '[class*="modal"][class*="show"]',
          '[class*="dialog"][class*="open"]',
          '[data-modal="true"]',
          '[aria-modal="true"]',
        ];
        const cssModal = modalSelectors
          .flatMap((s) => Array.from(document.querySelectorAll(s)))
          .find((el) => {
            const rect = (el as HTMLElement).getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });

        if (!cssModal) return { active: false, kind: null, hasClose: false, hasConfirm: false };

        return {
          active: true,
          kind: "unknown",
          hasClose: !!cssModal.querySelector('button[aria-label*="close" i],button[aria-label*="cancel" i]'),
          hasConfirm: !!cssModal.querySelector('button[aria-label*="confirm" i],button[aria-label*="continue" i],button[aria-label*="ok" i]'),
        };
      }

      const role = visibleDialog.getAttribute("role");
      const kind: "dialog" | "alert" | "unknown" =
        role === "alertdialog" ? "alert" : role === "dialog" ? "dialog" : "unknown";

      const closeBtn = visibleDialog.querySelector(
        'button[aria-label*="close" i],button[aria-label*="cancel" i],[data-dismiss],[data-close]',
      );
      const confirmBtn = visibleDialog.querySelector(
        'button[aria-label*="confirm" i],button[aria-label*="continue" i],button[aria-label*="ok" i],button[type="submit"]',
      );

      return {
        active: true,
        kind,
        hasClose: !!closeBtn,
        hasConfirm: !!confirmBtn,
      };
    });

    return result;
  } catch {
    return { active: false, kind: null, hasClose: false, hasConfirm: false };
  }
}

// ── Iframe Detection ──────────────────────────────────────────────────────────

/**
 * Detect iframe contexts on the page.
 * Returns safe metadata only — no raw frame DOM.
 */
export async function detectIframeContexts(page: Page): Promise<FrameContext[]> {
  const frames = page.frames();
  const contexts: FrameContext[] = [];

  for (let i = 0; i < Math.min(frames.length, 10); i++) {
    const frame = frames[i];
    if (frame === page.mainFrame()) continue;
    try {
      const url = sanitizeProtectedRuntimeText(frame.url().slice(0, 200));
      const title = sanitizeProtectedRuntimeText(
        await frame.title().catch(() => ""),
      ).slice(0, 80);
      contexts.push({ frameIndex: i, frameUrl: url, frameTitle: title });
    } catch {
      // Frame may have been detached
    }
  }

  return contexts;
}

// ── Candidate Extraction ──────────────────────────────────────────────────────

/**
 * Extract interactive candidates from the page (or a specific frame).
 * Uses AX snapshot + DOM query for semantic richness.
 * Returns raw candidate data for scoring.
 */
async function extractCandidates(
  page: Page,
  intent: string,
  frame: Frame | null,
): Promise<Array<{ locator: string; strategy: TargetCandidate["strategy"]; role: string; name: string }>> {
  const target = frame ?? page;
  const candidates: Array<{ locator: string; strategy: TargetCandidate["strategy"]; role: string; name: string }> = [];

  try {
    // Strategy 1: AX snapshot — most reliable semantic source
    // Playwright's accessibility.snapshot is available on the page object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snapshot = await ((page as any).accessibility?.snapshot?.() ?? Promise.resolve(null)).catch(() => null);
    if (snapshot) {
      const walk = (
        node: { role?: string; name?: string; children?: unknown[] },
        depth: number,
      ): void => {
        if (depth > 6) return;
        const role = node.role ?? "";
        const name = (node.name ?? "").trim();
        const interactiveRoles = new Set([
          "button", "link", "textbox", "searchbox", "combobox",
          "checkbox", "radio", "menuitem", "tab", "option",
        ]);
        if (interactiveRoles.has(role) && name) {
          // Build a resilient locator
          if (role === "button" || role === "link" || role === "menuitem" || role === "tab") {
            candidates.push({
              locator: `[role="${role}"][aria-label="${name.slice(0, 80)}"]`,
              strategy: "role",
              role,
              name,
            });
          } else if (role === "textbox" || role === "searchbox" || role === "combobox") {
            candidates.push({
              locator: `[aria-label="${name.slice(0, 80)}"]`,
              strategy: "label",
              role,
              name,
            });
          } else {
            candidates.push({
              locator: `[role="${role}"]`,
              strategy: "role",
              role,
              name,
            });
          }
        }
        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            walk(child as { role?: string; name?: string; children?: unknown[] }, depth + 1);
          }
        }
      };
      walk(snapshot, 0);
    }
  } catch {
    // AX snapshot failed — fall through to DOM query
  }

  try {
    // Strategy 2: DOM query for inputs with placeholders and labels
    const domCandidates = await (target as Frame).evaluate((intentText: string) => {
      const results: Array<{ locator: string; strategy: string; role: string; name: string }> = [];
      const inputs = document.querySelectorAll(
        'input:not([type="hidden"]):not([type="password"]),textarea,select,button,[role="button"],[role="link"],[role="tab"]',
      );
      inputs.forEach((el) => {
        const htmlEl = el as HTMLElement;
        const rect = htmlEl.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;

        const placeholder = (el as HTMLInputElement).placeholder?.trim().slice(0, 80);
        const ariaLabel = el.getAttribute("aria-label")?.trim().slice(0, 80);
        const labelEl = el.id
          ? document.querySelector(`label[for="${el.id}"]`)
          : null;
        const labelText = labelEl?.textContent?.trim().slice(0, 80);
        const buttonText = htmlEl.textContent?.trim().slice(0, 80);
        const tagName = el.tagName.toLowerCase();
        const role = el.getAttribute("role") ?? tagName;

        const name = ariaLabel ?? labelText ?? placeholder ?? buttonText ?? "";
        if (!name) return;

        // Score relevance to intent (simple keyword match)
        const intentLower = intentText.toLowerCase();
        const nameLower = name.toLowerCase();
        const relevant = intentLower.split(/\s+/).some((word) => nameLower.includes(word));
        if (!relevant && results.length > 10) return;

        if (placeholder) {
          results.push({ locator: `[placeholder="${placeholder}"]`, strategy: "placeholder", role, name });
        } else if (ariaLabel) {
          results.push({ locator: `[aria-label="${ariaLabel}"]`, strategy: "label", role, name });
        } else if (buttonText && (tagName === "button" || role === "button")) {
          results.push({ locator: `button:has-text("${buttonText.slice(0, 40)}")`, strategy: "text", role, name });
        }
      });
      return results.slice(0, 20);
    }, intent).catch(() => []);

    for (const c of domCandidates) {
      candidates.push({
        locator: c.locator,
        strategy: c.strategy as TargetCandidate["strategy"],
        role: c.role,
        name: c.name,
      });
    }
  } catch {
    // DOM query failed
  }

  // Deduplicate by locator
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.locator)) return false;
    seen.add(c.locator);
    return true;
  }).slice(0, MAX_CANDIDATES);
}

// ── Confidence Scoring ────────────────────────────────────────────────────────

/**
 * Score a single candidate for click confidence.
 * Returns a score 0–1 and visibility/state flags.
 */
async function scoreCandidate(
  page: Page,
  candidate: { locator: string; strategy: TargetCandidate["strategy"]; role: string; name: string },
  modalActive: boolean,
  intent: string,
): Promise<{ visible: boolean; covered: boolean; disabled: boolean; confidence: number; inModal: boolean; clickRisk: TargetCandidate["clickRisk"] }> {
  try {
    const result = await page.evaluate(
      ({ locator, intentText }: { locator: string; intentText: string }) => {
        let el: Element | null = null;
        try {
          el = document.querySelector(locator);
        } catch {
          return { visible: false, covered: false, disabled: false, inModal: false, uniqueMatch: false, semanticMatch: 0 };
        }
        if (!el) return { visible: false, covered: false, disabled: false, inModal: false, uniqueMatch: false, semanticMatch: 0 };

        const htmlEl = el as HTMLElement;
        const rect = htmlEl.getBoundingClientRect();
        const style = window.getComputedStyle(htmlEl);

        const visible =
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          rect.top < window.innerHeight &&
          rect.bottom > 0;

        const disabled =
          (htmlEl as HTMLButtonElement).disabled === true ||
          htmlEl.getAttribute("aria-disabled") === "true" ||
          htmlEl.getAttribute("disabled") !== null;

        // Check if covered by another element at the center point
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const topEl = document.elementFromPoint(centerX, centerY);
        const covered = topEl !== null && topEl !== el && !el.contains(topEl);

        // Check if inside a modal
        const inModal = !!el.closest('[role="dialog"],[role="alertdialog"],[aria-modal="true"]');

        // Uniqueness: how many elements match this locator
        let matchCount = 0;
        try {
          matchCount = document.querySelectorAll(locator).length;
        } catch {
          matchCount = 1;
        }
        const uniqueMatch = matchCount === 1;

        // Semantic match: does the element name contain intent keywords?
        const name = (
          el.getAttribute("aria-label") ??
          (el as HTMLInputElement).placeholder ??
          htmlEl.textContent ??
          ""
        ).toLowerCase();
        const intentWords = intentText.toLowerCase().split(/\s+/);
        const matchedWords = intentWords.filter((w) => w.length > 2 && name.includes(w));
        const semanticMatch = intentWords.length > 0 ? matchedWords.length / intentWords.length : 0;

        return { visible, covered, disabled, inModal, uniqueMatch, semanticMatch };
      },
      { locator: candidate.locator, intentText: intent },
    ).catch(() => ({
      visible: false, covered: false, disabled: false, inModal: false, uniqueMatch: false, semanticMatch: 0,
    }));

    // Compute confidence score
    let score = 0;
    if (result.visible) score += 0.3;
    if (!result.disabled) score += 0.2;
    if (!result.covered) score += 0.15;
    if (result.uniqueMatch) score += 0.2;
    score += (result.semanticMatch as number) * 0.15;

    // Modal penalty: if modal is active and candidate is NOT in modal, penalize heavily
    if (modalActive && !result.inModal) score *= 0.1;

    // Strategy bonus
    if (candidate.strategy === "role" || candidate.strategy === "label") score = Math.min(score + 0.05, 1.0);

    // Click risk classification
    const destructiveKeywords = ["delete", "remove", "cancel", "logout", "sign out", "deactivate"];
    const nameLower = candidate.name.toLowerCase();
    const clickRisk: TargetCandidate["clickRisk"] = destructiveKeywords.some((k) => nameLower.includes(k))
      ? "destructive"
      : score < 0.4
        ? "moderate"
        : "safe";

    return {
      visible: result.visible,
      covered: result.covered,
      disabled: result.disabled,
      inModal: result.inModal,
      confidence: Math.round(score * 100) / 100,
      clickRisk,
    };
  } catch {
    return { visible: false, covered: false, disabled: false, inModal: false, confidence: 0, clickRisk: "moderate" };
  }
}

// ── Main Ranking Function ─────────────────────────────────────────────────────

/**
 * Rank target candidates for a given intent on the page.
 *
 * Returns the best candidate and all evaluated candidates.
 * If a modal is active, only modal-contained candidates qualify.
 * If no candidate meets MIN_CLICK_CONFIDENCE, best is null → caller should
 * trigger screenshot fallback or handoff.
 */
export async function rankTargetCandidates(
  page: Page,
  intent: string,
  preferredSelector?: string,
): Promise<RankingResult> {
  const modalState = await detectModalState(page);
  const iframeContexts = await detectIframeContexts(page);
  const iframeContext = iframeContexts.length > 0 ? iframeContexts[0] : null;

  // Determine which frame to search
  let searchFrame: Frame | null = null;
  if (iframeContext) {
    const frames = page.frames();
    searchFrame = frames[iframeContext.frameIndex] ?? null;
  }

  // If a preferred selector is provided, build it as the first candidate
  const rawCandidates = await extractCandidates(page, intent, searchFrame);

  if (preferredSelector) {
    rawCandidates.unshift({
      locator: preferredSelector,
      strategy: "css",
      role: "unknown",
      name: preferredSelector.slice(0, 80),
    });
  }

  // Score all candidates
  const scored: TargetCandidate[] = [];
  for (const raw of rawCandidates) {
    const score = await scoreCandidate(page, raw, modalState.active, intent);
    scored.push({
      locator: sanitizeProtectedRuntimeText(raw.locator),
      strategy: raw.strategy,
      accessibleName: sanitizeProtectedRuntimeText(raw.name),
      role: raw.role,
      confidence: score.confidence,
      inModal: score.inModal,
      frameContext: searchFrame ? iframeContext : null,
      visible: score.visible,
      covered: score.covered,
      disabled: score.disabled,
      clickRisk: score.clickRisk,
    });
  }

  // Sort by confidence descending
  scored.sort((a, b) => b.confidence - a.confidence);

  // Best candidate must meet minimum confidence
  const best = scored.find((c) => c.confidence >= MIN_CLICK_CONFIDENCE && c.visible && !c.disabled) ?? null;

  return {
    best,
    candidates: scored.slice(0, 10), // return top 10 for cockpit display
    modalActive: modalState.active,
    iframeContext,
    totalFound: rawCandidates.length,
  };
}

// ── Type Verification ─────────────────────────────────────────────────────────

/**
 * Verify that a type action was accepted by the input field.
 * NEVER logs or exposes the typed text if it may be a secret.
 *
 * @param page - The Playwright page.
 * @param selector - The selector that was typed into.
 * @param typedText - The text that was typed (used for value comparison only).
 * @param isSecret - If true, the typed text is never included in the result.
 */
export async function verifyTypeAction(
  page: Page,
  selector: string,
  typedText: string,
  isSecret: boolean,
): Promise<TypeVerificationResult> {
  try {
    const result = await page.evaluate(
      ({ sel, text }: { sel: string; text: string }) => {
        const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement | null;
        if (!el) return { fieldReady: false, accepted: false, validationError: false, reason: "Element not found" };

        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        const visible = rect.width > 0 && rect.height > 0 && style.display !== "none";
        const disabled = el.disabled || el.getAttribute("aria-disabled") === "true";
        const readOnly = (el as HTMLInputElement).readOnly;

        if (!visible) return { fieldReady: false, accepted: false, validationError: false, reason: "Field not visible" };
        if (disabled) return { fieldReady: false, accepted: false, validationError: false, reason: "Field is disabled" };
        if (readOnly) return { fieldReady: false, accepted: false, validationError: false, reason: "Field is read-only" };

        const currentValue = el.value;
        const accepted = currentValue.includes(text.slice(0, 20));

        // Check for form validation error
        const validationError = !el.validity?.valid && el.validity !== undefined;

        return {
          fieldReady: true,
          accepted,
          validationError,
          reason: accepted
            ? "Input value accepted"
            : validationError
              ? "Form validation rejected value"
              : "Value not reflected in field",
        };
      },
      { sel: selector, text: isSecret ? "" : typedText },
    );

    return result;
  } catch {
    return {
      fieldReady: false,
      accepted: false,
      validationError: false,
      reason: "Type verification threw an exception",
    };
  }
}

// ── Screenshot Fallback ───────────────────────────────────────────────────────

/**
 * Screenshot-only fallback when AX/DOM candidate confidence is insufficient.
 *
 * RULES:
 *  - Captures proof screenshot through the existing artifact pipeline.
 *  - Returns artifactId only — no base64 in events or memory.
 *  - No vision/model calls. No hidden free model calls.
 *  - If captureProof fails, returns null (caller must handle gracefully).
 */
export async function captureScreenshotFallback(
  captureProof: (label: string) => Promise<string | null>,
  label: string,
): Promise<{ artifactId: string | null; reason: string }> {
  try {
    const artifactId = await captureProof(`screenshot-fallback-${label}`);
    return {
      artifactId,
      reason: artifactId
        ? `Screenshot fallback captured — proof artifact: ${artifactId}`
        : "Screenshot fallback attempted but capture failed",
    };
  } catch {
    return { artifactId: null, reason: "Screenshot fallback threw an exception" };
  }
}

// ── Expanded Verification Helpers ─────────────────────────────────────────────

/**
 * Verify that a modal opened or closed after an action.
 * Used for P1 expanded verification of modal interactions.
 */
export async function verifyModalStateChange(
  page: Page,
  expectedState: "open" | "closed",
): Promise<{ pass: boolean; reason: string }> {
  try {
    const modal = await detectModalState(page);
    const isOpen = modal.active;
    const pass = expectedState === "open" ? isOpen : !isOpen;
    return {
      pass,
      reason: pass
        ? `Modal is now ${expectedState} as expected`
        : `Expected modal to be ${expectedState} but it is ${isOpen ? "open" : "closed"}`,
    };
  } catch {
    return { pass: false, reason: "Modal state verification threw an exception" };
  }
}

/**
 * Verify that an iframe interaction succeeded by checking the frame's AX state.
 * Returns a safe result with no raw DOM content.
 */
export async function verifyIframeInteraction(
  page: Page,
  frameContext: FrameContext,
): Promise<{ pass: boolean; reason: string; frameUrl: string }> {
  try {
    const frames = page.frames();
    const frame = frames[frameContext.frameIndex];
    if (!frame) {
      return { pass: false, reason: "Frame not found at expected index", frameUrl: frameContext.frameUrl };
    }
    // Verify the frame is still accessible and has interactive content
    const accessible = await frame.evaluate(() => {
      return document.body ? document.body.children.length > 0 : false;
    }).catch(() => false);

    return {
      pass: accessible,
      reason: accessible
        ? `Iframe at ${frameContext.frameUrl.slice(0, 60)} is accessible after interaction`
        : `Iframe at ${frameContext.frameUrl.slice(0, 60)} is not accessible after interaction`,
      frameUrl: frameContext.frameUrl,
    };
  } catch {
    return { pass: false, reason: "Iframe verification threw an exception", frameUrl: frameContext.frameUrl };
  }
}
