import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { validateGatewayHealthDocument } from "./runtime-health.js";

const MAX_HEALTH_DOCUMENT_BYTES = 4 * 1024;

async function assertContainerReady(): Promise<void> {
  const path = String(process.env.REAPER_HEALTH_STATE_PATH || "").trim();
  const maximumAgeMs = Number(
    process.env.REAPER_HEALTH_MAX_AGE_MS || "90000",
  );
  if (!path || !isAbsolute(path)) {
    throw new Error("Gateway readiness path is invalid.");
  }
  if (
    !Number.isInteger(maximumAgeMs) || maximumAgeMs < 30_000 ||
    maximumAgeMs > 900_000
  ) throw new Error("Gateway readiness age is invalid.");

  const handle = await open(path, "r");
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() || metadata.size < 2 ||
      metadata.size > MAX_HEALTH_DOCUMENT_BYTES
    ) throw new Error("Gateway readiness file is invalid.");
    const buffer = Buffer.alloc(metadata.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) {
      throw new Error("Gateway readiness read was incomplete.");
    }
    const source = buffer.toString("utf8");
    if (!source.endsWith("\n") || source.includes("\uFFFD")) {
      throw new Error("Gateway readiness encoding is invalid.");
    }
    const document = validateGatewayHealthDocument(JSON.parse(source));
    const ageMs = Date.now() - Date.parse(document.observedAt);
    if (document.status !== "ready" || ageMs < 0 || ageMs > maximumAgeMs) {
      throw new Error("Gateway readiness is stale or not ready.");
    }
  } finally {
    await handle.close();
  }
}

try {
  await assertContainerReady();
} catch {
  console.error("Reaper Gateway readiness is unavailable.");
  process.exitCode = 1;
}
