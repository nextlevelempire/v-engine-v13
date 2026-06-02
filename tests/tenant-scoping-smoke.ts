/**
 * Unit test for userId/tenantId scoping (P8-02).
 */
import assert from "node:assert/strict";
import fs from "node:fs";

const localSrc = fs.readFileSync("src/server/local-server.ts", "utf8");
const grantSrc = fs.readFileSync("src/server/runtime-grant.ts", "utf8");

// Env var
assert.match(localSrc, /OMNI_TENANT_SCOPING/, "must reference OMNI_TENANT_SCOPING");
assert.match(localSrc, /TENANT_SCOPING/, "must have TENANT_SCOPING flag");

// whoami endpoint
assert.match(localSrc, /url\.pathname === "\/api\/whoami"/, "must have /api/whoami endpoint");
assert.match(localSrc, /tenantId: claims\.orgId/, "whoami must alias orgId as tenantId");

// orgId exists in the grant claims
assert.match(grantSrc, /orgId: input\.orgId/, "grant must accept orgId on mint");
assert.match(grantSrc, /orgId: string/, "grant claims must include orgId field");

// Service-level scoping (userId in listSessions)
const serviceSrc = fs.readFileSync("src/server/service.ts", "utf8");
assert.match(serviceSrc, /filter\.orgId.*record\.orgId/, "listSessions must filter by orgId");
assert.match(serviceSrc, /filter\.userId.*record\.userId/, "listSessions must filter by userId");

console.log("tenant-scoping unit test ok");
