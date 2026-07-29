import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type RuntimeManifest = {
  schemaVersion: number;
  status: string;
  productionOwner: string;
  sourceBaselineCommit: string;
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
  databaseTables: string[];
  databaseFunctions: string[];
  websiteFunctionConsumers: Array<{
    name: string;
    authenticationHeader: string;
  }>;
  websiteRouteConsumers: Array<{
    path: string;
    purpose: string;
  }>;
  retainedByProducer: string[];
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const functionsRoot = join(root, "supabase", "functions");
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
  ["send-vote-reminder", "constant-time-cron-secret"],
  ["send-member-spotlight-poll", "constant-time-cron-secret"],
  ["publish-member-spotlight-winner", "constant-time-cron-secret"],
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

const manifest = json<RuntimeManifest>("contracts/reaper-edge-runtime.v1.json");
if (
  manifest.schemaVersion !== 1 ||
  manifest.status !== "additive-candidate-not-deployed" ||
  manifest.productionOwner !== "Mochirii-Wushu/Mochirii-Website" ||
  !/^[0-9a-f]{40}$/u.test(manifest.sourceBaselineCommit)
) fail("Runtime manifest provenance/status is incomplete.");
sameSet(
  manifest.functions.map(({ name }) => name),
  expectedFunctions,
  "function manifest",
);
sameSet(
  readdirSync(functionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "_shared")
    .map((entry) => entry.name),
  expectedFunctions,
  "function directory inventory",
);
sameSet(manifest.discordCommands, expectedCommands, "Discord command manifest");
if (manifest.functions.some(({ verifyJwt }) => verifyJwt !== false)) {
  fail("Every additive Reaper function must declare verifyJwt=false.");
}
for (const { name, authentication } of manifest.functions) {
  if (expectedAuthentication.get(name) !== authentication) {
    fail(`${name} has an unexpected application-authentication contract.`);
  }
}
sameSet(
  Object.keys(manifest.activationBoundary),
  [
    "deployableFromThisBranch",
    "providerConfigurationIncluded",
    "schemaOrScheduleOwnershipTransferred",
  ],
  "activation boundary",
);
if (
  Object.values(manifest.activationBoundary).some(Boolean) ||
  manifest.functions.some(({ authentication }) => !authentication)
) {
  fail(
    "The additive candidate must remain non-deployable with explicit application authentication.",
  );
}

const config = read("supabase/config.toml");
const configNames = [...config.matchAll(/^\[functions\.([^\]]+)\]$/gmu)].map((
  match,
) => match[1]);
sameSet(configNames, expectedFunctions, "Supabase function config");
for (const name of expectedFunctions) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const block = config.match(
    new RegExp(
      `\\[functions\\.${escaped}\\]([\\s\\S]*?)(?=\\n\\[functions\\.|$)`,
      "u",
    ),
  )?.[1] || "";
  if (!/^verify_jwt = false$/mu.test(block)) {
    fail(`${name} must keep verify_jwt=false.`);
  }
  if (
    !block.includes(`import_map = "./functions/${name}/deno.json"`) ||
    !block.includes(`entrypoint = "./functions/${name}/index.ts"`)
  ) fail(`${name} must use its function-local import map and entrypoint.`);
  sameSet(
    readdirSync(join(functionsRoot, name)).filter((entry) =>
      entry !== "node_modules"
    ),
    ["deno.json", "deno.lock", "index.ts"],
    `${name} file inventory`,
  );
  for (const file of ["index.ts", "deno.json", "deno.lock"]) {
    if (!existsSync(join(functionsRoot, name, file))) {
      fail(`${name}/${file} is missing.`);
    }
  }
  const deno = json<{ imports: Record<string, string> }>(
    `supabase/functions/${name}/deno.json`,
  );
  if (
    deno.imports["@supabase/functions-js/edge-runtime.d.ts"] !==
      "jsr:@supabase/functions-js@2.110.8/edge-runtime.d.ts" ||
    deno.imports["@supabase/supabase-js"] !==
      "npm:@supabase/supabase-js@2.110.8"
  ) fail(`${name} must pin both approved Supabase packages to 2.110.8.`);
  const allowedImports = name === "reaper-discord-interactions"
    ? [
      "@supabase/functions-js/edge-runtime.d.ts",
      "@supabase/supabase-js",
      "tweetnacl",
    ]
    : ["@supabase/functions-js/edge-runtime.d.ts", "@supabase/supabase-js"];
  sameSet(Object.keys(deno.imports), allowedImports, `${name} import map`);
  if (
    name === "reaper-discord-interactions" &&
    deno.imports.tweetnacl !== "npm:tweetnacl@1.0.3"
  ) {
    fail("Discord signature verification must pin tweetnacl@1.0.3.");
  }
}
if (/^project_id\s*=|\[db\]|\[auth\]|\[storage\]/mu.test(config)) {
  fail(
    "The Reaper-local config must not contain project/provider configuration.",
  );
}

const interactionSource = read(
  "supabase/functions/reaper-discord-interactions/index.ts",
);
const commandBlock = interactionSource.match(
  /const commandName =[\s\S]*?if\s*\(\s*!\[\s*([\s\S]*?)\s*\]\.includes\(commandName\)\s*\)/u,
)?.[1] || "";
sameSet(
  [...commandBlock.matchAll(/"([a-z-]+)"/gu)].map((match) => match[1]),
  expectedCommands,
  "handled Discord commands",
);
const interactionHandler = interactionSource.slice(
  interactionSource.indexOf("Deno.serve("),
);
const boundedBodyIndex = interactionHandler.indexOf(
  "readBoundedUtf8RequestBody(",
);
const signatureIndex = interactionHandler.indexOf("verifyDiscordSignature(");
const jsonRoutingIndex = interactionHandler.indexOf("JSON.parse(");
if (
  boundedBodyIndex < 0 ||
  signatureIndex <= boundedBodyIndex ||
  jsonRoutingIndex <= signatureIndex ||
  interactionHandler.includes("await req.text()") ||
  !interactionSource.includes(
    "const MAX_DISCORD_INTERACTION_BODY_BYTES = 64 * 1024;",
  )
) {
  fail(
    "Discord interactions must bound the raw body, verify Ed25519, then route JSON.",
  );
}
for (const name of expectedFunctions) {
  const source = read(`supabase/functions/${name}/index.ts`);
  if (!source.includes(`runtimeProfileReady("${name}")`)) {
    fail(`${name} must fail closed against its runtime profile.`);
  }
}
for (
  const name of [
    "reaper-discord-member-sync",
    "send-vote-reminder",
    "send-member-spotlight-poll",
    "publish-member-spotlight-winner",
  ]
) {
  const source = read(`supabase/functions/${name}/index.ts`);
  if (!source.includes("constantTimeSecretEqual(")) {
    fail(`${name} must compare its application secret in constant time.`);
  }
}

const runtimeFiles = sourceFiles(functionsRoot)
  .filter((path) => path.endsWith(".ts"))
  .filter((path) =>
    !path.endsWith("_test.ts") && !path.endsWith("edge-tests.ts")
  );
const runtimeSource = runtimeFiles.map((path) => readFileSync(path, "utf8"))
  .join("\n");
if (/\b\d{16,22}\b/u.test(runtimeSource)) {
  fail("Runtime source must not embed Discord/provider snowflake identifiers.");
}
if (
  /https:\/\/(?:social\.)?mochirii\.com|\.supabase\.co|\.vercel\.app/iu.test(
    runtimeSource + config,
  )
) {
  fail("Runtime source/config must not embed production URLs.");
}
if (
  /Deno\.env\.get\([^)]*\).*(?:console\.|JSON\.stringify)/u.test(runtimeSource)
) {
  fail("Potential secret-value logging pattern detected.");
}

const consumer = json<ConsumerContract>(
  "contracts/website-supabase-consumer.v1.json",
);
if (
  consumer.schemaVersion !== 1 ||
  consumer.status !== "consumer-contract-only" ||
  consumer.producerOwner !== manifest.productionOwner ||
  consumer.producerBaselineCommit !== manifest.sourceBaselineCommit
) fail("Website consumer contract provenance/status drifted.");
const discoveredTables = [
  ...runtimeSource.matchAll(/\.from\(\s*"([a-z0-9_]+)"/gu),
].map((match) => match[1]);
const discoveredFunctions = [
  ...runtimeSource.matchAll(/\.rpc\(\s*"([a-z0-9_]+)"/gu),
].map((match) => match[1]);
sameSet(discoveredTables, consumer.databaseTables, "Website table consumers");
sameSet(
  discoveredFunctions,
  consumer.databaseFunctions,
  "Website RPC consumers",
);
for (
  const { name, authenticationHeader } of consumer.websiteFunctionConsumers
) {
  if (
    !runtimeSource.includes(`/functions/v1/${name}`) ||
    !runtimeSource.includes(authenticationHeader)
  ) {
    fail(`Website function consumer ${name} is not represented in source.`);
  }
}
sameSet(
  consumer.websiteRouteConsumers.map(({ path }) => path),
  ["data/guild-schedule.json", "spinner/media/render"],
  "Website route consumers",
);
for (const { path, purpose } of consumer.websiteRouteConsumers) {
  if (!purpose || !runtimeSource.includes(`siteUrl("${path}")`)) {
    fail(`Website route consumer ${path} is not represented in source.`);
  }
}
if (
  runtimeSource.includes('Deno.env.get("GUILD_SCHEDULE_URL")') ||
  !read("supabase/functions/_shared/reaper-event-sync-workflow.ts").includes(
    "fetch(deps.guildScheduleUrl,",
  )
) {
  fail(
    "Guild event sync must use only the contracted Website schedule route.",
  );
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

const workflowSource = sourceFiles(join(root, ".github", "workflows"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
if (
  /supabase\s+functions\s+deploy|vercel\s+deploy|docker\s+push|ghcr\.io/iu.test(
    workflowSource,
  )
) {
  fail("Repository workflows must remain CI-only for this additive candidate.");
}

console.log(
  `Validated ${expectedFunctions.length} additive functions, ${expectedCommands.length} Discord commands, and the Website consumer boundary.`,
);
