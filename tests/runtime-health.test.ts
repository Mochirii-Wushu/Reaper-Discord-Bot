import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRuntimeReady, GatewayReadiness } from "../src/runtime-health.js";

const temporaryDirectories: string[] = [];

async function temporaryReadinessFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reaper-readiness-"));
  temporaryDirectories.push(directory);
  return join(directory, "readiness.json");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("Gateway runtime readiness", () => {
  test("is absent until the Gateway is ready and is removed when it disconnects", async () => {
    const filePath = await temporaryReadinessFile();
    const now = Date.parse("2026-07-31T12:00:00.000Z");
    const readiness = new GatewayReadiness({ filePath, now: () => now, refreshMs: 60_000 });

    await readiness.initialize();
    await expect(assertRuntimeReady(filePath, now)).rejects.toThrow();

    await readiness.markReady();
    await expect(assertRuntimeReady(filePath, now)).resolves.toBeUndefined();
    const record = JSON.parse(await readFile(filePath, "utf8"));
    expect(record).toMatchObject({ schemaVersion: 1, state: "ready", pid: process.pid });

    await readiness.markNotReady();
    await expect(assertRuntimeReady(filePath, now)).rejects.toThrow();
    await readiness.close();
  });

  test("fails closed for stale, future, malformed, and dead-process records", async () => {
    const filePath = await temporaryReadinessFile();
    const now = Date.parse("2026-07-31T12:00:00.000Z");
    const cases = [
      { schemaVersion: 1, state: "ready", pid: process.pid, updatedAt: "2026-07-31T11:58:00.000Z" },
      { schemaVersion: 1, state: "ready", pid: process.pid, updatedAt: "2026-07-31T12:00:01.000Z" },
      { schemaVersion: 1, state: "ready", pid: 999_999_999, updatedAt: "2026-07-31T12:00:00.000Z" },
      { schemaVersion: 2, state: "ready", pid: process.pid, updatedAt: "2026-07-31T12:00:00.000Z" },
    ];

    for (const value of cases) {
      await writeFile(filePath, JSON.stringify(value), "utf8");
      await expect(assertRuntimeReady(filePath, now)).rejects.toThrow();
    }

    await writeFile(filePath, "not json", "utf8");
    await expect(assertRuntimeReady(filePath, now)).rejects.toThrow();
  });
});
