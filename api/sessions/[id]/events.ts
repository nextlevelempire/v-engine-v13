import { getOmniStandaloneService } from "../../../src/server/service.js";
import { openSse, writeEvent, writeJson } from "../../../src/server/vercel-helpers.js";
import { requireGrant } from "../../../src/server/vercel-runtime.js";

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== "GET") {
    writeJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const sessionId = String(req.query?.id ?? "");
  requireGrant(req, "sessions.command", sessionId);
  const service = getOmniStandaloneService();
  const unsubscribe = service.subscribe(sessionId, (event) => {
    writeEvent(res, event);
  });
  openSse(req, res, sessionId, unsubscribe);
}
