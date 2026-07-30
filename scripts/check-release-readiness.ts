import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WELCOME_DM_MESSAGE } from "../src/welcome.js";

type PackageManifest = {
  packageManager?: string;
  engines?: Record<string, string>;
  scripts?: Record<string, string>;
};

type GatewayRelease = {
  schemaVersion: number;
  status: string;
  repository: string;
  entrypoint: string;
  toolchain: Record<string, string>;
  welcomeDmSha256: string;
  releaseRequirements: string[];
  activationBoundary: Record<string, boolean>;
};

const root = resolve(import.meta.dir, "..");
const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
const json = <T>(path: string): T => JSON.parse(read(path)) as T;
const fail = (message: string): never => {
  throw new Error(message);
};

const manifest = json<PackageManifest>("package.json");
if (
  manifest.packageManager !== "bun@1.3.14" ||
  manifest.engines?.bun !== "1.3.14" ||
  manifest.engines?.node !== "22.23.1"
) fail("Repository toolchains are not pinned to the reviewed versions.");
for (
  const script of [
    "audit:all",
    "audit:runtime",
    "health:check",
    "website:compat",
  ]
) {
  if (!manifest.scripts?.[script]) fail(`Missing required ${script} script.`);
}
if (manifest.scripts?.["audit:runtime"] !== "bun audit --audit-level=high") {
  fail("Runtime dependency audit must fail at high severity.");
}

const release = json<GatewayRelease>("contracts/gateway-release.v1.json");
const welcomeHash = createHash("sha256")
  .update(WELCOME_DM_MESSAGE, "utf8")
  .digest("hex");
if (
  release.schemaVersion !== 1 ||
  release.status !== "source-only-not-deployed" ||
  release.repository !== "Mochirii-Wushu/Reaper-Discord-Bot" ||
  release.entrypoint !== "dist/index.js" ||
  release.toolchain.bun !== "1.3.14" ||
  release.toolchain.node !== "22.23.1" ||
  release.toolchain.deno !== "2.9.4" ||
  release.welcomeDmSha256 !== welcomeHash
) fail("Gateway release contract or approved welcome message drifted.");

const requirements = new Set(release.releaseRequirements);
for (
  const requirement of [
    "immutable-artifact-digest",
    "dependency-sbom",
    "provenance-attestation",
    "readiness-readback",
    "restart-and-session-resume-proof",
    "rollback-proof",
    "workstation-off-proof",
  ]
) {
  if (!requirements.has(requirement)) {
    fail(`Gateway release contract omits ${requirement}.`);
  }
}
if (Object.values(release.activationBoundary).some(Boolean)) {
  fail("The source-only Gateway candidate must remain non-deployable.");
}

const indexSource = read("src/index.ts");
for (
  const marker of [
    "Events.ShardReconnecting",
    "Events.ShardDisconnect",
    "Events.ShardReady",
    "Events.ShardResume",
    "Events.Invalidated",
    'process.once("SIGTERM"',
  ]
) {
  if (!indexSource.includes(marker)) fail(`Gateway lifecycle omits ${marker}.`);
}
if (indexSource.includes("readyClient.user.tag")) {
  fail("Gateway logs must not expose the connected account tag.");
}

const securityPolicy = read("SECURITY.md");
const operations = read("docs/runtime-operations.md");
const dependencyPolicy = read("docs/dependency-security.md");
for (const marker of ["Security Advisories", "Do not include secrets"]) {
  if (!securityPolicy.includes(marker)) fail(`SECURITY.md omits ${marker}.`);
}
for (
  const marker of [
    "SOURCE_ONLY_NOT_DEPLOYED",
    "REAPER_HEALTH_STATE_PATH",
    "automatic restart",
    "rollback",
    "workstation",
  ]
) {
  if (!operations.includes(marker)) fail(`Runtime runbook omits ${marker}.`);
}
for (const marker of ["high or critical", "expiry", "review trigger"]) {
  if (!dependencyPolicy.includes(marker)) {
    fail(`Dependency policy omits ${marker}.`);
  }
}

console.log("Reaper source-only release and security contracts are complete.");
