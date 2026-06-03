/**
 * Smoke test for Wave 2 Task 3 — ClickInput overloads.
 *
 * The click SessionCommand previously only accepted a CSS selector. Wave 2
 * adds three alternative target sources, with validation:
 *
 *   { selector }               → existing path, unchanged
 *   { text, match_index? }     → resolve via findByText → existing path
 *   { coordinates }             → page.mouse.click(x, y), bypass DOM lookup
 *
 * Exactly one of selector/text/coordinates must be provided. match_index
 * is optional and only meaningful with text (default 0). The existing
 * selector-only flow is preserved (zero-deletion rule).
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const SERVICE_SRC = fs.readFileSync("src/server/service.ts", "utf8");

// ── 1. Type-level: click command accepts all 3 target shapes ───────────────
// The click type definition spans multiple lines, so we match from "type: \"click\";"
// to the first `}` that ends the type literal (the coordinates one).
const clickTypeDefMatch = SERVICE_SRC.match(/type:\s*"click";[\s\S]+?\}\s*\|/);
assert.ok(clickTypeDefMatch, "click command type definition must exist");
const clickType = clickTypeDefMatch![0];
assert.match(clickType, /selector\?:\s*string/, "click must accept optional selector");
assert.match(clickType, /text\?:\s*string/, "click must accept optional text");
assert.match(clickType, /coordinates\?:\s*\{\s*x:\s*number;\s*y:\s*number\s*\}/, "click must accept optional coordinates");
assert.match(clickType, /match_index\?:\s*number/, "click must accept optional match_index");

// ── 2. Dispatch: click routes to handleClick (not the inline core.click) ──
const switchMatch = SERVICE_SRC.match(/case "click":[\s\S]+?break;/);
assert.ok(switchMatch, "click case must exist in executeCommand switch");
assert.match(
  switchMatch![0],
  /handleClick\(record, command\)/,
  "click must dispatch to handleClick (not the old inline path)",
);

// ── 3. handleClick validates the payload ──────────────────────────────────
const handleClickMatch = SERVICE_SRC.match(/private async handleClick[\s\S]+?\n  \}/);
assert.ok(handleClickMatch, "handleClick must exist");
const handleClick = handleClickMatch![0];
assert.match(handleClick, /requires one of: selector, text, coordinates/, "must reject empty click");
assert.match(handleClick, /accepts exactly one of: selector, text, coordinates/, "must reject ambiguous click");
assert.match(handleClick, /match_index must be a non-negative integer/, "must validate match_index");
assert.match(handleClick, /record\.core\.click\(selector\)/, "selector path must still call core.click");
assert.match(handleClick, /page\.mouse\.click\(coordinates!\.x, coordinates!\.y\)/, "coordinates path must use page.mouse.click");

// ── 4. findByText helper exists and returns a Playwright text= selector ───
assert.match(
  SERVICE_SRC,
  /private async findByText[\s\S]+?`text="\$\{escaped\}"`/,
  "findByText must return a Playwright text=\"...\" pseudo-selector",
);
assert.match(SERVICE_SRC, /match_index=.* out of range/, "findByText must validate match_index against match count");

// ── 5. describeCommandForActionLog handles all 3 click shapes ─────────────
const summaryMatch = SERVICE_SRC.match(/function\s+describeCommandForActionLog[\s\S]+?\n\}/);
assert.ok(summaryMatch, "describeCommandForActionLog must exist");
const summary = summaryMatch![0];
assert.match(summary, /case "click":[\s\S]+?selector !== undefined/, "summary must branch on selector");
assert.match(summary, /case "click":[\s\S]+?text !== undefined/, "summary must branch on text");
assert.match(summary, /case "click":[\s\S]+?coordinates !== undefined/, "summary must branch on coordinates");

// ── 6. Zero-deletion: the original selector-only flow still works ─────────
// A caller passing { type: "click", selector: "..." } must still typecheck
// (selector is still optional, so the original payload is valid). Verify by
// reading the type definition: selector is `?: string` (optional), not removed.
assert.ok(
  /type:\s*"click";[\s\S]+?selector\?:\s*string/.test(SERVICE_SRC),
  "selector field must remain in the click type (zero-deletion)",
);

// ── 7. SessionCommand union still includes click (regression) ─────────────
assert.match(
  SERVICE_SRC,
  /type:\s*"click";[\s\S]+?type:\s*"computer"/,
  "click must remain in SessionCommand union, ordered before computer",
);

console.log("click-input smoke ok");
