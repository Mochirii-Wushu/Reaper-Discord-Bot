import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
const dockerignore = readFileSync(resolve(root, ".dockerignore"), "utf8");
const contract = JSON.parse(readFileSync(resolve(root, "docs/operations/gateway-artifact.v1.json"), "utf8"));

describe("Gateway OCI artifact", () => {
  test("uses immutable multi-stage sources and an unprivileged production-only runtime", () => {
    expect(dockerfile).toMatch(/^# syntax=docker\/dockerfile:1\.18@sha256:[0-9a-f]{64}$/m);
    expect(dockerfile).toMatch(/oven\/bun:1\.3\.14-slim@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toMatch(/node:22\.23\.1-bookworm-slim@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toContain("bun install --frozen-lockfile --production --ignore-scripts");
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).not.toMatch(/^EXPOSE\b/m);
  });

  test("keeps secrets and provider operations outside the build", () => {
    expect(dockerignore.split(/\r?\n/)[0]).toBe("**");
    expect(dockerfile).not.toMatch(/\b(?:ARG|ENV)\s+(?:DISCORD|SUPABASE|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)/i);
    expect(dockerfile).not.toMatch(/\b(?:register:guild|register-commands|curl|wget)\b/i);
  });

  test("keeps publication, deployment, and host selection disabled", () => {
    expect(contract.artifact).toMatchObject({
      registrySelected: false,
      publicationAuthorized: false,
      deploymentAuthorized: false,
    });
    expect(Object.values(contract.releaseGates)).toEqual(Object.values(contract.releaseGates).map(() => false));
  });
});
