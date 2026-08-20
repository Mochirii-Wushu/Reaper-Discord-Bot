import { createHash, createHmac, randomBytes } from "node:crypto";

export const DISCORD_GALLERY_INGEST_PATH =
  "/functions/v1/submit-discord-gallery-image";
export const DISCORD_GALLERY_INGEST_ORIGIN =
  "https://deyvmtncimmcinldjyqe.supabase.co";
export const DISCORD_GALLERY_INGEST_MAX_BODY_BYTES = 16 * 1024;
export const DISCORD_GALLERY_INGEST_REQUEST_TIMEOUT_MS = 10_000;
export const DISCORD_GALLERY_INGEST_MAX_RESPONSE_BYTES = 64 * 1024;

export const DISCORD_GALLERY_INGEST_HEADERS = {
  keyId: "x-mochirii-gallery-key-id",
  timestamp: "x-mochirii-gallery-timestamp",
  nonce: "x-mochirii-gallery-nonce",
  signature: "x-mochirii-gallery-signature",
} as const;

const AUTH_VERSION = "v1";
const MAX_KEY_COUNT = 3;
const MAX_KEY_SET_BYTES = 4 * 1024;
const MIN_HMAC_KEY_BYTES = 32;
const MAX_HMAC_KEY_BYTES = 128;
const KEY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const TIMESTAMP_RE = /^[1-9][0-9]{9,12}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;

export type DiscordGalleryIngestHmacKeys = Readonly<Record<string, string>>;

function secretIsValid(secret: string): boolean {
  const length = Buffer.byteLength(secret, "utf8");
  return length >= MIN_HMAC_KEY_BYTES && length <= MAX_HMAC_KEY_BYTES;
}

export function parseDiscordGalleryIngestHmacKeys(
  rawValue: string | null | undefined,
): DiscordGalleryIngestHmacKeys | null {
  const raw = String(rawValue || "").trim();
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_KEY_SET_BYTES) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length < 1 || entries.length > MAX_KEY_COUNT) return null;

  const keys = Object.create(null) as Record<string, string>;
  const uniqueSecrets = new Set<string>();
  for (const [keyId, value] of entries) {
    if (
      !KEY_ID_RE.test(keyId) ||
      typeof value !== "string" ||
      !secretIsValid(value) ||
      uniqueSecrets.has(value)
    ) return null;
    uniqueSecrets.add(value);
    keys[keyId] = value;
  }

  return Object.freeze(keys);
}

export function discordGalleryIngestActiveKey(
  keys: DiscordGalleryIngestHmacKeys,
  rawKeyId: string | null | undefined,
): { keyId: string; secret: string } | null {
  const keyId = String(rawKeyId || "").trim();
  const secret = keys[keyId] || "";
  return KEY_ID_RE.test(keyId) && secretIsValid(secret)
    ? { keyId, secret }
    : null;
}

export function randomDiscordGalleryIngestNonce(): string {
  return randomBytes(16).toString("hex");
}

export function discordGalleryIngestCanonicalMessage(input: {
  keyId: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}): string {
  const bodyDigest = createHash("sha256")
    .update(input.rawBody, "utf8")
    .digest("hex");
  return [
    AUTH_VERSION,
    input.keyId,
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    bodyDigest,
  ].join("\n");
}

export function createDiscordGalleryIngestSignature(input: {
  secret: string;
  keyId: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
  method?: string;
  path?: string;
}): string {
  if (
    !secretIsValid(input.secret) ||
    !KEY_ID_RE.test(input.keyId) ||
    !TIMESTAMP_RE.test(input.timestamp) ||
    !NONCE_RE.test(input.nonce) ||
    Buffer.byteLength(input.rawBody, "utf8") >
      DISCORD_GALLERY_INGEST_MAX_BODY_BYTES
  ) throw new Error("gallery_ingest_hmac_invalid");

  const canonical = discordGalleryIngestCanonicalMessage({
    keyId: input.keyId,
    method: input.method || "POST",
    path: input.path || DISCORD_GALLERY_INGEST_PATH,
    timestamp: input.timestamp,
    nonce: input.nonce,
    rawBody: input.rawBody,
  });
  return `${AUTH_VERSION}=${createHmac("sha256", input.secret)
    .update(canonical, "utf8")
    .digest("hex")}`;
}

export function createDiscordGalleryIngestHeaders(input: {
  keys: DiscordGalleryIngestHmacKeys;
  activeKeyId: string;
  rawBody: string;
  nowMs?: number;
  nonce?: string;
}): Record<string, string> {
  const activeKey = discordGalleryIngestActiveKey(
    input.keys,
    input.activeKeyId,
  );
  if (!activeKey) throw new Error("gallery_ingest_hmac_not_configured");

  const timestamp = Math.floor((input.nowMs ?? Date.now()) / 1000).toString();
  const nonce = input.nonce || randomDiscordGalleryIngestNonce();
  const signature = createDiscordGalleryIngestSignature({
    secret: activeKey.secret,
    keyId: activeKey.keyId,
    timestamp,
    nonce,
    rawBody: input.rawBody,
  });

  return {
    [DISCORD_GALLERY_INGEST_HEADERS.keyId]: activeKey.keyId,
    [DISCORD_GALLERY_INGEST_HEADERS.timestamp]: timestamp,
    [DISCORD_GALLERY_INGEST_HEADERS.nonce]: nonce,
    [DISCORD_GALLERY_INGEST_HEADERS.signature]: signature,
  };
}

export function discordGalleryIngestEndpoint(
  supabaseFunctionsUrl: string,
): string {
  let base: URL;
  try {
    base = new URL(supabaseFunctionsUrl);
  } catch {
    throw new Error("SUPABASE_FUNCTIONS_URL must be the canonical HTTPS functions/v1 URL.");
  }

  if (
    base.protocol !== "https:" ||
    base.origin !== DISCORD_GALLERY_INGEST_ORIGIN ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname.replace(/\/+$/, "") !== "/functions/v1"
  ) {
    throw new Error("SUPABASE_FUNCTIONS_URL must be the canonical HTTPS functions/v1 URL.");
  }

  return `${base.origin}${DISCORD_GALLERY_INGEST_PATH}`;
}
