/**
 * omni-agent-loop.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Autonomous AI agent loop for the V-Engine.
 *
 * When OMNI_LLM_PROVIDER is set and a directive arrives, this loop takes over:
 *   1. Reads the current page state (AX tree + URL + title)
 *   2. Calls the configured LLM with state + objective + scratchpad history
 *   3. Parses ONE action from the LLM response
 *   4. Executes the action via OmniCoreClone
 *   5. Writes THINK → EXECUTE → REFLECT to the cockpit scratchpad
 *   6. Emits SSE events so the cockpit stays live
 *   7. Loops until [TASK_COMPLETE] or MAX_ITERATIONS
 *
 * Supported providers (env OMNI_LLM_PROVIDER):
 *   claude   — Anthropic Messages API (OMNI_LLM_API_KEY required)
 *   openai   — OpenAI Chat Completions API (OMNI_LLM_API_KEY required)
 *   ollama   — Local Ollama (OMNI_LLM_BASE_URL, default http://127.0.0.1:11434)
 *   custom   — Any OpenAI-compatible endpoint (OMNI_LLM_BASE_URL + OMNI_LLM_API_KEY)
 *
 * If OMNI_LLM_PROVIDER is unset, this module is a no-op — directives continue
 * to queue for external orchestration as before (backward-compatible).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { OmniCoreClone } from "./omni-core-clone.js";
import { sanitizeProtectedRuntimeText } from "../security/trade-secret-guard.js";

// ── Config ────────────────────────────────────────────────────────────────────

const PROVIDER = process.env.OMNI_LLM_PROVIDER?.trim().toLowerCase() || "";
const API_KEY = process.env.OMNI_LLM_API_KEY?.trim() || "";
const BASE_URL = process.env.OMNI_LLM_BASE_URL?.trim() || "";
const MODEL = process.env.OMNI_LLM_MODEL?.trim() || defaultModel(PROVIDER);
const MAX_ITERATIONS = Math.min(
  Math.max(Number(process.env.OMNI_AGENT_MAX_ITERATIONS) || 30, 1),
  100,
);

function defaultModel(provider: string): string {
  switch (provider) {
    case "claude": return "claude-sonnet-4-6";
    case "openai": return "gpt-4o";
    case "ollama": return "llama3.2";
    default: return "gpt-4o";
  }
}

/** Returns true when the agent loop is configured and ready to use. */
export function isAgentLoopEnabled(): boolean {
  return Boolean(PROVIDER);
}

// ── Action types the LLM can emit ─────────────────────────────────────────────

type AgentAction =
  | { action: "navigate"; url: string; thinking?: string }
  | { action: "click"; selector: string; thinking?: string }
  | { action: "type"; selector: string; text: string; thinking?: string }
  | { action: "scroll"; direction: "down" | "up"; amount?: number; thinking?: string }
  | { action: "screenshot"; label?: string; thinking?: string }
  | { action: "wait"; ms?: number; thinking?: string }
  | { action: "done"; summary: string; thinking?: string };

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  return [
    "You are an autonomous browser agent running inside the Empire V-Engine.",
    "You control a real browser. Each turn you receive the current page state and must respond with ONE action as strict JSON.",
    "",
    "Available actions:",
    '{ "action": "navigate", "url": "https://..." }',
    '{ "action": "click", "selector": "CSS selector or visible text" }',
    '{ "action": "type", "selector": "CSS selector", "text": "text to type" }',
    '{ "action": "scroll", "direction": "down"|"up", "amount": 300 }',
    '{ "action": "screenshot", "label": "optional label" }',
    '{ "action": "wait", "ms": 1000 }',
    '{ "action": "done", "summary": "what was accomplished" }',
    "",
    "Rules:",
    "- Respond with ONLY the JSON object. No prose, no markdown fences.",
    "- Add an optional `thinking` field to explain your reasoning (it is logged to the cockpit).",
    "- Use `done` when the mission objective is fully complete.",
    "- Prefer CSS selectors for click/type. Fall back to visible text if no CSS selector is clear.",
    "- After navigating, wait 1-2 seconds before interacting (use `wait`).",
    "- If stuck 3 times in a row on the same action, use `done` with a failure summary.",
  ].join("\n");
}

function buildUserPrompt(
  objective: string,
  url: string,
  title: string,
  axTree: string,
  scratchpadHistory: string,
  iteration: number,
): string {
  return [
    `Mission: ${objective}`,
    `Iteration: ${iteration} / ${MAX_ITERATIONS}`,
    "",
    `Current URL: ${url}`,
    `Page title: ${title}`,
    "",
    "Accessibility tree (what is visible on screen):",
    axTree.slice(0, 4000),
    "",
    scratchpadHistory ? `Recent cockpit log:\n${scratchpadHistory}\n` : "",
    "Respond with the next action as strict JSON:",
  ].join("\n");
}

// ── LLM caller ────────────────────────────────────────────────────────────────

type LlmMessage = { role: "system" | "user" | "assistant"; content: string };

async function callLlm(messages: LlmMessage[]): Promise<string> {
  switch (PROVIDER) {
    case "claude":
      return callClaude(messages);
    case "openai":
    case "custom":
      return callOpenAiCompat(messages, BASE_URL || "https://api.openai.com");
    case "ollama":
      return callOpenAiCompat(
        messages,
        (BASE_URL || "http://127.0.0.1:11434") + "/v1",
        API_KEY || "ollama",
      );
    default:
      throw new Error(`Unknown OMNI_LLM_PROVIDER: "${PROVIDER}"`);
  }
}

async function callClaude(messages: LlmMessage[]): Promise<string> {
  const systemMsg = messages.find((m) => m.role === "system")?.content ?? "";
  const userMsgs = messages.filter((m) => m.role !== "system");
  const body = {
    model: MODEL,
    max_tokens: 512,
    system: systemMsg,
    messages: userMsgs.map((m) => ({ role: m.role, content: m.content })),
  };
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Claude API error ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.find((c) => c.type === "text")?.text ?? "";
  return text.trim();
}

async function callOpenAiCompat(
  messages: LlmMessage[],
  baseUrl: string,
  apiKey: string = API_KEY,
): Promise<string> {
  const url = baseUrl.replace(/\/$/, "") + "/chat/completions";
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: 512 }),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`LLM API error ${resp.status}: ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

// ── JSON parser ───────────────────────────────────────────────────────────────

function parseAction(raw: string): AgentAction | null {
  const trimmed = raw.trim();
  // Extract JSON object — handle accidental markdown fences
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    if (typeof parsed.action !== "string") return null;
    return parsed as AgentAction;
  } catch {
    return null;
  }
}

// ── Telemetry emitter type (mirrors what service.ts passes) ───────────────────

export type AgentLoopEmitter = (
  event: string,
  payload: Record<string, unknown>,
) => void;

// ── Main loop ─────────────────────────────────────────────────────────────────

export type AgentLoopInput = {
  core: OmniCoreClone;
  emit: AgentLoopEmitter;
  objective: string;
  sessionId: string;
};

export type AgentLoopResult = {
  iterations: number;
  outcome: "complete" | "max_iterations" | "error";
  summary: string;
};

/**
 * Run the autonomous agent loop. Fire-and-forget from the caller;
 * results are surfaced via SSE events and cockpit scratchpad entries.
 */
export async function runAgentLoop(input: AgentLoopInput): Promise<AgentLoopResult> {
  const { core, emit, objective, sessionId } = input;
  let iterations = 0;
  const conversationHistory: LlmMessage[] = [
    { role: "system", content: buildSystemPrompt() },
  ];
  // Circuit breaker: track last 5 action fingerprints
  const recentActionFingerprints: string[] = [];
  let lastAxTreeHash = "";

  emit("agent.loop.started", {
    sessionId,
    objective: sanitizeProtectedRuntimeText(objective),
    provider: PROVIDER,
    model: MODEL,
    maxIterations: MAX_ITERATIONS,
  });

  await core.appendScratchpadEntry(
    `THINK: Starting autonomous agent loop. Objective: ${objective.slice(0, 200)}`,
  );

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // ── Observe: read current page state ─────────────────────────────────────
    let url = "(no page)";
    let title = "(no page)";
    let axTree = "(no page loaded)";
    try {
      const page = await core.ensurePage().catch(() => null);
      if (page) {
        url = page.url().slice(0, 300);
        title = (await page.title().catch(() => "")).slice(0, 200);
        // Capture AX tree via the existing captureAXObservation helper
        const { captureAXObservation } = await import("./omni-ax-observer.js");
        const obs = await captureAXObservation(page).catch(() => null);
        axTree = obs?.axTree?.slice(0, 4000) ?? "(AX capture failed)";
        // Stall detection
        if (obs?.axTreeHash && obs.axTreeHash !== lastAxTreeHash) {
          lastAxTreeHash = obs.axTreeHash;
        }

        // Auth wall / CAPTCHA detection — pause or auto-consent
        if (obs?.authWallHint || obs?.captchaHint) {
          // OAuth consent auto-click: OMNI_AUTO_CONSENT=1 + "Allow"/"Authorize" visible
          if (!obs.captchaHint && process.env.OMNI_AUTO_CONSENT === "1" && page) {
            const consentSelectors = [
              'button:has-text("Allow")',
              'button:has-text("Authorize")',
              'button:has-text("Accept")',
              'button:has-text("Continue")',
              '[data-action="allow"]',
              'input[value="Allow"]',
              '[id*="submit_approve_access"]',
            ];
            let clicked = false;
            for (const sel of consentSelectors) {
              const count = await page.locator(sel).count().catch(() => 0);
              if (count > 0) {
                await page.locator(sel).first().click({ timeout: 5000 }).catch(() => {});
                await core.appendScratchpadEntry(`EXECUTE: OAuth consent auto-clicked "${sel}".`);
                emit("agent.loop.consent_auto_clicked", { iteration: iterations, selector: sel, sessionId });
                recentActionFingerprints.length = 0; // reset circuit breaker
                clicked = true;
                break;
              }
            }
            if (clicked) continue; // resume loop after consent
          }
          const reason = obs.captchaHint
            ? "CAPTCHA detected — autonomous loop paused for human verification."
            : "Auth wall detected — autonomous loop paused for human login.";
          await core.appendScratchpadEntry(`⏸ ${reason}`);
          emit("agent.loop.paused", { sessionId, reason, iteration: iterations });
          return { iterations, outcome: "complete", summary: reason };
        }
      }
    } catch (obsErr) {
      axTree = `(observation error: ${obsErr instanceof Error ? obsErr.message : String(obsErr)})`;
    }

    // ── Build the scratchpad excerpt for context ──────────────────────────────
    const scratchpadExcerpt = ""; // kept lean; cockpit has full history

    // ── Call LLM ─────────────────────────────────────────────────────────────
    const userMessage = buildUserPrompt(objective, url, title, axTree, scratchpadExcerpt, iterations);
    conversationHistory.push({ role: "user", content: userMessage });

    let rawResponse = "";
    try {
      rawResponse = await callLlm(conversationHistory);
    } catch (llmErr) {
      const errMsg = llmErr instanceof Error ? llmErr.message : String(llmErr);
      await core.appendScratchpadEntry(`REFLECT: LLM call failed — ${errMsg}. Loop aborted.`);
      emit("agent.loop.error", { sessionId, error: errMsg, iteration: iterations });
      return { iterations, outcome: "error", summary: errMsg };
    }

    // Add assistant turn to history (keep last 10 turns to manage context)
    conversationHistory.push({ role: "assistant", content: rawResponse });
    if (conversationHistory.length > 22) {
      // Keep system prompt + last 20 messages
      conversationHistory.splice(1, conversationHistory.length - 21);
    }

    // ── Parse action ─────────────────────────────────────────────────────────
    const action = parseAction(rawResponse);
    if (!action) {
      await core.appendScratchpadEntry(
        `REFLECT: Could not parse action from LLM (iteration ${iterations}). Retrying.`,
      );
      continue;
    }

    // ── Circuit breaker: detect stuck loop ───────────────────────────────────
    const fingerprint = JSON.stringify({ a: action.action, ...(action as Record<string, unknown>) });
    recentActionFingerprints.push(fingerprint);
    if (recentActionFingerprints.length > 5) recentActionFingerprints.shift();
    const isStuck =
      recentActionFingerprints.length === 5 &&
      recentActionFingerprints.every((f) => f === recentActionFingerprints[0]);
    if (isStuck) {
      const reason = `Circuit breaker: same action repeated 5 times — ${describeAction(action)}. Pausing for human review.`;
      await core.appendScratchpadEntry(`REFLECT: ⚠️ ${reason}`);
      emit("agent.loop.stuck", { action: action.action, iteration: iterations, reason, sessionId });
      return { iterations, outcome: "error", summary: reason };
    }

    // Stall detection: if AX tree hash unchanged for 10 iterations, warn
    const thinking = action.thinking ? ` — ${action.thinking.slice(0, 200)}` : "";

    // ── THINK ─────────────────────────────────────────────────────────────────
    await core.appendScratchpadEntry(
      `THINK: [${iterations}/${MAX_ITERATIONS}] ${describeAction(action)}${thinking}`,
    );
    emit("agent.loop.think", {
      action: action.action,
      iteration: iterations,
      sessionId,
      thinking: sanitizeProtectedRuntimeText(action.thinking ?? ""),
    });

    // ── EXECUTE ───────────────────────────────────────────────────────────────
    if (action.action === "done") {
      const summary = sanitizeProtectedRuntimeText(action.summary ?? "Mission complete.");
      await core.appendScratchpadEntry(`REFLECT: [TASK_COMPLETE] ${summary}`);
      emit("agent.loop.done", { iterations, sessionId, summary });
      return { iterations, outcome: "complete", summary };
    }

    let execOk = false;
    let execErr = "";
    try {
      execOk = await executeAction(core, action);
    } catch (e) {
      execErr = e instanceof Error ? e.message : String(e);
      execOk = false;
    }

    // ── REFLECT ───────────────────────────────────────────────────────────────
    const reflectMsg = execOk
      ? `REFLECT: ${describeAction(action)} — OK`
      : `REFLECT: ${describeAction(action)} — FAILED${execErr ? ": " + execErr : ""}`;
    await core.appendScratchpadEntry(reflectMsg);

    emit("agent.loop.reflect", {
      action: action.action,
      iteration: iterations,
      ok: execOk,
      sessionId,
    });

    // Wait for page to settle after navigation/interaction
    if (action.action === "navigate" || action.action === "click") {
      try {
        const activePage = await core.ensurePage().catch(() => null);
        if (activePage) {
          // Wait for network to go idle (catches SPA route changes + XHR)
          await activePage.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {
            // Fallback: DOMContentLoaded is fast enough for most sites
            return activePage.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
          });
        }
      } catch {
        // Never block the loop on a settle failure — just continue
      }
    }
  }

  // Max iterations reached
  const summary = `Agent loop reached max iterations (${MAX_ITERATIONS}).`;
  await core.appendScratchpadEntry(`REFLECT: ${summary}`);
  emit("agent.loop.max_iterations", { iterations, sessionId, summary });
  return { iterations, outcome: "max_iterations", summary };
}

// ── Action executor ───────────────────────────────────────────────────────────

async function executeAction(core: OmniCoreClone, action: AgentAction): Promise<boolean> {
  const page = await core.ensurePage().catch(() => null);
  if (!page && action.action !== "navigate") {
    throw new Error("No active page");
  }

  switch (action.action) {
    case "navigate": {
      const outcome = await core.navigate(action.url);
      return Boolean(outcome.success);
    }
    case "click": {
      if (!page) return false;
      try {
        // Try CSS selector first, then visible text
        const loc = page.locator(action.selector).first();
        await loc.click({ timeout: 8000 });
        return true;
      } catch {
        try {
          await page.getByText(action.selector, { exact: false }).first().click({ timeout: 5000 });
          return true;
        } catch {
          return false;
        }
      }
    }
    case "type": {
      if (!page) return false;
      try {
        const loc = page.locator(action.selector).first();
        await loc.fill(action.text, { timeout: 8000 });
        return true;
      } catch {
        return false;
      }
    }
    case "scroll": {
      if (!page) return false;
      const amount = action.amount ?? 300;
      const delta = action.direction === "down" ? amount : -amount;
      await page.mouse.wheel(0, delta);
      return true;
    }
    case "screenshot": {
      await core.captureProofCheckpoint(action.label ?? `agent-loop-screenshot`);
      return true;
    }
    case "wait": {
      await new Promise<void>((r) => setTimeout(r, Math.min(action.ms ?? 1000, 10000)));
      return true;
    }
    default: {
      return false;
    }
  }
}

// ── Human-readable action description ────────────────────────────────────────

function describeAction(action: AgentAction): string {
  switch (action.action) {
    case "navigate": return `navigate to ${action.url}`;
    case "click": return `click "${action.selector}"`;
    case "type": return `type into "${action.selector}"`;
    case "scroll": return `scroll ${action.direction} ${action.amount ?? 300}px`;
    case "screenshot": return `screenshot "${action.label ?? "checkpoint"}"`;
    case "wait": return `wait ${action.ms ?? 1000}ms`;
    case "done": return `done — ${action.summary?.slice(0, 80) ?? "complete"}`;
    default: return "unknown action";
  }
}
