import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, posix, resolve } from "node:path";

type RuntimeContract = {
  productionOwner: string;
  sourceBaselineCommit: string;
  sourceBaselineTree: string;
  functions: Array<{
    name: string;
    verifyJwt: boolean;
    authentication: string;
  }>;
  discordCommands: string[];
};

type ConsumerContract = {
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
};

const repositoryRoot = resolve(import.meta.dir, "..");
const providedWebsiteRoot = String(
  process.argv[2] || process.env.MOCHIRII_WEBSITE_ROOT || "",
).trim();
const websiteRoot = resolve(providedWebsiteRoot);

function fail(message: string): never {
  throw new Error(message);
}

if (
  !providedWebsiteRoot ||
  !isAbsolute(providedWebsiteRoot) ||
  !existsSync(resolve(websiteRoot, ".git"))
) {
  fail("Provide the absolute Website worktree through an argument or MOCHIRII_WEBSITE_ROOT.");
}

async function repositoryJson<T>(path: string): Promise<T> {
  return JSON.parse(await Bun.file(resolve(repositoryRoot, path)).text()) as T;
}

function git(args: string[]): string {
  return execFileSync("git", ["-C", websiteRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitFile(revision: string, path: string): string {
  try {
    return execFileSync(
      "git",
      ["-C", websiteRoot, "show", `${revision}:${path}`],
      {
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch {
    fail(`Website source is missing ${path} at ${revision}.`);
  }
}

function tryGitBlob(revision: string, path: string): string | null {
  try {
    return git(["rev-parse", `${revision}:${path}`]);
  } catch {
    return null;
  }
}

function gitBlob(revision: string, path: string): string {
  return tryGitBlob(revision, path) ||
    fail(`Website source is missing ${path} at ${revision}.`);
}

function sameSet(
  actual: Iterable<string>,
  expected: Iterable<string>,
  label: string,
): void {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    fail(`${label} mismatch: ${JSON.stringify(left)}`);
  }
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function configBlock(config: string, name: string): string {
  const heading = `[functions.${name}]`;
  const headingIndex = config.indexOf(heading);
  if (headingIndex < 0) return "";
  const bodyIndex = config.indexOf("\n", headingIndex + heading.length);
  if (bodyIndex < 0) return "";
  const nextHeading = config.indexOf("\n[functions.", bodyIndex + 1);
  return config.slice(
    bodyIndex + 1,
    nextHeading < 0 ? config.length : nextHeading,
  ).trim();
}

function relativeImports(source: string): string[] {
  const imports = new Set<string>();
  for (
    const match of source.matchAll(
      /(?:\bfrom\s*|\bimport\s*)["'](\.\.?\/[^"']+)["']|\bimport\s*\(\s*["'](\.\.?\/[^"']+)["']\s*\)/gu,
    )
  ) {
    imports.add(match[1] || match[2]);
  }
  return [...imports];
}

function dependencyPath(
  revision: string,
  importer: string,
  specifier: string,
): string {
  const base = posix.normalize(posix.join(posix.dirname(importer), specifier));
  for (const candidate of [base, `${base}.ts`, posix.join(base, "index.ts")]) {
    if (tryGitBlob(revision, candidate)) return candidate;
  }
  fail(`Website relative import ${specifier} from ${importer} cannot be resolved.`);
}

function dependencyClosure(revision: string, entrypoints: string[]): Set<string> {
  const files = new Set<string>();
  const pending = [...entrypoints];
  while (pending.length > 0) {
    const path = pending.pop()!;
    if (files.has(path)) continue;
    files.add(path);
    const source = gitFile(revision, path);
    for (const specifier of relativeImports(source)) {
      const dependency = dependencyPath(revision, path, specifier);
      if (!files.has(dependency)) pending.push(dependency);
    }
  }
  return files;
}

function assertFileParity(
  baseline: string,
  current: string,
  paths: Iterable<string>,
): void {
  for (const path of paths) {
    if (gitBlob(baseline, path) !== gitBlob(current, path)) {
      fail(`Website producer file drifted from the reviewed contract: ${path}.`);
    }
  }
}

const runtime = await repositoryJson<RuntimeContract>(
  "contracts/reaper-edge-runtime.v1.json",
);
const consumer = await repositoryJson<ConsumerContract>(
  "contracts/website-supabase-consumer.v1.json",
);
const baseline = runtime.sourceBaselineCommit;
const current = git(["rev-parse", "HEAD"]);
const currentTree = git(["rev-parse", "HEAD^{tree}"]);
const baselineTree = git(["rev-parse", `${baseline}^{tree}`]);
if (
  consumer.producerOwner !== runtime.productionOwner ||
  consumer.producerBaselineCommit !== baseline ||
  consumer.producerBaselineTree !== runtime.sourceBaselineTree ||
  baselineTree !== runtime.sourceBaselineTree ||
  Object.values(consumer.producerFilePolicy).some((value) => value !== true)
) fail("Website producer provenance or file-parity policy is invalid.");

const functionsRoot = "supabase/functions";
const producerFunctions = consumer.websiteFunctionConsumers.map(({ name }) => name);
const allFunctionNames = [
  ...runtime.functions.map(({ name }) => name),
  ...producerFunctions,
];
const entrypoints = allFunctionNames.map((name) =>
  `${functionsRoot}/${name}/index.ts`
);
const baselineClosure = dependencyClosure(baseline, entrypoints);
const currentClosure = dependencyClosure(current, entrypoints);
sameSet(currentClosure, baselineClosure, "Website function dependency closure");
assertFileParity(baseline, current, currentClosure);

const manifestPaths = allFunctionNames.flatMap((name) => {
  const manifest = `${functionsRoot}/${name}/deno.json`;
  const lock = `${functionsRoot}/${name}/deno.lock`;
  const baselineHasLock = Boolean(tryGitBlob(baseline, lock));
  const currentHasLock = Boolean(tryGitBlob(current, lock));
  if (baselineHasLock !== currentHasLock) {
    fail(`Website function lockfile presence drifted from the reviewed contract: ${name}.`);
  }
  return baselineHasLock ? [manifest, lock] : [manifest];
});
assertFileParity(baseline, current, manifestPaths);

const baselineConfig = gitFile(baseline, "supabase/config.toml");
const currentConfig = gitFile(current, "supabase/config.toml");
for (const { name, verifyJwt } of runtime.functions) {
  const baselineBlock = configBlock(baselineConfig, name);
  const currentBlock = configBlock(currentConfig, name);
  if (!baselineBlock || baselineBlock !== currentBlock) {
    fail(`Website function config drifted from the reviewed contract: ${name}.`);
  }
  if (!new RegExp(`^verify_jwt = ${String(verifyJwt)}$`, "mu").test(currentBlock)) {
    fail(`Website verify_jwt drifted for ${name}.`);
  }
}
for (const name of producerFunctions) {
  if (configBlock(baselineConfig, name) !== configBlock(currentConfig, name)) {
    fail(`Website producer config drifted from the reviewed contract: ${name}.`);
  }
}

for (const name of allFunctionNames) {
  const deno = JSON.parse(
    gitFile(current, `${functionsRoot}/${name}/deno.json`),
  ) as { imports: Record<string, string> };
  if (
    deno.imports["@supabase/functions-js/edge-runtime.d.ts"] !==
      "jsr:@supabase/functions-js@2.110.8/edge-runtime.d.ts" ||
    deno.imports["@supabase/supabase-js"] !==
      "npm:@supabase/supabase-js@2.110.8"
  ) fail(`Website dependency policy drifted for ${name}.`);
}

const currentSource = [...currentClosure]
  .map((path) => gitFile(current, path))
  .join("\n");
for (const table of consumer.databaseTables) {
  if (!new RegExp(`\\.from\\(\\s*["']${regexEscape(table)}["']`, "u").test(currentSource)) {
    fail(`Website no longer exposes the contracted table consumer ${table}.`);
  }
}
for (const databaseFunction of consumer.databaseFunctions) {
  if (!new RegExp(`\\.rpc\\(\\s*["']${regexEscape(databaseFunction)}["']`, "u").test(currentSource)) {
    fail(`Website no longer exposes the contracted RPC ${databaseFunction}.`);
  }
}
for (const producer of consumer.websiteFunctionConsumers) {
  const producerSource = gitFile(
    current,
    `${functionsRoot}/${producer.name}/index.ts`,
  );
  for (const header of producer.authenticationHeaders) {
    if (!producerSource.includes(header) && !currentSource.includes(header)) {
      fail(`Website producer authentication header ${header} is missing.`);
    }
  }
}

const interactionSource = gitFile(
  current,
  `${functionsRoot}/reaper-discord-interactions/index.ts`,
);
const commandBlock = interactionSource.match(
  /const commandName =[\s\S]*?if\s*\(\s*!\[\s*([\s\S]*?)\s*\]\.includes\(commandName\)\s*\)/u,
)?.[1] || "";
sameSet(
  [...commandBlock.matchAll(/"([a-z-]+)"/gu)].map((match) => match[1]),
  runtime.discordCommands,
  "Website handled Discord commands",
);
const interactionHandler = interactionSource.slice(
  interactionSource.indexOf("Deno.serve("),
);
const rawBodyIndex = interactionHandler.indexOf("await req.text()");
const signatureIndex = interactionHandler.indexOf("verifyDiscordSignature(");
const jsonRoutingIndex = interactionHandler.indexOf("JSON.parse(");
if (
  rawBodyIndex < 0 ||
  signatureIndex <= rawBodyIndex ||
  jsonRoutingIndex <= signatureIndex
) fail("Website Discord interactions no longer verify the exact body before JSON routing.");

for (const { name, authentication } of runtime.functions) {
  const source = gitFile(current, `${functionsRoot}/${name}/index.ts`);
  if (
    authentication.includes("constant-time") &&
    !source.includes("constantTimeSecretEqual(") &&
    !source.includes("constantTimeEquals(")
  ) fail(`${name} no longer performs its constant-time secret check.`);
}

const runtimeSource = runtime.functions
  .map(({ name }) => gitFile(current, `${functionsRoot}/${name}/index.ts`))
  .join("\n");
for (const route of consumer.websiteRouteConsumers) {
  gitBlob(current, route.sourcePath);
  if (!runtimeSource.includes(route.path)) {
    fail(`Website route consumer ${route.path} drifted from Reaper functions.`);
  }
  if (route.path === "spinner/media/render") {
    assertFileParity(baseline, current, [route.sourcePath]);
    const routeSource = gitFile(current, route.sourcePath);
    for (const marker of [
      "SPINNER_MEDIA_CAPABILITY_HEADER",
      "reaper-spinner-dispatch",
      "opaqueDenied",
      "export async function POST",
    ]) {
      if (!routeSource.includes(marker)) {
        fail(`Spinner media route contract is missing ${marker}.`);
      }
    }
  }
  if (route.path === "data/guild-schedule.json") {
    const schedule = JSON.parse(gitFile(current, route.sourcePath)) as {
      timezone?: { offsetMinutes?: number; displayLabel?: string };
      monthly?: Record<string, { id?: string; startTime?: string; endTime?: string }>;
      weekly?: Array<{ id?: string; startTime?: string; endTime?: string }>;
    };
    if (
      schedule.timezone?.offsetMinutes !== 480 ||
      schedule.timezone?.displayLabel !== "UTC+8" ||
      !schedule.monthly ||
      !Array.isArray(schedule.weekly) ||
      Object.values(schedule.monthly).some((event) =>
        !event.id || !event.startTime || !event.endTime
      ) ||
      schedule.weekly.some((event) => !event.id || !event.startTime || !event.endTime)
    ) fail("Website guild schedule no longer satisfies the Reaper schedule contract.");
  }
}

const relevantPaths = new Set([
  ...currentClosure,
  ...manifestPaths,
  "supabase/config.toml",
  ...consumer.websiteRouteConsumers.map(({ sourcePath }) => sourcePath),
]);
const dirtyRelevantPaths = git([
  "status",
  "--porcelain=v1",
  "--",
  ...relevantPaths,
]);
if (dirtyRelevantPaths) {
  fail("Website contract files have uncommitted changes; use a sealed producer commit.");
}

console.log(
  `Website contract/file parity matches baseline ${baseline} (${currentClosure.size + manifestPaths.length + 3} reviewed files) at current ${current} tree ${currentTree}; unrelated Website tree changes are allowed.`,
);
