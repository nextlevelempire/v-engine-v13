# Wave 1 — Foundation, Reliability & Observability

**Date:** 2026-06-02
**Status:** IN PROGRESS
**Branch:** `wave/1-foundation`
**Findings covered:** 24 (see Tracker Sheet Wave column)

## Scope (from V13-IMPLEMENTATION-PLAN.md §7)

1. V-ENGINE.md field rename: `id` → `sessionId` (P0-01)
2. Parallel session cap configurable (P0-02, P0-06, P2-09)
3. Operational env vars (P2-01..02-08, P2-12..14)
4. Typed errors + status codes (P2-05)
5. Structured logging (P4-01)
6. /metrics Prometheus endpoint (P4-02)
7. Request ID + trace propagation (P4-03)
8. actionLog + screenshots timeline (P4-04, P4-05)
9. Webhooks (P4-06)
10. Healthz/readyz/livez (P8-01)
11. userId/tenantId scoping (P8-02)
12. Dockerfile + Fly.io example (P8-03 narrowed)
13. Feature flag system (P8-07)
14. session.evicted SSE event (new, found during recon)

## Decisions

### [Task 1] P0-01 — V-ENGINE.md field rename / create
- The v0.1 source has no V-ENGINE.md (it has README.md, which is project intro, not API ref). The v0.2 finding P0-01 was misnamed — it's really "create V-ENGINE.md as a proper API reference, with `sessionId` field naming."
- Created `V-ENGINE.md` at the working repo root (113 lines).
- Documented: all field names, all endpoints, env vars, error shape, SSE event types.
- Verified: live curl on `POST /api/sessions` returns response with `sessionId: "22d4daca-..."` (not `id`).
- Regression: v0.1 source code already uses `sessionId` — no code change needed. Doc-only fix.

## Blockers

- (filled in as we go)

## Outcomes

- (filled in at end of wave)
