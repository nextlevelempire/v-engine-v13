# V-Engine V13 v0.3

**This is the working repo for the v0.3 build of the V-Engine.** It is a copy of the v0.1 source (from `~/Documents/research-v-engine/05-omni-browser-v4/`) and is being incrementally improved through 5 implementation waves.

**Status:** Wave 1 — Foundation, Reliability & Observability — IN PROGRESS

**Commander:** Supreme Commander
**Engineer:** General Max
**Started:** 2026-06-02

---

## What this is

The V-Engine is a standalone browser-automation runtime. It exposes an HTTP+SSE API for creating browser sessions, driving them with mouse/keyboard commands, observing them via screenshots, and persisting state. v0.3 makes it production-grade: configurable, observable, secure, persistent, and operable by an AI the way a human uses a browser.

## What this is NOT

- Not a fork of the V-Engine — this is a fresh working repo.
- Not a consumer of OMNI GPT, the dashboard, billing, or auth — the V-Engine is a standalone engine.
- Not the v0.1 source — v0.1 is frozen at `~/Documents/research-v-engine/05-omni-browser-v4/`.

## Implementation plan

5 waves. See `V13-IMPLEMENTATION-PLAN.md` (also as Google Doc: https://docs.google.com/document/d/1wFPk9ih_nIpS3vZNY0hqXi3JEivjtHY_i784LbXByJ8/edit).

1. **Wave 1 — Foundation, Reliability & Observability (24 findings)** — current
2. **Wave 2 — AI Capability, Commander's Vision (24 findings)**
3. **Wave 3 — Persistence & Multi-Engine (7 findings)**
4. **Wave 4 — Security Hardening (9 findings)**
5. **Wave 5 — Performance & Polish (10 findings)**

## Live regression baseline

The v0.1 server runs on `127.0.0.1:4011` (PID 54357). It is the regression baseline for every wave. **DO NOT TOUCH** `~/Downloads/omni-browser-v4/`.

This v0.3 dev server uses port `4012` (configurable via `PORT` env var).

## Build & test

```bash
pnpm install
pnpm run typecheck
pnpm run build
pnpm run smoke:local
pnpm run smoke:security
pnpm run smoke:env
```

## Methodology (per Commander directive 2026-06-02)

Build → test → self-heal in place. If a build or test fails, fix it before moving on. Document every fix in `notes/SELF-HEALING.md`. Every wave ends with a green validation gate. Wave journals in `notes/wave-N.md`.

## Out of scope (deferred to v0.4+)

- P1-14 File system access
- P3-04 Screenshot diffing
- P5-03 Cookie auth alternative
- P5-10 Token rotation / refresh flow
- P5-11 mTLS / client certs (use a reverse proxy)
- P8-06 A/B testing framework (feature flags cover it)
