import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";

process.env.OMNI_HOME = path.resolve(".omni-smoke-home");

const { startStandaloneServer } = await import("../src/server/local-server.js");
const { mintRuntimeGrant } = await import("../src/server/runtime-grant.js");
const { getDaemonStateDir } = await import("../src/utils/omni-paths.js");

const port = 4311;
const server = await startStandaloneServer(port);

// Read the daemon instance id that the server just minted.
const daemonInstancePath = path.join(getDaemonStateDir(), "daemon-instance.json");
const daemonInstanceId = JSON.parse(fs.readFileSync(daemonInstancePath, "utf8")).daemonInstanceId;

const token = mintRuntimeGrant({
  daemonInstanceId,
  orgId: "smoke-org",
  sub: "smoke-user",
  scopes: ["runtime.attach", "sessions.create", "vault.read", "vault.write", "sessions.read"],
  ttlSeconds: 300,
});

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200, `health expected 200 got ${response.status}`);
  const payload = (await response.json()) as { ok?: boolean; transport?: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.transport, "http+sse");
  console.log("local smoke ok");
} finally {
  server.close();
  await once(server, "close");
}
