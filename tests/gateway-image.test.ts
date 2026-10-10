import { afterEach, describe, expect, test } from "bun:test";
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
    rejectWorkflow((w) => { w.jobs.build.steps[0]!.uses = "actions/checkout@main"; });
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
  test("accepts the exact dormant publisher with ordinary credential-free CI", () => {
    expect(validateGatewayWorkflowSet({ [publisherPath]: workflowSource, ".github/workflows/ci.yml": ordinaryCi }, publicationContract)).toEqual([]);
  });

  test("rejects missing, renamed, copied and additional privileged workflows", () => {
    const mutants: Record<string, string>[] = [
      {}, { ".github/workflows/renamed.yml": workflowSource },
      { [publisherPath]: workflowSource, ".github/workflows/copied.yml": workflowSource },
      ...["docker push registry.test/synthetic/reaper", "supabase functions deploy", "supabase db push", "vercel deploy", "echo ghcr.io"]
        .map((run) => ({ [publisherPath]: workflowSource, ".github/workflows/other.yml": ordinaryCi + "# " + run })),
    ];
    for (const workflows of mutants) expect(validateGatewayWorkflowSet(workflows, publicationContract).length).toBeGreaterThan(0);
  });

  test("a privileged workflow at the canonical name still requires exact source and contract", () => {
    expect(validateGatewayWorkflowSet({ [publisherPath]: workflowSource + "\n# unreviewed" }, publicationContract).length).toBeGreaterThan(0);
    expect(validateGatewayWorkflowSet({ [publisherPath]: workflowSource }, { ...publicationContract, publicationAuthorized: true }).length).toBeGreaterThan(0);
  });
});
