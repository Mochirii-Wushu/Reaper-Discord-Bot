import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  PUBLICATION_AUTHORIZATION, PUBLICATION_ENVIRONMENT, PUBLICATION_REPOSITORY,
  validateImageScan, validatePublicationContext, validatePublicationProtection,
  verifyPublicationBundle,
} from "../scripts/gateway-image-publication.js";
import { validateGatewayImageWorkflow, validateGatewayWorkflowSet } from "../scripts/check-gateway-image.js";

const commit = "a".repeat(40);
const tree = "b".repeat(40);
const otherCommit = "c".repeat(40);
const runnableDigest = "sha256:" + "d".repeat(64);
const now = Date.parse("2026-10-11T12:00:00.000Z");
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const bundleNames = [
  "gateway.oci.tar", "manifest.json", "sbom.spdx.json", "scan.json",
  "build-metadata.json", "tool-versions.json",
] as const;
const fixtureRoots = new Set<string>();

afterEach(() => {
  for (const directory of fixtureRoots) {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith("reaper-gateway-image-test-") ||
      lstatSync(target).isSymbolicLink()) throw new Error("Unexpected fixture cleanup target.");
    rmSync(target, { recursive: true, force: true });
    fixtureRoots.delete(directory);
  }
});

function context() {
  return {
    repository: PUBLICATION_REPOSITORY,
    event: "workflow_dispatch",
    ref: "refs/heads/main",
    workflowRef: PUBLICATION_REPOSITORY + "/.github/workflows/gateway-image.yml@refs/heads/main",
    actor: "xartaiusx",
    triggeringActor: "xartaiusx",
    commit, expectedCommit: commit, expectedTree: tree,
    authorization: PUBLICATION_AUTHORIZATION,
  };
}

function protection() {
  return {
    repository: { full_name: PUBLICATION_REPOSITORY, default_branch: "main", visibility: "public" },
    branch: { name: "main", protected: true, commit: { sha: commit } },
    environment: {
      name: PUBLICATION_ENVIRONMENT,
      can_admins_bypass: false,
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      protection_rules: [
        { type: "branch_policy" },
        { type: "required_reviewers", prevent_self_review: false,
          reviewers: [{ type: "User", reviewer: { login: "xartaiusx" } }] },
      ],
    },
  };
}

function cleanScan() {
  return {
    SchemaVersion: 2,
    Results: [{ Target: "synthetic.test/image", Class: "os-pkgs", Type: "debian",
      Vulnerabilities: [], Secrets: [] }],
  };
}

function bundle() {
  const directory = mkdtempSync(join(tmpdir(), "reaper-gateway-image-test-"));
  fixtureRoots.add(directory);
  const path = (name: string) => join(directory, name);
  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: runnableDigest,
        size: 100, platform: { os: "linux", architecture: "amd64" } },
      { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: "sha256:" + "e".repeat(64),
        size: 100, platform: { os: "unknown", architecture: "unknown" },
        annotations: { "vnd.docker.reference.type": "attestation-manifest",
          "vnd.docker.reference.digest": runnableDigest } },
    ],
  };
  const contents = {
    "gateway.oci.tar": "synthetic archive bytes; archive interpretation belongs to the OCI publication tool",
    "manifest.json": JSON.stringify(index),
    "sbom.spdx.json": JSON.stringify({ spdxVersion: "SPDX-2.3", packages: [{ name: "synthetic-package" }] }),
    "scan.json": JSON.stringify(cleanScan()),
    "build-metadata.json": JSON.stringify({ "containerimage.digest": "sha256:" + sha(JSON.stringify(index)) }),
    "tool-versions.json": JSON.stringify({ fixture: true }),
  };
  for (const [name, bytes] of Object.entries(contents)) writeFileSync(path(name), bytes);
  const proof = {
    schemaVersion: 1, repository: PUBLICATION_REPOSITORY, commit, tree,
    platform: "linux/amd64", createdAt: new Date(now).toISOString(),
    digest: "sha256:" + sha(contents["manifest.json"]),
    files: Object.fromEntries(bundleNames.map((name) => [name, sha(contents[name])])),
  };
  const writeProof = () => writeFileSync(path("source-proof.json"), JSON.stringify(proof));
  const reseal = () => {
    for (const name of bundleNames) proof.files[name] = sha(readFileSync(path(name)));
    proof.digest = "sha256:" + sha(readFileSync(path("manifest.json")));
    writeProof();
  };
  const setJson = (name: string, value: unknown) => {
    writeFileSync(path(name), JSON.stringify(value));
    reseal();
  };
  writeProof();
  return { directory, path, proof, index, writeProof, reseal, setJson,
    verify: (at = now) => verifyPublicationBundle(directory, commit, tree, at) };
}

describe("Gateway image publication authorization", () => {
  test("accepts only matching owner-dispatched source with its explicit exception", () => {
    expect(validatePublicationContext(context(), { commit, tree })).toEqual([]);
  });

  test("rejects forks, automatic/PR events, alternate refs/workflows and foreign reruns", () => {
    const changes = [
      { repository: "synthetic-owner/Reaper-Discord-Bot" },
      ...["push", "pull_request", "pull_request_target", "workflow_run", "schedule"].map((event) => ({ event })),
      { ref: "refs/heads/mochi/synthetic" }, { ref: "refs/tags/main" },
      { workflowRef: PUBLICATION_REPOSITORY + "/.github/workflows/ci.yml@refs/heads/main" },
      { workflowRef: PUBLICATION_REPOSITORY + "/.github/workflows/gateway-image.yml@refs/heads/mochi/synthetic" },
      { actor: "synthetic-owner" }, { triggeringActor: "synthetic-owner" },
      { actor: "Xartaiusx" },
    ];
    for (const change of changes) {
      expect(validatePublicationContext({ ...context(), ...change }, { commit, tree }).length).toBeGreaterThan(0);
    }
  });

  test("rejects commit/tree drift, abbreviated or malformed source and omitted permission exception", () => {
    for (const change of [
      { expectedCommit: otherCommit }, { commit: otherCommit }, { expectedTree: commit },
      { expectedCommit: commit.slice(0, 12), commit: commit.slice(0, 12) },
      { expectedCommit: "A".repeat(40), commit: "A".repeat(40) },
      { expectedTree: tree + "\n" }, { authorization: "" },
      { authorization: PUBLICATION_AUTHORIZATION + "_DEPLOY" },
    ]) expect(validatePublicationContext({ ...context(), ...change }, { commit, tree }).length).toBeGreaterThan(0);
    for (const source of [{ commit: otherCommit, tree }, { commit, tree: commit }]) {
      expect(validatePublicationContext(context(), source).length).toBeGreaterThan(0);
    }
    for (const key of Object.keys(context())) {
      const incomplete: Record<string, unknown> = { ...context() };
      delete incomplete[key];
      expect(validatePublicationContext(incomplete, { commit, tree }).length).toBeGreaterThan(0);
    }
  });
});

describe("existing protected publication policy", () => {
  test("accepts the acknowledged sole-owner approval policy on exact protected main", () => {
    const p = protection();
    expect(validatePublicationProtection(p.repository, p.branch, p.environment, commit)).toEqual([]);
  });

  test("rejects unprotected/moved main and wrong repository, default branch or visibility", () => {
    for (const change of [
      { full_name: "synthetic-owner/Reaper-Discord-Bot" }, { default_branch: "synthetic" },
      { visibility: "private" }, { visibility: "internal" },
    ]) {
      const p = protection();
      expect(validatePublicationProtection({ ...p.repository, ...change }, p.branch, p.environment, commit).length).toBeGreaterThan(0);
    }
    for (const change of [{ protected: false }, { protected: "true" },
      { name: "synthetic" }, { commit: { sha: otherCommit } }, { commit: null }]) {
      const p = protection();
      expect(validatePublicationProtection(p.repository, { ...p.branch, ...change }, p.environment, commit).length).toBeGreaterThan(0);
    }
  });

  test("rejects a nonexistent/unprotected environment and admin or custom-branch bypass", () => {
    for (const environment of [null, [], { message: "Not Found" }, {},
      { ...protection().environment, name: "synthetic-publication" },
      { ...protection().environment, can_admins_bypass: true },
      { ...protection().environment, can_admins_bypass: undefined },
      { ...protection().environment, deployment_branch_policy: null },
      { ...protection().environment, deployment_branch_policy: { protected_branches: false, custom_branch_policies: false } },
      { ...protection().environment, deployment_branch_policy: { protected_branches: true, custom_branch_policies: true } },
    ]) {
      const p = protection();
      expect(validatePublicationProtection(p.repository, p.branch, environment, commit).length).toBeGreaterThan(0);
    }
  });

  test("rejects missing/duplicate approvals, foreign users/teams and unacknowledged policy changes", () => {
    const review = protection().environment.protection_rules[1]!;
    const rules = [[], [{ type: "branch_policy" }], [review, review], [review, { type: "wait_timer" }],
      [null], [{ ...review, prevent_self_review: true }],
      [{ ...review, reviewers: [] }],
      [{ ...review, reviewers: [{ type: "Team", reviewer: { login: "xartaiusx" } }] }],
      [{ ...review, reviewers: [{ type: "User", reviewer: { login: "synthetic-owner" } }] }],
      [{ ...review, reviewers: [...review.reviewers!, { type: "User", reviewer: { login: "synthetic-owner" } }] }],
    ];
    for (const protection_rules of rules) {
      const p = protection();
      expect(validatePublicationProtection(p.repository, p.branch, { ...p.environment, protection_rules }, commit).length).toBeGreaterThan(0);
    }
  });
});

describe("final image scan policy", () => {
  test("accepts a complete clean scan and findings below the release threshold", () => {
    expect(validateImageScan(cleanScan())).toEqual([]);
    expect(validateImageScan({ SchemaVersion: 2, Results: [{ Vulnerabilities:
      ["UNKNOWN", "LOW", "MEDIUM"].map((Severity) => ({ Severity })) }] })).toEqual([]);
  });

  test("rejects high/critical vulnerabilities even without a fix and secret findings", () => {
    for (const field of ["Vulnerabilities", "Secrets"]) {
      for (const Severity of field === "Secrets" ? ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"] : ["HIGH", "CRITICAL"]) {
        for (const fix of [{}, { FixedVersion: "" }, { FixedVersion: "synthetic-fixed-version" }]) {
          expect(validateImageScan({ SchemaVersion: 2, Results: [{ [field]: [{ Severity, ...fix }] }] }).length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("rejects malformed, missing and unknown scan findings rather than coercing them", () => {
    for (const scan of [null, [], {}, { SchemaVersion: 1, Results: [] },
      { SchemaVersion: 2, Results: [] },
      { SchemaVersion: 2, Results: {} }, { SchemaVersion: 2, Results: [null] },
      { SchemaVersion: 2, Results: [{ Vulnerabilities: {} }] },
      { SchemaVersion: 2, Results: [{ Secrets: "none" }] },
      ...[null, {}, { Severity: "high" }, { Severity: "NONE" }, { Severity: 4 }]
        .map((finding) => ({ SchemaVersion: 2, Results: [{ Vulnerabilities: [finding] }] })),
    ]) expect(validateImageScan(scan).length).toBeGreaterThan(0);
  });
});

describe("bounded immutable publication bundle", () => {
  test("returns the manifest digest and archive hash for exact source and linked platform evidence", () => {
    const f = bundle();
    expect(f.verify()).toEqual({ digest: f.proof.digest, archiveSha256: f.proof.files["gateway.oci.tar"]! });
    expect(f.verify(now + 60 * 60 * 1000)).toEqual(f.verify());
  });

  test("rejects future/stale/invalid timestamps and mismatched source, platform or schema", () => {
    for (const change of [
      { repository: "synthetic-owner/Reaper-Discord-Bot" }, { commit: otherCommit }, { tree: commit },
      { platform: "linux/arm64" }, { schemaVersion: 2 },
      { createdAt: new Date(now + 1).toISOString() },
      { createdAt: new Date(now - 60 * 60 * 1000 - 1).toISOString() },
      { createdAt: "2026-10-11T12:00:00+00:00" }, { createdAt: "2026-02-30T12:00:00.000Z" },
      { createdAt: "2026-99-11T12:00:00.000Z" }, { digest: "sha256:" + "F".repeat(64) },
      { unexpected: true },
    ]) {
      const f = bundle();
      Object.assign(f.proof, change);
      f.writeProof();
      expect(() => f.verify()).toThrow();
    }
    const f = bundle();
    expect(() => verifyPublicationBundle(f.directory, otherCommit, tree, now)).toThrow();
    expect(() => verifyPublicationBundle(f.directory, commit, commit, now)).toThrow();
  });

  test("rejects changed or missing evidence bytes, unlisted files and a substituted manifest digest", () => {
    for (const name of bundleNames) {
      const f = bundle();
      writeFileSync(f.path(name), readFileSync(f.path(name), "utf8") + " ");
      expect(() => f.verify()).toThrow("byte drift");
    }
    for (const change of ["missing", "extra", "digest"] as const) {
      const f = bundle();
      if (change === "missing") delete f.proof.files["scan.json"];
      if (change === "extra") f.proof.files["synthetic-extra.json"] = "a".repeat(64);
      if (change === "digest") f.proof.digest = "sha256:" + "a".repeat(64);
      f.writeProof();
      expect(() => f.verify()).toThrow();
    }
    const f = bundle();
    rmSync(f.path("scan.json"));
    expect(() => f.verify()).toThrow();
  });

  test("rejects empty, oversized or non-file evidence before accepting the bundle", () => {
    for (const kind of ["empty", "oversized", "directory"] as const) {
      const f = bundle();
      if (kind === "empty") writeFileSync(f.path("gateway.oci.tar"), "");
      if (kind === "oversized") truncateSync(f.path("scan.json"), 16 * 1024 * 1024 + 1);
      if (kind === "directory") {
        rmSync(f.path("scan.json"));
        mkdirSync(f.path("scan.json"));
      }
      expect(() => f.verify()).toThrow("Invalid or oversized");
    }
    const f = bundle();
    writeFileSync(f.path("manifest.json"), " ".repeat(1024 * 1024 + 1));
    f.reseal();
    expect(() => f.verify()).toThrow("Invalid or oversized");
  });

  test("rejects correctly rehashed evidence with a foreign platform or detached/missing attestations", () => {
    for (const kind of ["arm", "os", "duplicate", "unlinked", "wrong-type", "missing"] as const) {
      const f = bundle();
      if (kind === "arm") f.index.manifests[0]!.platform.architecture = "arm64";
      if (kind === "os") f.index.manifests[0]!.platform.os = "windows";
      if (kind === "duplicate") f.index.manifests.push(f.index.manifests[0]!);
      if (kind === "unlinked") f.index.manifests[1]!.annotations!["vnd.docker.reference.digest"] = "sha256:" + "a".repeat(64);
      if (kind === "wrong-type") f.index.manifests[1]!.annotations!["vnd.docker.reference.type"] = "synthetic-manifest";
      if (kind === "missing") f.index.manifests.pop();
      f.setJson("manifest.json", f.index);
      expect(() => f.verify()).toThrow();
    }
  });

  test("rejects rehashed invalid SBOMs and high/critical image findings", () => {
    for (const sbom of [null, {}, { spdxVersion: "SPDX-2.2", packages: [{}] },
      { spdxVersion: "SPDX-2.3", packages: [] }, { spdxVersion: "SPDX-2.3", packages: {} }]) {
      const f = bundle();
      f.setJson("sbom.spdx.json", sbom);
      expect(() => f.verify()).toThrow("SPDX");
    }
    for (const field of ["Vulnerabilities", "Secrets"]) {
      for (const Severity of field === "Secrets" ? ["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"] : ["HIGH", "CRITICAL"]) {
        const f = bundle();
        f.setJson("scan.json", { SchemaVersion: 2, Results: [{ [field]: [{ Severity, FixedVersion: "" }] }] });
        expect(() => f.verify()).toThrow(field === "Secrets" ? "secret" : "cannot be suppressed");
      }
    }
  });
});

type WorkflowStep = {
  uses?: string; name?: string; id?: string; run?: string;
  with?: Record<string, unknown>; env?: Record<string, unknown>;
  [key: string]: unknown;
};
type WorkflowJob = {
  if: string; permissions: Record<string, string>; steps: WorkflowStep[];
  [key: string]: unknown;
};
type Workflow = {
  on: Record<string, unknown>; env: Record<string, unknown>; permissions: Record<string, string>;
  jobs: Record<"build" | "publish", WorkflowJob> & Record<string, WorkflowJob>;
  [key: string]: unknown;
};
const publisherPath = ".github/workflows/gateway-image.yml";
const workflowSource = readFileSync(new URL("../" + publisherPath, import.meta.url), "utf8");
const ciPath = ".github/workflows/ci.yml";
const ciSource = readFileSync(new URL("../" + ciPath, import.meta.url), "utf8");
const publicationContract = JSON.parse(readFileSync(new URL("../contracts/gateway-image-publication.v1.json", import.meta.url), "utf8"));
const workflow = (): Workflow => Bun.YAML.parse(workflowSource) as Workflow;
const action = (job: WorkflowJob, name: string): WorkflowStep => {
  const step = job.steps.find((candidate) => candidate.uses?.startsWith(name + "@"));
  if (!step) throw new Error("Expected baseline action is absent: " + name);
  return step;
};
const command = (job: WorkflowJob, fragment: string): WorkflowStep => {
  const step = job.steps.find((candidate) => candidate.run?.includes(fragment));
  if (!step) throw new Error("Expected baseline command is absent: " + fragment);
  return step;
};
function rejectWorkflow(mutate: (w: Workflow) => void) {
  const w = workflow();
  mutate(w);
  const source = JSON.stringify(w);
  expect(source).not.toBe(JSON.stringify(workflow()));
  const errors = validateGatewayImageWorkflow(source, publicationContract);
  expect(errors.length).toBeGreaterThan(0);
  // Prove semantic/step checks execute in addition to the normalized source seal.
  expect(errors.some((error) => !error.includes("source binding changed"))).toBe(true);
}

describe("exact dormant image workflow", () => {
  test("accepts the held source and CRLF normalization while preserving unapproved activation flags", () => {
    expect(validateGatewayImageWorkflow(workflowSource, publicationContract)).toEqual([]);
    expect(validateGatewayImageWorkflow(workflowSource.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n"), publicationContract)).toEqual([]);
    expect(publicationContract.publicationAuthorized).toBe(false);
    expect(publicationContract.deploymentAuthorized).toBe(false);
    expect(publicationContract.packageVisibilityChangeAllowed).toBe(false);
    expect(publicationContract.hostOrDiscordActionsAllowed).toBe(false);
    expect(validateGatewayImageWorkflow(JSON.stringify(workflow()), publicationContract)).not.toEqual([]);
  });

  test("initializes runner-local paths before use and rejects runner context in job env", () => {
    for (const name of ["build", "publish"] as const) {
      const job = workflow().jobs[name];
      expect(job.env).toBeUndefined();
      expect(job.steps[0]).toEqual({
        name: "Initialize runner-local bundle path",
        shell: "bash",
        run: 'set -Eeuo pipefail\nprintf \'BUNDLE=%s/gateway-bundle\\n\' "$RUNNER_TEMP" >> "$GITHUB_ENV"\n',
      });
      for (const value of ["${{ runner.temp }}/gateway-bundle", "${{ runner['temp'] }}/gateway-bundle"]) {
        const w = workflow();
        w.jobs[name].env = { BUNDLE: value };
        expect(validateGatewayImageWorkflow(JSON.stringify(w), publicationContract)).toContain(
          "Runner context is unavailable in job env; initialize runner-local paths in a step.",
        );
      }
      rejectWorkflow((w) => { w.jobs[name].steps.shift(); });
      rejectWorkflow((w) => {
        [w.jobs[name].steps[0], w.jobs[name].steps[1]] = [w.jobs[name].steps[1]!, w.jobs[name].steps[0]!];
      });
    }
  });

  test("runs every Skopeo mount operation as the runner without weakening access controls", () => {
    const runnerUser = '--user "$(id -u):$(id -g)"';
    const calls = (["build", "publish"] as const).flatMap((jobName) =>
      workflow().jobs[jobName].steps.flatMap((step, stepIndex) =>
        (step.run ?? "").split("\n").flatMap((line, lineIndex) =>
          line.includes("docker run ") && line.includes('"$SKOPEO_IMAGE"')
            ? [{ jobName, stepIndex, lineIndex, line }] : [])));
    expect(calls).toHaveLength(6);
    expect(calls.filter(({ jobName }) => jobName === "build")).toHaveLength(2);
    for (const { jobName, stepIndex, lineIndex, line } of calls) {
      for (const flag of [runnerUser, "--rm", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges"]) {
        expect(line).toContain(flag);
      }
      const mounts = [];
      expect(line).not.toContain('--volume "$RUNNER_TEMP:/output"');
      expect(line).not.toContain("oci:/layout");
      if (line.includes("oci-archive:/bundle/gateway.oci.tar")) {
        mounts.push('--volume "$RUNNER_TEMP/skopeo-tmp:/var/tmp"', '--volume "$BUNDLE:/bundle:ro"');
      }
      if (line.includes("docker-archive:/output/runtime.tar")) mounts.push('--volume "$RUNNER_TEMP/gateway-conversion:/output"');
      if (line.includes("--authfile /auth.json") || line.includes("--dest-authfile /auth.json")) {
        mounts.push('--volume "$auth:/auth.json:ro"');
      }
      for (const mount of mounts) expect(line).toContain(mount);
      if (!line.includes("docker://")) expect(line).toContain("--network none");
      for (const [from, to] of [
        [runnerUser, ""], [runnerUser, "--user 0:0"],
        [runnerUser, '--user "$(id -u):0"'], [runnerUser, "--user 65532:65532"],
        ["--cap-drop ALL", "--cap-add DAC_OVERRIDE"], ["--read-only", "--privileged"],
        ["--security-opt no-new-privileges", ""],
        ...mounts.map((mount) => [mount, mount.includes(":ro") ? mount.replace(":ro", ":rw") : ""]),
      ]) rejectWorkflow((w) => {
        const step = w.jobs[jobName].steps[stepIndex]!;
        const lines = step.run!.split("\n");
        lines[lineIndex] = lines[lineIndex]!.replace(from!, to!);
        step.run = lines.join("\n");
      });
    }
    rejectWorkflow((w) => {
      const step = command(w.jobs.publish, 'chmod 0600 "$auth"');
      step.run = step.run!.replace('chmod 0600 "$auth"', 'chmod 0666 "$auth"');
    });
    rejectWorkflow((w) => {
      const step = command(w.jobs.build, 'mkdir -p "$RUNNER_TEMP/skopeo-tmp"');
      step.run = step.run!.replace('mkdir -p "$RUNNER_TEMP/skopeo-tmp"', 'mkdir -p "$RUNNER_TEMP/skopeo-tmp"\nchmod -R 0777 "$RUNNER_TEMP"');
    });
  });

  test("isolates conversion output while retaining the original archive transport", () => {
    const message = "Conversion must isolate writable output from the verified archive.";
    const source = command(workflow().jobs.build, "docker-archive:/output/runtime.tar").run!;
    for (const fragment of [
      'mkdir -p "$RUNNER_TEMP/skopeo-tmp" "$RUNNER_TEMP/gateway-conversion"',
      'trivy image --input "$RUNNER_TEMP/gateway-conversion/runtime.tar"',
      'docker load --input "$RUNNER_TEMP/gateway-conversion/runtime.tar"',
    ]) expect(source).toContain(fragment);
    for (const [from, to] of [
      ['--volume "$RUNNER_TEMP/gateway-conversion:/output"', '--volume "$RUNNER_TEMP:/output"'],
      ['--volume "$RUNNER_TEMP/gateway-conversion:/output"', '--volume "$BUNDLE:/output"'],
      ["copy oci-archive:/bundle/gateway.oci.tar", "copy oci:/layout"],
      ['trivy image --input "$RUNNER_TEMP/gateway-conversion/runtime.tar"', 'trivy image --input "$RUNNER_TEMP/runtime.tar"'],
      ['docker load --input "$RUNNER_TEMP/gateway-conversion/runtime.tar"', 'docker load --input "$RUNNER_TEMP/runtime.tar"'],
    ]) {
      const w = workflow();
      const step = command(w.jobs.build, "docker-archive:/output/runtime.tar");
      step.run = step.run!.replaceAll(from!, to!);
      expect(validateGatewayImageWorkflow(JSON.stringify(w), publicationContract)).toContain(message);
      rejectWorkflow((candidate) => {
        const conversion = command(candidate.jobs.build, "docker-archive:/output/runtime.tar");
        conversion.run = conversion.run!.replaceAll(from!, to!);
      });
    }
  });

  test("rejects automatic or additional events, optional source inputs and global write scopes", () => {
    for (const event of ["push", "pull_request", "pull_request_target", "workflow_run", "schedule"]) {
      rejectWorkflow((w) => { w.on[event] = {}; });
    }
    rejectWorkflow((w) => { w.on = { push: { branches: ["main"] } }; });
    rejectWorkflow((w) => { w.permissions.packages = "write"; });
    for (const name of ["expected_commit", "expected_tree", "publication_authorization"]) {
      rejectWorkflow((w) => {
        const dispatch = w.on.workflow_dispatch as { inputs: Record<string, { required: boolean }> };
        dispatch.inputs[name]!.required = false;
      });
    }
  });

  test("rejects weakening either job's owner, main, event, source or explicit exception gate", () => {
    for (const name of ["build", "publish"] as const) {
      for (const gate of [
        "github.repository == 'Mochirii-Wushu/Reaper-Discord-Bot'",
        "github.event_name == 'workflow_dispatch'", "github.ref == 'refs/heads/main'",
        "github.actor == 'xartaiusx'", "github.triggering_actor == 'xartaiusx'",
        "inputs.expected_commit == github.sha",
        "inputs.publication_authorization == '" + PUBLICATION_AUTHORIZATION + "'",
      ]) rejectWorkflow((w) => { w.jobs[name].if = w.jobs[name].if.replace(gate, "true"); });
    }
    rejectWorkflow((w) => { w.jobs.publish.if = w.jobs.publish.if.replace("needs.build.result == 'success'", "always()"); });
    for (const name of ["build", "publish"] as const) {
      rejectWorkflow((w) => { action(w.jobs[name], "actions/checkout").with!.ref = "refs/heads/main"; });
      rejectWorkflow((w) => { action(w.jobs[name], "actions/checkout").with!["persist-credentials"] = true; });
    }
    rejectWorkflow((w) => { w.env.EXPECTED_SHA = "${{ github.event.pull_request.head.sha }}"; });
    rejectWorkflow((w) => { w.env.EXPECTED_TREE = tree; });
    rejectWorkflow((w) => { w.env.PUBLICATION_AUTHORIZATION = PUBLICATION_AUTHORIZATION; });
  });

  test("rejects privilege escalation, unprotected/self-hosted execution and bypassed build dependency", () => {
    for (const name of ["build", "publish"] as const) {
      rejectWorkflow((w) => { w.jobs[name]["runs-on"] = "self-hosted"; });
      rejectWorkflow((w) => { w.jobs[name]["timeout-minutes"] = 0; });
      rejectWorkflow((w) => { w.jobs[name]["continue-on-error"] = true; });
      rejectWorkflow((w) => { w.jobs[name].permissions.contents = "write"; });
      rejectWorkflow((w) => { w.jobs[name].permissions.deployments = "write"; });
    }
    rejectWorkflow((w) => { w.jobs.build.permissions.packages = "write"; });
    rejectWorkflow((w) => { w.jobs.build.permissions["id-token"] = "write"; });
    rejectWorkflow((w) => { w.jobs.publish.permissions["artifact-metadata"] = "write"; });
    rejectWorkflow((w) => { delete w.jobs.publish.permissions.attestations; });
    rejectWorkflow((w) => { w.jobs.publish.environment = "synthetic-unprotected"; });
    rejectWorkflow((w) => { delete w.jobs.publish.needs; });
    rejectWorkflow((w) => { w.jobs.synthetic = structuredClone(w.jobs.publish); });
  });

  test("rejects different image/platform/build output, credentials and mutable or extra actions", () => {
    rejectWorkflow((w) => { w.env.IMAGE = "registry.test/synthetic/reaper"; });
    rejectWorkflow((w) => { w.env.SKOPEO_IMAGE = "registry.test/synthetic/tool:latest"; });
    for (const [key, value] of [
      ["platforms", "linux/arm64"], ["platforms", "linux/amd64,linux/arm64"],
      ["push", true], ["provenance", false], ["sbom", false],
      ["outputs", "type=docker"], ["build-args", "SYNTHETIC_SECRET=${{ secrets.SYNTHETIC_TOKEN }}"],
    ] as const) rejectWorkflow((w) => { action(w.jobs.build, "docker/build-push-action").with![key] = value; });
    rejectWorkflow((w) => { action(w.jobs.publish, "docker/login-action").with!.registry = "registry.test"; });
    rejectWorkflow((w) => { action(w.jobs.publish, "docker/login-action").with!.password = "${{ secrets.SYNTHETIC_PAT }}"; });
    rejectWorkflow((w) => { action(w.jobs.build, "actions/checkout").uses = "actions/checkout@main"; });
    rejectWorkflow((w) => { w.jobs.publish.steps.push({ uses: "synthetic/action@" + commit }); });
    rejectWorkflow((w) => { w.jobs.publish.steps[0]!.env = { SYNTHETIC_SECRET: "${{ secrets.SYNTHETIC_TOKEN }}" }; });
  });

  test("rejects scan, exact archive, protection, artifact and attestation validation bypasses", () => {
    for (const [from, to] of [
      ["--ignore-unfixed=false", "--ignore-unfixed=true"],
      ["--scanners vuln,secret", "--scanners vuln"], ["--scanners vuln,secret", "--scanners vuln,secret --severity HIGH,CRITICAL"],
      ["--ignorefile /dev/null", "--ignorefile .trivyignore"],
      ["bun run check:container", "true"],
    ]) rejectWorkflow((w) => {
      const step = command(w.jobs.build, from!);
      step.run = step.run!.replace(from!, to!);
    });
    for (const name of ["build", "publish"] as const) {
      rejectWorkflow((w) => { command(w.jobs[name], "gateway-image-publication.ts guard").run = "true"; });
    }
    for (const fragment of ["gateway-image-publication.ts verify", "actual-manifest.json"]) {
      rejectWorkflow((w) => { command(w.jobs.publish, fragment).run = "true"; });
    }
    for (const [from, to] of [["--all --preserve-digests", ""],
      ['cmp "$BUNDLE/manifest.json" "$RUNNER_TEMP/registry-manifest.json"', "true"]]) {
      rejectWorkflow((w) => {
        const step = command(w.jobs.publish, from!);
        step.run = step.run!.replace(from!, to!);
      });
    }
    rejectWorkflow((w) => { action(w.jobs.publish, "actions/download-artifact").with!["digest-mismatch"] = "warn"; });
    rejectWorkflow((w) => { action(w.jobs.publish, "actions/download-artifact").with!["artifact-ids"] = "${{ inputs.synthetic_artifact_id }}"; });
    rejectWorkflow((w) => { action(w.jobs.build, "actions/upload-artifact").with!["if-no-files-found"] = "ignore"; });
    rejectWorkflow((w) => { action(w.jobs.build, "actions/upload-artifact").with!.overwrite = true; });
    rejectWorkflow((w) => { action(w.jobs.publish, "actions/attest").with!["subject-digest"] = runnableDigest; });
    rejectWorkflow((w) => { action(w.jobs.publish, "actions/attest").with!["create-storage-record"] = true; });
    rejectWorkflow((w) => { command(w.jobs.publish, "gh attestation verify").run = "true"; });
    rejectWorkflow((w) => { command(w.jobs.build, "trivy image --input")["continue-on-error"] = true; });
  });

  test("rejects appended host, Discord, release, deletion and visibility operations", () => {
    for (const run of [
      "ssh synthetic.test systemctl restart synthetic.service", "supabase functions deploy",
      "node dist/index.js", "bun src/register-commands.ts", "gh release create synthetic",
      "gh api --method DELETE /orgs/synthetic.test/packages/container/synthetic",
      "gh api --method PUT /orgs/synthetic.test/packages/container/synthetic/visibility -f visibility=public",
    ]) rejectWorkflow((w) => { w.jobs.publish.steps.push({ run }); });
  });

  test("changing workflow and all exposed seals together cannot self-authorize another target or privilege", () => {
    for (const kind of ["target", "permissions", "source", "activation"] as const) {
      const w = workflow();
      const contract = structuredClone(publicationContract);
      if (kind === "target") { w.env.IMAGE = "registry.test/synthetic/reaper"; contract.image = w.env.IMAGE; }
      if (kind === "permissions") w.jobs.publish.permissions.contents = "write";
      if (kind === "source") w.jobs.publish.if = "always()";
      if (kind === "activation") { contract.publicationAuthorized = true; contract.deploymentAuthorized = true; }
      const source = JSON.stringify(w);
      contract.workflowSha256 = sha(source);
      for (const name of ["build", "publish"] as const) {
        contract.stepSha256[name] = w.jobs[name].steps.map((step) => sha(JSON.stringify(step)));
      }
      expect(validateGatewayImageWorkflow(source, contract)).toContain("The exact reviewed publication-only contract is required.");
    }
  });

  test("rejects malformed, oversized and non-reviewed source or contracts", () => {
    for (const source of ["jobs: [", "null", "\uFEFF" + workflowSource, workflowSource + " ".repeat(64 * 1024)]) {
      expect(validateGatewayImageWorkflow(source, publicationContract).length).toBeGreaterThan(0);
    }
    for (const contract of [null, [], {}, { ...publicationContract, permissionExceptionRequired: false },
      { ...publicationContract, packageVisibilityChangeAllowed: true },
      { ...publicationContract, sourceProviderDependencyExceptionRequired: false }]) {
      expect(validateGatewayImageWorkflow(workflowSource, contract).length).toBeGreaterThan(0);
    }
  });
});

describe("publication-only workflow-set exception", () => {
  const ordinaryCi = "name: synthetic\non: push\npermissions: {contents: read}\njobs: {check: {runs-on: ubuntu-24.04, steps: [{run: bun run check}]}}\n";
  test("accepts only the actual canonical CI plus the dormant publisher, with optional ordinary CI elsewhere", () => {
    expect(validateGatewayWorkflowSet({ [publisherPath]: workflowSource, [ciPath]: ciSource }, publicationContract)).toEqual([]);
    expect(validateGatewayWorkflowSet({ [publisherPath]: workflowSource, [ciPath]: ciSource,
      ".github/workflows/other.yml": ordinaryCi }, publicationContract)).toEqual([]);
    expect(validateGatewayWorkflowSet({ [publisherPath]: workflowSource,
      [ciPath]: ciSource.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n") }, publicationContract)).toEqual([]);
  });

  test("rejects missing, renamed, copied and additional privileged workflows", () => {
    const mutants: Record<string, string>[] = [
      {}, { [ciPath]: ciSource }, { [publisherPath]: workflowSource },
      { [ciPath]: ciSource, ".github/workflows/renamed.yml": workflowSource },
      { [publisherPath]: workflowSource, ".github/workflows/renamed-ci.yml": ciSource },
      { [publisherPath]: workflowSource, [ciPath]: ordinaryCi },
      { [publisherPath]: workflowSource, [ciPath]: ciSource, ".github/workflows/copied.yml": workflowSource },
      ...["docker push registry.test/synthetic/reaper", "supabase functions deploy", "supabase db push", "vercel deploy", "echo ghcr.io"]
        .map((run) => ({ [publisherPath]: workflowSource, [ciPath]: ciSource,
          ".github/workflows/other.yml": ordinaryCi + "# " + run })),
    ];
    for (const workflows of mutants) expect(validateGatewayWorkflowSet(workflows, publicationContract).length).toBeGreaterThan(0);
  });

  test("a privileged workflow at the canonical name still requires exact source and contract", () => {
    expect(validateGatewayWorkflowSet({ [publisherPath]: workflowSource + "\n# unreviewed", [ciPath]: ciSource }, publicationContract).length).toBeGreaterThan(0);
    expect(validateGatewayWorkflowSet({ [publisherPath]: workflowSource, [ciPath]: ciSource },
      { ...publicationContract, publicationAuthorized: true }).length).toBeGreaterThan(0);
  });
});

describe("mandatory offline converter CI", () => {
  const ci = (): Workflow => Bun.YAML.parse(ciSource) as Workflow;
  const conversion = (candidate: Workflow): WorkflowStep => command(candidate.jobs.validate, "converter_args=(");
  const originalCi = ciSource.replaceAll("\r\n", "\n");
  const converterHeader = "      - name: Verify pinned converter without publishing\n        shell: bash\n";
  const converterStep = originalCi.slice(originalCi.indexOf(converterHeader));
  const offlineStep = "      - name: Verify OCI worker without provider access\n        env:\n" +
    "          REAPER_CONTAINER_IMAGE: mochirii-reaper-gateway:ci\n        run: bun run check:container\n";
  const jobHeader = "  validate:\n    runs-on: ubuntu-24.04\n";
  const jobEnv = "    env:\n      EXPECTED_SHA: ${{ github.event.pull_request.head.sha || github.sha }}\n";
  const permissions = "permissions:\n  contents: read\n";
  const acceptanceCommand = 'REAPER_CONTAINER_IMAGE=mochirii-reaper-gateway:converted REAPER_EXPECTED_REVISION="$EXPECTED_SHA" bun run check:container';
  const rejectCi = (from: string, to: string) => {
    expect(validateGatewayWorkflowSet({ [publisherPath]: workflowSource,
      [ciPath]: originalCi }, publicationContract)).toEqual([]);
    const offset = originalCi.indexOf(from);
    expect(from.length).toBeGreaterThan(0);
    expect(offset).toBeGreaterThanOrEqual(0);
    expect(originalCi.indexOf(from, offset + from.length)).toBe(-1);
    const candidate = originalCi.replace(from, to);
    expect(candidate).not.toBe(originalCi);
    expect(candidate).toBe(originalCi.slice(0, offset) + to + originalCi.slice(offset + from.length));
    expect(validateGatewayWorkflowSet({ [publisherPath]: workflowSource,
      [ciPath]: candidate }, publicationContract)).toContain(
      "The exact required CI source and offline converter gate must remain unchanged.",
    );
  };

  test("requires the converter gate immediately after the original offline container verification", () => {
    const candidate = ci();
    const steps = candidate.jobs.validate.steps;
    const step = conversion(candidate);
    const previous = steps[steps.indexOf(step) - 1];
    expect(step.name).toBe("Verify pinned converter without publishing");
    expect(step.shell).toBe("bash");
    expect(Object.keys(step).sort()).toEqual(["name", "run", "shell"]);
    expect(previous).toEqual({ name: "Verify OCI worker without provider access",
      env: { REAPER_CONTAINER_IMAGE: "mochirii-reaper-gateway:ci" }, run: "bun run check:container" });
    expect(candidate.permissions).toEqual({ contents: "read" });
    expect(candidate.jobs.validate.permissions).toBeUndefined();
    expect(Object.keys(candidate.jobs.validate.env as object)).toEqual(["EXPECTED_SHA"]);
    expect(step.env).toBeUndefined();
  });

  test("derives the exact candidate from the publication contract and pulls publicly before offline execution", () => {
    const run = conversion(ci()).run!;
    const assignment = 'SKOPEO_IMAGE="$(node -p "require(\'./contracts/gateway-image-publication.v1.json\').skopeoImage")"';
    expect(run).toContain("set -Eeuo pipefail");
    expect(run).toContain(assignment);
    expect(run).not.toContain(publicationContract.skopeoImage);
    expect(workflow().env.SKOPEO_IMAGE).toBe(publicationContract.skopeoImage);
    expect(run).toContain('docker pull --platform linux/amd64 "$SKOPEO_IMAGE"');
    expect(run.indexOf(assignment)).toBeLessThan(run.indexOf("docker pull "));
    expect(run.indexOf("docker pull ")).toBeLessThan(run.indexOf("docker run "));
    expect(run).toContain('--version | head -c257 > "$conversion/version.txt"');
    expect(run).toContain('grep -Fx \'skopeo version 1.22.3\' "$conversion/version.txt"');
    expect(run).toContain("test \"$(docker image inspect --format '{{.Os}}/{{.Architecture}}' \"$SKOPEO_IMAGE\")\" = linux/amd64");
    expect(run).not.toMatch(/docker\s+login|\$\{\{\s*secrets\.|--authfile|--dest-authfile|--creds/iu);
  });

  test("uses hardened non-root offline runs with read-only input and isolated writable conversion directories", () => {
    const run = conversion(ci()).run!;
    expect(run).toContain('conversion="$(mktemp -d "$RUNNER_TEMP/reaper-converter.XXXXXXXX")"');
    expect(run).toContain('mkdir "$conversion/input" "$conversion/oci" "$conversion/docker" "$conversion/tmp"');
    expect(run).toContain('converter_args=(--rm --pull never --user "$(id -u):$(id -g)" --network none --read-only --cap-drop ALL --security-opt no-new-privileges --volume "$conversion/tmp:/var/tmp")');
    expect(run.match(/docker run "\$\{converter_args\[@\]\}"/gu)).toHaveLength(3);
    for (const fragment of [
      '--volume "$conversion/input:/input:ro" --volume "$conversion/oci:/output"',
      '--volume "$conversion/oci:/input:ro" --volume "$conversion/docker:/output"',
      'copy docker-archive:/input/gateway.tar oci-archive:/output/gateway.oci.tar:ci',
      'copy oci-archive:/input/gateway.oci.tar docker-archive:/output/gateway.tar:mochirii-reaper-gateway:converted',
    ]) expect(run).toContain(fragment);
    expect(run).not.toContain('--volume "$RUNNER_TEMP:/output"');
    expect(run).not.toContain('--volume "$GITHUB_WORKSPACE:/output"');
    expect(run).not.toContain("--privileged");
  });

  test("checks the converted image's identity and platform before its unchanged offline acceptance check", () => {
    const run = conversion(ci()).run!;
    expect(run).toContain('docker save --output "$conversion/input/gateway.tar" mochirii-reaper-gateway:ci');
    expect(run).toContain('docker load --input "$conversion/docker/gateway.tar"');
    expect(run).toContain("test \"$(docker image inspect --format '{{.Id}}' mochirii-reaper-gateway:converted)\" = \"$original_image_id\"");
    expect(run).toContain("test \"$(docker image inspect --format '{{.Os}}/{{.Architecture}}' mochirii-reaper-gateway:converted)\" = linux/amd64");
    const acceptance = 'REAPER_CONTAINER_IMAGE=mochirii-reaper-gateway:converted REAPER_EXPECTED_REVISION="$EXPECTED_SHA" bun run check:container';
    expect(run).toContain(acceptance);
    expect(run.indexOf('docker load --input "$conversion/docker/gateway.tar"')).toBeLessThan(run.indexOf(acceptance));
  });

  test("reports failures using fixed stage labels and status without tracing commands or dumping environment", () => {
    const run = conversion(ci()).run!;
    const trap = 'trap \'status=$?; printf "Converter preflight failed: phase=%s status=%s\\n" "$stage" "$status" >&2; exit "$status"\' ERR';
    expect(run.split("\n").filter((line) => line.startsWith("trap "))).toEqual([trap]);
    expect([...run.matchAll(/^stage=([a-z-]+)$/gmu)].map((match) => match[1])).toEqual([
      "contract", "pull", "converter-platform", "scratch", "save-worker", "version-command",
      "version-evidence", "version-match", "docker-to-oci", "oci-to-docker", "load-worker",
      "config-identity", "worker-platform", "offline-runtime",
    ]);
    expect(run).not.toMatch(/set[\t ]+-[a-zA-Z]*x|xtrace|printenv|declare[\t ]+-p|typeset[\t ]+-p|(?:^|\n)env[\t ]*(?:\n|$)|BASH_COMMAND/u);
    rejectCi(trap, trap.replace('"$stage" "$status"', '"$BASH_COMMAND" "$status"'));
    rejectCi(trap, "set -x\n" + trap);
    rejectCi(trap, "printenv\n" + trap);
  });

  test("bounds version stdout before JSON-only evidence and retains the exact fixed-line version comparison", () => {
    const run = conversion(ci()).run!;
    const capture = 'docker run "${converter_args[@]}" "$SKOPEO_IMAGE" --version | head -c257 > "$conversion/version.txt"';
    const evidence = run.split("\n").find((line) => line.startsWith("node -e "))!;
    const compare = 'grep -Fx \'skopeo version 1.22.3\' "$conversion/version.txt"';
    expect(run).toContain(capture); expect(evidence).toContain('new TextDecoder("utf-8",{fatal:true})');
    expect(evidence).toContain("JSON.stringify(version)");
    expect(run.indexOf(capture)).toBeLessThan(run.indexOf(evidence));
    expect(run.indexOf(evidence)).toBeLessThan(run.indexOf(compare));
    rejectCi("head -c257", "cat");
    rejectCi('if(fs.statSync(file).size>256)throw Error("VERSION_SIZE");', "");
    rejectCi('if(bytes.length>256)throw Error("VERSION_SIZE");', "");
    rejectCi('new TextDecoder("utf-8",{fatal:true})', 'new TextDecoder("utf-8")');
    rejectCi("JSON.stringify(version)", "version");
    rejectCi(compare, compare.replace("grep -Fx", "grep -F"));
  });

  const versionProbe = (bytes: Buffer) => {
    const run = conversion(ci()).run!;
    const evidence = run.split("\n").find((line) => line.startsWith("node -e ")) || "";
    const match = /^node -e '([^']+)' "\$conversion\/version\.txt"$/u.exec(evidence);
    expect(match).not.toBeNull();
    const directory = mkdtempSync(join(tmpdir(), "reaper-gateway-image-test-"));
    fixtureRoots.add(directory);
    const file = join(directory, "version.txt"); writeFileSync(file, bytes);
    const result = spawnSync("node", ["-e", match![1]!, file], { encoding: "utf8", timeout: 5000, maxBuffer: 8192 });
    expect(result.error).toBeUndefined();
    return result;
  };

  test("the actual evidence reader JSON-escapes synthetic output and accepts the complete 256-byte UTF8 boundary", () => {
    for (const version of ["skopeo version 1.22.3\n", "界".repeat(85) + "a", "synthetic\n::warning::plain text\r\u001b[31m\t"]) {
      const result = versionProbe(Buffer.from(version, "utf8"));
      expect(result.status).toBe(0); expect(result.stderr).toBe("");
      expect(result.stdout).toBe("Converter version evidence: " + JSON.stringify(version) + "\n");
      expect(result.stdout.slice(0, -1)).not.toContain("\n");
      expect(result.stdout).not.toContain("\r"); expect(result.stdout).not.toContain("\u001b");
    }
  });

  test("the actual evidence reader rejects oversized or invalid UTF8 before printing any version data", () => {
    for (const bytes of [Buffer.alloc(257, 0x61), Buffer.from("界".repeat(86), "utf8"), Buffer.from([0xc3, 0x28])]) {
      const result = versionProbe(bytes);
      expect(result.status).not.toBe(0); expect(result.stdout).toBe("");
    }
  });

  test("rejects removing or reordering the required conversion step", () => {
    rejectCi(converterStep, "");
    rejectCi(offlineStep + converterStep, converterStep + offlineStep);
  });

  test("rejects conditional, error-tolerant or credential-bearing conversion and CI jobs", () => {
    rejectCi(converterHeader, converterHeader + "        if: false\n");
    rejectCi(converterHeader, converterHeader + "        continue-on-error: true\n");
    rejectCi(jobHeader, jobHeader + "    if: false\n");
    rejectCi(jobHeader, jobHeader + "    continue-on-error: true\n");
    for (const [key, value] of [
      ["SYNTHETIC_TOKEN", "${{ secrets.SYNTHETIC_TOKEN }}"], ["DOCKER_CONFIG", "/synthetic/credentials"],
    ]) {
      rejectCi(converterHeader, converterHeader + `        env:\n          ${key}: ${value}\n`);
      rejectCi(jobEnv, jobEnv + `      ${key}: ${value}\n`);
    }
    rejectCi(permissions, permissions + "\nenv:\n  SYNTHETIC_TOKEN: ${{ secrets.SYNTHETIC_TOKEN }}\n");
    rejectCi(acceptanceCommand, acceptanceCommand + "\n          docker login registry.test");
    rejectCi(permissions, permissions + "  packages: write\n");
    rejectCi(jobHeader, jobHeader + "    permissions:\n      contents: read\n      id-token: write\n");
  });

  test("rejects alternate candidates, network or privilege expansion, writable input and broad mounts", () => {
    for (const [from, to] of [
      ['SKOPEO_IMAGE="$(node -p "require(\'./contracts/gateway-image-publication.v1.json\').skopeoImage")"',
        'SKOPEO_IMAGE="registry.test/synthetic/converter:latest"'],
      ["--network none", "--network host"], ["--pull never", "--pull always"],
      ['--user "$(id -u):$(id -g)"', "--user 0:0"],
      ["--read-only", "--privileged"], ["--cap-drop ALL", "--cap-add SYS_ADMIN"],
      ["--security-opt no-new-privileges", ""],
      ['--volume "$conversion/input:/input:ro"', '--volume "$conversion/input:/input:rw"'],
      ['--volume "$conversion/oci:/input:ro"', '--volume "$conversion/oci:/input:rw"'],
      ['--volume "$conversion/docker:/output"', '--volume "$RUNNER_TEMP:/output"'],
      ['--volume "$conversion/oci:/output"', '--volume "$GITHUB_WORKSPACE:/output"'],
      ['--volume "$conversion/tmp:/var/tmp"', '--volume "$RUNNER_TEMP:/var/tmp"'],
    ]) rejectCi(from!, to!);
  });

  test("rejects bypassing either conversion, identity validation or the converted-image check", () => {
    for (const fragment of [
      'grep -Fx \'skopeo version 1.22.3\' "$conversion/version.txt"',
      "copy docker-archive:/input/gateway.tar oci-archive:/output/gateway.oci.tar:ci",
      "copy oci-archive:/input/gateway.oci.tar docker-archive:/output/gateway.tar:mochirii-reaper-gateway:converted",
      "test \"$(docker image inspect --format '{{.Id}}' mochirii-reaper-gateway:converted)\" = \"$original_image_id\"",
      'REAPER_CONTAINER_IMAGE=mochirii-reaper-gateway:converted REAPER_EXPECTED_REVISION="$EXPECTED_SHA" bun run check:container',
    ]) rejectCi(fragment, "true");
  });
});
