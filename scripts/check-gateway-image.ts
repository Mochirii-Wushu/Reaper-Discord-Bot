import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PUBLICATION_AUTHORIZATION,
  PUBLICATION_ENVIRONMENT,
  PUBLICATION_IMAGE,
  PUBLICATION_REPOSITORY,
} from "./gateway-image-publication.js";

const expectedContractSha256 = "636885d51536d8d59741abcfb904fb18739084b72a1933f6c7409786eb562853";
const hash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const equal = (actual: unknown, expected: unknown): boolean =>
  JSON.stringify(actual) === JSON.stringify(expected);
const keys = (actual: Record<string, unknown>, expected: string[]): boolean =>
  equal(Object.keys(actual).sort(), expected.sort());
const condition =
  "github.repository == 'Mochirii-Wushu/Reaper-Discord-Bot' && github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main' && github.actor == 'xartaiusx' && github.triggering_actor == 'xartaiusx' && inputs.expected_commit == github.sha && inputs.publication_authorization == '" +
  PUBLICATION_AUTHORIZATION + "'";

export function validateGatewayImageWorkflow(source: string, contract: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(contract) || hash(JSON.stringify(contract)) !== expectedContractSha256) {
    return ["The exact reviewed publication-only contract is required."];
  }
  if (
    source.length > 64 * 1024 || source.includes("\uFEFF") ||
    hash(source.replaceAll("\r\n", "\n")) !== contract.workflowSha256
  ) errors.push("The exact reviewed dormant publisher source binding changed.");
  let workflow: unknown;
  try {
    workflow = Bun.YAML.parse(source);
  } catch {
    return [...errors, "Invalid publication workflow YAML."];
  }
  if (
    !isRecord(workflow) ||
    !keys(workflow, ["name", "on", "permissions", "concurrency", "env", "jobs"]) ||
    workflow.name !== "Gateway image publication" ||
    !equal(workflow.permissions, {}) ||
    !equal(workflow.concurrency, { group: "reaper-gateway-image-publication", "cancel-in-progress": false }) ||
    !isRecord(workflow.on) || !keys(workflow.on, ["workflow_dispatch"]) ||
    !isRecord(workflow.on.workflow_dispatch) ||
    !keys(workflow.on.workflow_dispatch, ["inputs"]) ||
    !isRecord(workflow.on.workflow_dispatch.inputs) ||
    !keys(workflow.on.workflow_dispatch.inputs, ["expected_commit", "expected_tree", "publication_authorization"])
  ) return [...errors, "Only the exact manual dispatch and inert global permissions are allowed."];
  for (const input of Object.values(workflow.on.workflow_dispatch.inputs)) {
    if (!isRecord(input) || !keys(input, ["description", "required", "type"]) || input.required !== true || input.type !== "string") {
      errors.push("Publication must require all explicit reviewed source/exception inputs.");
    }
  }
  if (
    !isRecord(workflow.env) ||
    !keys(workflow.env, ["EXPECTED_SHA", "EXPECTED_TREE", "PUBLICATION_AUTHORIZATION", "IMAGE", "SKOPEO_IMAGE"]) ||
    workflow.env.EXPECTED_SHA !== "${{ inputs.expected_commit }}" ||
    workflow.env.EXPECTED_TREE !== "${{ inputs.expected_tree }}" ||
    workflow.env.PUBLICATION_AUTHORIZATION !== "${{ inputs.publication_authorization }}" ||
    workflow.env.IMAGE !== PUBLICATION_IMAGE || workflow.env.SKOPEO_IMAGE !== contract.skopeoImage
  ) errors.push("Publication source inputs and exact image/tool targets cannot change.");
  if (!isRecord(workflow.jobs) || !keys(workflow.jobs, ["build", "publish"])) {
    return [...errors, "Exactly one credential-free build and protected publisher are allowed."];
  }
  const expectedPermissions = {
    build: { contents: "read", actions: "read" },
    publish: { contents: "read", actions: "read", packages: "write", attestations: "write", "id-token": "write" },
  };
  for (const jobName of ["build", "publish"] as const) {
    const job = workflow.jobs[jobName];
    const allowed = jobName === "build"
      ? ["if", "runs-on", "timeout-minutes", "permissions", "env", "outputs", "steps"]
      : ["needs", "if", "environment", "runs-on", "timeout-minutes", "permissions", "env", "steps"];
    if (!isRecord(job) || !keys(job, allowed)) {
      errors.push("Unexpected publication job fields.");
      continue;
    }
    if (
      job.if !== (jobName === "build" ? condition : "needs.build.result == 'success' && " + condition) ||
      job["runs-on"] !== "ubuntu-24.04" ||
      job["timeout-minutes"] !== (jobName === "build" ? 45 : 30) ||
      !equal(job.permissions, expectedPermissions[jobName]) ||
      !equal(job.env, { BUNDLE: "${{ runner.temp }}/gateway-bundle" }) ||
      (jobName === "publish" && (job.needs !== "build" || job.environment !== PUBLICATION_ENVIRONMENT)) ||
      (jobName === "build" && !equal(job.outputs, {
        artifact_id: "${{ steps.upload.outputs.artifact-id }}",
        digest: "${{ steps.image.outputs.digest }}",
      }))
    ) errors.push("Owner/source/environment/permission/runner boundaries cannot change.");
    const stepBindings = isRecord(contract.stepSha256) ? contract.stepSha256[jobName] : null;
    if (!Array.isArray(job.steps) || !Array.isArray(stepBindings) || job.steps.length !== stepBindings.length) {
      errors.push("The exact reviewed publication step sequence is required.");
      continue;
    }
    job.steps.forEach((step, index) => {
      if (!isRecord(step) || hash(JSON.stringify(step)) !== stepBindings[index]) {
        errors.push("A reviewed publication step changed.");
        return;
      }
      if (
        Object.keys(step).some((key) => !["name", "id", "uses", "with", "env", "shell", "run"].includes(key)) ||
        (typeof step.uses === "string" && !/^[a-z0-9-]+\/[a-z0-9-]+@[0-9a-f]{40}$/i.test(step.uses))
      ) errors.push("Steps cannot add conditional/error bypasses or mutable Actions.");
    });
  }
  if (
    contract.repository !== PUBLICATION_REPOSITORY ||
    contract.image !== PUBLICATION_IMAGE ||
    contract.platform !== "linux/amd64" ||
    contract.permissionExceptionRequired !== true ||
    contract.publicationAuthorized !== false ||
    contract.deploymentAuthorized !== false
  ) errors.push("Publication remains an unapproved, fixed-target source-only candidate.");
  return errors;
}

export function validateGatewayWorkflowSet(
  workflows: Record<string, string>,
  contract: unknown,
): string[] {
  const publisher = ".github/workflows/gateway-image.yml";
  const errors: string[] = [];
  if (!Object.hasOwn(workflows, publisher)) errors.push("The exact dormant publisher is missing.");
  for (const [path, source] of Object.entries(workflows)) {
    if (path === publisher) {
      errors.push(...validateGatewayImageWorkflow(source, contract));
    } else if (
      /supabase\s+(?:functions\s+deploy|db\s+push)|vercel\s+deploy|docker\s+push|ghcr\.io/iu.test(source)
    ) {
      errors.push("Every other workflow must remain CI-only and provider-neutral.");
    }
  }
  return errors;
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const errors = validateGatewayImageWorkflow(
    readFileSync(resolve(root, ".github/workflows/gateway-image.yml"), "utf8"),
    JSON.parse(readFileSync(resolve(root, "contracts/gateway-image-publication.v1.json"), "utf8")),
  );
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Exact dormant Gateway image publisher contract passed.");
}
