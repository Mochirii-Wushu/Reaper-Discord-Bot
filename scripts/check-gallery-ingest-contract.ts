import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDiscordGalleryIngestSignature,
  DISCORD_GALLERY_INGEST_HEADERS,
  DISCORD_GALLERY_INGEST_MAX_BODY_BYTES,
  DISCORD_GALLERY_INGEST_MAX_RESPONSE_BYTES,
  DISCORD_GALLERY_INGEST_ORIGIN,
  DISCORD_GALLERY_INGEST_PATH,
  DISCORD_GALLERY_INGEST_REQUEST_TIMEOUT_MS,
  discordGalleryIngestCanonicalMessage,
} from "../src/gallery-ingest-auth.js";
import {
  DISCORD_GALLERY_INGEST_ERROR_CODES,
  DISCORD_GALLERY_INGEST_ERROR_MAX_CHARACTERS,
  DISCORD_GALLERY_INGEST_MAX_MISSING_ROLE_IDS,
  DISCORD_GALLERY_INGEST_MESSAGE_MAX_CHARACTERS,
  DISCORD_GALLERY_INGEST_MISSING_ROLE_ID_PATTERN,
} from "../src/supabase.js";

type Contract = {
  schemaVersion: number;
  status: string;
  producerRepository: string;
  consumerRepository: string;
  reviewedProducerCommit: string;
  reviewedProducerTree: string;
  origin: string;
  method: string;
  path: string;
  authentication: {
    scheme: string;
    headers: string[];
    canonicalFields: string[];
    fieldSeparator: string;
    signaturePrefix: string;
    maximumClockSkewSeconds: number;
    maximumBodyBytes: number;
    nonceBytes: number;
    minimumKeyBytes: number;
    maximumKeyBytes: number;
    maximumKeyCount: number;
  };
  configuration: { keySet: string; activeKeyId: string };
  response: {
    mediaType: string;
    maximumBytes: number;
    messageMaximumCharacters: number;
    successFields: string[];
    successDataFields: Record<string, number>;
    errorFields: string[];
    eligibilityErrorFields: string[];
    errorMaximumCharacters: number;
    errorCodes: string[];
    maximumMissingRoleIds: number;
    missingRoleIdPattern: string;
    unknownFieldsAllowed: boolean;
  };
  fixture: string;
  producerSource: string[];
  consumerSource: string[];
  activationBoundary: Record<string, boolean>;
};

type Fixture = {
  synthetic: boolean;
  keyId: string;
  secret: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
  bodySha256: string;
  canonicalMessage: string;
  signature: string;
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(message: string): never {
  throw new Error(message);
}

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function json<T>(path: string): T {
  return JSON.parse(read(path)) as T;
}

function same(actual: unknown, expected: unknown, label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} drifted.`);
  }
}

function safeRepositoryPath(path: string): boolean {
  const normalized = normalize(path);
  return Boolean(path) &&
    !isAbsolute(path) &&
    normalized !== ".." &&
    !normalized.startsWith(`..${sep}`);
}

const contract = json<Contract>("contracts/gallery-ingest-consumer.v1.json");
if (
  contract.schemaVersion !== 1 ||
  contract.status !== "source-only-consumer-contract" ||
  contract.producerRepository !== "Mochirii-Wushu/Mochirii-Website" ||
  contract.consumerRepository !== "Mochirii-Wushu/Reaper-Discord-Bot" ||
  !/^[0-9a-f]{40}$/u.test(contract.reviewedProducerCommit) ||
  !/^[0-9a-f]{40}$/u.test(contract.reviewedProducerTree)
) fail("Gallery ingest consumer provenance/status is invalid.");

same(contract.method, "POST", "request method");
same(contract.origin, DISCORD_GALLERY_INGEST_ORIGIN, "request origin");
same(contract.path, DISCORD_GALLERY_INGEST_PATH, "request path");
same(contract.authentication, {
  scheme: "body-bound-hmac-sha256-v1",
  headers: Object.values(DISCORD_GALLERY_INGEST_HEADERS),
  canonicalFields: [
    "version",
    "key-id",
    "method",
    "path",
    "unix-timestamp-seconds",
    "nonce",
    "sha256-raw-body",
  ],
  fieldSeparator: "LF",
  signaturePrefix: "v1=",
  maximumClockSkewSeconds: 60,
  maximumBodyBytes: DISCORD_GALLERY_INGEST_MAX_BODY_BYTES,
  nonceBytes: 16,
  minimumKeyBytes: 32,
  maximumKeyBytes: 128,
  maximumKeyCount: 3,
}, "authentication contract");
same(contract.configuration, {
  keySet: "DISCORD_GALLERY_INGEST_HMAC_KEYS_JSON",
  activeKeyId: "DISCORD_GALLERY_INGEST_HMAC_ACTIVE_KEY_ID",
}, "configuration contract");
same(contract.response, {
  mediaType: "application/json",
  maximumBytes: DISCORD_GALLERY_INGEST_MAX_RESPONSE_BYTES,
  messageMaximumCharacters: DISCORD_GALLERY_INGEST_MESSAGE_MAX_CHARACTERS,
  successFields: ["data", "duplicate", "message", "ok"],
  successDataFields: {
    createdAt: 80,
    status: 40,
    submissionId: 80,
  },
  errorFields: ["error", "message", "ok"],
  eligibilityErrorFields: ["error", "message", "missingRoleIds", "ok"],
  errorMaximumCharacters: DISCORD_GALLERY_INGEST_ERROR_MAX_CHARACTERS,
  errorCodes: [...DISCORD_GALLERY_INGEST_ERROR_CODES],
  maximumMissingRoleIds: DISCORD_GALLERY_INGEST_MAX_MISSING_ROLE_IDS,
  missingRoleIdPattern: DISCORD_GALLERY_INGEST_MISSING_ROLE_ID_PATTERN,
  unknownFieldsAllowed: false,
}, "response contract");
same(Object.keys(contract.activationBoundary).sort(), [
  "deploymentIncluded",
  "productionRequestIncluded",
  "providerConfigurationIncluded",
  "secretValuesIncluded",
], "activation boundary fields");
if (Object.values(contract.activationBoundary).some(Boolean)) {
  fail("Gallery ingest activation boundary must remain source-only.");
}

same(contract.producerSource, [
  "supabase/functions/_shared/discord-gallery-ingest-auth.ts",
  "supabase/functions/submit-discord-gallery-image/index.ts",
], "producer source contract");
same(contract.consumerSource, [
  "src/gallery-ingest-auth.ts",
  "src/config.ts",
  "src/supabase.ts",
], "consumer source contract");
same(contract.fixture, "contracts/fixtures/gallery-ingest-hmac-v1.json", "fixture path");

for (const path of [...contract.producerSource, ...contract.consumerSource, contract.fixture]) {
  if (!safeRepositoryPath(path)) fail(`Gallery ingest contract path is unsafe: ${path}.`);
}
for (const path of [...contract.consumerSource, contract.fixture]) {
  if (!existsSync(resolve(root, path))) fail(`Gallery ingest consumer source is missing: ${path}.`);
}

const fixture = json<Fixture>(contract.fixture);
if (!fixture.synthetic) fail("Gallery ingest fixture must remain explicitly synthetic.");
const bodySha256 = createHash("sha256")
  .update(fixture.rawBody, "utf8")
  .digest("hex");
same(bodySha256, fixture.bodySha256, "fixture body digest");
same(discordGalleryIngestCanonicalMessage({
  keyId: fixture.keyId,
  method: fixture.method,
  path: fixture.path,
  timestamp: fixture.timestamp,
  nonce: fixture.nonce,
  rawBody: fixture.rawBody,
}), fixture.canonicalMessage, "fixture canonical message");
same(createDiscordGalleryIngestSignature({
  secret: fixture.secret,
  keyId: fixture.keyId,
  timestamp: fixture.timestamp,
  nonce: fixture.nonce,
  rawBody: fixture.rawBody,
  method: fixture.method,
  path: fixture.path,
}), fixture.signature, "fixture signature");

const runtimeConsumerText = contract.consumerSource.map(read).join("\n");
const environmentTemplate = read(".env.example");
if (
  /x-mochirii-reaper-secret|DISCORD_GALLERY_INGEST_SECRET/u.test(runtimeConsumerText) ||
  /^DISCORD_GALLERY_INGEST_SECRET=/mu.test(environmentTemplate)
) {
  fail("Retired static Gallery ingest authentication remains in tracked consumer source.");
}
const trackedConsumerText = [
  runtimeConsumerText,
  environmentTemplate,
  read("AGENTS.md"),
  read("README.md"),
].join("\n");
for (const marker of [
  ...Object.values(DISCORD_GALLERY_INGEST_HEADERS),
  contract.configuration.keySet,
  contract.configuration.activeKeyId,
]) {
  if (!trackedConsumerText.includes(marker)) {
    fail(`Tracked Gallery ingest consumer source is missing ${marker}.`);
  }
}
if (
  !runtimeConsumerText.includes('redirect: "error"') ||
  !runtimeConsumerText.includes("AbortSignal.timeout(DISCORD_GALLERY_INGEST_REQUEST_TIMEOUT_MS)") ||
  !runtimeConsumerText.includes("DISCORD_GALLERY_INGEST_MAX_RESPONSE_BYTES") ||
  DISCORD_GALLERY_INGEST_REQUEST_TIMEOUT_MS !== 10_000 ||
  DISCORD_GALLERY_INGEST_MAX_RESPONSE_BYTES !== 64 * 1024
) {
  fail("Tracked Gallery ingest consumer transport controls drifted.");
}

console.log(
  "Validated the source-only Gallery ingest HMAC v1 consumer contract and deterministic protocol fixture.",
);
