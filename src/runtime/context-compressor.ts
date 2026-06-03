/**
 * context-compressor.ts — Conversation history compression for long missions.
 *
 * When the agent loop's conversation history grows beyond the threshold,
 * this module compresses it: keeps the system prompt + first 3 exchanges
 * (objective + initial state) + a mid-point summary + last 5 exchanges
 * (recent context). Prevents context overflow on 50+ iteration missions.
 *
 * Also provides AX tree truncation with priority scoring — important
 * interactive elements (buttons, inputs, links) appear first.
 */

// ── Conversation compressor ───────────────────────────────────────────────────

export interface ConversationMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Maximum messages before compression kicks in (system + N exchanges = N+1). */
const COMPRESS_THRESHOLD = 20;

/** After compression: keep this many recent messages (system excluded). */
const KEEP_RECENT = 8;

/** Keep this many oldest messages for objective context (system excluded). */
const KEEP_OLDEST = 4;

/**
 * Compress conversation history when it exceeds COMPRESS_THRESHOLD messages.
 * Idempotent: returns the input unchanged when below threshold.
 */
export function compressConversation(
  messages: ConversationMessage[],
): ConversationMessage[] {
  if (messages.length <= COMPRESS_THRESHOLD) return messages;

  const system = messages.filter((m) => m.role === "system");
  const nonSystem = messages.filter((m) => m.role !== "system");

  if (nonSystem.length <= KEEP_OLDEST + KEEP_RECENT) return messages;

  const oldest = nonSystem.slice(0, KEEP_OLDEST);
  const recent = nonSystem.slice(-KEEP_RECENT);
  const middle = nonSystem.slice(KEEP_OLDEST, -KEEP_RECENT);

  const summary = buildSummary(middle);
  const summaryMsg: ConversationMessage = {
    role: "user",
    content: summary,
  };

  return [...system, ...oldest, summaryMsg, ...recent];
}

function buildSummary(middle: ConversationMessage[]): string {
  const actionCount = middle.filter((m) => m.role === "assistant").length;
  const urlMatches = middle
    .map((m) => [...m.content.matchAll(/https?:\/\/[^\s"]+/g)].map((x) => x[0]))
    .flat()
    .filter((u, i, a) => a.indexOf(u) === i)
    .slice(0, 5);
  const doneMatches = middle.filter((m) => m.content.includes("TASK_COMPLETE") || m.content.includes('"action":"done"')).length;

  const lines = [
    `[CONTEXT SUMMARY: ${actionCount} actions in compressed window]`,
  ];
  if (urlMatches.length > 0) lines.push(`Pages visited: ${urlMatches.join(", ")}`);
  if (doneMatches > 0) lines.push(`Partial completions detected: ${doneMatches}`);
  lines.push("(Earlier steps compressed to save context. Continue from current state.)");

  return lines.join("\n");
}

// ── AX tree trimmer ───────────────────────────────────────────────────────────

/** Maximum characters for the AX tree in agent loop prompts. */
const AX_TREE_MAX_CHARS = 4000;

/** Priority roles to show first — interactive elements the AI is most likely to need. */
const HIGH_PRIORITY_ROLES = new Set([
  "button", "link", "textbox", "input", "checkbox", "radio", "combobox",
  "menuitem", "tab", "option", "searchbox", "spinbutton", "slider",
  "switch", "treeitem", "row",
]);

/**
 * Trim the AX tree to stay within MAX_CHARS. High-priority interactive
 * elements are kept; static text is trimmed first.
 */
export function trimAxTree(axTree: string, maxChars = AX_TREE_MAX_CHARS): string {
  if (axTree.length <= maxChars) return axTree;

  const lines = axTree.split("\n");
  const highPriority: string[] = [];
  const lowPriority: string[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    const isHighPriority = [...HIGH_PRIORITY_ROLES].some((role) => lower.includes(role));
    if (isHighPriority) {
      highPriority.push(line);
    } else {
      lowPriority.push(line);
    }
  }

  // Start with all high-priority lines, add low-priority until budget runs out
  let result = highPriority.join("\n");
  const budget = maxChars - result.length - 100; // 100 chars for the truncation notice

  if (budget > 0 && lowPriority.length > 0) {
    const lowTrimmed = lowPriority.join("\n").slice(0, budget);
    result = `${result}\n${lowTrimmed}`;
  }

  if (axTree.length > maxChars) {
    result += `\n[... AX tree truncated (${lines.length} total lines, showing ${result.split("\n").length}) ...]`;
  }

  return result;
}

// ── Token estimator ───────────────────────────────────────────────────────────

/** Rough token estimate: chars / 4 (good enough for safety thresholds). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Check if conversation is approaching token limit. */
export function isApproachingTokenLimit(
  messages: ConversationMessage[],
  limitTokens = 100_000,
): boolean {
  const total = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  return total > limitTokens * 0.8; // warn at 80%
}
