import { getOmniStandaloneService } from "../../../src/server/service.js";
import { readBody, writeJson } from "../../../src/server/vercel-helpers.js";
import { requireGrant } from "../../../src/server/vercel-runtime.js";

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const serviceName = String(req.query?.service ?? "");
  const { claims } = requireGrant(req, "vault.write");
  const payload = readBody(req);
  const service = getOmniStandaloneService();
  writeJson(res, 200, service.saveVaultPayload(serviceName, claims.sub, payload as any, claims.orgId));
}
