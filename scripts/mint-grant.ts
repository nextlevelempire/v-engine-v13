/**
 * CLI: mint a runtime grant for the local engine.
 * Prints the token + ready-to-paste curl commands.
 *
 * Usage: pnpm run mint-grant
 * Env:   OMNI_HOME (defaults to ~/.omni-browser)
 */
import fs from "node:fs";
import path from "node:path";
import { mintRuntimeGrant } from "../src/server/runtime-grant.js";
import { getDaemonStateDir } from "../src/utils/omni-paths.js";

const HOME = process.env.OMNI_HOME ?? path.join(process.env.HOME ?? "~", ".omni-browser");
const PORT = process.env.PORT ?? "4011";
const ORG = process.env.OMNI_GRANT_ORG ?? "operator";
const SUB = process.env.OMNI_GRANT_SUB ?? "operator-cli";
const TTL = Number(process.env.OMNI_GRANT_TTL ?? 600);

const daemonPath = path.join(getDaemonStateDir(), "daemon-instance.json");
if (!fs.existsSync(daemonPath)) {
  console.error(`[mint-grant] no daemon-instance.json at ${daemonPath}`);
  console.error(`[mint-grant] is the engine running? try: PORT=${PORT} node dist/src/cli.js serve`);
  process.exit(1);
}
const { daemonInstanceId } = JSON.parse(fs.readFileSync(daemonPath, "utf8"));

const token = mintRuntimeGrant({
  daemonInstanceId,
  orgId: ORG,
  sub: SUB,
  scopes: [
    "runtime.attach",
    "sessions.create",
    "sessions.read",
    "sessions.command",
    "artifacts.read",
    "vault.read",
    "vault.write",
  ],
  ttlSeconds: TTL,
});

console.log(`# V-Engine runtime grant (org=${ORG} sub=${SUB} ttl=${TTL}s)`);
console.log(`# engine: http://127.0.0.1:${PORT}`);
console.log(`# daemonInstanceId: ${daemonInstanceId}`);
console.log();
console.log(`export OMNI_TOKEN='${token}'`);
console.log();
console.log(`# Quick checks:`);
console.log(`curl -s -H "Authorization: Bearer $OMNI_TOKEN" http://127.0.0.1:${PORT}/api/whoami`);
console.log(`curl -s -H "Authorization: Bearer $OMNI_TOKEN" http://127.0.0.1:${PORT}/api/commands | head -c 200`);
console.log();
console.log(`# Create a session:`);
console.log(`curl -s -X POST -H "Authorization: Bearer $OMNI_TOKEN" -H "content-type: application/json" \\`);
console.log(`  -d '{"objective":"hello","viewport":{"width":1280,"height":800}}' \\`);
console.log(`  http://127.0.0.1:${PORT}/api/sessions`);
