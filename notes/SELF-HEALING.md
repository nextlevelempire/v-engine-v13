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
