import { getOmniStandaloneService } from "../../../src/server/service.js";
import { writeJson } from "../../../src/server/vercel-helpers.js";
import { requireGrant } from "../../../src/server/vercel-runtime.js";

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const serviceName = String(req.query?.service ?? "");
  const { claims } = requireGrant(req, "vault.read");
  const service = getOmniStandaloneService();
  writeJson(res, 200, service.loadVaultPayload(serviceName, claims.sub) ?? {});
}
