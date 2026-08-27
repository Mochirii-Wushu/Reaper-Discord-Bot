import { execFileSync, spawnSync } from "node:child_process";

const image = process.env.REAPER_CONTAINER_IMAGE || "mochirii-reaper-gateway:local";
const expectedRevision = process.env.REAPER_EXPECTED_REVISION || process.env.EXPECTED_SHA || "";

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const [inspection] = JSON.parse(docker(["image", "inspect", image]));
const errors = [];
const config = inspection?.Config ?? {};

if (config.User !== "65532:65532") errors.push("Container runtime user must be numeric nonroot.");
if (JSON.stringify(config.Entrypoint) !== JSON.stringify(["/nodejs/bin/node", "dist/index.js"])) {
  errors.push("Container entrypoint drifted from the Gateway worker.");
}
if (JSON.stringify(config.Healthcheck?.Test) !== JSON.stringify(["CMD", "/nodejs/bin/node", "dist/healthcheck.js"])) {
  errors.push("Container readiness command drifted.");
}
if (config.ExposedPorts && Object.keys(config.ExposedPorts).length) errors.push("Gateway image must not expose a port.");
if ((config.Env ?? []).some((entry) => /^(?:DISCORD|SUPABASE|.*TOKEN|.*SECRET|.*PASSWORD|.*PRIVATE_KEY)=/i.test(entry))) {
  errors.push("Container image must not contain provider credentials.");
}

const metadata = config.Labels ?? {};
for (const key of ["org.opencontainers.image.created", "org.opencontainers.image.revision", "org.opencontainers.image.source", "org.opencontainers.image.title", "org.opencontainers.image.version"]) {
  if (!metadata[key]) errors.push(`Container is missing ${key}.`);
}
if (!/^[0-9a-f]{40}$/.test(metadata["org.opencontainers.image.revision"] ?? "")) {
  errors.push("Container revision label must be a full commit SHA.");
}
if (!/^[0-9a-f]{40}$/.test(expectedRevision)) {
  errors.push("REAPER_EXPECTED_REVISION or EXPECTED_SHA must name the exact reviewed commit.");
} else if (metadata["org.opencontainers.image.revision"] !== expectedRevision) {
  errors.push("Container revision label does not match the exact reviewed commit.");
}

const fileProbe = spawnSync(
  "docker",
  [
    "run", "--rm", "--network", "none", "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--entrypoint", "/nodejs/bin/node", image, "-e",
    "const fs=require('node:fs');const path=require('node:path');const top=fs.readdirSync('/opt/reaper').sort();let native=false;function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p);else if(e.name.endsWith('.node'))native=true;}}walk('/opt/reaper');if(process.version!=='v22.23.2'||process.getuid()!==65532||native||fs.existsSync('/bin/sh')||fs.existsSync('/usr/local/bin/npm')||JSON.stringify(top)!==JSON.stringify(['dist','node_modules','package.json']))process.exit(2);",
  ],
  { encoding: "utf8" },
);
if (fileProbe.status !== 0) errors.push("Hardened container file/user probe failed.");

const readinessProbe = spawnSync(
  "docker",
  [
    "run", "--rm", "--network", "none", "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=16m",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--entrypoint", "/nodejs/bin/node", image, "dist/healthcheck.js",
  ],
  { encoding: "utf8" },
);
if (readinessProbe.status !== 1 || !readinessProbe.stderr.includes("Reaper Gateway readiness is unavailable.")) {
  errors.push("Unconfigured container readiness must fail closed without provider access.");
}

if (errors.length) {
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Reaper Gateway OCI runtime contract passed for ${image}.`);
}
