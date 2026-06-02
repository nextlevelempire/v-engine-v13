import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";

process.env.OMNI_HOME = path.resolve(".omni-smoke-home");

const { startStandaloneServer } = await import("../src/server/local-server.js");

const port = 4311;
const server = await startStandaloneServer(port);

try {
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  const payload = (await response.json()) as { ok?: boolean; transport?: string };
  assert.equal(payload.ok, true);
  assert.equal(payload.transport, "http+sse");
  console.log("local smoke ok");
} finally {
  server.close();
  await once(server, "close");
}
