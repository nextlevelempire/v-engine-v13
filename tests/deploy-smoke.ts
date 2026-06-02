/**
 * Unit test for Dockerfile + Fly.io deployment (P8-03).
 * Verifies the deliverable files exist and contain required patterns.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(process.cwd());

// Files exist
const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
const flyToml = fs.readFileSync(path.join(repoRoot, "fly.toml"), "utf8");
const envExample = fs.readFileSync(path.join(repoRoot, ".env.production.example"), "utf8");

// Dockerfile
assert.match(dockerfile, /FROM node:22/, "Dockerfile must use node:22 base image");
assert.match(dockerfile, /multi-stage|AS build|AS runtime/, "Dockerfile must use multi-stage build");
assert.match(dockerfile, /playwright|chromium|gbm/, "Dockerfile must install Chromium runtime deps");
assert.match(dockerfile, /USER omni|useradd/, "Dockerfile must drop to non-root user");
assert.match(dockerfile, /HEALTHCHECK/, "Dockerfile must have a HEALTHCHECK directive");
assert.match(dockerfile, /\/livez/, "HEALTHCHECK must hit /livez probe");
assert.match(dockerfile, /tini/, "Dockerfile must use tini as PID 1 for zombie reaping");
assert.match(dockerfile, /EXPOSE 4011/, "Dockerfile must expose port 4011");
assert.match(dockerfile, /OMNI_LISTEN_HOST=0\.0\.0\.0/, "Dockerfile must default to 0.0.0.0 bind");
assert.match(dockerfile, /dist\/src\/cli\.js/, "Dockerfile must run the built server");

// fly.toml
assert.match(flyToml, /app = "v-engine"|app = ".*"/, "fly.toml must declare app name");
assert.match(flyToml, /primary_region/, "fly.toml must declare primary region");
assert.match(flyToml, /internal_port = 4011/, "fly.toml must serve on internal_port 4011");
assert.match(flyToml, /path = "\/livez"/, "fly.toml healthcheck must use /livez");
assert.match(flyToml, /source = "v_engine_data"/, "fly.toml must mount a volume for /data");
assert.match(flyToml, /\[mounts\]/, "fly.toml must declare mounts section");
assert.match(flyToml, /services\.http_checks/, "fly.toml must declare HTTP health checks");
assert.match(flyToml, /services\.tcp_checks/, "fly.toml must declare TCP health checks");

// .env.production.example
assert.match(envExample, /OMNI_DASHBOARD_JWT_SECRET=/, "env example must show JWT secret");
assert.match(envExample, /OMNI_DAEMON_INSTANCE_ID=/, "env example must show daemon id");
assert.match(envExample, /OMNI_WEBHOOK_URL=/, "env example must show webhook URL");
assert.match(envExample, /OMNI_TENANT_SCOPING=off/, "env example must show tenant scoping default");

console.log("deploy-artifacts unit test ok");
