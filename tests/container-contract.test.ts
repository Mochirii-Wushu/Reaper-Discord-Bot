import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const dockerfile = readFileSync(resolve(root, "Dockerfile"), "utf8");
const dockerignore = readFileSync(resolve(root, ".dockerignore"), "utf8");
const contract = JSON.parse(readFileSync(resolve(root, "docs/operations/gateway-artifact.v1.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const readme = readFileSync(resolve(root, "README.md"), "utf8");

describe("Gateway OCI artifact", () => {
  test("uses immutable multi-stage sources and an unprivileged production-only runtime", () => {
    expect(dockerfile).toMatch(/^# syntax=docker\/dockerfile:1\.18@sha256:[0-9a-f]{64}$/m);
    expect(dockerfile).toMatch(/oven\/bun:1\.3\.14-distroless@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toMatch(/gcr\.io\/distroless\/nodejs22-debian13:nonroot@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toContain('RUN ["/usr/local/bin/bun", "install", "--frozen-lockfile", "--production", "--ignore-scripts"]');
    expect(dockerfile).toContain('RUN ["/usr/local/bin/bun", "node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"]');
    expect(dockerfile.split(/\r?\n/).filter((line) => line.startsWith("RUN ")).every((line) => line.startsWith("RUN ["))).toBe(true);
    expect(dockerfile).toContain("USER 65532:65532");
    expect(dockerfile).toContain('ENTRYPOINT ["/nodejs/bin/node", "dist/index.js"]');
    expect(contract.build).toMatchObject({
      builderDistroless: true,
      builderShellIncluded: false,
      runtimeNodeVersion: "22.23.2",
      runtimeDistroless: true,
      runtimeShellIncluded: false,
      runtimePackageManagerIncluded: false,
    });
    expect(contract.source.entrypoint).toEqual(["/nodejs/bin/node", "dist/index.js"]);
    expect(contract.runtime.readinessCommand).toEqual(["/nodejs/bin/node", "dist/healthcheck.js"]);
    expect(contract.dependencyAudit).toMatchObject({
      rawJsonRequired: true,
      exceptionMatchFields: ["package", "advisoryUrl", "vulnerableVersions"],
    });
    expect(packageJson.scripts.check).toBe("bun run check:artifact && bun run audit:policy && bun run audit:production && bun run audit:complete && bun run typecheck && bun test tests && bun run build");
    expect(readme).toMatch(/^\s*bun install --frozen-lockfile --ignore-scripts\s*$/m);
    expect(readme).not.toMatch(/^\s*bun install(?! --frozen-lockfile --ignore-scripts\s*$).*$/m);
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
