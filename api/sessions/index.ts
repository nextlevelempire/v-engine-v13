import { getOmniStandaloneService } from "../../src/server/service.js";
import { readBody, writeJson } from "../../src/server/vercel-helpers.js";
import { requireGrant } from "../../src/server/vercel-runtime.js";

export default async function handler(req: any, res: any): Promise<void> {
  const service = getOmniStandaloneService();

  if (req.method === "GET") {
    const { claims } = requireGrant(req, "sessions.create");
    writeJson(res, 200, { sessions: service.listSessions({ orgId: claims.orgId, userId: claims.sub }) });
    return;
  }

  if (req.method === "POST") {
    const { claims } = requireGrant(req, "sessions.create");
    const payload = readBody(req);
    const session = await service.createSession({
      agentId: claims.sub,
      creditBudget:
        typeof payload.creditBudget === "number" ? payload.creditBudget : (claims.creditBudget ?? 0),
      objective: typeof payload.objective === "string" ? payload.objective : null,
      operatorSessionId:
        typeof payload.operatorSessionId === "number" ? payload.operatorSessionId : null,
      orgId: claims.orgId,
      persistent: payload.persistent === true,
      policyVersion:
        typeof payload.policyVersion === "string" ? payload.policyVersion : claims.policyVersion,
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : claims.sessionId,
      userId: claims.sub,
    });
    writeJson(res, 201, session);
    return;
  }

  writeJson(res, 405, { error: "Method not allowed" });
}
