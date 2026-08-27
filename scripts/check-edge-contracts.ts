import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type RuntimeContract = {
  schemaVersion: number;
  status: string;
  sourceOwner: string;
  currentProductionWriter: string;
  predecessorCommit: string;
  predecessorTree: string;
  predecessorSeals: Record<string, string>;
  functions: Array<
    { name: string; verifyJwt: boolean; authentication: string }
  >;
  discordCommands: string[];
  activationBoundary: Record<string, boolean>;
};

type ConsumerContract = {
  schemaVersion: number;
  status: string;
  functionSourceOwner: string;
  sharedProducerOwner: string;
  currentProductionWriter: string;
  predecessorCommit: string;
  predecessorTree: string;
  databaseTables: string[];
  databaseFunctions: string[];
  websiteFunctionConsumers: Array<{
    name: string;
    authentication: string;
    authenticationHeaders: string[];
    authorizationContextContract: string;
    requestPayload: {
      requiredKeys: string[];
      unknownOrMissingKeys: string;
      forbiddenDecodedCodePoints: string[];
      identifiers: string;
      attachmentUrl: string;
      mimeTypes: string[];
      sizeBytes: { type: string; minimum: number; maximum: number };
      originalFilename: {
        type: string;
        maximumLength: number;
        extensionMustMatchMime: boolean;
      };
      title: { type: string; maximumLength: number };
      caption: { type: string; maximumLength: number };
      instagramOptIn: string;
      authorizationContextFields: string;
    };
    signerOwner: string;
    verifierOwner: string;
  }>;
  websiteRouteConsumers: Array<
    { path: string; purpose: string; sourcePath: string }
  >;
  retainedByWebsite: string[];
};

type RelocationContract = {
  schemaVersion: number;
  status: string;
  canonicalOwner: string;
  predecessor: {
    repository: string;
    commit: string;
    runtimeClosure: { fileCount: number; byteCount: number; sha256: string };
    packagingClosure: { fileCount: number; byteCount: number; sha256: string };
    functionConfig: {
      functionCount: number;
      byteCount: number;
      sha256: string;
    };
  };
  paths: Array<{
    sourcePath: string;
    targetPath: string;
    sourceBlob: string;
    sourceSha256: string;
    transfer: string;
  }>;
  deferredContractInputs: Array<
    { name: string; status: string; reason: string }
  >;
};

type HmacContract = {
  schemaVersion: number;
  contractId: string;
  status: string;
  signerOwner: string;
  verifierOwner: string;
  verifierFunction: string;
  wire: {
    method: string;
    path: string;
    pathSemantics: {
      signerValue: string;
      verifierValue: string;
      requireExactPathname: string;
      requireEmptySearch: boolean;
      requireEmptyHash: boolean;
      requireEmptyUsername: boolean;
      requireEmptyPassword: boolean;
      requireAllowedRuntimeOriginAndPort: boolean;
      rawRequestTargetBound: boolean;
      rawRequestTargetVisibleToVerifier: boolean;
    };
    bodySemantics: {
      digestInput: string;
      decodeOrNormalizeBeforeDigest: boolean;
      utf8BomAccepted: boolean;
    };
    canonicalFields: string[];
    canonicalSeparator: string;
    signature: string;
    signaturePrefix: string;
  };
  headers: string[];
  limits: Record<string, number>;
  replay: Record<string, boolean | string>;
  activationLimitation: {
    edgeVerifierCannotRecoverRawHttpRequestTarget: boolean;
    gatewayNormalizationRequiresPrivateActivationManifestAndProviderReadback:
      boolean;
  };
  ownershipBoundary: Record<string, boolean>;
};

type AuthorizationContextContract = {
  schemaVersion: number;
  contractId: string;
  status: string;
  producerOwner: string;
  consumerOwner: string;
  consumerFunction: string;
  payloadFields: {
    authorizationContextVersion: { type: string; const: string };
    authorizationContextSha256: { type: string; pattern: string };
    duplicateDecodedJsonKeys: string;
  };
  canonicalization: {
    encoding: string;
    rowFraming: string;
    finalLf: boolean;
    identifierValidation: {
      inputType: string;
      trimOrCoercion: string;
      asciiDecimalPattern: string;
      minimumValue: string;
      maximumValue: string;
      canonicalRoundTrip: string;
      validationOrder: string[];
    };
    requiredRoleCount: number;
    requiredRoleUniqueness: string;
    requiredRoleOrdering: string;
    requiredRoleMatch: string;
    rowOrder: string[];
    fixedVersion: string;
  };
  authorizationBoundary: {
    producerInputs: string[];
    excludedInputs: string[];
    producerBehavior: string;
    consumerBehavior: string;
    driftGuarantee: {
      detects: string;
      doesNotDetect: string;
      coordinatedChangeControl: string;
    };
    verificationOrder: string[];
    nonceConsumptionException: string;
  };
  hmacRelationship: {
    contractId: string;
    wireChange: string;
    bodyBinding: string;
  };
  syntheticVector: {
    guildId: string;
    galleryChannelId: string;
    requiredRoleMatch: string;
    requiredRoleIdsInput: string[];
    requiredRoleIdsCanonical: string[];
    canonicalUtf8ByteCount: number;
    canonicalUtf8Base64: string;
    sha256: string;
  };
  sortDistinguishingVector: {
    guildId: string;
    galleryChannelId: string;
    requiredRoleMatch: string;
    requiredRoleIdsInput: string[];
    requiredRoleIdsCanonical: string[];
    canonicalUtf8ByteCount: number;
    canonicalUtf8Base64: string;
    sha256: string;
    numericOrderWouldBe: string[];
    wrongNumericOrderCanonicalUtf8Base64: string;
    wrongNumericOrderSha256: string;
  };
  negativeVectorBaseline: {
    guildId: string;
    galleryChannelId: string;
    requiredRoleMatch: string;
    requiredRoleIdsInput: string[];
  };
  negativeVectors: Array<{
    name: string;
    override: Partial<{
      guildId: string;
      galleryChannelId: string;
      requiredRoleMatch: string;
      requiredRoleIdsInput: string[];
    }>;
    rejection: string;
  }>;
};

type SourceClosureContract = {
  schemaVersion: number;
  contractId: string;
  status: string;
  baseCommit: string;
  branch: string;
  selfPath: string;
  selfExcludedFromClosure: boolean;
  framing: string;
  fileCount: number;
  byteCount: number;
  sha256: string;
  entries: Array<{
    status: "A" | "M" | "D";
    path: string;
    mode: string;
    blob: string;
    sha256: string;
    byteCount: number;
  }>;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const functionsRoot = join(root, "supabase", "functions");
const reaperRepository = "Mochirii-Wushu/Reaper-Discord-Bot";
const websiteRepository = "Mochirii-Wushu/Mochirii-Website";
const predecessorCommit = "f587409adef29d4735b5e6ce8512c794579d8bef";
const predecessorTree = "ea5b564d7e1874706aa3ce948aeec38215d40821";
const expectedFunctions = [
  "reaper-discord-interactions",
  "reaper-discord-member-sync",
  "reaper-spinner-dispatch",
  "send-vote-reminder",
  "send-member-spotlight-poll",
  "publish-member-spotlight-winner",
] as const;
const expectedCommands = [
  "submit",
  "sync-ranks",
  "sync-events",
  "sync-pending-verification",
  "audit-modmail",
  "vote-status",
  "vote-leaderboard",
  "vote-reminder-preview",
  "photo-day-poll",
] as const;
const expectedGalleryPayloadKeys = [
  "guildId",
  "channelId",
  "messageId",
  "attachmentId",
  "discordUserId",
  "attachmentUrl",
  "mimeType",
  "sizeBytes",
  "originalFilename",
  "title",
  "caption",
  "instagramOptIn",
  "authorizationContextVersion",
  "authorizationContextSha256",
] as const;
const safeWholeSourcePaths = [
  ...expectedFunctions.map((name) => `supabase/functions/${name}/index.ts`),
  "supabase/functions/_shared/discord-interaction-helpers.ts",
  "supabase/functions/_shared/discord-signature.ts",
  "supabase/functions/_shared/modmail-audit.ts",
  "supabase/functions/_shared/pending-verification-containment.ts",
  "supabase/functions/_shared/photo-day-polls.ts",
  "supabase/functions/_shared/reaper-discord-events.ts",
  "supabase/functions/_shared/reaper-event-sync-workflow.ts",
  "supabase/functions/_shared/reaper-photo-day-poll-workflow.ts",
  "supabase/functions/_shared/reaper-rank-sync-workflow.ts",
  "supabase/functions/_shared/reaper-vote-interactions.ts",
  "supabase/functions/_shared/spinner-discord-outbox.ts",
  "supabase/functions/_shared/spinner-media-dispatch.ts",
] as const;
const adapterSourcePaths = [
  "supabase/functions/_shared/bounded-request-body.ts",
  "supabase/functions/_shared/cors.ts",
  "supabase/functions/_shared/discord-api.ts",
  "supabase/functions/_shared/discord-gallery-ingest-auth.ts",
  "supabase/functions/_shared/gallery-source-image.ts",
  "supabase/functions/_shared/outbound-http.ts",
  "supabase/functions/_shared/public-origins.ts",
  "supabase/functions/_shared/secret-auth.ts",
  "supabase/functions/_shared/spinner-live.ts",
  "supabase/functions/_shared/spinner-media.ts",
  "supabase/functions/_shared/spotlight-polls.ts",
  "supabase/functions/_shared/supabase-service-role.ts",
  "supabase/functions/_shared/vote-reminders.ts",
] as const;
const hmacHeaders = [
  "x-mochirii-gallery-key-id",
  "x-mochirii-gallery-timestamp",
  "x-mochirii-gallery-nonce",
  "x-mochirii-gallery-signature",
] as const;

function fail(message: string): never {
  throw new Error(message);
}

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function json<T>(path: string): T {
  return JSON.parse(read(path)) as T;
}

function sameSet(
  actual: Iterable<string>,
  expected: readonly string[],
  label: string,
): void {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    fail(`${label} mismatch: ${JSON.stringify(left)}`);
  }
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function repositoryPath(path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

function gitBytes(args: string[]): Buffer {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "buffer",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitText(args: string[]): string {
  return gitBytes(args).toString("utf8").trim();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const runtime = json<RuntimeContract>("contracts/reaper-edge-runtime.v1.json");
if (
  runtime.schemaVersion !== 1 ||
  runtime.status !== "reaper-owned-source-candidate" ||
  runtime.sourceOwner !== reaperRepository ||
  runtime.currentProductionWriter !== websiteRepository ||
  runtime.predecessorCommit !== predecessorCommit ||
  runtime.predecessorTree !== predecessorTree
) fail("Runtime source ownership/provenance contract drifted.");
sameSet(
  runtime.functions.map(({ name }) => name),
  expectedFunctions,
  "runtime functions",
);
sameSet(runtime.discordCommands, expectedCommands, "Discord commands");
if (
  runtime.functions.some(({ verifyJwt, authentication }) =>
    verifyJwt || !authentication
  )
) {
  fail(
    "All six verify_jwt=false functions require application-layer authentication.",
  );
}
const expectedActivation = {
  sourcePresent: true,
  scopedDeploymentDefinitionIncluded: true,
  scopedDeploymentWorkflowIncluded: false,
  providerConfigurationIncluded: false,
  schemaOrScheduleOwnershipTransferred: false,
  productionWriterCutoverApproved: false,
  productionActivated: false,
};
if (
  JSON.stringify(runtime.activationBoundary) !==
    JSON.stringify(expectedActivation)
) {
  fail(
    "Activation boundary must remain source-present and production-inactive.",
  );
}

const relocation = json<RelocationContract>(
  "contracts/reaper-source-relocation.v1.json",
);
if (
  relocation.schemaVersion !== 1 ||
  relocation.status !== "source-candidate-not-activated" ||
  relocation.canonicalOwner !== reaperRepository ||
  relocation.predecessor.repository !== websiteRepository ||
  relocation.predecessor.commit !== predecessorCommit ||
  relocation.predecessor.runtimeClosure.fileCount !== 31 ||
  relocation.predecessor.runtimeClosure.byteCount !== 3584 ||
  relocation.predecessor.runtimeClosure.sha256 !==
    runtime.predecessorSeals.runtimeSha256 ||
  relocation.predecessor.packagingClosure.fileCount !== 7 ||
  relocation.predecessor.packagingClosure.byteCount !== 839 ||
  relocation.predecessor.packagingClosure.sha256 !==
    runtime.predecessorSeals.packagingSha256 ||
  relocation.predecessor.functionConfig.functionCount !== 6 ||
  relocation.predecessor.functionConfig.byteCount !== 753 ||
  relocation.predecessor.functionConfig.sha256 !==
    runtime.predecessorSeals.configSha256
) fail("Immutable predecessor seals or framing counts drifted.");
if (
  relocation.paths.length !== 31 ||
  new Set(relocation.paths.map((row) => row.sourcePath)).size !== 31
) {
  fail("Relocation manifest must contain exactly 31 unique predecessor paths.");
}
sameSet(
  relocation.paths.filter(({ transfer }) =>
    transfer === "reaper-specific-semantic-port"
  ).map(({ sourcePath }) => sourcePath),
  safeWholeSourcePaths,
  "18 safe Reaper-specific predecessor paths",
);
sameSet(
  relocation.paths.filter(({ transfer }) =>
    transfer === "versioned-interface-adapter"
  ).map(({ sourcePath }) => sourcePath),
  adapterSourcePaths,
  "13 Website-shared adapter predecessor paths",
);
if (
  relocation.paths.some(({ sourceBlob, sourceSha256, targetPath }) =>
    !/^[0-9a-f]{40}$/u.test(sourceBlob) ||
    !/^[0-9a-f]{64}$/u.test(sourceSha256) || !existsSync(join(root, targetPath))
  )
) {
  fail(
    "Relocation rows require exact predecessor identities and present targets.",
  );
}
sameSet(
  relocation.deferredContractInputs.map(({ name }) => name),
  ["Singapore schedule override", "Last Blossom behavior override"],
  "deferred dirty Website inputs",
);
if (
  relocation.deferredContractInputs.some(({ status, reason }) =>
    status !== "deferred-uncommitted-input" || !reason
  )
) {
  fail("Deferred Website overrides require explicit fail-closed reasons.");
}

const sourceClosure = json<SourceClosureContract>(
  "contracts/reaper-edge-source-closure.v1.json",
);
const expectedSourceCandidateBranch =
  "agent/reaper-source-ownership-replay-20260811";
const currentSourceCandidateBranch = gitText(["branch", "--show-current"]);
if (
  sourceClosure.schemaVersion !== 1 ||
  sourceClosure.contractId !== "reaper-edge-source-closure.v1" ||
  sourceClosure.status !== "staged-candidate-not-committed" ||
  sourceClosure.baseCommit !== "88d06147159ba3b9ea8d62fee08e50187c394a5b" ||
  sourceClosure.branch !== expectedSourceCandidateBranch ||
  (currentSourceCandidateBranch !== expectedSourceCandidateBranch &&
    !(currentSourceCandidateBranch === "" &&
      process.env.GITHUB_ACTIONS === "true")) ||
  sourceClosure.selfPath !== "contracts/reaper-edge-source-closure.v1.json" ||
  sourceClosure.selfExcludedFromClosure !== true ||
  sourceClosure.framing !==
    "rows ASCII-sorted by path; each row is status + NUL + path + NUL + mode + NUL + Git blob + NUL + lowercase SHA256(blob bytes) + LF"
) fail("Local source-candidate closure metadata drifted.");
if (
  sourceClosure.entries.length !== sourceClosure.fileCount ||
  sourceClosure.entries.length < 1 ||
  new Set(sourceClosure.entries.map(({ path }) => path)).size !==
    sourceClosure.entries.length ||
  sourceClosure.entries.some(({ path }) =>
    !path || path === sourceClosure.selfPath || path.includes("\\") ||
    path.split("/").includes("..")
  )
) fail("Local source-candidate closure path inventory is invalid.");
const stagedNameStatusParts = gitBytes([
  "diff",
  "--cached",
  "--name-status",
  "-z",
  "--no-renames",
  sourceClosure.baseCommit,
]).toString("utf8").split("\0");
if (stagedNameStatusParts.at(-1) === "") stagedNameStatusParts.pop();
if (stagedNameStatusParts.length % 2 !== 0) {
  fail("Staged source-candidate inventory framing is invalid.");
}
const stagedInventory: Array<{ status: string; path: string }> = [];
for (let index = 0; index < stagedNameStatusParts.length; index += 2) {
  stagedInventory.push({
    status: stagedNameStatusParts[index],
    path: stagedNameStatusParts[index + 1],
  });
}
const excludedSelfRows = stagedInventory.filter(({ path }) =>
  path === sourceClosure.selfPath
);
const coveredStagedRows = stagedInventory.filter(({ path }) =>
  path !== sourceClosure.selfPath
);
const inventoryKey = ({ status, path }: { status: string; path: string }) =>
  `${status}\0${path}`;
const expectedInventory = [...sourceClosure.entries].map(inventoryKey).sort();
const actualInventory = coveredStagedRows.map(inventoryKey).sort();
if (
  excludedSelfRows.length !== 1 ||
  !/^[AMD]$/u.test(excludedSelfRows[0].status) ||
  JSON.stringify(actualInventory) !== JSON.stringify(expectedInventory)
) {
  fail(
    "Local source-candidate closure must cover the exact staged inventory except its one self path.",
  );
}
const closureRows: Buffer[] = [];
for (
  const entry of [...sourceClosure.entries].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  )
) {
  const revision = entry.status === "D"
    ? `${sourceClosure.baseCommit}:${entry.path}`
    : `:${entry.path}`;
  const blob = gitText(["rev-parse", revision]);
  const bytes = gitBytes(["cat-file", "blob", blob]);
  const modeLine = entry.status === "D"
    ? gitText(["ls-tree", sourceClosure.baseCommit, "--", entry.path])
    : gitText(["ls-files", "-s", "--", entry.path]);
  const mode = modeLine.match(/^(\d{6})\s/u)?.[1] || "";
  if (
    blob !== entry.blob || mode !== entry.mode ||
    sha256(bytes) !== entry.sha256 || bytes.byteLength !== entry.byteCount ||
    (entry.status === "D"
      ? existsSync(join(root, entry.path))
      : !existsSync(join(root, entry.path)))
  ) fail(`Local source-candidate closure drifted for ${entry.path}.`);
  closureRows.push(Buffer.from(
    `${entry.status}\0${entry.path}\0${entry.mode}\0${entry.blob}\0${entry.sha256}\n`,
    "utf8",
  ));
}
const closureFrame = Buffer.concat(closureRows);
if (
  closureFrame.byteLength !== sourceClosure.byteCount ||
  sha256(closureFrame) !== sourceClosure.sha256
) fail("Local source-candidate aggregate closure seal drifted.");

if (
  existsSync(join(root, "supabase", "config.toml")) ||
  existsSync(join(root, "supabase", "migrations"))
) {
  fail("Reaper must not own Supabase config or migrations.");
}
const deployment = json<{
  schemaVersion: number;
  contractId: string;
  status: string;
  owner: string;
  functions: Array<
    { name: string; entrypoint: string; importMap: string; verifyJwt: boolean }
  >;
  providerBinding: unknown;
  secretValues: boolean;
  executableDeploymentCommand: boolean;
  workflowIncluded: boolean;
}>("contracts/reaper-edge-deployment.v1.json");
if (
  deployment.schemaVersion !== 1 ||
  deployment.contractId !== "reaper-edge-deployment.v1" ||
  deployment.status !== "provider-neutral-definition-not-activated" ||
  deployment.owner !== reaperRepository ||
  deployment.providerBinding !== null || deployment.secretValues ||
  deployment.executableDeploymentCommand ||
  deployment.workflowIncluded
) {
  fail(
    "Scoped deployment definition must remain provider-neutral and inactive.",
  );
}
sameSet(
  deployment.functions.map(({ name }) => name),
  expectedFunctions,
  "scoped deployment functions",
);
for (const { name, entrypoint, importMap, verifyJwt } of deployment.functions) {
  if (
    verifyJwt || entrypoint !== `supabase/functions/${name}/index.ts` ||
    importMap !== `supabase/functions/${name}/deno.json` ||
    !existsSync(join(root, entrypoint)) ||
    !existsSync(join(root, importMap))
  ) fail(`${name} scoped deployment definition drifted.`);
}
sameSet(
  readdirSync(functionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "_shared")
    .map(({ name }) => name),
  expectedFunctions,
  "function directory inventory",
);
for (const name of expectedFunctions) {
  sameSet(
    readdirSync(join(functionsRoot, name)).filter((entry) =>
      entry !== "node_modules"
    ),
    [
      "deno.json",
      "deno.lock",
      "index.ts",
    ],
    `${name} package inventory`,
  );
  const deno = json<{ imports: Record<string, string> }>(
    `supabase/functions/${name}/deno.json`,
  );
  if (
    deno.imports["@supabase/functions-js/edge-runtime.d.ts"] !==
      "jsr:@supabase/functions-js@2.110.8/edge-runtime.d.ts" ||
    deno.imports["@supabase/supabase-js"] !==
      "npm:@supabase/supabase-js@2.110.8" ||
    (name === "reaper-discord-interactions" &&
      deno.imports.tweetnacl !== "npm:tweetnacl@1.0.3")
  ) fail(`${name} dependency pins drifted.`);
  const source = read(`supabase/functions/${name}/index.ts`);
  if (!source.includes(`runtimeProfileReady("${name}")`)) {
    fail(`${name} must fail closed against its runtime configuration profile.`);
  }
}

const runtimeFiles = filesUnder(functionsRoot)
  .filter((path) => path.endsWith(".ts"))
  .filter((path) =>
    !path.endsWith("_test.ts") && !path.endsWith("edge-tests.ts")
  );
const runtimeSource = runtimeFiles.map((path) => readFileSync(path, "utf8"))
  .join("\n");
if (/\b\d{16,22}\b/u.test(runtimeSource)) {
  fail("Runtime source embeds a provider snowflake identifier.");
}
if (/https?:\/\//iu.test(runtimeSource)) {
  fail("Runtime source embeds a provider origin or URL.");
}
if (/discord-gallery-ingest-auth/u.test(runtimeSource)) {
  fail("The verifier-era gallery auth module name must not remain.");
}
if (
  /console\.(?:error|warn)\([\s\S]{0,240}?(?:error\.message|String\(error\)|statusText)/u
    .test(runtimeSource)
) fail("Edge runtime diagnostics must not emit raw external error text.");
for (const path of runtimeFiles) {
  const source = readFileSync(path, "utf8");
  if (
    repositoryPath(path) !== "supabase/functions/_shared/strict-json.ts" &&
    /\bJSON\.parse\s*\(/u.test(source)
  ) {
    fail(`Direct JSON.parse is forbidden at runtime: ${repositoryPath(path)}.`);
  }
  if (
    /\b(?:req|request)\.json\s*\(|\b(?:req|request)\.text\s*\(|\bresponse\.json\s*\(/iu
      .test(source)
  ) {
    fail(
      `Unbounded JSON/body read is forbidden at runtime: ${
        repositoryPath(path)
      }.`,
    );
  }
}

const interaction = read(
  "supabase/functions/reaper-discord-interactions/index.ts",
);
const interactionHelpers = read(
  "supabase/functions/_shared/discord-interaction-helpers.ts",
);
const interactionHandler = interaction.slice(
  interaction.indexOf("Deno.serve("),
);
const boundedAt = interactionHandler.indexOf("readBoundedUtf8RequestBody(");
const signatureAt = interactionHandler.indexOf("verifyDiscordSignature(");
const parseAt = interactionHandler.indexOf("parseJsonObjectNoDuplicateKeys(");
if (boundedAt < 0 || signatureAt <= boundedAt || parseAt <= signatureAt) {
  fail(
    "Interactions must bound raw bytes, verify Ed25519, then parse duplicate-safe JSON.",
  );
}
for (
  const name of [
    "reaper-discord-member-sync",
    "send-vote-reminder",
    "send-member-spotlight-poll",
    "publish-member-spotlight-winner",
  ]
) {
  const handler = read(`supabase/functions/${name}/index.ts`).slice(
    read(`supabase/functions/${name}/index.ts`).indexOf("Deno.serve("),
  );
  const authMarker = name === "reaper-discord-member-sync"
    ? "await verifyMemberSyncSecret(req)"
    : "await constantTimeSecretEqual(";
  if (!handler.includes(authMarker)) {
    fail(`${name} must await its fixed-digest secret check.`);
  }
  const authAt = handler.indexOf(authMarker);
  const parseMarkers = ["parseJsonObjectNoDuplicateKeys(", "readJson(req)"];
  const bodyAt = Math.max(
    ...parseMarkers.map((marker) => handler.indexOf(marker)),
  );
  if (bodyAt >= 0 && authAt > bodyAt) {
    fail(`${name} parses its body before application authentication.`);
  }
}
const spinnerHandler = read(
  "supabase/functions/reaper-spinner-dispatch/index.ts",
).slice(
  read("supabase/functions/reaper-spinner-dispatch/index.ts").indexOf(
    "Deno.serve(",
  ),
);
const capabilityAt = spinnerHandler.indexOf("if (capability)");
const capabilityVerifyAt = spinnerHandler.indexOf(
  "verifySpinnerMediaToken(capability, dispatchSecret)",
  capabilityAt,
);
const capabilityGuardAt = spinnerHandler.indexOf(
  "if (!payload) return opaqueDenied()",
  capabilityVerifyAt,
);
const capabilityBodyAt = spinnerHandler.indexOf(
  "readBoundedJsonObject(req)",
  capabilityAt,
);
const dispatcherAuthAt = spinnerHandler.indexOf(
  "await constantTimeSecretEqual(",
  capabilityBodyAt,
);
const dispatcherBodyAt = spinnerHandler.indexOf(
  "readBoundedJsonObject(req)",
  dispatcherAuthAt,
);
if (
  capabilityAt < 0 || capabilityVerifyAt <= capabilityAt ||
  capabilityGuardAt <= capabilityVerifyAt ||
  capabilityBodyAt <= capabilityGuardAt ||
  dispatcherAuthAt <= capabilityBodyAt ||
  dispatcherBodyAt <= dispatcherAuthAt
) {
  fail(
    "Spinner capability and dispatcher secret must authenticate before their respective JSON bodies are parsed.",
  );
}
for (
  const path of [
    "supabase/functions/_shared/spotlight-polls.ts",
    "supabase/functions/_shared/spinner-discord-outbox.ts",
    "supabase/functions/_shared/outbound-http.ts",
    "supabase/functions/_shared/discord-api.ts",
    "supabase/functions/_shared/supabase-service-role.ts",
  ]
) {
  if (!read(path).includes("parseJson")) {
    fail(`${path} must use duplicate-aware JSON parsing.`);
  }
}

const authorizationContextPath =
  "contracts/discord-gallery-authorization-context.v1.json";
const authorizationContextBytes = readFileSync(
  join(root, authorizationContextPath),
);
if (
  authorizationContextBytes.byteLength !== 8451 ||
  sha256(authorizationContextBytes) !==
    "db5ab92c20df4e59957979750e2ba6d3484f6112eb0ad87787bdf1d5be8d237c"
) fail("Gallery authorization-context contract bytes drifted.");
const authorizationContext = json<AuthorizationContextContract>(
  authorizationContextPath,
);
if (
  authorizationContext.schemaVersion !== 1 ||
  authorizationContext.contractId !==
    "discord-gallery-authorization-context.v1" ||
  authorizationContext.status !== "active-source-contract-not-deployed" ||
  authorizationContext.producerOwner !== reaperRepository ||
  authorizationContext.consumerOwner !== websiteRepository ||
  authorizationContext.consumerFunction !== "submit-discord-gallery-image" ||
  authorizationContext.payloadFields.authorizationContextVersion.type !==
    "string" ||
  authorizationContext.payloadFields.authorizationContextVersion.const !==
    authorizationContext.contractId ||
  authorizationContext.payloadFields.authorizationContextSha256.type !==
    "string" ||
  authorizationContext.payloadFields.authorizationContextSha256.pattern !==
    "^[0-9a-f]{64}$" ||
  authorizationContext.payloadFields.duplicateDecodedJsonKeys !== "reject"
) fail("Gallery authorization-context ownership or payload fields drifted.");
const contextCanonicalization = authorizationContext.canonicalization;
const contextIdValidation = contextCanonicalization.identifierValidation;
if (
  contextCanonicalization.encoding !== "UTF-8" ||
  contextCanonicalization.rowFraming !== "label + NUL + value + LF" ||
  contextCanonicalization.finalLf !== true ||
  contextIdValidation.inputType !== "string" ||
  contextIdValidation.trimOrCoercion !== "reject" ||
  contextIdValidation.asciiDecimalPattern !== "^[1-9][0-9]{15,19}$" ||
  contextIdValidation.minimumValue !== "1" ||
  contextIdValidation.maximumValue !== "18446744073709551615" ||
  contextIdValidation.canonicalRoundTrip !==
    "BigInt(value).toString(10) === value" ||
  JSON.stringify(contextIdValidation.validationOrder) !== JSON.stringify([
      "require string without trimming or coercion",
      "require ASCII decimal syntax and 16..20 digits",
      "parse BigInt and require minimumValue <= value <= maximumValue",
      "require canonical base-10 BigInt round-trip equality",
    ]) ||
  contextCanonicalization.requiredRoleCount !== 2 ||
  contextCanonicalization.requiredRoleUniqueness !==
    "reject-duplicates-after-identifier-validation" ||
  contextCanonicalization.requiredRoleOrdering !== "ascending-ASCII" ||
  contextCanonicalization.requiredRoleMatch !== "all" ||
  contextCanonicalization.fixedVersion !== authorizationContext.contractId ||
  JSON.stringify(contextCanonicalization.rowOrder) !== JSON.stringify([
      "version",
      "guild",
      "gallery-channel",
      "required-role-count",
      "required-role-match",
      "required-role (repeated once per canonical required role)",
    ])
) fail("Gallery authorization-context canonicalization drifted.");
const contextBoundary = authorizationContext.authorizationBoundary;
if (
  JSON.stringify(contextBoundary.producerInputs) !== JSON.stringify([
      "configured Discord guild ID",
      "configured Discord gallery channel ID",
      "configured required Discord role IDs",
    ]) ||
  JSON.stringify(contextBoundary.excludedInputs) !==
    JSON.stringify(["secrets", "HMAC key IDs", "Discord member IDs"]) ||
  contextBoundary.producerBehavior !==
    "hash canonical context and include both payload fields before HMAC signing" ||
  contextBoundary.consumerBehavior !==
    "independently recompute from validated consumer runtime context and reject mismatch before profile lookup, external fetch, storage upload, or application-row mutation" ||
  contextBoundary.driftGuarantee.detects !==
    "one-sided guild, gallery-channel, required-role-set, or role-match drift" ||
  contextBoundary.driftGuarantee.doesNotDetect !==
    "coordinated matching configuration changes to both runtimes" ||
  contextBoundary.driftGuarantee.coordinatedChangeControl !==
    "reviewed private activation manifest and provider readback" ||
  JSON.stringify(contextBoundary.verificationOrder) !== JSON.stringify([
      "bound raw request body and HMAC envelope",
      "verify exact-body HMAC v1 without mutation",
      "atomically consume the one-use nonce",
      "parse duplicate-key-safe JSON and validate exact authorization field shape",
      "recompute and compare authorization context from validated consumer runtime configuration",
      "require all configured roles during profile authorization",
      "permit external media fetch, storage upload, and application-row mutation",
    ]) ||
  contextBoundary.nonceConsumptionException !==
    "the nonce security ledger is the sole permitted pre-context mutation; nonce-store failure is fail-closed 503" ||
  authorizationContext.hmacRelationship.contractId !==
    "discord-gallery-ingest-hmac.v1" ||
  authorizationContext.hmacRelationship.wireChange !== "none" ||
  authorizationContext.hmacRelationship.bodyBinding !==
    "both authorization-context fields are inside the exact UTF-8 JSON body before HMAC signing"
) fail("Gallery authorization-context boundary drifted.");

type ContextVectorInput = {
  guildId: string;
  galleryChannelId: string;
  requiredRoleMatch: string;
  requiredRoleIdsInput: string[];
};
const contextIdPattern = new RegExp(
  contextIdValidation.asciiDecimalPattern,
  "u",
);
const contextMaximumId = BigInt(contextIdValidation.maximumValue);
function validContextId(value: unknown): value is string {
  if (typeof value !== "string" || !contextIdPattern.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= contextMaximumId &&
      parsed.toString(10) === value;
  } catch {
    return false;
  }
}

function framedContextBytes(
  input: Omit<ContextVectorInput, "requiredRoleIdsInput">,
  roleIds: readonly string[],
): Buffer {
  return Buffer.from(
    [
      `version\0${contextCanonicalization.fixedVersion}\n`,
      `guild\0${input.guildId}\n`,
      `gallery-channel\0${input.galleryChannelId}\n`,
      `required-role-count\0${roleIds.length}\n`,
      `required-role-match\0${input.requiredRoleMatch}\n`,
      ...roleIds.map((roleId) => `required-role\0${roleId}\n`),
    ].join(""),
    "utf8",
  );
}

function canonicalContextBytes(input: ContextVectorInput): Buffer | null {
  if (
    !validContextId(input.guildId) ||
    !validContextId(input.galleryChannelId) ||
    input.requiredRoleMatch !== contextCanonicalization.requiredRoleMatch ||
    !Array.isArray(input.requiredRoleIdsInput) ||
    input.requiredRoleIdsInput.length !==
      contextCanonicalization.requiredRoleCount
  ) return null;
  if (input.requiredRoleIdsInput.some((value) => !validContextId(value))) {
    return null;
  }
  if (
    new Set(input.requiredRoleIdsInput).size !==
      input.requiredRoleIdsInput.length
  ) {
    return null;
  }
  const roleIds = [...input.requiredRoleIdsInput].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  return framedContextBytes(input, roleIds);
}

function verifyContextVector(
  vector: ContextVectorInput & {
    requiredRoleIdsCanonical: string[];
    canonicalUtf8ByteCount: number;
    canonicalUtf8Base64: string;
    sha256: string;
  },
  expectedByteCount: number,
  expectedSha256: string,
): Buffer {
  const bytes = canonicalContextBytes(vector);
  if (
    !bytes || vector.requiredRoleMatch !== "all" ||
    JSON.stringify(
        [...vector.requiredRoleIdsInput].sort((left, right) =>
          left < right ? -1 : left > right ? 1 : 0
        ),
      ) !== JSON.stringify(vector.requiredRoleIdsCanonical) ||
    bytes.byteLength !== vector.canonicalUtf8ByteCount ||
    bytes.byteLength !== expectedByteCount ||
    bytes.toString("base64") !== vector.canonicalUtf8Base64 ||
    sha256(bytes) !== vector.sha256 || vector.sha256 !== expectedSha256
  ) fail("Gallery authorization-context positive vector drifted.");
  return bytes;
}

verifyContextVector(
  authorizationContext.syntheticVector,
  213,
  "af0e2e6f1bcc2f15633ed33fc8947684c0f86abf50fa82d51c7f849bd72450d2",
);
const sortVector = authorizationContext.sortDistinguishingVector;
const sortBytes = verifyContextVector(
  sortVector,
  214,
  "70e0d0f32e819025ab8b35831e2ccd53fc2d6a95599141d4fd7761a6d79fdbab",
);
if (
  JSON.stringify(sortVector.numericOrderWouldBe) !== JSON.stringify([
    "9000000000000000",
    "10000000000000000",
  ])
) fail("Gallery authorization-context wrong-order fixture drifted.");
const wrongOrderBytes = framedContextBytes(
  {
    guildId: sortVector.guildId,
    galleryChannelId: sortVector.galleryChannelId,
    requiredRoleMatch: sortVector.requiredRoleMatch,
  },
  sortVector.numericOrderWouldBe,
);
if (
  wrongOrderBytes.byteLength !== 214 ||
  wrongOrderBytes.toString("base64") !==
    sortVector.wrongNumericOrderCanonicalUtf8Base64 ||
  sha256(wrongOrderBytes) !== sortVector.wrongNumericOrderSha256 ||
  sortVector.wrongNumericOrderSha256 !==
    "dfbe607461ff52ce4484eb4ad13535243c18d41460f109ec884e6c3d01847c6f" ||
  sha256(sortBytes) === sha256(wrongOrderBytes)
) fail("Gallery authorization-context ASCII sort is not distinguished.");

const expectedNegativeVectors = new Map([
  ["exact-duplicate-role", "duplicate-required-role"],
  ["leading-zero-role-alias", "non-canonical-identifier"],
  ["zero-guild", "non-canonical-identifier"],
  ["uint64-overflow-channel", "identifier-out-of-range"],
  ["one-required-role", "required-role-count"],
  ["three-required-roles", "required-role-count"],
  ["leading-whitespace-guild", "non-canonical-identifier"],
  ["trailing-whitespace-channel", "non-canonical-identifier"],
  ["plus-sign-role", "non-canonical-identifier"],
  ["minus-sign-role", "non-canonical-identifier"],
  ["nul-role", "non-canonical-identifier"],
  ["lf-role", "non-canonical-identifier"],
  ["any-role-match", "required-role-match"],
]);
if (
  authorizationContext.negativeVectors.length !==
    expectedNegativeVectors.size ||
  new Set(authorizationContext.negativeVectors.map(({ name }) => name)).size !==
    expectedNegativeVectors.size
) fail("Gallery authorization-context negative-vector inventory drifted.");
for (const vector of authorizationContext.negativeVectors) {
  if (
    expectedNegativeVectors.get(vector.name) !== vector.rejection ||
    canonicalContextBytes({
        ...authorizationContext.negativeVectorBaseline,
        ...vector.override,
      } as ContextVectorInput) !== null
  ) {
    fail(
      `Gallery authorization-context hostile vector passed: ${vector.name}.`,
    );
  }
}

const runtimeConfig = read("supabase/functions/_shared/runtime-config.ts");
const contextValidationAt = runtimeConfig.indexOf(
  "function canonicalAuthorizationRoleIds",
);
const contextValidationEnd = runtimeConfig.indexOf(
  "function uuids",
  contextValidationAt,
);
const contextValidation = runtimeConfig.slice(
  contextValidationAt,
  contextValidationEnd,
);
const contextProducerAt = runtimeConfig.indexOf(
  "export function canonicalDiscordGalleryAuthorizationContextBytes",
);
const contextProducerEnd = runtimeConfig.indexOf(
  "function strongSharedSecret",
  contextProducerAt,
);
const contextProducer = runtimeConfig.slice(
  contextProducerAt,
  contextProducerEnd,
);
for (
  const marker of [
    "DISCORD_GALLERY_AUTHORIZATION_CONTEXT_VERSION",
    "required-role-count",
    "required-role-match",
    "required-role",
    'crypto.subtle.digest("SHA-256"',
    "configuredDiscordGalleryAuthorizationContext",
  ]
) {
  if (!contextProducer.includes(marker)) {
    fail(`Gallery authorization-context producer is missing ${marker}.`);
  }
}
if (
  contextValidationAt < 0 || contextValidationEnd <= contextValidationAt ||
  !contextValidation.includes("AUTHORIZATION_SNOWFLAKE_PATTERN") ||
  !contextValidation.includes("MAX_UINT64") ||
  !contextValidation.includes("BigInt(value)") ||
  !contextValidation.includes("parsed.toString(10) === value") ||
  !contextValidation.includes("Deno.env.get(name)") ||
  !contextValidation.includes("new Set(values).size !== values.length") ||
  contextValidation.includes(".trim(") ||
  contextProducerAt < 0 || contextProducerEnd <= contextProducerAt ||
  /\b(?:secret|keyId|memberId)\b/iu.test(contextProducer) ||
  !runtimeConfig.includes('validAuthorizationSnowflake("DISCORD_GUILD_ID")') ||
  !runtimeConfig.includes(
    'validAuthorizationSnowflake("DISCORD_GALLERY_CHANNEL_ID")',
  )
) fail("Gallery authorization-context producer accepts a forbidden input.");
const interactionContextAt = interaction.indexOf(
  "await configuredDiscordGalleryAuthorizationContext()",
);
const interactionDeclaredMimeAt = interaction.indexOf(
  "const declaredMime = canonicalDeclaredImageMime(attachment.content_type)",
);
const interactionTitleAt = interaction.indexOf(
  'exactOptionalStringOption(data, "title", 80)',
);
const interactionCaptionAt = interaction.indexOf(
  'exactOptionalStringOption(data, "subtitle", 300)',
);
const interactionConsentAt = interaction.indexOf(
  "const instagramOption = exactOptionalBooleanOption(",
);
const interactionConsentRejectAt = interaction.indexOf(
  "!instagramOption.ok",
  interactionConsentAt,
);
const interactionSizeAt = interaction.indexOf(
  "canonicalGalleryAttachmentSize(attachment.size)",
);
const interactionFilenameAt = interaction.indexOf(
  "exactBoundedString(attachment.filename, 255)",
);
const interactionUrlAt = interaction.indexOf(
  "canonicalDiscordGalleryAttachmentUrl(",
);
const interactionMimeMatchAt = interaction.indexOf(
  "const filenameMatchesDeclaredMime = imageFilenameMatchesMime(",
  interactionDeclaredMimeAt,
);
const interactionMimeRejectAt = interaction.indexOf(
  "!filenameMatchesDeclaredMime",
  interactionMimeMatchAt,
);
const interactionMissingMimeRejectAt = interaction.lastIndexOf(
  "!declaredMime",
  interactionMimeRejectAt,
);
const interactionPayloadAt = interaction.indexOf(
  "const payload = discordGallerySubmissionPayload({",
  interactionContextAt,
);
const interactionVersionAt = interaction.indexOf(
  "authorizationContextVersion:",
  interactionPayloadAt,
);
const interactionDigestAt = interaction.indexOf(
  "authorizationContextSha256:",
  interactionPayloadAt,
);
const interactionSubmissionAt = interaction.indexOf(
  "processSubmission(payload",
  interactionPayloadAt,
);
if (
  interactionDeclaredMimeAt < 0 ||
  interactionTitleAt < 0 || interactionCaptionAt <= interactionTitleAt ||
  interactionConsentAt <= interactionCaptionAt ||
  interactionUrlAt <= interactionConsentAt ||
  interactionSizeAt <= interactionUrlAt ||
  interactionFilenameAt <= interactionSizeAt ||
  interactionMimeMatchAt <= interactionDeclaredMimeAt ||
  interactionMissingMimeRejectAt <= interactionMimeMatchAt ||
  interactionMimeRejectAt <= interactionMimeMatchAt ||
  interactionConsentRejectAt <= interactionConsentAt ||
  interactionContextAt <= interactionMimeRejectAt ||
  interactionPayloadAt <= interactionContextAt ||
  interactionVersionAt <= interactionPayloadAt ||
  interactionDigestAt <= interactionVersionAt ||
  interactionSubmissionAt <= interactionDigestAt ||
  interaction.includes("(!declaredMime && !filenameLooksImage)") ||
  interaction.includes("Number(attachment.size)") ||
  interaction.includes("safeString(attachment.url") ||
  interaction.includes("safeString(attachment.filename")
) {
  fail(
    "Gallery submission must reject missing/mismatched MIME and bind authorization context before HMAC signing.",
  );
}
for (
  const marker of [
    "DISCORD_GALLERY_SUBMISSION_PAYLOAD_KEYS",
    "discordGallerySubmissionPayload",
    "CANONICAL_SNOWFLAKE_PATTERN",
    "MAX_UINT64",
    "canonicalDiscordGalleryAttachmentUrl",
    "url.toString() !== text",
    "snowflake(path[1]) !== expectedChannelId",
    "snowflake(path[2]) !== expectedAttachmentId",
    "canonicalGalleryAttachmentSize",
    "Number.isSafeInteger(value)",
    "DISCORD_GALLERY_ATTACHMENT_MAX_BYTES",
    "exactOptionalBooleanOption",
    'typeof option.value === "boolean"',
    "exactOptionalStringOption",
    "!value.includes(FORBIDDEN_ZERO_WIDTH_NO_BREAK_SPACE)",
  ]
) {
  if (!interactionHelpers.includes(marker)) {
    fail(`Gallery payload helper is missing ${marker}.`);
  }
}
for (const key of expectedGalleryPayloadKeys) {
  if (!interactionHelpers.includes(`${key}: input.${key}`)) {
    fail(`Gallery payload builder is missing exact key ${key}.`);
  }
}

const hmacContractPath = "contracts/discord-gallery-ingest-hmac.v1.json";
const hmacContractBytes = readFileSync(join(root, hmacContractPath));
if (
  hmacContractBytes.byteLength !== 2227 ||
  sha256(hmacContractBytes) !==
    "af3025221626aadd2d0fc82fd79bb02b3f253ccdd8753fb78082aa885c929e3f"
) fail("Gallery HMAC contract bytes drifted across repositories.");
const hmac = json<HmacContract>(
  hmacContractPath,
);
const hmacPath = hmac.wire.pathSemantics;
const hmacBody = hmac.wire.bodySemantics;
if (
  hmac.schemaVersion !== 1 ||
  hmac.contractId !== "discord-gallery-ingest-hmac.v1" ||
  hmac.status !== "active-source-contract-not-deployed" ||
  hmac.signerOwner !== reaperRepository ||
  hmac.verifierOwner !== websiteRepository ||
  hmac.verifierFunction !== "submit-discord-gallery-image" ||
  hmac.wire.method !== "POST" ||
  hmac.wire.path !== "/functions/v1/submit-discord-gallery-image" ||
  hmacPath.signerValue !== "constant-reviewed-pathname" ||
  hmacPath.verifierValue !== "runtime-normalized-whatwg-url-pathname" ||
  hmacPath.requireExactPathname !== hmac.wire.path ||
  hmacPath.requireEmptySearch !== true || hmacPath.requireEmptyHash !== true ||
  hmacPath.requireEmptyUsername !== true ||
  hmacPath.requireEmptyPassword !== true ||
  hmacPath.requireAllowedRuntimeOriginAndPort !== true ||
  hmacPath.rawRequestTargetBound !== false ||
  hmacPath.rawRequestTargetVisibleToVerifier !== false ||
  hmacBody.digestInput !== "exact-bounded-request-body-bytes" ||
  hmacBody.decodeOrNormalizeBeforeDigest !== false ||
  hmacBody.utf8BomAccepted !== false ||
  JSON.stringify(hmac.wire.canonicalFields) !== JSON.stringify([
      "v1",
      "keyId",
      "uppercaseMethod",
      "runtimeNormalizedWhatwgPathname",
      "unixTimestampSeconds",
      "nonceLowerHex",
      "lowercaseSha256OfExactBoundedRequestBodyBytes",
    ]) ||
  hmac.wire.canonicalSeparator !== "LF" ||
  hmac.wire.signature !== "lowercase-hmac-sha256" ||
  hmac.wire.signaturePrefix !== "v1=" ||
  hmac.activationLimitation.edgeVerifierCannotRecoverRawHttpRequestTarget !==
    true ||
  hmac.activationLimitation
      .gatewayNormalizationRequiresPrivateActivationManifestAndProviderReadback !==
    true
) fail("Gallery HMAC ownership/wire contract drifted.");
sameSet(hmac.headers, hmacHeaders, "gallery HMAC headers");
const expectedLimits = {
  maximumBodyBytes: 16384,
  maximumClockSkewSeconds: 60,
  minimumKeyBytes: 32,
  maximumKeyBytes: 128,
  maximumKeyCount: 3,
  nonceBytes: 16,
};
if (JSON.stringify(hmac.limits) !== JSON.stringify(expectedLimits)) {
  fail("Gallery HMAC limits drifted.");
}
if (
  hmac.replay.consumeAfterSignatureVerification !== true ||
  hmac.replay.oneUsePerKeyIdAndNonce !== true ||
  hmac.replay.storageFailureMode !== "fail-closed-503" ||
  hmac.ownershipBoundary.reaperContainsSignerAndActiveKeySelection !== true ||
  hmac.ownershipBoundary.reaperContainsProductionVerifier !== false ||
  hmac.ownershipBoundary.websiteRetainsVerifierAndNonceStore !== true
) fail("Gallery HMAC replay/ownership boundary drifted.");
const signer = read(
  "supabase/functions/_shared/discord-gallery-ingest-signer.ts",
);
for (
  const marker of [
    "DISCORD_GALLERY_INGEST_HMAC_KEYS_JSON",
    "DISCORD_GALLERY_INGEST_HMAC_ACTIVE_KEY_ID",
    'const DISCORD_GALLERY_INGEST_METHOD = "POST"',
    "DISCORD_GALLERY_INGEST_PATH",
    "crypto.getRandomValues",
    "SHA-256",
    "HMAC",
    "parseJsonObjectNoDuplicateKeys",
    "encoder.encode(value)",
  ]
) if (!signer.includes(marker)) fail(`Gallery signer is missing ${marker}.`);
if (
  /consumeNonce|productionVerifier|verifyGallery|TextDecoder/u.test(signer) ||
  signer.includes("export async function discordGalleryIngestCanonicalBytes") ||
  signer.includes("method?: string") || signer.includes("path?: string") ||
  signer.includes("input.method") || signer.includes("input.path")
) {
  fail(
    "Reaper signer must keep verification separate and hard-bind its reviewed method/pathname.",
  );
}
const verifierFixture = read(
  "supabase/functions/_shared/discord-gallery-ingest-contract_test.ts",
);
if (verifierFixture.includes("canonicalGalleryIngestMessage")) {
  fail("Verifier fixture must canonicalize independently of the signer.");
}
for (
  const marker of [
    "duplicate",
    "consumed.add",
    "replay",
    "unavailable",
    "nonce storage failure",
    "60",
    "POST",
    "/functions/v1/submit-discord-gallery-image",
    "rawBodyBytes",
    "new URL(",
    "requestUrl.pathname",
    "requestUrl.origin",
    "requestUrl.search",
    "requestUrl.hash",
    "requestUrl.username",
    "requestUrl.password",
    "ignored/../submit-discord-gallery-image",
    "UTF8_BOM",
    "BOM-prefixed bytes",
    "project.synthetic.test:8443",
  ]
) {
  if (!verifierFixture.includes(marker)) {
    fail(`Independent verifier fixture is missing ${marker}.`);
  }
}
if (
  verifierFixture.includes("encoder.encode(input.rawBody)") ||
  verifierFixture.includes("TextDecoder")
) fail("Independent verifier fixture normalizes body bytes before HMAC.");
const signerFixture = read(
  "supabase/functions/_shared/discord-gallery-ingest-signer_test.ts",
);
if (
  !signer.includes(
    "input.rawBody.includes(FORBIDDEN_ZERO_WIDTH_NO_BREAK_SPACE)",
  ) ||
  !signerFixture.includes("literal leading or embedded U+FEFF must be rejected")
) fail("Gallery signer must reject literal U+FEFF before HMAC signing.");
const galleryAdapter = json<{
  schemaVersion: number;
  contractId: string;
  status: string;
  owner: string;
  predecessor: {
    repository: string;
    commit: string;
    path: string;
    sha256: string;
  };
  localModule: string;
  validatorVersion: string;
  supportedMimeTypes: string[];
  producerBoundary: {
    declaredMimeRequiredBeforeSigning: boolean;
    filenameExtensionMustMatchDeclaredMime: boolean;
    extensionOnlyMimeInference: boolean;
    attachmentUrlBoundToChannelAndAttachmentIds: boolean;
    safeIntegerSizeRequired: boolean;
    failureMode: string;
  };
  limits: Record<string, number>;
}>("contracts/gallery-source-image-adapter.v1.json");
if (
  galleryAdapter.schemaVersion !== 1 ||
  galleryAdapter.contractId !== "reaper-gallery-source-image-adapter.v1" ||
  galleryAdapter.status !== "versioned-interface-adapter" ||
  galleryAdapter.owner !== reaperRepository ||
  galleryAdapter.predecessor.repository !== websiteRepository ||
  galleryAdapter.predecessor.commit !== predecessorCommit ||
  galleryAdapter.predecessor.path !==
    "supabase/functions/_shared/gallery-source-image.ts" ||
  galleryAdapter.predecessor.sha256 !==
    "9c7880f9710c8f011277252489893aa877e60621cba035c03f0598de40cc7a66" ||
  galleryAdapter.localModule !==
    "supabase/functions/_shared/gallery-source-image.ts" ||
  galleryAdapter.validatorVersion !== "reaper-gallery-source-adapter-v1" ||
  galleryAdapter.producerBoundary.declaredMimeRequiredBeforeSigning !== true ||
  galleryAdapter.producerBoundary.filenameExtensionMustMatchDeclaredMime !==
    true ||
  galleryAdapter.producerBoundary.extensionOnlyMimeInference !== false ||
  galleryAdapter.producerBoundary
      .attachmentUrlBoundToChannelAndAttachmentIds !== true ||
  galleryAdapter.producerBoundary.safeIntegerSizeRequired !== true ||
  galleryAdapter.producerBoundary.failureMode !== "reject-before-hmac-signing"
) fail("Gallery source-image adapter contract drifted.");
sameSet(galleryAdapter.supportedMimeTypes, [
  "image/jpeg",
  "image/png",
  "image/webp",
], "gallery adapter MIME types");
if (
  !read(galleryAdapter.localModule).includes(
    `"${galleryAdapter.contractId}"`,
  ) ||
  !read(galleryAdapter.localModule).includes(
    `"${galleryAdapter.validatorVersion}"`,
  )
) {
  fail(
    "Gallery source module must expose its local adapter contract and validator version.",
  );
}

const consumer = json<ConsumerContract>(
  "contracts/website-supabase-consumer.v1.json",
);
if (
  consumer.schemaVersion !== 1 ||
  consumer.status !== "website-retained-shared-consumer-contract" ||
  consumer.functionSourceOwner !== reaperRepository ||
  consumer.sharedProducerOwner !== websiteRepository ||
  consumer.currentProductionWriter !== websiteRepository ||
  consumer.predecessorCommit !== predecessorCommit ||
  consumer.predecessorTree !== predecessorTree
) fail("Website-retained consumer contract drifted.");
sameSet(
  [...runtimeSource.matchAll(/\.from\(\s*["']([a-z0-9_]+)["']/gu)].map((
    match,
  ) => match[1]),
  consumer.databaseTables,
  "Website table consumers",
);
sameSet(
  [...runtimeSource.matchAll(/\.rpc\(\s*["']([a-z0-9_]+)["']/gu)].map((match) =>
    match[1]
  ),
  consumer.databaseFunctions,
  "Website RPC consumers",
);
sameSet(consumer.websiteFunctionConsumers.map(({ name }) => name), [
  "submit-discord-gallery-image",
], "Website function consumers");
sameSet(
  consumer.websiteFunctionConsumers[0].authenticationHeaders,
  hmacHeaders,
  "consumer HMAC headers",
);
const consumerPayload = consumer.websiteFunctionConsumers[0].requestPayload;
if (
  JSON.stringify(consumerPayload.requiredKeys) !==
    JSON.stringify(expectedGalleryPayloadKeys) ||
  consumerPayload.unknownOrMissingKeys !== "reject" ||
  JSON.stringify(consumerPayload.forbiddenDecodedCodePoints) !==
    JSON.stringify(["U+FEFF"]) ||
  consumerPayload.identifiers !==
    "canonical-positive-uint64-decimal-16-to-20-digits" ||
  consumerPayload.attachmentUrl !==
    "exact-normalized-allowlisted-discord-https-url-bound-to-channel-and-attachment-ids" ||
  JSON.stringify(consumerPayload.mimeTypes) !==
    JSON.stringify(["image/jpeg", "image/png", "image/webp"]) ||
  JSON.stringify(consumerPayload.sizeBytes) !== JSON.stringify({
      type: "safe-integer",
      minimum: 1,
      maximum: 8388608,
    }) ||
  JSON.stringify(consumerPayload.originalFilename) !== JSON.stringify({
      type: "exact-trim-stable-nonempty-string",
      maximumLength: 255,
      extensionMustMatchMime: true,
    }) ||
  JSON.stringify(consumerPayload.title) !== JSON.stringify({
      type: "explicit-null-or-exact-trim-stable-nonempty-string",
      maximumLength: 80,
    }) ||
  JSON.stringify(consumerPayload.caption) !== JSON.stringify({
      type: "explicit-null-or-exact-trim-stable-nonempty-string",
      maximumLength: 300,
    }) ||
  consumerPayload.instagramOptIn !== "boolean" ||
  consumerPayload.authorizationContextFields !==
    "exact-discord-gallery-authorization-context.v1"
) fail("Gallery request-payload wire contract drifted.");
if (
  consumer.websiteFunctionConsumers[0].signerOwner !== reaperRepository ||
  consumer.websiteFunctionConsumers[0].verifierOwner !== websiteRepository ||
  consumer.websiteFunctionConsumers[0].authorizationContextContract !==
    authorizationContext.contractId
) fail("Gallery signer/verifier ownership drifted.");
sameSet(consumer.websiteRouteConsumers.map(({ path }) => path), [
  "data/guild-schedule.json",
  "spinner/media/render",
], "Website route consumers");
for (const { path, purpose, sourcePath } of consumer.websiteRouteConsumers) {
  if (!purpose || !sourcePath || !runtimeSource.includes(path)) {
    fail(`Website route consumer ${path} is not represented in source.`);
  }
}
sameSet(consumer.retainedByWebsite, [
  "migrations",
  "database-schema",
  "row-level-security",
  "grants",
  "schedules",
  "submit-discord-gallery-image",
  "shared-identity-and-authorization",
  "generic-project-config",
  "current-production-writer-until-approved-cutover",
], "Website-retained ownership");

const workflowSource = filesUnder(join(root, ".github", "workflows"))
  .map((path) => readFileSync(path, "utf8")).join("\n");
if (
  /supabase\s+(?:functions\s+deploy|db\s+push)|vercel\s+deploy|docker\s+push|ghcr\.io/iu
    .test(workflowSource)
) {
  fail("Repository workflows must remain CI-only and provider-neutral.");
}
const environment = read(".env.example");
if (
  !environment.includes(
    "DISCORD_REQUIRED_ROLE_IDS=replace-with-required-role-id-1,replace-with-required-role-id-2",
  )
) {
  fail(
    "Environment template must declare exactly two gallery role placeholders.",
  );
}
for (
  const name of [
    "DISCORD_API_ORIGIN",
    "DISCORD_WEB_ORIGIN",
    "DISCORD_GALLERY_INGEST_HMAC_KEYS_JSON",
    "DISCORD_GALLERY_INGEST_HMAC_ACTIVE_KEY_ID",
  ]
) {
  if (!environment.includes(`${name}=`)) {
    fail(`Environment template is missing ${name}.`);
  }
}

console.log(
  `Validated ${expectedFunctions.length} Reaper-owned source functions, ${safeWholeSourcePaths.length} safe semantic ports, ${adapterSourcePaths.length} versioned adapters, and immutable predecessor seals.`,
);
