import { getOmniStandaloneService } from "../../../src/server/service.js";
import { readBody, writeJson } from "../../../src/server/vercel-helpers.js";
import { readRemoteAddress, requireGrant } from "../../../src/server/vercel-runtime.js";

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const sessionId = String(req.query?.id ?? "");
  const { claims } = requireGrant(req, "sessions.command", sessionId);
  const payload = readBody(req);
  const service = getOmniStandaloneService();
  const result = await service.executeCommand(sessionId, payload as any, {
    agentId: claims.sub,
    ip: readRemoteAddress(req),
    orgId: claims.orgId,
    userAgent: req.headers["user-agent"] || null,
    userId: claims.sub,
  });
  writeJson(res, 200, result);
}
