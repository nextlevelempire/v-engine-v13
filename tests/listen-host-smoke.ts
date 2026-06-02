import assert from "node:assert/strict";
import { once } from "node:events";
import path from "node:path";

process.env.OMNI_HOME = path.resolve(".omni-smoke-home");

const { startStandaloneServer } = await import("../src/server/local-server.js");

// Default: bind to 127.0.0.1 (loopback only — security default)
delete process.env.OMNI_LISTEN_HOST;
const port = 4321;
const server = await startStandaloneServer(port);
try {
  const address = server.address();
  const boundAddress = typeof address === "string" ? address : address?.address;
  assert.equal(boundAddress, "127.0.0.1", `default host should be 127.0.0.1, got ${boundAddress}`);
  console.log("default host ok (127.0.0.1)");
} finally {
  server.close();
  await once(server, "close");
}

console.log("listen-host smoke ok");
