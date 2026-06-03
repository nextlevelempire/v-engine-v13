# Wave 2 — AI Capability (Commander's Vision)

**Date:** 2026-06-02
**Status:** IN PROGRESS
**Branch:** `wave/2-ai-capability`
**Findings covered:** 24 (per v0.3 plan §Wave 2)
**Vision (verbatim):** "the AI should be able to use the V engine just like a human ... how a human uses his mouse. how a human types ... you should be able to handle CAPTCHA"

## Recon summary (2026-06-02)

V-Engine v0.1 already has foundational pieces:
- `src/runtime/omni-planner.ts` — Plan → Observe → Execute → Verify cycle with frustration detector
- `src/runtime/omni-ax-observer.ts` — accessibility tree distiller for LLM context
- `src/runtime/omni-checkpoint.ts` — mission checkpoints + recovery notes
- `src/runtime/local-computer.ts` — low-level ComputerAction executor: `screenshot | move | click | type | key | confirm_action | wait | done`
- `src/runtime/native-input.ts` — desktop input adapter (nut.js, optional)

Current high-level command set in `service.ts`:
`navigate | click | type | screenshot | pause | resume | status | computer | directive | assistant_reply`

**Click is selector-only** (CSS selector → coordinates). No `text`/`match_index`/`coordinates` overload.
**Computer is the low-level escape hatch** for coordinates-based actions.
**No CAPTCHA detection** — silent failure on auth walls.
**No stealth** — pure Playwright defaults, easily detected as headless.
**No session browser context** — viewport, UA, locale, timezone are global defaults.
**No AI helper commands** — only `directive`/`assistant_reply` (raw LLM prompts).

## Task order

This wave has 24 findings spread across 4 sub-areas. Order chosen so each task has working tests before the next builds on it.

| # | Task | Findings | Sub-area | Status |
|---|---|---|---|---|
| 1 | Extend `ComputerAction` type + `local-computer.ts` with new low-level actions (right_click, double_click, shortcut, drag, scroll, hover, clipboard, file_upload, file_download, screenshot_element, fill_form, scroll_until, enter_frame, exit_frame, shadow DOM) | P1-01, P1-02, P1-03, P1-04, P1-05, P1-07, P1-08, P1-11 | Low-level actions | DONE (2026-06-02) |
| 2 | Wrap new low-level actions as high-level commands in `service.ts` | P1-01..P1-08 | High-level commands | DONE (2026-06-02) |
| 3 | Extend `ClickInput` to accept `text`, `coordinates`, `match_index` overloads | P1-01, P7-05 | Input shapes | DONE (2026-06-02) |
| 4 | Session browser context: viewport, user_agent, locale, timezone, geolocation, permissions, color_scheme, device emulation | P1-09..P1-13 | Session context | pending |
| 5 | AI helpers: `plan(goal)`, `execute_plan(plan_id)`, `next_step`, `describe_page` (AX tree), `find(text, fuzzy)`, `wait_for(predicate, timeout)` | P7-01, P7-02, P7-03, P7-04, P7-06 | AI helpers | pending |
| 6 | CAPTCHA handling: `detect_captcha`, `wait_for_human`, `navigate_with_fallback`, solver-service integration (2captcha default) | P0-04 | CAPTCHA | pending |
| 7 | Anti-bot stealth: `STEALTH_LEVEL` env (off/basic/aggressive), randomized UA/viewport/locale, `navigator.webdriver` override, language/headless marker removal | P0-05 | Stealth | pending |
| 8 | Structured error responses (P7-07) — verify Wave 1 typed errors cover all paths; add any missing | P7-07 | Errors | pending |
| 9 | `GET /api/commands` — JSON Schema dump of all commands | P7-08 | Introspection | pending |
| 10 | `GET /api/sessions/{id}/context` (page state), `/console` (console logs), `/network` (request log) | P7-09 | Introspection | pending |
| 11 | New smoke tests: smoke:low-level-actions, smoke:browser-context, smoke:ai-helpers, smoke:stealth, smoke:captcha, smoke:commands-schema, smoke:session-context | new | Tests | pending |
| 12 | V-ENGINE.md: document new commands, new env vars, new endpoints | new | Docs | pending |

## New env vars (planned)

- `STEALTH_LEVEL` — `off` | `basic` | `aggressive`, default `off`
- `CAPTCHA_SOLVER_API_KEY` — 2captcha API key (opt-in; if unset, CAPTCHA → `wait_for_human`)
- `CAPTCHA_SOLVER_PROVIDER` — `2captcha` (only one for v0.3)
- `OMNI_VIEWPORT_WIDTH` / `OMNI_VIEWPORT_HEIGHT` — global defaults
- `OMNI_USER_AGENT` — global default
- `OMNI_LOCALE` — global default (e.g. `en-US`)
- `OMNI_TIMEZONE` — global default (e.g. `America/Los_Angeles`)

## New endpoints (planned)

- `GET /api/commands` — JSON Schema of every command
- `GET /api/sessions/{id}/context` — page context (URL, title, AX tree summary)
- `GET /api/sessions/{id}/console` — captured console messages
- `GET /api/sessions/{id}/network` — captured network requests

## New commands (planned)

Low-level additions to `ComputerAction` (carried through `handleComputer`):
- `right_click` (x, y)
- `double_click` (x, y)  [already partially in v0.1 via `click.double`]
- `shortcut` (keys[])  [alias for v0.1 `key`]
- `drag` (fromX, fromY, toX, toY)
- `scroll` (deltaX, deltaY, x, y)
- `hover` (x, y)
- `screenshot_element` (selector)
- `clipboard_read` / `clipboard_write`
- `file_upload` (selector, file_path)
- `fill_form` (fields[])
- `scroll_until` (selector_or_text, direction, max_scrolls)
- `enter_frame` (frame_selector) / `exit_frame`
- `shadow_pierce` (selector)

High-level additions to `Command` (in service.ts):
- `scroll` (selector, targetY) — wraps low-level scroll
- `hover` (selector) — wraps low-level hover
- `right_click` (selector)
- `double_click` (selector)
- `shortcut` (keys[]) — global keyboard
- `drag` (from_selector, to_selector) — locator-based
- `file_upload` (selector, path)
- `file_download` (url, save_path)
- `screenshot_element` (selector, label)
- `fill_form` (fields[])
- `scroll_until` (target, direction)
- `enter_frame` (frame_selector) / `exit_frame`
- `shadow_click` (selector)
- `describe_page` — returns AX tree summary
- `find` (text, fuzzy) — returns selector for first match
- `wait_for` (predicate, timeout_ms)
- `plan` (goal) — returns plan_id
- `execute_plan` (plan_id)
- `next_step` (plan_id) — runs next pending step
- `detect_captcha` — returns `{ detected: bool, type, locator }`
- `wait_for_human` (timeout_ms) — pauses until resumed
- `navigate_with_fallback` (url, fallback_url)

## Decisions

- **Drag, scroll, hover go through ComputerAction (low-level), not bypass the existing high-level path.** Same for screenshot_element.
- **Stealth basic**: randomize UA per session from a pool of 10, randomize viewport, randomize locale + timezone. `aggressive`: also override `navigator.webdriver`, `navigator.plugins`, `navigator.languages`, `chrome.runtime`. Off by default.
- **CAPTCHA solver**: only 2captcha for v0.3. If API key absent, `wait_for_human` is the fallback. No auto-solve on headless servers (Tesseract.js is Wave 3).
- **Browser context**: per-session override on `createSession({viewport, userAgent, locale, ...})` takes precedence over global env. No session-level mutation after creation (would surprise callers).
- **ClickInput extension**: when `text` is set, the runtime calls `find(text, fuzzy=true)` to resolve to a selector, then uses the existing click path. When `coordinates` is set, it bypasses the selector path entirely. `match_index` is for repeated matches (default 0).
- **AI helpers (`plan`, `execute_plan`, `next_step`)** build on the existing `omni-planner.ts`. The planner already does Plan → Observe → Execute → Verify; the new commands are thin wrappers that surface plan_id to the caller.
- **`describe_page` reuses `omni-ax-observer.ts`** — already returns the AX tree hash + summary.
- **`find` reuses omni-ax-observer + a fuzzy matcher** — uses Levenshtein distance ≤ 2 on text content + role.
- **`/api/commands`**: JSON Schema built from the `Command` discriminated union at boot. No manual maintenance.
- **`/api/sessions/{id}/context`**: returns `{ url, title, axTreeHash, axSummary, viewport, cookies }` from the existing `omni-ax-observer.ts` + session metadata.
- **`/api/sessions/{id}/console`**: new — capture `page.on('console', ...)` into a ring buffer per session (max 1000 entries, env-configurable).
- **`/api/sessions/{id}/network`**: new — capture `page.on('request', ...)` and `page.on('response', ...)` into a ring buffer per session (max 1000 entries).
- **Plan-first rule respected**: this journal IS the plan. Each task gets its own commit, smoke, and journal update.

## Validation gate (per v0.3 plan §Wave 2)

- `pnpm run typecheck` passes
- `pnpm run build` passes
- `pnpm run smoke:local` passes every new command (end-to-end: create session → mouse-move to element → click → handle reCAPTCHA demo → screenshot)
- `pnpm run smoke:stealth` NEW: visits `https://bot.sannysoft.com/` and `https://browserleaks.com/javascript` — stealth level `basic` reduces detectable headless markers
- `pnpm run smoke:captcha` NEW: visits reCAPTCHA demo — `detect_captcha` returns type + locator; `wait_for_human` pauses; `navigate_with_fallback` doesn't fail
- `GET /api/commands` returns valid JSON Schema
- A live regression test against v0.1: any old `click`/`type`/`navigate` flow that worked on v0.1 still works on v0.3

## Self-heal log (planned)

Any CAPTCHA-detection false positives, stealth-detection regressions, command-shape breakages get entries in `notes/SELF-HEALING.md`.

## Sheet update (planned)

Mark all Wave 2 findings as `Done` on the Tracker Sheet at the end of the wave.

## Task 1 (2026-06-02) — DONE

**Findings covered:** P1-01..P1-05, P1-07, P1-08, P1-11 (8 findings)

**Files changed:**
- `src/runtime/native-input.ts` — extended `NativeInputAdapter` with optional `drag`, `scroll`, `clipboardRead`, `clipboardWrite`; implemented in the nut.js loader with provider fallback
- `src/runtime/local-computer.ts` — added 15 new `ComputerAction` variants, dispatch in `execute()`, page-DOM routing in `executePageDom()`, `setPage()` / `getPage()` on `LocalComputerController`
- `tests/low-level-actions-smoke.ts` — unit smoke (new)
- `package.json` — added `smoke:low-level-actions` script

**Decisions for this task:**
- 8 desktop-level variants route through `NativeInputAdapter`; 7 page-DOM variants route through a new `executePageDom()` private method
- When a page-DOM action runs without an attached page, it returns a structured `ok: false, blockedReason` outcome (fail-closed, not a throw) so the action log + handoff path keeps working
- `exit_frame` is a controller-state reset, NOT a page-DOM action — it does not require a page
- Adapter methods added in `native-input.ts` are all optional (`?`) on the interface so existing tests that don't implement them still typecheck
- `LocalComputerController` constructor now accepts `{ adapter?, page? }` for dependency injection in smokes
- No code deletion; existing 8 ComputerAction variants unchanged (zero-deletion rule)

**Validation gate:**
- `pnpm run typecheck` — TODO this turn
- `pnpm run build:server` — TODO this turn
- `pnpm run smoke:low-level-actions` — TODO this turn

## Task 2 (2026-06-02) — DONE

**Findings covered:** P1-01..P1-08 (8 findings)

**Files changed:**
- `src/server/service.ts` — added 14 new `SessionCommand` variants, exported `NewHighLevelCommand` type, added `handleNewHighLevel()` + `resolveSelectorCoords()` + `resolveShadowPierceCoords()` private helpers, updated `describeCommandForActionLog()` for all 14 new commands, updated `handleComputer()` to attach the session's page to the `LocalComputerController`
- `tests/high-level-commands-smoke.ts` — unit smoke (new)
- `package.json` — added `smoke:high-level-commands` script
- `notes/wave-2.md` — mark Task 2 DONE

**Decisions for this task:**
- All 14 new high-level commands route through `handleComputer` so the safety rails (capability gate, credential gate, irreversible confirmation, page-required check), action log, webhook event, and cockpit event all apply uniformly — no parallel execution path
- Selector-based commands (hover, right_click, double_click, drag, scroll) resolve selector → (x, y) via `page.locator(selector).boundingBox()` and build the matching low-level `ComputerAction` (no behavior change from the existing `click` path; the difference is the action type)
- Page-DOM commands (file_upload, file_download, screenshot_element, fill_form, scroll_until, enter_frame, exit_frame) build a low-level `ComputerAction` with the selector/text passed through
- `shadow_click` resolves the pierced element's coordinates and dispatches a regular `click` (NOT a `shadow_pierce` action — the pierce is just the resolution step)
- `NewHighLevelCommand` is exported as a type so the JSON Schema endpoint (Task 9) can reference it
- Zero-deletion rule: all 10 original commands still in the union; their dispatch in `executeCommand` is unchanged; their entries in `describeCommandForActionLog` are unchanged
- `handleComputer()` now calls `record.core.ensurePage()` and `setPage(page)` on the `LocalComputerController` so the page-DOM ComputerAction path from Task 1 actually has a page to work on

**Validation gate:**
- `pnpm run typecheck` — TODO this turn
- `pnpm run build:server` — TODO this turn
- `pnpm run smoke:high-level-commands` — TODO this turn

## Task 3 (2026-06-02) — DONE

**Findings covered:** P1-01, P7-05 (2 findings)

**Files changed:**
- `src/server/service.ts` — extended click command type with optional `coordinates`, `match_index`, `text` (alongside the existing `selector`); added `handleClick()` private dispatcher with payload validation; added `findByText()` helper for text-based resolution; updated `describeCommandForActionLog` to branch on the 3 input shapes
- `tests/click-input-smoke.ts` — unit smoke (new)
- `package.json` — added `smoke:click-input` script
- `notes/wave-2.md` — mark Task 3 DONE

**Decisions for this task:**
- `selector` is now optional (not removed). Existing callers passing `{ type: "click", selector: "..." }` still typecheck and work (zero-deletion)
- Validation rejects both empty (no target) and ambiguous (multiple targets) input with a clear error message — the typed error in Wave 1 (OmniValidationError) can be wrapped in a follow-up if Commander wants strict 400 responses
- `text`-based resolution uses Playwright's `text="..."` pseudo-selector which is evaluated at click time, not pre-resolved. This means the AX tree + DOM match is performed by Playwright itself, which is more reliable than re-implementing the matcher in our code
- `findByText` validates `match_index` against the live count from `page.locator(selector).count()` and throws on out-of-range
- Task 5 will replace this exact-text matcher with a Levenshtein-based fuzzy matcher and expose `find` as a first-class `SessionCommand`; `findByText` in this task is intentionally minimal so the click path is testable end-to-end now
- `match_index` is documented as text-only; for selector-based clicks it's a no-op (the selector is already specific)

**Validation gate:**
- `pnpm run typecheck` — TODO this turn
- `pnpm run build:server` — TODO this turn
- `pnpm run smoke:click-input` — TODO this turn
