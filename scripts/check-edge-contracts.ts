import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type RuntimeManifest = {
  schemaVersion: number;
  status: string;
  productionOwner: string;
  consumerRepository: string;
  sourceBaselineCommit: string;
  sourceBaselineTree: string;
  functions: Array<{
    name: string;
    verifyJwt: boolean;
    authentication: string;
  }>;
  discordCommands: string[];
  activationBoundary: Record<string, boolean>;
};

type ConsumerContract = {
  schemaVersion: number;
  status: string;
  producerOwner: string;
  producerBaselineCommit: string;
  producerBaselineTree: string;
  producerFilePolicy: Record<string, boolean>;
  databaseTables: string[];
  databaseFunctions: string[];
  websiteFunctionConsumers: Array<{
    name: string;
    authentication: string;
    authenticationHeaders: string[];
  }>;
  websiteRouteConsumers: Array<{
    path: string;
    purpose: string;
    sourcePath: string;
  }>;
  retainedByProducer: string[];
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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
const expectedAuthentication = new Map<string, string>([
  ["reaper-discord-interactions", "discord-ed25519-signature"],
  ["reaper-discord-member-sync", "constant-time-shared-secret"],
  [
    "reaper-spinner-dispatch",
    "constant-time-shared-secret-or-scoped-media-capability",
  ],
  ["send-vote-reminder", "exact-cron-secret"],
  ["send-member-spotlight-poll", "exact-cron-secret"],
  ["publish-member-spotlight-winner", "exact-cron-secret"],
]);

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
  const normalizedActual = [...new Set(actual)].sort();
  const normalizedExpected = [...new Set(expected)].sort();
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    fail(`${label} mismatch: ${JSON.stringify(normalizedActual)}`);
  }
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && entry.name === "node_modules") return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

function isSafeRepositoryPath(path: string): boolean {
  const normalized = normalize(path);
  return Boolean(path) &&
    !isAbsolute(path) &&
    normalized !== ".." &&
    !normalized.startsWith(`..${sep}`) &&
    !normalized.startsWith("../");
}

const manifest = json<RuntimeManifest>("contracts/reaper-edge-runtime.v1.json");
if (
  manifest.schemaVersion !== 1 ||
  manifest.status !== "website-owned-runtime-contract" ||
  manifest.productionOwner !== "Mochirii-Wushu/Mochirii-Website" ||
  manifest.consumerRepository !== "Mochirii-Wushu/Reaper-Discord-Bot" ||
  !/^[0-9a-f]{40}$/u.test(manifest.sourceBaselineCommit) ||
  !/^[0-9a-f]{40}$/u.test(manifest.sourceBaselineTree)
) fail("Runtime contract provenance/status is incomplete.");
sameSet(
  manifest.functions.map(({ name }) => name),
  expectedFunctions,
  "function contract",
);
sameSet(manifest.discordCommands, expectedCommands, "Discord command contract");
if (manifest.functions.some(({ verifyJwt }) => verifyJwt !== false)) {
  fail("Every Website-owned Reaper function must declare verifyJwt=false.");
}
for (const { name, authentication } of manifest.functions) {
  if (expectedAuthentication.get(name) !== authentication) {
    fail(`${name} has an unexpected application-authentication contract.`);
  }
}
sameSet(
  Object.keys(manifest.activationBoundary),
  [
    "deployableFromThisRepository",
    "copiedSupabaseSourceIncluded",
    "providerConfigurationIncluded",
    "schemaOrScheduleOwnershipTransferred",
  ],
  "activation boundary",
);
if (Object.values(manifest.activationBoundary).some(Boolean)) {
  fail("The Reaper contract consumer must remain non-deployable and source-free.");
}

const consumer = json<ConsumerContract>(
  "contracts/website-supabase-consumer.v1.json",
);
if (
  consumer.schemaVersion !== 1 ||
  consumer.status !== "consumer-contract-only" ||
  consumer.producerOwner !== manifest.productionOwner ||
  consumer.producerBaselineCommit !== manifest.sourceBaselineCommit ||
  consumer.producerBaselineTree !== manifest.sourceBaselineTree
) fail("Website consumer contract provenance/status drifted.");
sameSet(
  Object.keys(consumer.producerFilePolicy),
  [
    "compareFunctionDependencyClosureToBaseline",
    "compareFunctionManifestsAndLocksToBaseline",
    "compareRelevantConfigBlocksToBaseline",
    "allowUnrelatedProducerTreeChanges",
  ],
  "producer file policy",
);
if (Object.values(consumer.producerFilePolicy).some((value) => value !== true)) {
  fail("Every reviewed producer file-parity control must remain enabled.");
}
for (const [label, values] of [
  ["database table", consumer.databaseTables],
  ["database function", consumer.databaseFunctions],
] as const) {
  if (
    values.length === 0 ||
    values.some((value) => !/^[a-z][a-z0-9_]*$/u.test(value)) ||
    new Set(values).size !== values.length
  ) fail(`${label} contract must contain unique safe identifiers.`);
}
sameSet(
  consumer.websiteFunctionConsumers.map(({ name }) => name),
  ["submit-discord-gallery-image"],
  "Website function consumers",
);
const galleryConsumer = consumer.websiteFunctionConsumers[0];
if (
  galleryConsumer.authentication !== "body-bound-hmac-sha256-v1" ||
  new Set(galleryConsumer.authenticationHeaders).size !== 4
) fail("Gallery ingest authentication contract drifted.");
sameSet(
  galleryConsumer.authenticationHeaders,
  [
    "x-mochirii-gallery-key-id",
    "x-mochirii-gallery-timestamp",
    "x-mochirii-gallery-nonce",
    "x-mochirii-gallery-signature",
  ],
  "Gallery ingest authentication headers",
);
sameSet(
  consumer.websiteRouteConsumers.map(({ path }) => path),
  ["data/guild-schedule.json", "spinner/media/render"],
  "Website route consumers",
);
for (const route of consumer.websiteRouteConsumers) {
  if (!route.purpose || !isSafeRepositoryPath(route.sourcePath)) {
    fail(`Website route consumer ${route.path} has an unsafe source contract.`);
  }
}
sameSet(
  consumer.retainedByProducer,
  [
    "migrations",
    "database-schema",
    "row-level-security",
    "schedules",
    "website-producers",
    "generic-project-config",
  ],
  "retained Website ownership",
);

const localSupabaseRoot = join(root, "supabase");
if (existsSync(localSupabaseRoot) && sourceFiles(localSupabaseRoot).length > 0) {
  fail("Reaper must not copy Website-owned Supabase source or configuration.");
}
const environmentTemplate = read(".env.example");
if (/DISCORD_GALLERY_INGEST_HMAC_(?:KEYS_JSON|ACTIVE_KEY_ID)/u.test(environmentTemplate)) {
  fail("Reaper must not declare Website-owned Edge Function signing secrets.");
}
const workflowSource = sourceFiles(join(root, ".github", "workflows"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
if (
  /supabase\s+(?:functions\s+deploy|db\s+push)|vercel\s+deploy|docker\s+push|ghcr\.io/iu.test(
    workflowSource,
  )
) fail("Repository workflows must remain CI-only contract consumers.");

console.log(
  `Validated ${expectedFunctions.length} Website-owned function contracts, ${expectedCommands.length} Discord commands, and no copied Supabase source.`,
);
