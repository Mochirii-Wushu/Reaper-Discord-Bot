import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateAuditPolicy } from "./audit-dependencies.mjs";

const root = resolve(import.meta.dirname, "..");
const [dockerfile, dockerignore, contract, packageJson, source, workflow, auditPolicy, securityPolicy, readme] = await Promise.all([
  readFile(resolve(root, "Dockerfile"), "utf8"),
  readFile(resolve(root, ".dockerignore"), "utf8"),
  readFile(resolve(root, "docs/operations/gateway-artifact.v1.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "package.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "src/index.ts"), "utf8"),
  readFile(resolve(root, ".github/workflows/ci.yml"), "utf8"),
  readFile(resolve(root, "security/dependency-audit-exceptions.v1.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "SECURITY.md"), "utf8"),
  readFile(resolve(root, "README.md"), "utf8"),
]);

const errors = [];
const requireText = (text, pattern, message) => {
  if (!pattern.test(text)) errors.push(message);
};

requireText(dockerfile, /^ARG BUN_IMAGE="oven\/bun:1\.3\.14-distroless@sha256:[0-9a-f]{64}"$/m, "Builder image must be versioned, distroless, and digest-pinned.");
requireText(dockerfile, /^ARG NODE_IMAGE="gcr\.io\/distroless\/nodejs22-debian13:nonroot@sha256:[0-9a-f]{64}"$/m, "Runtime image must be supported, distroless, nonroot, and digest-pinned.");
requireText(dockerfile, /^# syntax=docker\/dockerfile:1\.18@sha256:[0-9a-f]{64}$/m, "Dockerfile frontend must be versioned and digest-pinned.");
requireText(dockerfile, /^RUN \["\/usr\/local\/bin\/bun", "install", "--frozen-lockfile", "--production", "--ignore-scripts"\]$/m, "Production dependencies must use the frozen lockfile without lifecycle scripts.");
requireText(dockerfile, /^RUN \["\/usr\/local\/bin\/bun", "node_modules\/typescript\/bin\/tsc", "-p", "tsconfig\.build\.json"\]$/m, "The distroless builder must invoke TypeScript directly without a package-script shell.");
if (dockerfile.split(/\r?\n/).some((line) => /^RUN\s+/.test(line) && !/^RUN \[/.test(line))) errors.push("Every builder command must use JSON-form RUN without a shell.");
requireText(dockerfile, /^USER 65532:65532$/m, "Runtime must use the numeric distroless nonroot user.");
requireText(dockerfile, /^STOPSIGNAL SIGTERM$/m, "Runtime must declare the supervisor shutdown signal.");
requireText(dockerfile, /^HEALTHCHECK .*\["\/nodejs\/bin\/node", "dist\/healthcheck\.js"\]$/m, "Runtime must declare the absolute distroless exec readiness check.");
requireText(dockerfile, /^ENTRYPOINT \["\/nodejs\/bin\/node", "dist\/index\.js"\]$/m, "Runtime entrypoint must start only the Gateway worker.");
requireText(source, /process\.once\("SIGTERM"/, "Gateway worker must handle SIGTERM.");
requireText(source, /GatewayReadiness/, "Gateway worker must maintain readiness state.");

if (/\b(?:ARG|ENV)\s+(?:DISCORD|SUPABASE|TOKEN|SECRET|PASSWORD|PRIVATE_KEY)/i.test(dockerfile)) {
  errors.push("Dockerfile must not accept or embed provider credentials.");
}
if (/\b(?:register:guild|register-commands|curl|wget)\b/i.test(dockerfile)) {
  errors.push("The image build must not register commands or call providers.");
}
if (/^EXPOSE\b/m.test(dockerfile)) errors.push("The Gateway worker must not expose a public listener.");
if (/docker\s+(?:login|push)|build-push-action|packages:\s*write/i.test(workflow)) {
  errors.push("Source validation workflow must not authenticate to or publish to a registry.");
}
requireText(workflow, /EXPECTED_SHA:\s*\$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/, "CI must bind validation to the exact pull-request head.");
requireText(workflow, /test "\$\(git rev-parse HEAD\)" = "\$EXPECTED_SHA"/, "CI must reject checkout source drift.");
requireText(workflow, /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020[\s\S]*?node-version:\s*"22\.23\.2"/, "CI must pin the reviewed Node runtime and immutable setup action.");
requireText(workflow, /^\s*- run: bun install --frozen-lockfile --ignore-scripts$/m, "CI must install the frozen graph without lifecycle scripts.");
requireText(workflow, /bun run check:container/, "CI must inspect the built runtime image.");

const ignoreLines = new Set(dockerignore.split(/\r?\n/).filter(Boolean));
for (const required of ["**", "!bun.lock", "!package.json", "!src/", "!src/**", "!tsconfig.build.json", "!tsconfig.json"]) {
  if (!ignoreLines.has(required)) errors.push(`.dockerignore is missing ${required}.`);
}
if ([".env", ".env.local", "tests", "docs"].some((path) => ignoreLines.has(`!${path}`) || ignoreLines.has(`!${path}/**`))) {
  errors.push("The image context must not re-include secrets, tests, or operations evidence.");
}

if (contract.schemaVersion !== 1 || contract.artifact?.format !== "OCI image") errors.push("Artifact contract schema is invalid.");
for (const key of ["registrySelected", "publicationAuthorized", "deploymentAuthorized"]) {
  if (contract.artifact?.[key] !== false) errors.push(`artifact.${key} must fail closed.`);
}
for (const key of Object.keys(contract.releaseGates ?? {})) {
  if (contract.releaseGates[key] !== false) errors.push(`releaseGates.${key} must fail closed.`);
}
if (contract.build?.builderImage !== dockerfile.match(/^ARG BUN_IMAGE="([^"]+)"$/m)?.[1]) errors.push("Builder provenance drifted from Dockerfile.");
if (contract.build?.runtimeImage !== dockerfile.match(/^ARG NODE_IMAGE="([^"]+)"$/m)?.[1]) errors.push("Runtime provenance drifted from Dockerfile.");
if (contract.build?.dockerfileFrontend !== dockerfile.match(/^# syntax=([^\s]+)$/m)?.[1]) errors.push("Dockerfile frontend provenance drifted from Dockerfile.");
if (contract.runtime?.workstationDependencyAllowed !== false) errors.push("Workstation independence must fail closed.");
if (contract.runtime?.rootAllowed !== false || contract.runtime?.user !== "65532:65532") errors.push("Runtime privilege contract is invalid.");
if (contract.build?.runtimeNodeVersion !== "22.23.2" || contract.build?.runtimeDistroless !== true) errors.push("Runtime version or distroless contract is invalid.");
if (contract.build?.builderDistroless !== true || contract.build?.builderShellIncluded !== false) errors.push("Builder distroless or shell contract is invalid.");
if (contract.build?.runtimeShellIncluded !== false || contract.build?.runtimePackageManagerIncluded !== false) errors.push("Runtime tool surface must fail closed.");
if (contract.build?.runtimeImageSignatureRequired !== true) errors.push("Runtime image signature verification must be required.");
if (JSON.stringify(contract.source?.entrypoint) !== JSON.stringify(["/nodejs/bin/node", "dist/index.js"])) errors.push("Artifact entrypoint contract drifted from the Dockerfile.");
if (JSON.stringify(contract.runtime?.readinessCommand) !== JSON.stringify(["/nodejs/bin/node", "dist/healthcheck.js"])) errors.push("Artifact readiness contract drifted from the Dockerfile.");
if (contract.dependencyAudit?.severityThreshold !== "high" || contract.dependencyAudit?.productionGraphRequired !== true || contract.dependencyAudit?.completeGraphRequired !== true) {
  errors.push("Dependency audit contract is invalid.");
}
if (contract.dependencyAudit?.rawJsonRequired !== true || JSON.stringify(contract.dependencyAudit?.exceptionMatchFields) !== JSON.stringify(["package", "advisoryUrl", "vulnerableVersions"])) {
  errors.push("Dependency audit exceptions must bind exact raw-report finding fields.");
}
if (packageJson.engines?.node !== "22.23.2" || packageJson.engines?.bun !== "1.3.14") errors.push("Runtime engines drifted from the reviewed toolchain.");
if (packageJson.scripts?.start !== "node dist/index.js") errors.push("Package start command drifted from the developer runtime contract.");
if (packageJson.scripts?.["audit:production"] !== "node scripts/audit-dependencies.mjs --scope=production") errors.push("Production dependency audit command drifted.");
if (packageJson.scripts?.["audit:complete"] !== "node scripts/audit-dependencies.mjs --scope=complete") errors.push("Complete dependency audit command drifted.");
const expectedCheck = "bun run check:artifact && bun run audit:policy && bun run audit:production && bun run audit:complete && bun run typecheck && bun test tests && bun run build";
if (packageJson.scripts?.check !== expectedCheck) errors.push("CI check must audit both graphs before executing dependency code.");
try {
  validateAuditPolicy(auditPolicy);
} catch (error) {
  errors.push(`Dependency audit policy is invalid: ${error instanceof Error ? error.message : String(error)}`);
}
requireText(securityPolicy, /maximum lifetime is 30 days/i, "Security policy must document bounded dependency exceptions.");
requireText(securityPolicy, /critical advisory within one business day/i, "Security policy must document the critical update cadence.");
requireText(readme, /^\s*bun install --frozen-lockfile --ignore-scripts\s*$/m, "README setup must use the frozen graph without lifecycle scripts.");
if (/^\s*bun install(?! --frozen-lockfile --ignore-scripts\s*$).*$/m.test(readme)) errors.push("README contains a non-hardened bun install command.");

if (errors.length) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("Reaper Gateway OCI artifact contract passed.");
}
