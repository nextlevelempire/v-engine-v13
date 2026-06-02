# V-Engine V13 v0.3 — Implementation Plan
**Status:** APPROVED — IN PROGRESS (Wave 1)
**Author:** General Max
**Date:** 2026-06-02
**Commander:** Supreme Commander
**Source of truth:** https://docs.google.com/document/d/1ia8FKnagy5uqnXtrcpwIJx27nObGtUGKZqC89csKOW8/edit (80 findings)
**Companion tracker:** https://docs.google.com/spreadsheets/d/1keUcP1JYRZkIN9tWYmhW_LIU42xF_zI6zya9Qmkazuw/edit
**Plan Doc (Google):** https://docs.google.com/document/d/1yhEO3g_IEFkZ_nnpt5nmJQm3C1xrvMKCfcR57XcgpMA/edit

---

## 1. Executive Summary

Implement 80 blind spots and pain points in the V-Engine across **5 ordered waves** (down from 13). Keystones: **human-like AI** (Commander's #1 ask) + **CAPTCHA/anti-bot handling** + **session persistence**. Foundation: API surface, configuration, observability, security.

**Target outcome:** A V-Engine that an AI can use on real websites the way a human uses a mouse and keyboard — including detecting and pausing on CAPTCHA, running for hours without losing state, surviving restarts, and being operated safely in production.

**Total effort:** All 5 waves, executed in sequence, build-and-test-as-we-go.

**Methodology:** Build → test → self-heal in place. If a test fails, fix it before moving on. Document every healing event in `notes/SELF-HEALING.md` (this is part of the V-Engine deliverable, not throwaway logs).

**Reporting cadence:** End of each wave = checkpoint to Commander. Between waves, ask any blocking questions.

---

## 2. Source of Truth

- **Findings doc:** V-Engine V13 v0.2 — Blind Spots & Pain Points (link above)
- **Sheet tracker:** Testing & Improvement Tracker (link above) — every finding is a row, columns include `Status` (Open/In Progress/Done), `Owner`, `Date Resolved`, `Wave` (which wave addressed it), `Notes`
- **Source code (read-only reference):** `~/Documents/research-v-engine/05-omni-browser-v4/` (frozen v0.1 snapshot)
- **Live test target (DO NOT TOUCH):** `~/Downloads/omni-browser-v4/`, running on port 4011, PID 54357 — stays running as our regression baseline throughout the build
- **Healing log:** `~/Documents/v-engine-v13/notes/SELF-HEALING.md` — every bug found and fixed during build/test cycles
- **Wave journals:** `~/Documents/v-engine-v13/notes/wave-N.md` — one journal per wave with decisions, blockers, outcomes

---

## 3. Working Repository

`~/Documents/v-engine-v13/` — initialized as a git repo, with the V-Engine v0.1 source as the starting commit. All changes happen here.

**Branch strategy:**
- `main` — always green, mirrors what we'd ship
- `wave/N-name` — one branch per wave, e.g. `wave/1-foundation`, `wave/2-ai-capability`
- Merge to `main` only after a wave passes its validation gate

**Local-only for now.** GitHub push deferred to after Wave 5 unless Commander orders otherwise.

**Reason for new repo, not the existing `omni-browser-v4`:** The existing `omni-browser-v4` repo is the v0.1 artifact. v0.3 is a major version with structural changes. Different history, different release cadence. The v0.1 repo will be **frozen** with a `v0.1-final` tag once v0.3 ships.

---

## 4. Forbidden Files / Out of Scope

These will NOT be touched in v0.3:
- `~/Downloads/omni-browser-v4/` — the LIVING v0.1 server. Untouched. Used as regression baseline.
- `~/Documents/research-v-engine/` — the v0.1 research dump. Frozen. Read-only.
- Any external product, dashboard, billing, or auth system that consumes the V-Engine. The V-Engine is a standalone engine. Consumers are not our concern.
- Renaming V-Engine source files (the `omni-*.ts` prefix is the V-Engine's own naming convention; it predates any consumer product).
- Changing the JS/TS language or runtime (V-Engine is Node 22 + TypeScript + Playwright; stays that way).

---

## 5. Junk Removed (Transparency)

The following findings from the doc are **dropped** from v0.3 scope. Each line is a conscious decision.

| ID | Title | Why dropped |
|---|---|---|
| P1-14 | No file system access for browser | Not a V-Engine concern — out of scope for an engine that doesn't own the host file system. |
| P3-04 | No screenshot diffing | Niche feature. High effort, low demand. Defer to v0.4+. |
| P5-03 | JWT in Authorization header (cookie alt) | Cookie auth adds CSRF surface for negligible benefit over short-TTL JWT. Drop. |
| P5-10 | No token rotation (refresh flow) | Short-lived access tokens (15 min) cover the same threat model with less code. Drop. |
| P5-11 | No mTLS or client cert support | Enterprise feature, niche. Document running behind mTLS-terminating reverse proxy. Drop. |
| P8-03 | No cloud deploy manifests (multi-cloud) | V-Engine is platform-agnostic. Ship one Dockerfile + one example (Fly.io). Drop the rest. |
| P8-06 | No A/B test framework | Feature flags (P8-07) cover this with less code. Drop. |

**Net effect:** 80 findings → 73 actionable + 7 documented as "out of scope."

---

## 6. Merges (Consolidation)

To reduce surface area, the following findings are merged into single deliverables:

| Merged into | Replaces | Reason |
|---|---|---|
| **P1-09 + P1-10 + P1-11 + P1-12 + P1-13 → "Session browser context"** | 5 separate findings | All are fields on the same create-session payload. One PR. |
| **P1-04 → P1-02 batch** | (shortcut) | Keyboard shortcut is one line in the new commands list. |
| **P1-05 + P1-06 → "Smart form & scroll helpers"** | fill_form + scroll_until | Both are polling-style helpers. One module. |
| **P3-05 + P3-06 → "Session manager consolidation"** | (per-session manager) + (no CDP pool) | Both are the same architectural change. |
| **P6-03 + P6-06 → "Engine selector"** | (Chromium option) + (browserType selector) | Same feature. |
| **P2-12 + P2-13 + P2-14 → "Timeouts & watchdogs"** | (no stuck detection) + (no request timeout) + (watchdog never fires) | One timeout infrastructure. |
| **P8-04 + P2-07 → "Lifecycle management"** | (graceful restart) + (graceful shutdown) | Same signal handler. |
| **P7-05 → P1-01** | (no Nth occurrence) → click input type | Same change to the click command. |
| **P6-05 → "Remote browser support"** | (no CDP-based remote) | One feature: external browser via CDP. |

**Net effect:** 73 actionable findings → 65 implementation tasks, distributed across the 5 waves below.

---

## 7. The 5 Waves

Each wave is a milestone. Each wave ends with a passing validation gate. After every wave, the Sheet's `Status`, `Wave`, and `Date Resolved` columns are updated for findings in that wave. The self-healing log gets new entries for every bug found and fixed during the wave.

---

### Wave 1 — Foundation, Reliability & Observability
**Goal:** A V-Engine that operators can deploy, monitor, scale, and trust. Every error is typed, every status code is correct, every request has a trace, the process fails gracefully.

**Scope (covers old Waves 0, 2, 5, 8, 10):**

| Task | Source finding(s) | Notes |
|---|---|---|
| Fix V-ENGINE.md field naming: `id` → `sessionId` | P0-01 | Cheap first win, unblocks every consumer's first parse |
| Make parallel session cap configurable (env `V_ENGINE_MAX_PARALLEL_SESSIONS`, default 50) | P0-02 | |
| Consolidate the two parallel caps — one source of truth | P0-06, P2-09 | |
| LISTEN_HOST env-configurable, default 127.0.0.1 | P2-01 | Security default |
| Request body size limit (default 10MB) | P2-02 | |
| TLS support (`--tls-cert`, `--tls-key`) | P2-03 | Self-signed + PEM bundle |
| Rate limiting on auth failures | P2-04 | |
| Typed error classes → status codes (4xx/5xx mapping) | P2-05 | |
| 404 JSON for unknown /api paths | P2-06 | |
| CORS allowlist env-configurable, include localhost by default | P2-08 | |
| Per-command timeout, request timeout, watchdog (one timeout infrastructure) | P2-12, P2-13, P2-14 | |
| Emit `session.evicted` SSE event when parallel cap fires | new | Found during recon; not silent anymore |
| pino structured JSON logs | P4-01 | |
| `/metrics` Prometheus endpoint | P4-02 | |
| Request ID middleware + W3C traceparent propagation | P4-03 | |
| Unlimited actionLog + paginated GET | P4-04 | |
| Screenshots timeline endpoint | P4-05 | |
| Global event log + webhooks | P4-06 | |
| `/healthz`, `/readyz`, `/livez` | P8-01 | |
| `userId`/`tenantId` scoping (optional, backward-compat) | P8-02 | |
| Dockerfile + Fly.io example | P8-03 narrowed | |
| Feature flag system | P8-07 | Runtime-toggleable, persisted |

**Validation gate:**
- `pnpm run typecheck` passes
- `pnpm run build` passes
- `pnpm run smoke:local` passes (includes the new env vars)
- `pnpm run smoke:security` passes (rate limits, TLS, CORS)
- `pnpm run smoke:env` passes (env vars, lifecycle)
- `curl http://127.0.0.1:4012/healthz` returns 200
- `curl http://127.0.0.1:4012/metrics` returns Prometheus text
- A live test against the v0.1 server on port 4011 with the same input → same output (regression)

**Branch:** `wave/1-foundation`
**Self-heal log:** must be empty (or entries explained)
**Sheet update:** mark all Wave 1 findings as `Done` with wave tag

---

### Wave 2 — AI Capability (Commander's Vision)
**Goal:** An AI using V-Engine on a real website behaves like a human. Every basic interaction is supported. CAPTCHA is detected and handled. Anti-bot defenses are manageable.

**Scope (covers old Waves 1, 4a, 4b, 4c):**

| Task | Source finding(s) | Notes |
|---|---|---|
| **API surface — new commands** | P1-01, P1-02, P1-03, P1-04, P1-05, P1-06, P1-07, P1-08 | All the new commands (drag, scroll, hover, right_click, double_click, shortcut, clipboard_*, file_upload, file_download, screenshot_element, fill_form, scroll_until, enter_frame, exit_frame, shadow DOM, recording API) |
| **Session browser context** | P1-09..P1-13 | viewport, user_agent, device, locale, timezone, geolocation, permissions, color_scheme |
| **CAPTCHA handling** | P0-04 | `detect_captcha`, `wait_for_human`, `navigate_with_fallback`, solver-service integration (2captcha default, opt-in via `CAPTCHA_SOLVER_API_KEY`) |
| **Anti-bot stealth** | P0-05 | puppeteer-extra-plugin-stealth, randomized UA/viewport/locale/timezone, `STEALTH_LEVEL` env (off / basic / aggressive, default off) |
| **AI helpers** | P7-01, P7-02, P7-03, P7-04, P7-06 | `plan(goal)`, `execute_plan(plan_id)`, `next_step`, `describe_page` (AX tree), `find(text, fuzzy=true)`, `wait_for(predicate, timeout)` |
| **Structured error responses** | P7-07 | `code`, `message`, `hint`, `retry_after_ms` |
| **`GET /api/commands`** | P7-08 | JSON Schema dump of all commands |
| **`GET /api/sessions/:id/context`, `/console`, `/network`** | P7-09 | |
| **ClickInput with `text`, `coordinates`, `match_index`** | P1-01, P7-05 | Merged |

**Validation gate:**
- `pnpm run typecheck` passes
- `pnpm run build` passes
- `pnpm run smoke:local` passes every new command (must include end-to-end: create session → mouse-move to element → click → handle reCAPTCHA demo → screenshot)
- `pnpm run smoke:stealth` NEW: visits `https://bot.sannysoft.com/` and `https://browserleaks.com/javascript` — stealth level `basic` reduces detectable headless markers
- `pnpm run smoke:captcha` NEW: visits reCAPTCHA demo (`https://www.google.com/recaptcha/api2/demo`) — `detect_captcha` returns type + locator; `wait_for_human` pauses; `navigate_with_fallback` doesn't fail
- `GET /api/commands` returns valid JSON Schema
- A live regression test against v0.1: any old `click`/`type`/`navigate` flow that worked on v0.1 still works on v0.3

**Branch:** `wave/2-ai-capability`
**Self-heal log:** any CAPTCHA-detection false positives, stealth-detection regressions, command-shape breakages get entries
**Sheet update:** mark all Wave 2 findings as `Done`

---

### Wave 3 — Persistence & Multi-Engine
**Goal:** Sessions survive restarts. Cloud deploys are possible. The engine runs in any browser (Chromium, Firefox, WebKit) and connects to remote browsers via CDP.

**Scope (covers old Waves 3, 9):**

| Task | Source finding(s) | Notes |
|---|---|---|
| Session persistence: local-fs adapter (default) | P0-03 | `~/.v-engine-v13/sessions/` |
| Session persistence: Redis adapter (cloud) | P0-03 | Opt-in via `V_ENGINE_PERSISTENCE=redis` |
| Graceful shutdown + restart recovery | P2-07, P8-04 | SIGTERM handler, drain, reload |
| Session export/import bundles | P8-05 | tar.gz with manifest |
| Tesseract.js fallback for OCR | P6-01 | For headless + Linux servers |
| Explicit headless mode | P6-02 | `V_ENGINE_HEADLESS=true` default; `false` requires explicit opt-in |
| Engine selector: chromium / firefox / webkit | P6-03, P6-04, P6-06 | Per-session override |
| Remote browser via `connect_url` | P6-05 | Connect to existing CDP endpoint |

**Validation gate:**
- `pnpm run typecheck` passes
- `pnpm run build` passes
- `pnpm run smoke:persistence` NEW: create session → kill server with SIGTERM → restart → session still queryable
- `pnpm run smoke:export` NEW: export bundle → fresh server → import → session restored
- `pnpm run smoke:firefox` NEW: firefox engine smoke (uses Playwright's Firefox)
- `pnpm run smoke:webkit` NEW: webkit engine smoke
- `pnpm run smoke:remote` NEW: connect to a remote CDP endpoint (uses local chromium on alternate port as proxy)
- Live regression: a v0.1 session that ran in-memory still works in v0.3 in in-memory mode (backward compat)

**Branch:** `wave/3-persistence`
**Self-heal log:** any persistence race conditions, restore bugs, engine-launch failures get entries
**Sheet update:** mark all Wave 3 findings as `Done`

---

### Wave 4 — Security Hardening
**Goal:** Production-safe defaults. The engine can be exposed behind a reverse proxy without becoming a liability.

**Scope (covers old Wave 6):**

| Task | Source finding(s) | Notes |
|---|---|---|
| Refuse default JWT secret unless bound to 127.0.0.1; auto-gen in dev | P5-01 | |
| iss/aud claims | P5-02 | |
| Refuse to start in production without explicit vault key | P5-04 | NODE_ENV=production gate |
| CSRF protection | P5-05 | Token in header, SameSite=Lax cookie where applicable |
| Vault validation | P5-06 | Reject obviously weak keys |
| Remove `nle_takeover` from global; content-script bridge | P5-07 | |
| Per-IP rate limit | P5-08 | Sliding window, default 100 req/min |
| Token revocation list | P5-09 | In-memory + optional Redis |

**Validation gate:**
- `pnpm run typecheck` passes
- `pnpm run build` passes
- `pnpm run smoke:security` (extended): every path under P5-01..P5-09 exercised
- Security checklist document updated (`docs/SECURITY.md`)
- A live test: server with default JWT secret + LISTEN_HOST=0.0.0.0 → refuses to start
- A live test: server with weak vault key (e.g. `password123`) → refuses to start
- A live test: cross-origin POST without CSRF token → 403
- Live regression: a v0.1 valid token still validates in v0.3 (iss/aud additive, not breaking)

**Branch:** `wave/4-security`
**Self-heal log:** any auth failures, false 403s, CSRF edge cases get entries
**Sheet update:** mark all Wave 4 findings as `Done`

---

### Wave 5 — Performance & Polish
**Goal:** Fast, efficient, and ready to ship. Status cache, screenshot optimization, recording control, session manager consolidation with CDP pool, and final documentation.

**Scope (covers old Wave 7):**

| Task | Source finding(s) | Notes |
|---|---|---|
| Screenshot format/quality/scale options | P3-01 | JPEG quality, scale 0.5x, format=jpg |
| Record on/off + segment rotation | P3-02 | Save only what user wants |
| Status cache (5s TTL, stale-while-revalidate) | P3-03 | |
| Session manager consolidation + CDP pool | P3-05, P3-06 | One manager per engine type, not per session |
| Emit `frustration_handoff` SSE event | P2-10 | New capability, added here |
| Final `docs/`: V-ENGINE.md rewrite, SECURITY.md, ARCHITECTURE.md, DEPLOY.md | new | All from current build state |
| Final smoke suite: combine all smoke:* into one `pnpm run smoke:all` | new | One-shot validation |
| CHANGELOG.md entry per wave | new | |
| Self-healing log: review and decide what becomes tests | new | Distill every log entry into either a test or a docs note |

**Validation gate:**
- `pnpm run typecheck` passes
- `pnpm run build` passes
- `pnpm run smoke:all` passes (every smoke:* in one run)
- Latency benchmark: 100 sequential commands in < 30s on a 4-core machine
- Screenshot at quality 80 is < 100KB for a typical page
- CDP pool reuses connections — 10 parallel sessions use 1 Chromium, not 10
- Full docs site renders correctly (just markdown, no VitePress needed)
- CHANGELOG.md lists all 5 waves with diff stats
- Live regression: a v0.1 + v0.3 side-by-side run on the same input → v0.3 is at least as fast

**Branch:** `wave/5-performance-polish`
**Self-heal log:** reviewed and either-rolled-into-tests or moved-to-known-issues
**Sheet update:** mark ALL findings as `Done` (anything left = `Deferred to v0.4`)

**Final ship:** Tag `v0.3.0` on `main`. Freeze `omni-browser-v4` with `v0.1-final` tag.

---

## 8. Validation Strategy

Every wave ends with a green validation gate before merging to `main`. Gates are layered:

1. **Static:** `pnpm run typecheck` must pass.
2. **Build:** `pnpm run build` must succeed.
3. **Smoke suites (per wave):** New `pnpm run smoke:*` targets for the wave's domain. All pass.
4. **Live regression:** A live `curl` against the running v0.1 server on port 4011 with the same input as a v0.3 wave test. Outputs compared. Any v0.1 behavior that breaks in v0.3 is a regression — must be justified or reverted.
5. **Sheet update:** Wave's findings have their `Status` set to `Done` in the Sheet, with the wave number, commit hash, and date in `Notes`.
6. **Self-heal log review:** Every entry from the wave's work has been either turned into a regression test, documented in known-issues, or fixed and verified.

The pre-existing smoke tests are the safety net. We add new tests in the same files (`tests/smoke/`) for every new command.

**Self-heal discipline:** If a build fails, a smoke test fails, or a regression is found, fix it IMMEDIATELY in the same branch before moving to the next task. Document every fix in `notes/SELF-HEALING.md` with: timestamp, symptom, root cause, fix, test added. This is part of the V-Engine deliverable.

---

## 9. Rollback Plan

- **Per-wave rollback:** Every wave ships on its own branch. If a wave is bad, `git revert <merge-commit>` on `main` and the engine is back to the previous state. Sheet `Status` reverts to `In Progress`.
- **Whole-project rollback:** If we need to abandon v0.3 entirely, the v0.1 server on port 4011 is untouched. Users fall back to v0.1. The new `v-engine-v13` repo is deleted; research-v-engine dump is still intact.
- **Database/storage rollback:** v0.3 introduces persistence; v0.1 has none. The persistence store (`~/.v-engine-v13/sessions/` or Redis) is namespaced. Deleting the dir or `FLUSHDB` reverts cleanly.

---

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| 5 waves × ~13 tasks each = scope is still big | High | High | Strict per-wave gates; refuse to start wave N+1 if wave N is not green. Self-heal in place. |
| Breaking change to API surface | Medium | High | Versioned API: new commands are additive. Old `selector`-only `click` still works. |
| CAPTCHA solver integration blocks on legal review | Medium | Medium | Stub the integration; ship `wait_for_human` first (no third party). 2captcha as opt-in. |
| Anti-bot stealth breaks real-user sites | Medium | Medium | `STEALTH_LEVEL=off` by default. Opt-in. |
| Persistence adds latency | Low | Medium | Cache reads; async writes. Benchmark in Wave 5. |
| Multi-tenant scoping breaks existing consumers | Low | High | Add `userId`/`tenantId` as optional fields. Existing sessions are unscoped. |
| mTLS dropped → enterprise customer pushback | Low | Low | Document reverse-proxy path in deployment guide. |
| Self-healing log becomes noise | Medium | Low | Discipline: every entry → test or docs or known-issue. Review at end of each wave. |

---

## 11. Sequencing Rationale

The 5 waves are ordered so each is a meaningful, shippable milestone, and Commander's vision is delivered in Wave 2 (the second checkpoint).

- **Wave 1 (Foundation) first:** everything needed to deploy, monitor, and operate. Without this, we can't even measure whether later waves work.
- **Wave 2 (AI Capability) second:** Commander's #1 ask. Delivered as a single coherent block so the "wow moment" lands on the second checkpoint.
- **Wave 3 (Persistence) third:** makes the engine cloud-deployable. Important for the multi-tenant use case.
- **Wave 4 (Security) fourth:** gates the engine from being exposed. Can wait until we're sure the engine works.
- **Wave 5 (Performance & Polish) last:** perf and docs. Nothing should block; only refine.

**Order: 1 → 2 → 3 → 4 → 5.**

---

## 12. Questions for Commander (will be asked between waves as needed)

Currently no blocking questions for Wave 1. Will surface any blockers immediately when they arise.

Deferred-question bank (asked only when reached):
1. Persistence storage: local-fs only for Wave 3, or also ship Redis adapter? — Default plan: ship both.
2. CAPTCHA solver provider: 2captcha default, or another? — Default plan: 2captcha.
3. STEALTH_LEVEL default: `off` (opt-in) or `basic` (always on)? — Default plan: `off` (opt-in) for safety.
4. Working repo on GitHub: when to push? — Default plan: after Wave 5.
5. `omni-browser-v4` freeze timing: now or after Wave 5? — Default plan: after Wave 5.
6. Docs site: VitePress / Docusaurus / plain markdown? — Default plan: plain markdown in `docs/`.
7. Multi-tenant scoping: how aggressive? — Default plan: optional fields, backward-compat.

---

## 13. Build & Self-Heal Methodology

This is the operational standard. **Mandatory for every wave.**

### Per-task loop
1. Pick a task from the wave's scope table.
2. Read the relevant source file(s).
3. Make the smallest correct change.
4. Write or extend a test for the change.
5. Run the test. If it fails → **self-heal**: fix the code, retest, repeat until green.
6. If a bug is found, add an entry to `notes/SELF-HEALING.md` BEFORE moving on.
7. Commit on the wave branch with a descriptive message.
8. Move to the next task.

### Per-wave gate
1. All tasks complete.
2. All smoke:* suites for the wave pass.
3. Live regression vs v0.1 passes.
4. Self-heal log reviewed: every entry has a corresponding test OR is documented as known-issue.
5. Sheet updated for the wave's findings.
6. Wave journal written: `notes/wave-N.md` with decisions, blockers, outcomes.
7. **Stop and report to Commander.** Ask any blocking questions.
8. Wait for Commander's go-ahead before starting the next wave.

### Self-heal log format (`notes/SELF-HEALING.md`)
```
## [YYYY-MM-DD HH:MM] [Task ID] — [one-line symptom]
- Root cause: [what was actually wrong]
- Fix: [what I changed]
- Test: [the test that now catches this]
- Status: fixed
```

### Anti-patterns (forbidden)
- Skipping tests because "they probably work."
- Reverting a test because it fails (instead of fixing the code).
- Bundling multiple unrelated changes in one commit.
- Merging to `main` with any red smoke suite.
- Starting the next wave without a green gate on the previous one.
- Forgetting to update the Sheet.
- Hiding regressions.

---

## 14. What Happens Now (Wave 1 Kickoff)

1. Create the working repo at `~/Documents/v-engine-v13/`, init git, copy v0.1 source as commit 1.
2. Run v0.1 smoke tests against the new working copy to prove the baseline is green.
3. Create `wave/1-foundation` branch.
4. Create `notes/SELF-HEALING.md` and `notes/wave-1.md`.
5. Work Wave 1 task by task, build + test + self-heal.
6. Update the Sheet as findings are completed.
7. At end of Wave 1, stop and report to Commander.
8. **WAIT for Commander's go-ahead before starting Wave 2.**

---

**No wave starts without a green gate on the previous wave. No silent scope changes. No skipping the Sheet update. No skipping the self-heal log. No skipping the wave journal.**
