import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
type DeploymentFiles = Record<"compose" | "lifecycle" | "health" | "timer" | "script", string>;
const checkerUrl = new URL("../scripts/check-gateway-deployment.mjs", import.meta.url);
const { readGatewayDeployment, validateGatewayDeployment }: {
  readGatewayDeployment(): Promise<DeploymentFiles>;
  validateGatewayDeployment(files: DeploymentFiles): string[];
} = await import(checkerUrl.href);

const files = await readGatewayDeployment();
const image = `registry.test/mochirii/reaper@sha256:${"a".repeat(64)}`;
const imageId = `sha256:${"b".repeat(64)}`;
const containerId = "c".repeat(64);
const fixtures: string[] = [];
const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "/bin/sh";
const posix = (path: string) => path.replaceAll("\\", "/").replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);

afterEach(() => {
  for (const path of fixtures.splice(0)) {
    if (!resolve(path).startsWith(resolve(tmpdir(), "reaper-gateway-health-test-"))) throw new Error("Unexpected fixture cleanup path.");
    rmSync(path, { recursive: true, force: true });
  }
});

function fixture(overrides: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), "reaper-gateway-health-test-"));
  fixtures.push(root);
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "state"));
  const snapshot = `${containerId}|/mochirii-reaper-gateway|${image}|${imageId}|mochirii-reaper-gateway|gateway|running|unhealthy`;
  const values = { snapshot, "image-id": imageId, now: "1791651600", "exec-result": "1", "restart-result": "0", ...overrides };
  for (const [name, value] of Object.entries(values)) writeFileSync(join(root, name), value + "\n");
  const mocks = {
    docker: `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$MOCK_ROOT/calls"
case "$1" in
  image) cat "$MOCK_ROOT/image-id" ;;
  inspect)
    if [ -f "$MOCK_ROOT/inspected" ] && [ -f "$MOCK_ROOT/second-snapshot" ]; then cat "$MOCK_ROOT/second-snapshot";
    else cat "$MOCK_ROOT/snapshot"; fi
    : > "$MOCK_ROOT/inspected" ;;
  exec)
    if [ -f "$MOCK_ROOT/stop-on-exec" ]; then cp "$MOCK_ROOT/stopped-snapshot" "$MOCK_ROOT/second-snapshot"; fi
    exit "$(cat "$MOCK_ROOT/exec-result")" ;;
  restart) exit "$(cat "$MOCK_ROOT/restart-result")" ;;
  *) exit 80 ;;
esac
`,
    systemctl: `#!/bin/sh
[ ! -f "$MOCK_ROOT/inactive" ]
`,
    date: `#!/bin/sh
cat "$MOCK_ROOT/now"
`,
  };
  for (const [name, text] of Object.entries(mocks)) {
    writeFileSync(join(root, "bin", name), text);
    chmodSync(join(root, "bin", name), 0o755);
  }
  const env = {
    ...process.env,
    MOCK_ROOT: posix(root),
    MOCK_BIN: posix(join(root, "bin")),
    HEALTH_SCRIPT: posix(resolve(import.meta.dirname, "../deploy/gateway-health.sh")),
    STATE_DIRECTORY: posix(join(root, "state")),
    REAPER_GATEWAY_IMAGE: image,
  };
  return {
    root,
    env,
    run: (changes: Record<string, string> = {}, args = "") => Bun.spawnSync([shell, "-c", `export PATH="$MOCK_BIN:$PATH"; exec sh "$HEALTH_SCRIPT" ${args}`], {
      env: { ...env, ...changes }, stdout: "pipe", stderr: "pipe", timeout: 5000,
    }),
    calls: () => existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8") : "",
    set: (name: string, value: string) => writeFileSync(join(root, name), value + "\n"),
  };
}

describe("Gateway deployment contract", () => {
  test("declares durable private state without authorizing activation", () => {
    const release = JSON.parse(readFileSync(new URL("../contracts/gateway-release.v1.json", import.meta.url), "utf8"));
    expect(release.runtime).toEqual({
      persistentGatewayRequired: true, automaticRestartRequired: true, statefulApplicationData: true,
    });
    expect(release.status).toBe("source-only-not-deployed");
    expect(Object.values(release.activationBoundary).every((flag) => flag === false)).toBe(true);
  });

  test("accepts the bounded source-only deployment templates", () => {
    expect(validateGatewayDeployment(files)).toEqual([]);
  });

  test("rejects privilege, build, secret interpolation, network and resource regressions", () => {
    const mutations = [
      (service: any) => { service.user = "0:0"; },
      (service: any) => { service.read_only = false; },
      (service: any) => { service.cap_drop = []; },
      (service: any) => { service.security_opt = []; },
      (service: any) => { service.ports = ["80:80"]; },
      (service: any) => { service.volumes = ["/var/run/docker.sock:/var/run/docker.sock"]; },
      (service: any) => { service.volumes[0].bind.create_host_path = true; },
      (service: any) => { service.volumes[0].source = "/tmp/gateway"; },
      (service: any) => { service.environment.REAPER_MEMBER_SYNC_STATE_PATH = "/tmp/member-sync"; },
      (service: any) => { service.build = "."; },
      (service: any) => { service.image = "registry.test/reaper:latest"; },
      (service: any) => { service.env_file[0].format = "dotenv"; },
      (service: any) => { service.env_file[0].required = false; },
      (service: any) => { service.environment.WELCOME_DM_ENABLED = "true"; },
      (service: any) => { service.environment.DISCORD_BOT_TOKEN = "synthetic-only"; },
      (service: any) => { service.mem_limit = "1g"; },
      (service: any) => { service.memswap_limit = "512m"; },
      (service: any) => { service.tmpfs = ["/tmp:size=1g"]; },
      (service: any) => { service.logging.options["max-file"] = "99"; },
      (service: any) => { service.restart = "always"; },
    ];
    for (const mutate of mutations) {
      const compose = JSON.parse(files.compose);
      mutate(compose.services.gateway);
      expect(validateGatewayDeployment({ ...files, compose: JSON.stringify(compose) }).length).toBeGreaterThan(0);
    }
  });

  test("rejects lifecycle and health actions that bypass ownership or manual stops", () => {
    for (const [key, from, to] of [
      ["lifecycle", "Restart=no", "Restart=always"],
      ["lifecycle", "--pull never", "--pull always"],
      ["lifecycle", "--no-build", "--build"],
      ["lifecycle", "0:600", "0:644"],
      ["lifecycle", "test ! -L /var/lib/mochirii-reaper/gateway;", ""],
      ["lifecycle", "65532:65532:700", "0:0:755"],
      ["health", "Requisite=", "Requires="],
      ["health", "TimeoutStartSec=45", "TimeoutStartSec=infinity"],
      ["timer", "OnUnitActiveSec=60s", "OnUnitActiveSec=1s"],
      ["script", 'docker restart --time 20 "$container_id"', 'docker restart --time 20 "$container"'],
    ]) {
      expect(validateGatewayDeployment({ ...files, [key]: files[key as keyof typeof files].replace(from!, to!) }).length).toBeGreaterThan(0);
    }
  });
});

describe("private health script with synthetic Docker responses", () => {
  test("validates a digest without contacting Docker or reading runtime credentials", () => {
    const f = fixture();
    expect(f.run({}, "--validate-image").exitCode).toBe(0);
    expect(f.calls()).toBe("");
    for (const invalid of ["registry.test/reaper:latest", image + "\ninvalid", "", "https://registry.test/reaper:latest"]) {
      expect(f.run({ REAPER_GATEWAY_IMAGE: invalid }, "--validate-image").exitCode).toBe(1);
    }
    expect(f.calls()).toBe("");
  });

  test("probes an owned healthy container by its immutable ID without recovery", () => {
    const f = fixture({ "exec-result": "0" });
    expect(f.run().exitCode).toBe(0);
    expect(f.calls()).toContain(`exec ${containerId} /nodejs/bin/node dist/healthcheck.js`);
    expect(f.calls()).not.toContain("restart");
    expect(existsSync(join(f.root, "state", "recovery-attempts"))).toBe(false);
  });

  test("does not probe or restart a stopped container or inactive service", () => {
    const f = fixture();
    f.set("snapshot", readFileSync(join(f.root, "snapshot"), "utf8").trim().replace("|running|", "|exited|"));
    expect(f.run().exitCode).toBe(0);
    expect(f.calls()).not.toMatch(/exec |restart /);
    f.set("inactive", "1");
    f.set("calls", "");
    expect(f.run().exitCode).toBe(0);
    expect(f.calls().trim()).toBe("");
  });

  test("leaves a starting healthcheck alone and rejects a missing healthcheck", () => {
    const f = fixture();
    const snapshot = readFileSync(join(f.root, "snapshot"), "utf8").trim();
    f.set("snapshot", snapshot.replace(/unhealthy$/, "starting"));
    expect(f.run().exitCode).toBe(0);
    expect(f.calls()).not.toMatch(/exec |restart /);
    f.set("snapshot", snapshot.replace(/unhealthy$/, "none"));
    expect(f.run().exitCode).toBe(1);
    expect(f.calls()).not.toContain("restart");
  });

  test("fails closed for every foreign identity and never probes or recovers it", () => {
    const original = `${containerId}|/mochirii-reaper-gateway|${image}|${imageId}|mochirii-reaper-gateway|gateway|running|unhealthy`;
    for (const [index, replacement] of [[0, "bad-id"], [1, "/foreign"], [2, image.replace(/a{64}$/, "d".repeat(64))], [3, `sha256:${"e".repeat(64)}`], [4, "foreign-project"], [5, "foreign-service"]] as const) {
      const fields = original.split("|");
      fields[index] = replacement;
      const f = fixture({ snapshot: fields.join("|") });
      expect(f.run().exitCode).toBe(1);
      expect(f.calls()).not.toMatch(/exec |restart /);
    }
  });

  test("allows three recoveries then persists the latch across later windows", () => {
    const f = fixture();
    for (let attempt = 0; attempt < 3; attempt += 1) expect(f.run().exitCode).toBe(0);
    expect(f.calls().match(/^restart /gm)).toHaveLength(3);
    expect(existsSync(join(f.root, "state", "recovery-latched"))).toBe(true);
    f.set("now", "1791652601");
    expect(f.run().exitCode).toBe(1);
    expect(f.calls().match(/^restart /gm)).toHaveLength(3);
  });

  test("expires older attempts within a rolling window rather than fixed buckets", () => {
    const f = fixture();
    f.set("state/recovery-attempts", "1791650699\n1791651599");
    expect(f.run().exitCode).toBe(0);
    expect(readFileSync(join(f.root, "state", "recovery-attempts"), "utf8")).toBe("1791651599\n1791651600\n");
    expect(existsSync(join(f.root, "state", "recovery-latched"))).toBe(false);
  });

  test("counts failed restart requests and refuses corrupt or future state", () => {
    const f = fixture({ "restart-result": "1" });
    expect(f.run().exitCode).toBe(1);
    expect(readFileSync(join(f.root, "state", "recovery-attempts"), "utf8")).toBe("1791651600\n");
    for (const history of ["not-an-epoch", "1791651601", "1\n2\n3\n4"]) {
      f.set("state/recovery-attempts", history);
      f.set("calls", "");
      expect(f.run().exitCode).toBe(1);
      expect(f.calls()).not.toContain("restart");
    }
  });

  test("cancels recovery after a concurrent stop or container replacement", () => {
    const f = fixture({ "stop-on-exec": "1" });
    const snapshot = readFileSync(join(f.root, "snapshot"), "utf8").trim();
    f.set("stopped-snapshot", snapshot.replace("|running|", "|exited|"));
    expect(f.run().exitCode).toBe(0);
    expect(f.calls()).not.toContain("restart");
    const replacement = fixture({ "stop-on-exec": "1" });
    replacement.set("stopped-snapshot", snapshot.replace(containerId, "d".repeat(64)));
    expect(replacement.run().exitCode).toBe(1);
    expect(replacement.calls()).not.toContain("restart");
  });

  test("fails closed while another private check owns the recovery lock", () => {
    const f = fixture();
    mkdirSync(join(f.root, "state", "lock"));
    expect(f.run().exitCode).toBe(1);
    expect(f.calls()).toBe("");
  });
});
