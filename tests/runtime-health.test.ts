import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRuntimeHealthReporter,
  RuntimeHealthReporter,
  validateGatewayHealthDocument,
} from "../src/runtime-health.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("RuntimeHealthReporter", () => {
  test("writes a bounded provider-neutral readiness snapshot atomically", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mochirii-health-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "gateway.json");
    const reporter = new RuntimeHealthReporter({
      path,
      clock: () => new Date("2026-07-30T00:00:00.000Z"),
    });

    await reporter.publish("starting");
    await reporter.publish("ready");
    await reporter.resumed();

    expect(
      validateGatewayHealthDocument(JSON.parse(readFileSync(path, "utf8"))),
    ).toEqual({
      schemaVersion: 1,
      status: "ready",
      observedAt: "2026-07-30T00:00:00.000Z",
      sequence: 3,
      resumeCount: 1,
    });
    expect(readFileSync(path, "utf8")).not.toContain("token");
  });

  test("stays inert when no host path is configured", async () => {
    const reporter = createRuntimeHealthReporter({});
    expect(reporter.enabled).toBe(false);
    await expect(reporter.publish("ready")).resolves.toBeUndefined();
  });

  test("rejects relative state paths and unsafe heartbeat intervals", () => {
    expect(() => createRuntimeHealthReporter({
      REAPER_HEALTH_STATE_PATH: "gateway.json",
    })).toThrow("absolute path");
    expect(() => createRuntimeHealthReporter({
      REAPER_HEALTH_HEARTBEAT_MS: "1000",
    })).toThrow("15000 through 300000");
  });

  test("rejects malformed readiness documents", () => {
    expect(() => validateGatewayHealthDocument({ status: "ready" })).toThrow(
      "malformed",
    );
  });
});
