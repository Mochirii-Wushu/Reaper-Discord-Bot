import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const [dockerfile, dockerignore, contract, packageJson, source, workflow] = await Promise.all([
  readFile(resolve(root, "Dockerfile"), "utf8"),
  readFile(resolve(root, ".dockerignore"), "utf8"),
  readFile(resolve(root, "docs/operations/gateway-artifact.v1.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "package.json"), "utf8").then(JSON.parse),
  readFile(resolve(root, "src/index.ts"), "utf8"),
  readFile(resolve(root, ".github/workflows/ci.yml"), "utf8"),
]);

const errors = [];
const expectedNodeImage = "node:22.23.2-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46";
const requireText = (text, pattern, message) => {
  if (!pattern.test(text)) errors.push(message);
};

requireText(dockerfile, /^ARG BUN_IMAGE="oven\/bun:1\.3\.14-slim@sha256:[0-9a-f]{64}"$/m, "Builder image must be versioned and digest-pinned.");
if (dockerfile.match(/^ARG NODE_IMAGE="([^"]+)"$/m)?.[1] !== expectedNodeImage) {
  errors.push("Runtime image must match the reviewed Node.js 22.23.2 index digest.");
}
requireText(dockerfile, /^# syntax=docker\/dockerfile:1\.18@sha256:[0-9a-f]{64}$/m, "Dockerfile frontend must be versioned and digest-pinned.");
requireText(dockerfile, /bun install --frozen-lockfile --production --ignore-scripts/, "Production dependencies must use the frozen lockfile without lifecycle scripts.");
requireText(dockerfile, /^USER node$/m, "Runtime must use the unprivileged node user.");
requireText(dockerfile, /^STOPSIGNAL SIGTERM$/m, "Runtime must declare the supervisor shutdown signal.");
requireText(dockerfile, /^HEALTHCHECK .*\["node", "dist\/healthcheck\.js"\]$/m, "Runtime must declare the exec readiness check.");
requireText(dockerfile, /^ENTRYPOINT \["node", "dist\/index\.js"\]$/m, "Runtime entrypoint must start only the Gateway worker.");
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
if (contract.build?.runtimeImage !== expectedNodeImage) errors.push("Runtime provenance does not match the reviewed Node.js 22.23.2 index digest.");
if (contract.build?.dockerfileFrontend !== dockerfile.match(/^# syntax=([^\s]+)$/m)?.[1]) errors.push("Dockerfile frontend provenance drifted from Dockerfile.");
if (contract.runtime?.rootAllowed !== false || contract.runtime?.user !== "node") errors.push("Runtime privilege contract is invalid.");
if (contract.runtime?.workstationDependencyAllowed !== false) errors.push("Workstation independence must fail closed.");
if (packageJson.scripts?.start !== "node dist/index.js") errors.push("Package start command drifted from the OCI entrypoint.");

if (errors.length) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("Reaper Gateway OCI artifact contract passed.");
}
