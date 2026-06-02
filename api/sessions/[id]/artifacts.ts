import { getOmniStandaloneService } from "../../../src/server/service.js";
import { writeJson } from "../../../src/server/vercel-helpers.js";
import { requireGrant } from "../../../src/server/vercel-runtime.js";

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== "GET") {
    writeJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const sessionId = String(req.query?.id ?? "");
  const { claims } = requireGrant(req, "artifacts.read", sessionId);
  const service = getOmniStandaloneService();
  writeJson(res, 200, { artifacts: service.listArtifacts(sessionId, claims.sub) });
}
