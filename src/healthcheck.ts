import { assertRuntimeReady } from "./runtime-health.js";

try {
  await assertRuntimeReady();
} catch {
  console.error("Reaper Gateway readiness is unavailable.");
  process.exitCode = 1;
}
