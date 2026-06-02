import fs from "node:fs";
import { getOmniStandaloneService } from "../../../../src/server/service.js";
import { writeJson } from "../../../../src/server/vercel-helpers.js";
import { requireGrant } from "../../../../src/server/vercel-runtime.js";

export default async function handler(req: any, res: any): Promise<void> {
  if (req.method !== "GET") {
    writeJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const sessionId = String(req.query?.id ?? "");
  const artifactId = String(req.query?.artifactId ?? "");
  const { claims } = requireGrant(req, "artifacts.read", sessionId);
  const service = getOmniStandaloneService();
  const artifact = service.getArtifact(sessionId, artifactId, claims.sub);
  if (!artifact) {
    writeJson(res, 404, { error: "Artifact not found" });
    return;
  }

  const targetPath = typeof artifact.path === "string" ? artifact.path : null;
  if (targetPath && fs.existsSync(targetPath)) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(fs.readFileSync(targetPath));
    return;
  }

  writeJson(res, 200, artifact);
}
