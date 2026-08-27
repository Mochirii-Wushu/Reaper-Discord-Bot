import { parseJsonObjectNoDuplicateKeys } from "./strict-json.ts";

export const DISCORD_GALLERY_INGEST_WIRE_CONTRACT =
  "discord-gallery-ingest-hmac.v1";
export const DISCORD_GALLERY_INGEST_HMAC_KEYS_ENV =
  "DISCORD_GALLERY_INGEST_HMAC_KEYS_JSON";
export const DISCORD_GALLERY_INGEST_ACTIVE_KEY_ID_ENV =
  "DISCORD_GALLERY_INGEST_HMAC_ACTIVE_KEY_ID";
export const DISCORD_GALLERY_INGEST_PATH =
  "/functions/v1/submit-discord-gallery-image";
export const DISCORD_GALLERY_INGEST_MAX_BODY_BYTES = 16 * 1024;

export const DISCORD_GALLERY_INGEST_HEADERS = {
  keyId: "x-mochirii-gallery-key-id",
  timestamp: "x-mochirii-gallery-timestamp",
  nonce: "x-mochirii-gallery-nonce",
  signature: "x-mochirii-gallery-signature",
} as const;

const AUTH_VERSION = "v1";
const DISCORD_GALLERY_INGEST_METHOD = "POST";
const MAX_KEY_COUNT = 3;
const MAX_KEY_SET_BYTES = 4 * 1024;
const MIN_HMAC_KEY_BYTES = 32;
const MAX_HMAC_KEY_BYTES = 128;
const KEY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const TIMESTAMP_RE = /^[1-9][0-9]{9,12}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const FORBIDDEN_ZERO_WIDTH_NO_BREAK_SPACE = "\uFEFF";
const encoder = new TextEncoder();

export type DiscordGalleryIngestHmacKeys = Readonly<Record<string, string>>;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function secretIsValid(secret: string): boolean {
  const length = encoder.encode(secret).byteLength;
  return length >= MIN_HMAC_KEY_BYTES && length <= MAX_HMAC_KEY_BYTES;
}

export function parseDiscordGalleryIngestHmacKeys(
  rawValue: string | null | undefined,
): DiscordGalleryIngestHmacKeys | null {
  const raw = String(rawValue || "").trim();
  if (!raw || encoder.encode(raw).byteLength > MAX_KEY_SET_BYTES) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonObjectNoDuplicateKeys(raw, {
      maximumBytes: MAX_KEY_SET_BYTES,
      maximumDepth: 4,
    });
  } catch {
    return null;
  }

  const entries = Object.entries(parsed);
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
  const secret = keys[keyId];
  return KEY_ID_RE.test(keyId) && secretIsValid(secret || "")
    ? { keyId, secret }
    : null;
}

export function randomDiscordGalleryIngestNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToHex(new Uint8Array(digest));
}

async function discordGalleryIngestCanonicalBytes(input: {
  keyId: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}): Promise<Uint8Array<ArrayBuffer>> {
  const bodyDigest = await sha256Hex(input.rawBody);
  return encoder.encode([
    AUTH_VERSION,
    input.keyId,
    DISCORD_GALLERY_INGEST_METHOD,
    DISCORD_GALLERY_INGEST_PATH,
    input.timestamp,
    input.nonce,
    bodyDigest,
  ].join("\n"));
}

async function hmacHex(
  secret: string,
  canonicalBytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  if (!secretIsValid(secret)) throw new Error("gallery_ingest_hmac_invalid");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, canonicalBytes);
  return bytesToHex(new Uint8Array(signature));
}

export async function createDiscordGalleryIngestSignature(input: {
  secret: string;
  keyId: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
}): Promise<string> {
  if (
    !KEY_ID_RE.test(input.keyId) ||
    !TIMESTAMP_RE.test(input.timestamp) ||
    !NONCE_RE.test(input.nonce) ||
    typeof input.rawBody !== "string" ||
    input.rawBody.includes(FORBIDDEN_ZERO_WIDTH_NO_BREAK_SPACE) ||
    encoder.encode(input.rawBody).byteLength >
      DISCORD_GALLERY_INGEST_MAX_BODY_BYTES
  ) throw new Error("gallery_ingest_hmac_invalid");

  const canonicalBytes = await discordGalleryIngestCanonicalBytes({
    keyId: input.keyId,
    timestamp: input.timestamp,
    nonce: input.nonce,
    rawBody: input.rawBody,
  });
  return `${AUTH_VERSION}=${await hmacHex(input.secret, canonicalBytes)}`;
}

export async function createDiscordGalleryIngestHeaders(input: {
  keys: DiscordGalleryIngestHmacKeys;
  activeKeyId: string;
  rawBody: string;
  nowMs?: number;
  nonce?: string;
}): Promise<Record<string, string>> {
  const activeKey = discordGalleryIngestActiveKey(
    input.keys,
    input.activeKeyId,
  );
  if (!activeKey) throw new Error("gallery_ingest_hmac_not_configured");

  const timestamp = Math.floor((input.nowMs ?? Date.now()) / 1000).toString();
  const nonce = input.nonce || randomDiscordGalleryIngestNonce();
  const signature = await createDiscordGalleryIngestSignature({
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
