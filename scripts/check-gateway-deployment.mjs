import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const paths = {
  compose: "deploy/gateway.compose.yml",
  lifecycle: "deploy/mochirii-reaper-gateway.service",
  health: "deploy/mochirii-reaper-gateway-health.service",
  timer: "deploy/mochirii-reaper-gateway-health.timer",
  script: "deploy/gateway-health.sh",
};

export async function readGatewayDeployment(base = root) {
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) =>
    [key, await readFile(resolve(base, path), "utf8")])));
}

function unitEntries(text) {
  const values = new Map();
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (/^\[[A-Za-z]+\]$/.test(line)) { section = line.slice(1, -1); continue; }
    const match = /^([A-Za-z]+)=(.*)$/.exec(line);
    if (!section || !match) throw new Error("Invalid systemd unit syntax.");
    const key = `${section}.${match[1]}`;
    const existing = values.get(key) ?? [];
    values.set(key, [...existing, match[2]]);
  }
  return values;
}

export function validateGatewayDeployment(files) {
  const errors = [];
  const require = (condition, message) => { if (!condition) errors.push(message); };
  const equals = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
  let compose;
  try { compose = JSON.parse(files.compose); } catch { return ["Compose must use the JSON subset of YAML."]; }
  require(equals(Object.keys(compose).sort(), ["name", "services"]), "Compose must declare only its name and one service.");
  require(compose.name === "mochirii-reaper-gateway" && equals(Object.keys(compose.services ?? {}), ["gateway"]), "The project must own exactly the Gateway service.");
  const service = compose.services?.gateway ?? {};
  const required = {
    image: "${REAPER_GATEWAY_IMAGE:?An approved digest-pinned image is required}",
    container_name: "mochirii-reaper-gateway",
    pull_policy: "never",
    restart: "on-failure:3",
    user: "65532:65532",
    read_only: true,
    env_file: [{ path: "/etc/mochirii-reaper/gateway.env", required: true, format: "raw" }],
    environment: {
      NODE_ENV: "production",
      REAPER_GALLERY_GATEWAY_ROLLBACK_ENABLED: "false",
      REAPER_HEALTH_STATE_PATH: "/tmp/mochirii-reaper-readiness.json",
      REAPER_HEALTH_HEARTBEAT_MS: "30000",
      REAPER_HEALTH_MAX_AGE_MS: "90000",
      REAPER_MEMBER_SYNC_STATE_PATH: "/var/lib/reaper/member-sync",
    },
    volumes: [{ type: "bind", source: "/var/lib/mochirii-reaper/gateway", target: "/var/lib/reaper", read_only: false, bind: { create_host_path: false } }],
    tmpfs: ["/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=0700,uid=65532,gid=65532"],
    cap_drop: ["ALL"],
    security_opt: ["no-new-privileges:true"],
    mem_limit: "256m",
    memswap_limit: "256m",
    cpus: "0.50",
    pids_limit: 64,
    shm_size: "1m",
    stop_grace_period: "20s",
    logging: { driver: "local", options: { "max-size": "5m", "max-file": "3" } },
  };
  require(equals(Object.keys(service).sort(), Object.keys(required).sort()), "Unexpected service options may add builds, privileges, mounts, commands, or ports.");
  for (const [key, expected] of Object.entries(required)) require(equals(service[key], expected), `Gateway service ${key} violates the deployment contract.`);

  let lifecycle, health, timer;
  try {
    lifecycle = unitEntries(files.lifecycle);
    health = unitEntries(files.health);
    timer = unitEntries(files.timer);
  } catch { return [...errors, "Invalid systemd unit syntax."]; }
  const exact = (unit, key, expected) => require(equals(unit.get(key), [expected]), `systemd ${key} must equal ${expected}.`);
  const only = (unit, allowed) => require([...unit.keys()].every((key) => allowed.includes(key)), "Unreviewed systemd settings can alter lifecycle or privilege boundaries.");
  only(lifecycle, ["Unit.Description", "Unit.Requires", "Unit.After", "Unit.Wants", "Service.Type", "Service.RemainAfterExit", "Service.EnvironmentFile", "Service.WorkingDirectory", "Service.ExecStartPre", "Service.ExecStart", "Service.ExecStop", "Service.Restart", "Service.TimeoutStartSec", "Service.TimeoutStopSec", "Service.UMask", "Service.NoNewPrivileges", "Install.WantedBy"]);
  only(health, ["Unit.Description", "Unit.Requisite", "Unit.After", "Unit.PartOf", "Service.Type", "Service.EnvironmentFile", "Service.ExecStart", "Service.StateDirectory", "Service.StateDirectoryMode", "Service.TimeoutStartSec", "Service.UMask", "Service.NoNewPrivileges", "Service.PrivateTmp", "Service.ProtectSystem", "Service.ProtectHome"]);
  only(timer, ["Unit.Description", "Unit.PartOf", "Timer.OnActiveSec", "Timer.OnUnitActiveSec", "Timer.AccuracySec", "Timer.Unit", "Install.WantedBy"]);
  const composition = "/usr/bin/docker compose --env-file /etc/mochirii-reaper/gateway-release.env --project-name mochirii-reaper-gateway --file /opt/mochirii-reaper/deploy/gateway.compose.yml";
  exact(lifecycle, "Service.Type", "oneshot");
  exact(lifecycle, "Service.RemainAfterExit", "yes");
  exact(lifecycle, "Service.EnvironmentFile", "/etc/mochirii-reaper/gateway-release.env");
  exact(lifecycle, "Service.ExecStart", `${composition} up --detach --no-build --pull never --wait --wait-timeout 120 gateway`);
  exact(lifecycle, "Service.ExecStop", `${composition} stop --timeout 20 gateway`);
  exact(lifecycle, "Service.Restart", "no");
  exact(lifecycle, "Service.WorkingDirectory", "/opt/mochirii-reaper");
  exact(lifecycle, "Service.TimeoutStartSec", "150");
  exact(lifecycle, "Service.TimeoutStopSec", "30");
  exact(lifecycle, "Unit.Requires", "docker.service");
  exact(lifecycle, "Unit.After", "docker.service network-online.target");
  exact(lifecycle, "Unit.Wants", "network-online.target mochirii-reaper-gateway-health.timer");
  exact(lifecycle, "Install.WantedBy", "multi-user.target");
  require(equals(lifecycle.get("Service.ExecStartPre"), [
    "/bin/sh /opt/mochirii-reaper/deploy/gateway-health.sh --validate-image",
    `/bin/sh -ec 'test "$$(stat -c %%u:%%a /etc/mochirii-reaper/gateway.env)" = "0:600"; test "$$(stat -c %%u:%%a /etc/mochirii-reaper/gateway-release.env)" = "0:600"; test -d /var/lib/mochirii-reaper/gateway; test ! -L /var/lib/mochirii-reaper/gateway; test "$$(stat -c %%u:%%g:%%a /var/lib/mochirii-reaper/gateway)" = "65532:65532:700"'`,
  ]), "Startup must validate the image, root-only secret-file metadata and private non-symlink spool directory without reading credential values.");
  exact(health, "Service.Type", "oneshot");
  exact(health, "Service.EnvironmentFile", "/etc/mochirii-reaper/gateway-release.env");
  exact(health, "Service.ExecStart", "/bin/sh /opt/mochirii-reaper/deploy/gateway-health.sh");
  exact(health, "Unit.Requisite", "mochirii-reaper-gateway.service");
  exact(health, "Unit.After", "mochirii-reaper-gateway.service");
  exact(health, "Unit.PartOf", "mochirii-reaper-gateway.service");
  exact(health, "Service.StateDirectory", "mochirii-reaper-gateway-health");
  exact(health, "Service.StateDirectoryMode", "0700");
  exact(health, "Service.TimeoutStartSec", "45");
  exact(health, "Service.ProtectSystem", "strict");
  exact(health, "Service.ProtectHome", "yes");
  exact(health, "Service.PrivateTmp", "yes");
  exact(timer, "Unit.PartOf", "mochirii-reaper-gateway.service");
  exact(timer, "Timer.OnActiveSec", "60s");
  exact(timer, "Timer.OnUnitActiveSec", "60s");
  exact(timer, "Timer.AccuracySec", "5s");
  exact(timer, "Timer.Unit", "mochirii-reaper-gateway-health.service");
  exact(timer, "Install.WantedBy", "mochirii-reaper-gateway.service");
  for (const unit of [lifecycle, health]) {
    exact(unit, "Service.NoNewPrivileges", "yes");
    exact(unit, "Service.UMask", "0077");
    require(!unit.has("Service.ExecStartPost") && !unit.has("Service.ExecStopPost") && !unit.has("Service.Environment"), "Units must not add hidden startup actions or environment values.");
  }
  require(!/(?:^|\n)\s*(?:source\s|\.\s)|(?:cat|read)\s+.*gateway\.env|docker\s+(?:build|pull|run|start|logs)|\.Config\.Env/.test(files.script), "Health must not read credentials, logs, or start/build another container.");
  require(files.script.includes('docker exec "$container_id" /nodejs/bin/node dist/healthcheck.js') && files.script.includes('docker restart --time 20 "$container_id"'), "Health and recovery must target the validated exact container ID.");
  require(files.script.includes('com.docker.compose.project') && files.script.includes('com.docker.compose.service') && files.script.includes('[ "$actual_image" = "$expected_id" ]'), "Health must prove image and Compose ownership before acting.");
  require(files.script.includes('"$count" -lt 3') && files.script.includes('"$((now - timestamp))" -lt 900') && files.script.includes('recovery_latched'), "Health recovery must retain its bounded window and operator latch.");
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const errors = validateGatewayDeployment(await readGatewayDeployment());
  if (errors.length) {
    errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
  } else console.log("Gateway deployment templates passed; host activation and runtime proof remain pending.");
}
