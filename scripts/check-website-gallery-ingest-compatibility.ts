import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createDiscordGalleryIngestHeaders,
  DISCORD_GALLERY_INGEST_HEADERS,
  DISCORD_GALLERY_INGEST_MAX_BODY_BYTES,
  DISCORD_GALLERY_INGEST_ORIGIN,
  DISCORD_GALLERY_INGEST_PATH,
  parseDiscordGalleryIngestHmacKeys,
} from "../src/gallery-ingest-auth.js";

type Contract = {
  reviewedProducerCommit: string;
  reviewedProducerTree: string;
  origin: string;
  authentication: {
    headers: string[];
    maximumClockSkewSeconds: number;
    maximumBodyBytes: number;
  };
  response: {
    errorCodes: string[];
    successDataFields: Record<string, number>;
    maximumMissingRoleIds: number;
  };
  fixture: string;
  producerSource: string[];
};

type Fixture = {
  synthetic: boolean;
  keyId: string;
  secret: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
};

type WebsiteAuthModule = {
  DISCORD_GALLERY_INGEST_HEADERS: Record<string, string>;
  DISCORD_GALLERY_INGEST_MAX_BODY_BYTES: number;
  DISCORD_GALLERY_INGEST_MAX_SKEW_SECONDS: number;
  DISCORD_GALLERY_INGEST_PATH: string;
  exactDiscordGalleryIngestPath: (requestUrl: string) => string | null;
  parseDiscordGalleryIngestHmacKeys: (
    rawValue: string | null | undefined,
  ) => Readonly<Record<string, string>> | null;
  verifyDiscordGalleryIngestRequest: (
    headers: Headers,
    rawBody: string,
    dependencies: {
      keys: Readonly<Record<string, string>>;
      nowMs: number;
      method: string;
      path: string;
      consumeNonce: (keyId: string, nonce: string) => Promise<boolean>;
    },
  ) => Promise<unknown>;
};

const repositoryRoot = resolve(import.meta.dir, "..");
const providedWebsiteRoot = String(
  process.argv[2] || process.env.MOCHIRII_WEBSITE_ROOT || "",
).trim();
const websiteRoot = resolve(providedWebsiteRoot);

function fail(message: string): never {
  throw new Error(message);
}

function git(args: string[]): string {
  return execFileSync("git", ["-C", websiteRoot, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function same(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} drifted.`);
  }
}

if (
  !providedWebsiteRoot ||
  !isAbsolute(providedWebsiteRoot) ||
  !existsSync(resolve(websiteRoot, ".git"))
) fail("Provide the absolute Website worktree through an argument or MOCHIRII_WEBSITE_ROOT.");

const contract = JSON.parse(readFileSync(
  resolve(repositoryRoot, "contracts/gallery-ingest-consumer.v1.json"),
  "utf8",
)) as Contract;
const fixture = JSON.parse(readFileSync(
  resolve(repositoryRoot, contract.fixture),
  "utf8",
)) as Fixture;
if (!fixture.synthetic) fail("Gallery ingest compatibility fixture must remain synthetic.");
const currentHead = git(["rev-parse", "HEAD"]);
const currentTree = git(["rev-parse", "HEAD^{tree}"]);
try {
  execFileSync("git", [
    "-C",
    websiteRoot,
    "merge-base",
    "--is-ancestor",
    contract.reviewedProducerCommit,
    currentHead,
  ], { windowsHide: true, stdio: "ignore" });
} catch {
  fail("Website current head does not descend from the reviewed Gallery ingest producer baseline.");
}
if (git(["rev-parse", `${contract.reviewedProducerCommit}^{tree}`]) !== contract.reviewedProducerTree) {
  fail("Reviewed Website Gallery ingest producer provenance is invalid.");
}

const relevantPaths = [
  ...contract.producerSource,
  "supabase/functions/_shared/discord-gallery-ingest-auth_test.ts",
  "supabase/functions/reaper-discord-interactions/index.ts",
];
if (git(["status", "--porcelain=v1", "--", ...relevantPaths])) {
  fail("Website Gallery ingest producer files have uncommitted changes.");
}

for (const path of relevantPaths) {
  try {
    git(["rev-parse", `HEAD:${path}`]);
  } catch {
    fail(`Website Gallery ingest producer source is missing ${path}.`);
  }
}

const authPath = resolve(
  websiteRoot,
  "supabase/functions/_shared/discord-gallery-ingest-auth.ts",
);
const websiteAuth = await import(pathToFileURL(authPath).href) as WebsiteAuthModule;
same(websiteAuth.DISCORD_GALLERY_INGEST_HEADERS, DISCORD_GALLERY_INGEST_HEADERS, "header contract");
same(websiteAuth.DISCORD_GALLERY_INGEST_PATH, DISCORD_GALLERY_INGEST_PATH, "path contract");
same(
  websiteAuth.DISCORD_GALLERY_INGEST_MAX_BODY_BYTES,
  DISCORD_GALLERY_INGEST_MAX_BODY_BYTES,
  "body limit",
);
same(
  websiteAuth.DISCORD_GALLERY_INGEST_MAX_SKEW_SECONDS,
  contract.authentication.maximumClockSkewSeconds,
  "clock-skew window",
);
same(
  Object.values(websiteAuth.DISCORD_GALLERY_INGEST_HEADERS),
  contract.authentication.headers,
  "machine-readable header list",
);

const keys = parseDiscordGalleryIngestHmacKeys(JSON.stringify({
  [fixture.keyId]: fixture.secret,
}));
if (!keys) fail("Synthetic compatibility key set was rejected.");
const receiverKeys = websiteAuth.parseDiscordGalleryIngestHmacKeys(JSON.stringify({
  [fixture.keyId]: fixture.secret,
}));
if (!receiverKeys) fail("Website rejected the synthetic compatibility key set.");
const nowMs = Number(fixture.timestamp) * 1000;
const rawBody = fixture.rawBody;
const headers = new Headers(createDiscordGalleryIngestHeaders({
  keys,
  activeKeyId: fixture.keyId,
  rawBody,
  nowMs,
  nonce: fixture.nonce,
}));
const consumed = new Set<string>();
const verify = (body: string) => websiteAuth.verifyDiscordGalleryIngestRequest(
  headers,
  body,
  {
    keys: receiverKeys,
    nowMs,
    method: "POST",
    path: DISCORD_GALLERY_INGEST_PATH,
    consumeNonce: async (keyId, requestNonce) => {
      const identity = `${keyId}:${requestNonce}`;
      if (consumed.has(identity)) return false;
      consumed.add(identity);
      return true;
    },
  },
);
same(await verify(rawBody), { ok: true, keyId: fixture.keyId }, "signed request acceptance");
same(await verify(rawBody), {
  ok: false,
  status: 401,
  error: "replayed_request",
}, "replay rejection");
consumed.clear();
same(await verify(`${rawBody} `), {
  ok: false,
  status: 401,
  error: "invalid_request",
}, "raw-body binding");
same(
  websiteAuth.exactDiscordGalleryIngestPath(
    `https://example.supabase.co${DISCORD_GALLERY_INGEST_PATH}`,
  ),
  DISCORD_GALLERY_INGEST_PATH,
  "exact receiver path",
);

const producerText = relevantPaths.map((path) =>
  readFileSync(resolve(websiteRoot, path), "utf8")
).join("\n");
same(contract.origin, DISCORD_GALLERY_INGEST_ORIGIN, "request origin");
if (!producerText.includes(
  `const EXPECTED_SUPABASE_ORIGIN = ${JSON.stringify(contract.origin)};`,
)) {
  fail("Website Gallery ingest producer origin drifted from the reviewed consumer contract.");
}
for (const errorCode of contract.response.errorCodes) {
  if (!producerText.includes(JSON.stringify(errorCode))) {
    fail(`Website Gallery ingest response source is missing ${errorCode}.`);
  }
}
for (const marker of [
  `submissionId: safeString(existing.id, ${contract.response.successDataFields.submissionId})`,
  `status: safeString(existing.status, ${contract.response.successDataFields.status})`,
  `createdAt: safeString(existing.created_at, ${contract.response.successDataFields.createdAt})`,
  "missingRoleIds: missingStoredRoleIds",
]) {
  if (!producerText.includes(marker)) {
    fail(`Website Gallery ingest response source drifted at ${marker}.`);
  }
}
if (contract.response.maximumMissingRoleIds !== 2) {
  fail("Website Gallery ingest missing-role response bound drifted.");
}
if (/x-mochirii-reaper-secret|DISCORD_GALLERY_INGEST_SECRET/u.test(producerText)) {
  fail("Website Gallery ingest producer reintroduced retired static authentication.");
}

console.log(
  `Reaper HMAC signer interoperates with Website ${currentHead} tree ${currentTree}; fresh acceptance, replay rejection, and raw-body binding passed.`,
);
