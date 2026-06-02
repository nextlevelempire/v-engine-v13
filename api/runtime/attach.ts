import { writeJson } from "../../src/server/vercel-helpers.js";
import { requireGrant } from "../../src/server/vercel-runtime.js";

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== "POST") {
    writeJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const { claims, daemonInstanceId } = requireGrant(req, "runtime.attach");
  writeJson(res, 200, {
    attached: true,
    claims,
    daemonInstanceId,
  });
}
