import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

type RelocationContract = {
  predecessor: {
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
    sourceBlob: string;
    sourceSha256: string;
  }>;
};

const repositoryRoot = resolve(import.meta.dir, "..");
const providedWebsiteRoot = String(
  process.argv[2] || process.env.MOCHIRII_WEBSITE_ROOT || "",
).trim();
const websiteRoot = resolve(providedWebsiteRoot || ".");
const expectedTree = "ea5b564d7e1874706aa3ce948aeec38215d40821";
const functions = [
  "publish-member-spotlight-winner",
  "reaper-discord-interactions",
  "reaper-discord-member-sync",
  "reaper-spinner-dispatch",
  "send-member-spotlight-poll",
  "send-vote-reminder",
] as const;
const packagingPaths = [
  ...functions.map((name) => `supabase/functions/${name}/deno.json`),
  "supabase/functions/reaper-spinner-dispatch/deno.lock",
].sort();

function fail(message: string): never {
  throw new Error(message);
}

if (
  !providedWebsiteRoot || !isAbsolute(providedWebsiteRoot) ||
  !existsSync(resolve(websiteRoot, ".git"))
) {
  fail(
    "Provide an absolute Website worktree through an argument or MOCHIRII_WEBSITE_ROOT.",
  );
}

const relocation = JSON.parse(
  await Bun.file(
    resolve(repositoryRoot, "contracts/reaper-source-relocation.v1.json"),
  ).text(),
) as RelocationContract;
const commit = relocation.predecessor.commit;

function gitText(args: string[]): string {
  return execFileSync("git", ["-C", websiteRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function gitBytes(path: string): Buffer {
  try {
    return execFileSync(
      "git",
      ["-C", websiteRoot, "show", `${commit}:${path}`],
      {
        encoding: "buffer",
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    fail(`Website predecessor is missing ${path}.`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function framedSeal(paths: string[], expectedRows?: Map<string, string>): {
  byteCount: number;
  sha256: string;
} {
  const rows = paths.sort().map((path) => {
    const digest = sha256(gitBytes(path));
    if (expectedRows && expectedRows.get(path) !== digest) {
      fail(`Website predecessor content hash drifted for ${path}.`);
    }
    return Buffer.from(`${path}\0${digest}\n`, "utf8");
  });
  const framed = Buffer.concat(rows);
  return { byteCount: framed.byteLength, sha256: sha256(framed) };
}

function configBlock(config: string, name: string): string {
  const heading = `[functions.${name}]`;
  const start = config.indexOf(heading);
  if (start < 0) fail(`Website predecessor config is missing ${name}.`);
  const bodyStart = config.indexOf("\n", start + heading.length);
  const next = config.indexOf("\n[functions.", bodyStart + 1);
  return config.slice(bodyStart + 1, next < 0 ? config.length : next);
}

const resolvedCommit = gitText(["rev-parse", commit]);
const resolvedTree = gitText(["rev-parse", `${commit}^{tree}`]);
if (resolvedCommit !== commit || resolvedTree !== expectedTree) {
  fail("Website predecessor commit/tree identity drifted.");
}

const runtimeRows = new Map(
  relocation.paths.map(({ sourcePath, sourceBlob, sourceSha256 }) => {
    const resolvedBlob = gitText(["rev-parse", `${commit}:${sourcePath}`]);
    if (resolvedBlob !== sourceBlob) {
      fail(`Website predecessor blob identity drifted for ${sourcePath}.`);
    }
    return [sourcePath, sourceSha256];
  }),
);
if (runtimeRows.size !== relocation.predecessor.runtimeClosure.fileCount) {
  fail("Runtime relocation row count drifted.");
}
const runtime = framedSeal([...runtimeRows.keys()], runtimeRows);
if (
  runtime.byteCount !== relocation.predecessor.runtimeClosure.byteCount ||
  runtime.sha256 !== relocation.predecessor.runtimeClosure.sha256
) fail("Website predecessor runtime closure seal drifted.");

const packaging = framedSeal(packagingPaths);
if (
  packaging.byteCount !== relocation.predecessor.packagingClosure.byteCount ||
  packaging.sha256 !== relocation.predecessor.packagingClosure.sha256
) fail("Website predecessor packaging closure seal drifted.");

const rawConfig = gitBytes("supabase/config.toml").toString("utf8");
const canonicalConfig: Record<string, {
  enabled: boolean;
  verifyJwt: boolean;
  importMap: string;
}> = {};
for (const name of [...functions].sort()) {
  const block = configBlock(rawConfig, name);
  const enabled = /^enabled\s*=\s*true\s*$/mu.test(block);
  const verifyJwt = !/^verify_jwt\s*=\s*false\s*$/mu.test(block);
  const importMap = block.match(/^import_map\s*=\s*"([^"]+)"\s*$/mu)?.[1] || "";
  const expectedImportMap = `./functions/${name}/deno.json`;
  if (!enabled || verifyJwt || importMap !== expectedImportMap) {
    fail(`Website predecessor function config drifted for ${name}.`);
  }
  canonicalConfig[name] = { enabled, verifyJwt, importMap };
}
const configBytes = Buffer.from(JSON.stringify(canonicalConfig), "utf8");
const configSeal = sha256(configBytes);
if (
  functions.length !== relocation.predecessor.functionConfig.functionCount ||
  configBytes.byteLength !== relocation.predecessor.functionConfig.byteCount ||
  configSeal !== relocation.predecessor.functionConfig.sha256
) fail("Website predecessor function configuration seal drifted.");

console.log(
  `Reproduced Website predecessor ${commit} tree ${resolvedTree}: runtime ${runtimeRows.size}/${runtime.byteCount}/${runtime.sha256}, packaging ${packagingPaths.length}/${packaging.byteCount}/${packaging.sha256}, config ${functions.length}/${configBytes.byteLength}/${configSeal}.`,
);
