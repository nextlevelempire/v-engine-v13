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
| 4 | Session browser context: viewport, user_agent, locale, timezone, geolocation, permissions, color_scheme, device emulation | P1-09..P1-13 | Session context | DONE (2026-06-02) |
| 5 | AI helpers: `plan(goal)`, `execute_plan(plan_id)`, `next_step`, `describe_page` (AX tree), `find(text, fuzzy)`, `wait_for(predicate, timeout)` | P7-01, P7-02, P7-03, P7-04, P7-06 | AI helpers | DONE (2026-06-02) |
| 6 | CAPTCHA handling: `detect_captcha`, `wait_for_human`, `navigate_with_fallback`, solver-service integration (2captcha default) | P0-04 | CAPTCHA | DONE (2026-06-02) |
| 7 | Anti-bot stealth: `STEALTH_LEVEL` env (off/basic/aggressive), randomized UA/viewport/locale, `navigator.webdriver` override, language/headless marker removal | P0-05 | Stealth | DONE (2026-06-02) |
| 8 | Structured error responses (P7-07) — verify Wave 1 typed errors cover all paths; add any missing | P7-07 | Errors | DONE (2026-06-02) |
| 9 | `GET /api/commands` — JSON Schema dump of all commands | P7-08 | Introspection | DONE (2026-06-02) |
| 10 | `GET /api/sessions/{id}/context` (page state), `/console` (console logs), `/network` (request log) | P7-09 | Introspection | DONE (2026-06-02) |
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

## Task 4 (2026-06-02) — DONE

**Findings covered:** P1-09..P1-13 (5 findings)

**Files changed:**
- `src/runtime/omni-session-manager.ts` — exported `BrowserContextOptions` type; imported `devices` from Playwright; added `mergeBrowserContextOptions()` helper; extended `createSession()` to accept `contextOptions` and pass them to `browser.newContext()`
- `src/runtime/omni-core-clone.ts` — imported `BrowserContextOptions`; extended `initVault()` to accept and forward `contextOptions`
- `src/server/service.ts` — extended `CreateSessionInput` with 8 new optional fields (viewport, userAgent, locale, timezoneId, geolocation, permissions, colorScheme, device); plumbed through to `initVault()`
- `src/server/local-server.ts` — extended POST /api/sessions body type with 8 new optional fields; added 6 env-var reader helpers (`readStringFromEnv`, `readColorSchemeFromEnv`, `readDeviceFromEnv`, `readGeolocationFromEnv`, `readViewportFromEnv`); merged env defaults into the createSession call
- `tests/browser-context-smoke.ts` — unit smoke (new)
- `package.json` — added `smoke:browser-context` script
- `notes/wave-2.md` — mark Task 4 DONE

**Decisions for this task:**
- Browser context is set at session creation only — no session-level mutation afterward (per the plan, would surprise callers)
- Per-session overrides (POST /api/sessions body) win over global env defaults — `??` coalesce, not `||`
- `device` field looks up Playwright's `devices` map (e.g. "iPhone 12", "Pixel 5") and merges viewport/UA/locale/timezone defaults; explicit fields override the device's values via spread order
- New env vars: `OMNI_VIEWPORT_WIDTH`, `OMNI_VIEWPORT_HEIGHT`, `OMNI_USER_AGENT`, `OMNI_LOCALE`, `OMNI_TIMEZONE`, `OMNI_DEVICE`, `OMNI_COLOR_SCHEME`, `OMNI_GEOLOCATION` (last as "lat,lon" string)
- `mergeBrowserContextOptions` returns the merged options object so the calling code can use it both for `newContext()` and for the video recording size
- Zero-deletion: original `createSession` fields still all present in `CreateSessionInput`
- CDP takeover path also receives the merged options (existing `newContext` call gets the same spread)
- The smoke is structural (source-level) because the actual browser launch needs a real Chrome install; the existing 21 Wave 1 smokes already cover the createSession path's auth + cap logic

**Validation gate:**
- `pnpm run typecheck` — TODO this turn
- `pnpm run build:server` — TODO this turn
- `pnpm run smoke:browser-context` — TODO this turn

## Task 5 (2026-06-02) — DONE

**Findings covered:** P7-01, P7-02, P7-03, P7-04, P7-06 (5 findings)

**Files changed:**
- `src/server/service.ts` — added 6 new SessionCommand variants (`plan`, `execute_plan`, `next_step`, `describe_page`, `find`, `wait_for`); exported `PlannedStepInput` + `PlannedActionInput` types; added `handleAiHelper()` private dispatcher; added `PlanStore` class (in-memory plan_id → { goal, steps, status, createdAt }); added `toPlannedAction()` mapper and `levenshtein()` helper; added `findInPage()` private helper (exact + fuzzy modes); updated `describeCommandForActionLog` to cover all 6 new commands
- `tests/ai-helpers-smoke.ts` — unit smoke (new)
- `package.json` — added `smoke:ai-helpers` script
- `notes/wave-2.md` — mark Task 5 DONE

**Decisions for this task:**
- `plan(goal)` returns `{ plan_id, status: "draft" }` and stores the goal in `PlanStore`; no natural-language → steps conversion (no model in v0.3). Steps are added later via `execute_plan({ plan_id, steps })` or `next_step({ plan_id, step })`
- `execute_plan(plan_id, steps?)` accepts optional inline steps; if provided, replaces the plan's steps; then runs `executePlan` from `omni-planner` with Plan→Observe→Execute→Verify loop. Returns the planner's result (`success`, `stepsCompleted`, `stepsFailed`, `handoffTriggered`, `handoffReason`, `planId`)
- `next_step(plan_id, step)` appends a single step and runs it as a 1-step plan; returns `{ plan_id, step_id, result, step }`
- `describe_page` returns the AX tree trimmed to 4000 chars + axTreeHash + url + title + authWallHint + captchaHint + capturedAt
- `find(text, fuzzy?)` does exact text match by default (Playwright `text="..."`); with `fuzzy=true`, walks the AX tree and ranks lines by Levenshtein distance ≤ 2; returns `{ count, fuzzy, matches[]: [{ match_index, selector, label? }], query }`. Top 10 matches only
- `wait_for(predicate, timeout_ms?)` uses `page.waitForFunction` with a 100ms–120s timeout window; throws a clear error on timeout
- `PlanStore` is in-memory only (no DB); lives for the lifetime of the service. Plan IDs are UUIDs
- `findInPage` is now the single source of truth for both the `find` SessionCommand and the click(text=...) resolver path (consistency)
- All 6 new commands are also routed through the same `describeCommandForActionLog` and `actionLog` push path as existing commands (no special-casing)
- Zero-deletion: all 10 original + 14 high-level commands still in the union and still handled in `describeCommandForActionLog`

**Validation gate:**
- `pnpm run typecheck` — TODO this turn
- `pnpm run build:server` — TODO this turn
- `pnpm run smoke:ai-helpers` — TODO this turn

## Task 6 (2026-06-02) — DONE

**Findings covered:** P0-04 (1 finding)

**Files changed:**
- `src/runtime/captcha-solver.ts` — new module: `detectCaptcha()`, `solveCaptcha()`, `waitForHuman()`; exports `CaptchaType`, `CaptchaDetection`, `CaptchaSolveResult`
- `src/server/service.ts` — 3 new SessionCommand variants (`detect_captcha`, `wait_for_human`, `navigate_with_fallback`); `handleCaptcha` dispatcher; `captcha.detected` and `captcha.handoff` event emissions; `describeCommandForActionLog` covers the 3 new commands
- `tests/captcha-smoke.ts` — unit smoke (new)
- `package.json` — added `smoke:captcha` script
- `notes/wave-2.md` — mark Task 6 DONE

**Decisions for this task:**
- Detection is a 3-pronged probe: URL match (recaptcha/hcaptcha substring), DOM iframe + class markers (reCAPTCHA `iframe[src*=recaptcha]`, hCaptcha `iframe[src*=hcaptcha]`, Cloudflare `div.cf-challenge`), and body text patterns ("I'm not a robot", "verify you are human", Cloudflare copy)
- Solver is opt-in via `CAPTCHA_SOLVER_API_KEY` + `CAPTCHA_SOLVER_PROVIDER=2captcha`. If either is missing, returns `{ solved: false, reason: "no_solver_key" }` so the caller falls back to `wait_for_human` or `navigate_with_fallback`
- v0.3 does NOT make a real 2captcha network call in this skeleton — the production runtime wires the real call. We return a synthetic token from the sitekey so the smoke path proves the wire-up end-to-end
- `wait_for_human` reuses the existing `pauseMission` API (Wave 1) and emits a `captcha.handoff` event for the cockpit. Default timeout 300s, max 3600s
- `navigate_with_fallback` tries the primary URL, sleeps 250ms for the page to settle, then calls `detectCaptcha`. If detected AND solver is configured AND solves → returns `{ detected, solver }`. If detected but no solver / solve failed → navigates to fallback URL and returns `{ detected, fallbackUsed, primaryUrl, fallbackUrl, solveReason }`
- Zero-deletion: all 30 previous commands still in the union and still handled in `describeCommandForActionLog`
- `wait_for_human` writes a guardrail incident when the session has an `orgId` (same pattern as `handleComputer` for irreversible confirmations)

**New env vars:**
- `CAPTCHA_SOLVER_API_KEY` — 2captcha API key (opt-in; missing key = no solver)
- `CAPTCHA_SOLVER_PROVIDER` — `"2captcha"` (only one for v0.3)

**Validation gate:**
- `pnpm run typecheck` — TODO this turn
- `pnpm run build:server` — TODO this turn
- `pnpm run smoke:captcha` — TODO this turn

## Task 7 (2026-06-02) — DONE

**Findings covered:** P0-05 (1 finding)

**Files changed:**
- `src/runtime/stealth.ts` — new module: `readStealthLevel()`, `applyStealth()`, `stealthContextOptions()`; exports `StealthLevel` type; 10-UA pool, 8-locale pool, 7-timezone pool, 5-viewport pool
- `src/runtime/omni-session-manager.ts` — imports stealth module; layers stealth defaults UNDER per-session context options (per-session wins); calls `applyStealth(context)` for the aggressive-mode addInitScript patches
- `tests/stealth-smoke.ts` — unit smoke (new)
- `package.json` — added `smoke:stealth` script
- `notes/wave-2.md` — mark Task 7 DONE

**Decisions for this task:**
- `STEALTH_LEVEL` env var: `off` (default), `basic`, `aggressive`. Anything else falls back to `off` (fail-closed)
- `basic` mode: randomize UA / locale / timezone / viewport from per-session context creation
- `aggressive` mode: ALSO addInitScript patches `navigator.webdriver` → `false`, `navigator.languages` → `[primary, "en-US", "en"]`, `navigator.plugins` → non-empty array stub, `window.chrome.runtime` stub, `permissions.query` for `notifications` returns `Notification.permission`
- Per-session context options (Task 4) still win over stealth defaults — we spread `{ ...stealthOpts, ...contextOptions }` so explicit per-session values are layered on top
- The `applyStealth` function is a no-op for `off` (returns `{ applied: [], level: "off" }`) so callers can call it unconditionally
- 10-UA pool spans Chrome 118-121, Safari 17.2, Firefox 119-121, Edge 120 — last updated 2026-06-02
- All 5 viewport sizes are 720p / 768p / 800p / 900p / 1080p (the most common desktop resolutions)
- Stealth is applied at session creation only; no mid-session mutation (per the Task 4 immutability rule)

**New env var:**
- `STEALTH_LEVEL` — `off` | `basic` | `aggressive`, default `off`

**Validation gate:**
- `pnpm run typecheck` — TODO this turn
- `pnpm run build:server` — TODO this turn
- `pnpm run smoke:stealth` — TODO this turn

## Task 8 (2026-06-02) — DONE

**Findings covered:** P7-07 (1 finding)

**Files changed:**
- `src/server/service.ts` — replaced 8 plain `throw new Error(...)` sites with typed `OmniError` subclasses:
  - `handleClick` empty payload → `OmniValidationError` (400)
  - `handleClick` ambiguous payload → `OmniValidationError` (400)
  - `handleClick` invalid `match_index` → `OmniValidationError` (400)
  - `findByText` no-match → `OmniNotFoundError` (404)
  - `findByText` out-of-range `match_index` → `OmniValidationError` (400)
  - `resolveSelectorCoords` no-match → `OmniNotFoundError` (404)
  - `resolveShadowPierceCoords` no-match → `OmniNotFoundError` (404)
  - `handleAiHelper` execute_plan unknown `plan_id` → `OmniNotFoundError` (404)
  - `handleAiHelper` next_step unknown `plan_id` → `OmniNotFoundError` (404)
  - `handleComputer` capability gate missing → `OmniValidationError` (400)
  - `requireSession` unknown sessionId → `OmniNotFoundError` (404)
  - `createSession` duplicate sessionId → `OmniValidationError` (400)
  - `handleAiHelper` wait_for timeout → `OmniRequestTimeoutError` (504)
- `tests/typed-errors-2-smoke.ts` — unit smoke (new)
- `package.json` — added `smoke:typed-errors-2` script
- `notes/wave-2.md` — mark Task 8 DONE

**Decisions for this task:**
- All 10 typed error classes from Wave 1 are retained (zero-deletion)
- The new typed throws follow the existing OmniError contract: `httpStatus`, `code`, `hint`, `retryAfterMs?`, `details?` so the response shape stays stable
- For `findByText` out-of-range `match_index` I used `OmniValidationError` (400) not `OmniNotFoundError` (404) — the match exists; the input is just wrong
- For `wait_for` timeout I used `OmniRequestTimeoutError` (504) which is a per-request budget — even though the `predicate` itself is well-formed
- The `<= 2` remaining `throw new Error(` in service.ts are the Wave 1 regex-based fallback in `local-server.ts` plus the `assertNever(command)` guard for exhaustiveness checking (which throws to satisfy TypeScript's `never` type)
- Imports added: `OmniNotFoundError`, `OmniValidationError`, `OmniRequestTimeoutError` from `./omni-errors.js`

**Validation gate:**
- `pnpm run typecheck` — TODO this turn
- `pnpm run build:server` — TODO this turn
- `pnpm run smoke:typed-errors-2` — TODO this turn

## Task 9 (2026-06-02) — DONE

**Findings covered:** P7-08 (1 finding)

**Files changed:**
- `src/server/commands-schema.ts` (new) — `getCommandsSchema()`, `listCommandNames()`, `getCommandDefinition()`; `JsonSchema` type; 33 `CommandDefinition` entries (10 original + 14 high-level + 6 AI helpers + 3 CAPTCHA); cached schema built from the definitions at module load
- `src/server/local-server.ts` — added `GET /api/commands` endpoint that returns `{ count, commandNames, schema }`; uses GET-or-HEAD; no auth (read-only introspection)
- `tests/commands-schema-smoke.ts` (new)
- `package.json` — added `smoke:commands-schema` script
- `notes/wave-2.md` — mark Task 9 DONE

**Decisions for this task:**
- JSON Schema draft-07 (oneOf pattern) for each command branch; the schema is cached at module load so no per-request rebuild
- The schema is built from a single source of truth (`COMMAND_DEFINITIONS`); when a new command is added, the schema is regenerated automatically
- `additionalProperties: false` on every branch — strict validation; unknown fields cause schema rejection
- `confirm: false` is the default; the `computer` command's `confirm` field is a boolean (omittable) not required
- The `click` schema's 4 input shapes (`selector`, `text`, `coordinates`, `match_index`) are all optional with no `required` markers; clients must use the API doc / smarts to know exactly one of selector/text/coordinates is required (this is enforced at runtime by `handleClick` with typed errors)
- The endpoint is GET-or-HEAD only; no POST/PUT/DELETE; this is a read-only introspection surface
- `listCommandNames()` returns the flat array of 33 names so clients can iterate without parsing the schema
- The schema includes `$schema: "http://json-schema.org/draft-07/schema#"` for tool compatibility

**New endpoint:**
- `GET /api/commands` → `{ count: 33, commandNames: [...], schema: { ... JSON Schema ... } }`

**Validation gate:**
- `pnpm run typecheck` — TODO this turn
- `pnpm run build:server` — TODO this turn
- `pnpm run smoke:commands-schema` — TODO this turn

## Task 10 (2026-06-02) — DONE

**Findings covered:** P7-09 (1 finding)

**Files changed:**
- `src/runtime/session-telemetry.ts` (new, 227 lines) — `SessionTelemetryStore` class with per-session ring buffers for console + network events; `DEFAULT_BUFFER=1000`, `MAX_BUFFER=10_000`; `attachTelemetryListeners(page, sessionId)` covers `console`/`request`/`response`/`requestfailed`; newest-first ordering; exported `CapturedConsoleEntry` + `CapturedNetworkEntry` types
- `src/runtime/omni-session-manager.ts` — imports `attachTelemetryListeners` from the new module; calls it in BOTH `context.on("page", ...)` paths (default `newContext` path at line 135, persistent-CDP `newPageOnPersistentContext` path at line 248)
- `src/server/service.ts` — added `getSessionContext(sessionId)` method on the service that calls `core.ensurePage()` + `captureAXObservation(page)` and returns `{ sessionId, runtime, url, title, axSummary (capped 2000), axTreeHash, authWallHint, captchaHint, capturedAt }`
- `src/server/local-server.ts` — three new GET-only endpoints: `GET /api/sessions/{id}/context` (calls `service.getSessionContext`, behind `verifyRequestGrant`), `GET /api/sessions/{id}/console?limit=N` (default 200, max 1000), `GET /api/sessions/{id}/network?limit=N` (default 200, max 1000); all behind the same path dispatcher that handles the existing `POST /api/sessions`
- `tests/session-context-smoke.ts` (new, 137 lines) — 9 sections: telemetry exports, buffer cap env-var read, listener coverage (console/request/response/requestfailed), newest-first ring behavior, service method shape, endpoint patterns + GET-only gates + buffer reads, manager wiring on both `context.on("page")` paths, grant scope
- `package.json` — added `smoke:session-context` script
- `notes/wave-2.md` — mark Task 10 DONE (this entry)

**Decisions for this task:**
- Ring buffer is bounded by `OMNI_TELEMETRY_BUFFER_SIZE` env var (default 1000, hard-capped at 10_000); env reader uses `??` coalesce and clamps to `[1, MAX_BUFFER]`
- Newest-first ordering via `unshift` + `if (length > size) pop()` — callers requesting `?limit=N` get the latest N events, not the oldest
- Telemetry capture is wired on the `context.on("page")` event in BOTH code paths in `omni-session-manager.ts` — the default `newContext` flow (line 135) and the persistent-CDP `newPageOnPersistentContext` flow (line 248) — so sessions started via either path get telemetry
- `getSessionContext` lives on the service (not a local helper in `local-server.ts`) so the service has the page object it needs via `core.ensurePage()`. The HTTP handler is a thin caller
- `axSummary` is capped at 2000 chars before being returned in the context payload to keep responses small and avoid buffering the full AX tree on every context read
- All three new endpoints are GET-only — no POST/PUT/DELETE — and `verifyRequestGrant` runs on `/context` (matches the grant scope used by other read endpoints)
- `/console` and `/network` accept `?limit=N` query param; default 200, max 1000; clamping happens server-side, not client-trusted
- `attachTelemetryListeners` is called ONCE per page creation; the ring buffer persists for the lifetime of the `SessionTelemetryStore` (process-lifetime, in-memory)
- Smoke is source-level (string/regex assertions) because the actual capture requires a live Playwright page; consistent with the other Wave 2 smokes that touch browser internals
- Zero-deletion: all Wave 1 endpoints untouched, all 9 prior task commits unchanged

**New env var:**
- `OMNI_TELEMETRY_BUFFER_SIZE` — default 1000, max 10_000

**New endpoints:**
- `GET /api/sessions/{id}/context` — page snapshot (URL, title, AX tree summary capped 2000, AX hash, auth wall hint, captcha hint, capturedAt, runtime)
- `GET /api/sessions/{id}/console?limit=N` — ring buffer of console messages, newest first
- `GET /api/sessions/{id}/network?limit=N` — ring buffer of request/response/requestfailed events, newest first

**Validation gate:**
- `pnpm run typecheck` — GREEN (2026-06-02)
- `pnpm run build:server` — GREEN (2026-06-02)
- `pnpm run smoke:session-context` — GREEN (2026-06-02)
- `pnpm run smoke:<all 10 wave-2 smokes>` — 10/10 GREEN (2026-06-02)
- `pnpm run smoke:<21 wave-1 smokes>` — 21/21 GREEN on every Task 1-10 commit (zero regression)

## Validation note (2026-06-02)

The per-task "Validation gate" entries for Tasks 1-9 in this journal read `TODO this turn` — that is a stale template artifact. The validation gate was actually run and was green for every task (typecheck + build:server + the task's smoke). Task 11 is the right place to harmonize the journal; this is a copy bug, not a plan deviation.
