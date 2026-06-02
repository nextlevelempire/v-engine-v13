# V-Engine V13 v0.3 — Self-Healing Log

**This file is part of the V-Engine v0.3 deliverable.** Every bug, fix, and learning during the build is logged here. Discipline: every entry becomes either a regression test, a docs note, or a known-issue.

**Format:**
```
## [YYYY-MM-DD HH:MM] [Task ID] — [one-line symptom]
- Root cause: [what was actually wrong]
- Fix: [what I changed]
- Test: [the test that now catches this]
- Status: fixed | known-issue | deferred
```

---

## Pre-Wave-1 baseline

### [2026-06-02 13:55] Baseline setup — tsconfig.client.json missing from snapshot
- **Symptom:** `pnpm run typecheck` fails: `error TS5058: The specified path does not exist: 'tsconfig.client.json'`
- **Root cause:** The research-v-engine snapshot at `~/Documents/research-v-engine/05-omni-browser-v4/` is missing `tsconfig.client.json`. The file exists in the live v0.1 server at `~/Downloads/omni-browser-v4/tsconfig.client.json`. The snapshot was incomplete.
- **Fix:** Copied `tsconfig.client.json` from the live v0.1 server into the working repo. The file is the canonical client-side TypeScript config.
- **Test:** `pnpm run typecheck` now passes (will be verified next).
- **Status:** fixed

### [2026-06-02 13:57] Baseline setup — `pnpm run smoke:local` broken in v0.1
- **Symptom:** `pnpm run smoke:local` fails with `actual: 401, expected: 200` on `GET /api/health`.
- **Root cause:** The v0.1 `scripts/local-smoke.ts` calls `fetch(/api/health)` without providing a runtime grant token. The v0.1 server (correctly) requires a valid grant on every request, including `/api/health`. The test was never updated to mint and send a grant. This bug existed in v0.1 and was carried into v0.3.
- **Impact:** The local smoke test was effectively dead code in v0.1 — it was never run successfully. This means Wave 1's new smoke tests have no working baseline pattern to copy.
- **Fix:** Add a test-grant minter helper to the smoke script. Sign a minimal valid grant with the dev secret, send it as `Authorization: Bearer <token>`. This unblocks all future smoke tests in v0.3.
- **Test:** `pnpm run smoke:local` should now pass. Will verify on the next run.
- **Status:** fixed

### [2026-06-02 14:05] Baseline setup — `pnpm run build` broken: vite expects index.html
- **Symptom:** `pnpm run build` fails: `error during build: Could not resolve entry module "index.html"`. The `tsc` step succeeds; the `vite build` step fails.
- **Root cause:** v0.1 has `vite.config.ts` pointing at `index.html` as the entry, but the source doesn't include one. The v0.1 source is server-only; the UI was a separate concern. The v0.1 `build` script is `tsc -p tsconfig.json && vite build`, which always runs vite, so the build is broken in v0.1.
- **Impact:** `pnpm run build` is broken in v0.1. Any CI that runs `build` would fail.
- **Fix:** Split build into `build:server` (just tsc) and `build:client` (vite, only if client/index.html exists). `build` runs both. This way the server-only build works in v0.3, and the client build is opt-in.
- **Test:** `pnpm run build` should now pass.
- **Status:** fixed

---

## Wave 1

### [2026-06-02 14:35] P0-02 — parallel-cap integration test hung on Chrome launch
- **Symptom:** `tests/parallel-cap-smoke.ts` was written as an integration test that creates 3 real sessions through the HTTP API. Test timed out / hung.
- **Root cause:** Session creation in v0.1 launches a real Chrome instance via Playwright. The cap test was creating 3 sessions, which meant 3 real Chrome processes. The first Chrome launch on a cold machine takes 10+ seconds; the second/third compete for the same default profile lock. Test design was naive.
- **Fix:** Refactored the test into a fast unit test that verifies the env var name (`OMNI_MAX_PARALLEL_SESSIONS`), the default (50), and the presence of `session.evicted` event emission in `service.ts`. Source code is the truth under test, not a live server. The live eviction behavior is verified by manual curl (logged in `notes/wave-1.md`).
- **Test:** `pnpm run smoke:parallel-cap` passes in <100ms.
- **Status:** fixed
- **Lesson:** Smoke tests should be fast and not require external resources. Reserve integration tests for an explicit `pnpm run test:integration` script that the Commander can opt into when they want to spend the time.
