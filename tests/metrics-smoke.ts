/**
 * Unit test for the Prometheus metrics module (P4-02).
 */
import assert from "node:assert/strict";
import { metrics, renderPrometheus, resetMetrics } from "../src/server/metrics.js";

resetMetrics();

// Increment some counters
metrics.httpRequestsTotal.inc({ method: "GET", path: "/api/health", status: "200" });
metrics.httpRequestsTotal.inc({ method: "GET", path: "/api/health", status: "200" });
metrics.httpRequestErrorsTotal.inc({ method: "POST", path: "/api/sessions", status: "401" });
metrics.sessionsCreatedTotal.inc();
metrics.sessionsEvictedTotal.inc({ reason: "parallel_cap" });
metrics.bodyTooLargeTotal.inc();
metrics.requestTimeoutsTotal.inc();
metrics.rateLimitedTotal.inc({ scope: "auth" });
metrics.sessionsActive.set(3);

const out = renderPrometheus();

// Required metric lines
assert.match(out, /# TYPE omni_http_requests_total counter/, "must declare http_requests_total");
assert.match(out, /omni_http_requests_total\{method="GET",path="\/api\/health",status="200"\} 2/, "counter increments by 2");
assert.match(out, /# TYPE omni_http_request_errors_total counter/);
assert.match(out, /omni_http_request_errors_total\{method="POST",path="\/api\/sessions",status="401"\} 1/);
assert.match(out, /# TYPE omni_sessions_active gauge/);
assert.match(out, /omni_sessions_active 3/, "gauge set to 3");
assert.match(out, /# TYPE omni_sessions_created_total counter/);
assert.match(out, /omni_sessions_created_total 1/);
assert.match(out, /# TYPE omni_sessions_evicted_total counter/);
assert.match(out, /omni_sessions_evicted_total\{reason="parallel_cap"\} 1/);
assert.match(out, /# TYPE omni_body_too_large_total counter/);
assert.match(out, /omni_body_too_large_total 1/);
assert.match(out, /# TYPE omni_request_timeouts_total counter/);
assert.match(out, /omni_request_timeouts_total 1/);
assert.match(out, /# TYPE omni_rate_limited_total counter/);
assert.match(out, /omni_rate_limited_total\{scope="auth"\} 1/);

// Counter families share the same name → inc accumulates
const before = metrics.httpRequestsTotal;
before.inc({ method: "GET", path: "/api/health", status: "200" });
const out2 = renderPrometheus();
assert.match(out2, /omni_http_requests_total\{method="GET",path="\/api\/health",status="200"\} 3/, "same family increments cumulatively");

// Reset
resetMetrics();
const out3 = renderPrometheus();
// After reset, zero values
assert.match(out3, /omni_http_requests_total 0/);
assert.match(out3, /omni_sessions_active 0/);

console.log("metrics unit test ok");
