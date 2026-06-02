import { writeJson } from "../src/server/vercel-helpers.js";
import { buildHealthPayload } from "../src/server/vercel-runtime.js";

export default async function handler(_req: any, res: any): Promise<void> {
  writeJson(res, 200, buildHealthPayload());
}
