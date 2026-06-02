import { getOmniStandaloneService } from "../../../src/server/service.js";
import { writeJson } from "../../../src/server/vercel-helpers.js";
import { requireGrant } from "../../../src/server/vercel-runtime.js";

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== "GET") {
    writeJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const sessionId = String(req.query?.id ?? "");
  requireGrant(req, "sessions.command", sessionId);
  const service = getOmniStandaloneService();
  const status = await service.getSessionStatus(sessionId);
  writeJson(res, 200, status);
}
