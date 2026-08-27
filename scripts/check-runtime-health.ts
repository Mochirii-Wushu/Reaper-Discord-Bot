import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { validateGatewayHealthDocument } from "../src/runtime-health.js";

const path = String(process.argv[2] || process.env.REAPER_HEALTH_STATE_PATH || "")
  .trim();
const maximumAgeMs = Number(
  process.env.REAPER_HEALTH_MAX_AGE_MS || "90000",
);

if (!path || !isAbsolute(path)) {
  throw new Error("Provide an absolute gateway readiness path.");
}
if (
  !Number.isInteger(maximumAgeMs) ||
  maximumAgeMs < 30_000 ||
  maximumAgeMs > 900_000
) {
  throw new Error("REAPER_HEALTH_MAX_AGE_MS must be 30000 through 900000.");
}

const document = validateGatewayHealthDocument(
  JSON.parse(await readFile(path, "utf8")),
);
const ageMs = Date.now() - Date.parse(document.observedAt);
if (document.status !== "ready" || ageMs < 0 || ageMs > maximumAgeMs) {
  throw new Error("Gateway readiness is stale or not ready.");
}

console.log("Gateway readiness is current.");
