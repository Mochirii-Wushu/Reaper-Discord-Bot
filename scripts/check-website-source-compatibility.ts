import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

type RuntimeContract = {
  sourceBaselineCommit: string;
  sourceBaselineTree: string;
  functions: Array<{ name: string; verifyJwt: boolean; authentication: string }>;
};

type ConsumerContract = {
  producerBaselineCommit: string;
  producerBaselineTree: string;
  databaseTables: string[];
  databaseFunctions: string[];
  websiteFunctionConsumers: Array<{
    name: string;
    authenticationHeaders: string[];
  }>;
  websiteRouteConsumers: Array<{ path: string }>;
};

const repositoryRoot = resolve(import.meta.dir, "..");
const websiteRoot = resolve(
  String(process.argv[2] || process.env.MOCHIRII_WEBSITE_ROOT || "").trim(),
);

function fail(message: string): never {
  throw new Error(message);
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

if (
  !String(process.argv[2] || process.env.MOCHIRII_WEBSITE_ROOT || "").trim() ||
  !isAbsolute(websiteRoot) ||
  !existsSync(join(websiteRoot, ".git"))
) {
  fail("Provide the absolute clean Website worktree through an argument or MOCHIRII_WEBSITE_ROOT.");
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function json<T>(root: string, path: string): T {
  return JSON.parse(read(root, path)) as T;
}

function gitRevision(revision: string): string {
  return execFileSync("git", ["-C", websiteRoot, "rev-parse", revision], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

const runtime = json<RuntimeContract>(
  repositoryRoot,
  "contracts/reaper-edge-runtime.v1.json",
);
const consumer = json<ConsumerContract>(
  repositoryRoot,
  "contracts/website-supabase-consumer.v1.json",
);
const websiteHead = gitRevision("HEAD");
const websiteTree = gitRevision("HEAD^{tree}");
if (
  websiteHead !== runtime.sourceBaselineCommit ||
  websiteTree !== runtime.sourceBaselineTree ||
  consumer.producerBaselineCommit !== websiteHead ||
  consumer.producerBaselineTree !== websiteTree
) {
  fail("Website source does not match the exact reviewed consumer baseline.");
}

const functionsRoot = join(websiteRoot, "supabase", "functions");
const config = read(websiteRoot, "supabase/config.toml");
const websiteFunctionSource: string[] = [];
for (const { name, verifyJwt } of runtime.functions) {
  const entrypoint = join(functionsRoot, name, "index.ts");
  const importMap = join(functionsRoot, name, "deno.json");
  if (!existsSync(entrypoint) || !existsSync(importMap)) {
    fail(`Website source is missing ${name}.`);
  }
  const escapedName = regexEscape(name);
  const block = config.match(
    new RegExp(
      `\\[functions\\.${escapedName}\\]([\\s\\S]*?)(?=\\n\\[functions\\.|$)`,
      "u",
    ),
  )?.[1] || "";
  if (!block.includes(`verify_jwt = ${String(verifyJwt)}`)) {
    fail(`Website verify_jwt drifted for ${name}.`);
  }
  const deno = json<{ imports: Record<string, string> }>(
    websiteRoot,
    `supabase/functions/${name}/deno.json`,
  );
  if (
    deno.imports["@supabase/functions-js/edge-runtime.d.ts"] !==
      "jsr:@supabase/functions-js@2.110.8/edge-runtime.d.ts" ||
    deno.imports["@supabase/supabase-js"] !==
      "npm:@supabase/supabase-js@2.110.8"
  ) fail(`Website dependency policy drifted for ${name}.`);
  websiteFunctionSource.push(readFileSync(entrypoint, "utf8"));
}

const allWebsiteFunctionSource = sourceFiles(functionsRoot)
  .filter((path) => path.endsWith(".ts"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
for (const table of consumer.databaseTables) {
  if (
    !new RegExp(`\\.from\\(\\s*["']${regexEscape(table)}["']`, "u").test(
      allWebsiteFunctionSource,
    )
  ) {
    fail(`Website no longer exposes the contracted table consumer ${table}.`);
  }
}
for (const databaseFunction of consumer.databaseFunctions) {
  if (
    !new RegExp(
      `\\.rpc\\(\\s*["']${regexEscape(databaseFunction)}["']`,
      "u",
    ).test(allWebsiteFunctionSource)
  ) {
    fail(`Website no longer exposes the contracted RPC ${databaseFunction}.`);
  }
}
for (const { name, authenticationHeaders } of consumer.websiteFunctionConsumers) {
  if (!existsSync(join(functionsRoot, name, "index.ts"))) {
    fail(`Website producer function ${name} is missing.`);
  }
  for (const header of authenticationHeaders) {
    if (!allWebsiteFunctionSource.includes(header)) {
      fail(`Website producer authentication header ${header} is missing.`);
    }
  }
}
for (const { path } of consumer.websiteRouteConsumers) {
  if (!websiteFunctionSource.some((source) => source.includes(path))) {
    fail(`Website route consumer ${path} drifted from Reaper source.`);
  }
}

console.log(
  `Website compatibility matches ${websiteHead} (${runtime.functions.length} functions).`,
);
