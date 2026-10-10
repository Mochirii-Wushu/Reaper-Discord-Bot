import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const PUBLICATION_REPOSITORY = "Mochirii-Wushu/Reaper-Discord-Bot";
export const PUBLICATION_IMAGE = "ghcr.io/mochirii-wushu/reaper-discord-bot";
export const PUBLICATION_ENVIRONMENT = "gateway-image-publication";
export const PUBLICATION_AUTHORIZATION =
  "APPROVE_PUBLICATION_ONLY_GITHUB_TOKEN_PACKAGES_ATTESTATIONS_OIDC";
const sha = (bytes: string | Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
  JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.sort());

export function validatePublicationContext(
  context: Record<string, unknown>,
  source: { commit: string; tree: string },
): string[] {
  const errors: string[] = [];
  if (
    context.repository !== PUBLICATION_REPOSITORY ||
    context.event !== "workflow_dispatch" ||
    context.ref !== "refs/heads/main" ||
    context.workflowRef !==
      PUBLICATION_REPOSITORY + "/.github/workflows/gateway-image.yml@refs/heads/main" ||
    context.actor !== "xartaiusx" || context.triggeringActor !== "xartaiusx"
  ) errors.push("Only the canonical owner-dispatched main workflow is allowed.");
  if (
    typeof context.expectedCommit !== "string" ||
    !/^[0-9a-f]{40}$/.test(context.expectedCommit) ||
    typeof context.expectedTree !== "string" ||
    !/^[0-9a-f]{40}$/.test(context.expectedTree) ||
    context.commit !== context.expectedCommit ||
    source.commit !== context.expectedCommit ||
    source.tree !== context.expectedTree
  ) errors.push("The checkout, dispatch commit and approved tree must match.");
  if (context.authorization !== PUBLICATION_AUTHORIZATION) {
    errors.push("The explicit publication-only permission exception is required.");
  }
  return errors;
}

export function validatePublicationProtection(
  repository: unknown,
  branch: unknown,
  environment: unknown,
  expectedCommit: string,
): string[] {
  const errors: string[] = [];
  if (
    !record(repository) || repository.full_name !== PUBLICATION_REPOSITORY ||
    repository.default_branch !== "main" || repository.visibility !== "public"
  ) errors.push("The canonical public repository and default branch must match.");
  if (
    !record(branch) || branch.name !== "main" || branch.protected !== true ||
    !record(branch.commit) || branch.commit.sha !== expectedCommit
  ) errors.push("The approved commit must remain the protected main head.");
  if (
    !record(environment) || environment.name !== PUBLICATION_ENVIRONMENT ||
    environment.can_admins_bypass !== false ||
    !record(environment.deployment_branch_policy) ||
    environment.deployment_branch_policy.protected_branches !== true ||
    environment.deployment_branch_policy.custom_branch_policies !== false ||
    !Array.isArray(environment.protection_rules)
  ) {
    errors.push("The preconfigured non-bypassable protected environment is required.");
    return errors;
  }
  const rules = environment.protection_rules;
  const review = rules.filter((rule) =>
    record(rule) && rule.type === "required_reviewers"
  );
  if (
    rules.some((rule) =>
      !record(rule) ||
      !["required_reviewers", "branch_policy"].includes(String(rule.type))
    ) ||
    review.length !== 1 || !record(review[0]) ||
    review[0].prevent_self_review !== false ||
    !Array.isArray(review[0].reviewers) || review[0].reviewers.length !== 1 ||
    !record(review[0].reviewers[0]) ||
    review[0].reviewers[0].type !== "User" ||
    !record(review[0].reviewers[0].reviewer) ||
    review[0].reviewers[0].reviewer.login !== "xartaiusx"
  ) errors.push("Only the explicitly acknowledged sole-owner approval policy is allowed.");
  return errors;
}

export function validateImageScan(scan: unknown): string[] {
  if (!record(scan) || scan.SchemaVersion !== 2 || !Array.isArray(scan.Results) || !scan.Results.length) {
    return ["A complete successful Trivy JSON report is required."];
  }
  const errors: string[] = [];
  for (const result of scan.Results) {
    if (!record(result)) return ["Invalid image scan result."];
    for (const field of ["Vulnerabilities", "Secrets"]) {
      const findings = result[field];
      if (findings === undefined || findings === null) continue;
      if (!Array.isArray(findings)) return ["Invalid image scan finding array."];
      for (const finding of findings) {
        if (
          !record(finding) || typeof finding.Severity !== "string" ||
          !["UNKNOWN", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(finding.Severity)
        ) return ["Invalid image scan finding."];
        if (field === "Secrets" || ["HIGH", "CRITICAL"].includes(finding.Severity)) {
          errors.push(field === "Secrets"
            ? "Every detected final-image secret must be rejected."
            : "Final-image high or critical findings cannot be suppressed.");
        }
      }
    }
  }
  return errors;
}

const bundleFiles = [
  "gateway.oci.tar", "manifest.json", "sbom.spdx.json", "scan.json",
  "build-metadata.json", "tool-versions.json",
] as const;
const readBounded = (path: string, maximum: number): Buffer => {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > maximum) {
    throw new Error("Invalid or oversized publication evidence.");
  }
  return readFileSync(path);
};
const readJson = (path: string): unknown =>
  JSON.parse(readBounded(path, 16 * 1024 * 1024).toString("utf8"));
const check = (errors: string[]): void => {
  if (errors.length) throw new Error(errors.join("\n"));
};
const git = (revision: string): string =>
  execFileSync("git", ["rev-parse", revision], { encoding: "utf8" }).trim();
const context = (): Record<string, unknown> => ({
  repository: process.env.GITHUB_REPOSITORY,
  event: process.env.GITHUB_EVENT_NAME,
  ref: process.env.GITHUB_REF,
  workflowRef: process.env.GITHUB_WORKFLOW_REF,
  actor: process.env.GITHUB_ACTOR,
  triggeringActor: process.env.GITHUB_TRIGGERING_ACTOR,
  commit: process.env.GITHUB_SHA,
  expectedCommit: process.env.EXPECTED_SHA,
  expectedTree: process.env.EXPECTED_TREE,
  authorization: process.env.PUBLICATION_AUTHORIZATION,
});

export function verifyPublicationBundle(
  directory: string,
  expectedCommit: string,
  expectedTree: string,
  now = Date.now(),
): { digest: string; archiveSha256: string } {
  const proof = readJson(resolve(directory, "source-proof.json"));
  if (
    !record(proof) ||
    !exactKeys(proof, ["schemaVersion", "repository", "commit", "tree", "platform", "createdAt", "digest", "files"]) ||
    proof.schemaVersion !== 1 || proof.repository !== PUBLICATION_REPOSITORY ||
    proof.commit !== expectedCommit || proof.tree !== expectedTree ||
    proof.platform !== "linux/amd64" ||
    typeof proof.createdAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(proof.createdAt) ||
    new Date(proof.createdAt).toISOString() !== proof.createdAt ||
    Date.parse(proof.createdAt) > now ||
    now - Date.parse(proof.createdAt) > 60 * 60 * 1000 ||
    typeof proof.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(proof.digest) ||
    !record(proof.files) || !exactKeys(proof.files, [...bundleFiles])
  ) throw new Error("Publication source proof is missing, stale or mismatched.");
  for (const file of bundleFiles) {
    const data = readBounded(resolve(directory, file), file === "gateway.oci.tar" ? 1024 ** 3 : 16 * 1024 * 1024);
    if (proof.files[file] !== sha(data)) throw new Error("Publication evidence byte drift.");
  }
  const manifest = readBounded(resolve(directory, "manifest.json"), 1024 * 1024);
  if (proof.digest !== "sha256:" + sha(manifest)) {
    throw new Error("OCI manifest digest differs from the approved bundle.");
  }
  const index: unknown = JSON.parse(manifest.toString("utf8"));
  if (
    !record(index) || index.schemaVersion !== 2 ||
    index.mediaType !== "application/vnd.oci.image.index.v1+json" ||
    !Array.isArray(index.manifests) || index.manifests.length !== 2
  ) throw new Error("One runnable platform plus its attestations is required.");
  const runnable = index.manifests.filter((entry) =>
    record(entry) && record(entry.platform) &&
    entry.platform.os === "linux" && entry.platform.architecture === "amd64"
  );
  const attestations = index.manifests.filter((entry) =>
    record(entry) && record(entry.platform) &&
    entry.platform.os === "unknown" && entry.platform.architecture === "unknown" &&
    record(entry.annotations) &&
    entry.annotations["vnd.docker.reference.type"] === "attestation-manifest" &&
    record(runnable[0]) &&
    entry.annotations["vnd.docker.reference.digest"] === runnable[0].digest
  );
  if (runnable.length !== 1 || attestations.length !== 1) {
    throw new Error("The exact platform and linked BuildKit attestations are required.");
  }
  const sbom = readJson(resolve(directory, "sbom.spdx.json"));
  if (!record(sbom) || sbom.spdxVersion !== "SPDX-2.3" || !Array.isArray(sbom.packages) || !sbom.packages.length) {
    throw new Error("A nonempty SPDX image SBOM is required.");
  }
  check(validateImageScan(readJson(resolve(directory, "scan.json"))));
  return { digest: proof.digest, archiveSha256: String(proof.files["gateway.oci.tar"]) };
}

if (import.meta.main) {
  const [mode, directory, digest] = process.argv.slice(2);
  check(validatePublicationContext(context(), { commit: git("HEAD"), tree: git("HEAD^{tree}") }));
  const expectedCommit = String(process.env.EXPECTED_SHA);
  const expectedTree = String(process.env.EXPECTED_TREE);
  if (mode === "guard" && directory && !digest) {
    check(validatePublicationProtection(
      readJson(resolve(directory, "repository.json")),
      readJson(resolve(directory, "branch.json")),
      readJson(resolve(directory, "environment.json")),
      expectedCommit,
    ));
    console.log("Exact source and existing protected publication policy verified.");
  } else if (mode === "record" && directory && /^sha256:[0-9a-f]{64}$/.test(digest || "")) {
    const files = Object.fromEntries(bundleFiles.map((file) => [
      file, sha(readBounded(resolve(directory, file), file === "gateway.oci.tar" ? 1024 ** 3 : 16 * 1024 * 1024)),
    ]));
    writeFileSync(resolve(directory, "source-proof.json"), JSON.stringify({
      schemaVersion: 1, repository: PUBLICATION_REPOSITORY, commit: expectedCommit,
      tree: expectedTree, platform: "linux/amd64", createdAt: new Date().toISOString(),
      digest, files,
    }, null, 2) + "\n");
    verifyPublicationBundle(directory, expectedCommit, expectedTree);
    console.log("Scanned OCI publication bundle recorded for " + digest + ".");
  } else if (mode === "verify" && directory && !digest) {
    const proof = verifyPublicationBundle(directory, expectedCommit, expectedTree);
    if (!process.env.GITHUB_OUTPUT) throw new Error("A hosted workflow output boundary is required.");
    writeFileSync(process.env.GITHUB_OUTPUT, "digest=" + proof.digest + "\n", { flag: "a" });
    console.log("Exact scanned OCI archive and source proof verified.");
  } else {
    throw new Error("Unsupported publication evidence operation.");
  }
}
