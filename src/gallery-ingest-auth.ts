import { createHash, createHmac, randomBytes } from "node:crypto";

export const DISCORD_GALLERY_INGEST_PATH =
  "/functions/v1/submit-discord-gallery-image";
export const DISCORD_GALLERY_INGEST_MAX_BODY_BYTES = 16 * 1024;
export const DISCORD_GALLERY_INGEST_REQUEST_TIMEOUT_MS = 10_000;
export const DISCORD_GALLERY_INGEST_MAX_RESPONSE_BYTES = 64 * 1024;
export const DISCORD_GALLERY_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
export const DISCORD_GALLERY_AUTHORIZATION_CONTEXT_VERSION =
  "discord-gallery-authorization-context.v1" as const;
export const DISCORD_GALLERY_REQUIRED_ROLE_MATCH = "all" as const;

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
const MAX_FUNCTIONS_URL_CHARACTERS = 2_048;
const MAX_ATTACHMENT_URL_CHARACTERS = 4_096;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const KEY_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const TIMESTAMP_RE = /^[1-9][0-9]{9,12}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const CANONICAL_DISCORD_IDENTIFIER_RE = /^[1-9][0-9]{15,19}$/;
const DISCORD_GALLERY_ATTACHMENT_PATH =
  /^\/(?:ephemeral-)?attachments\/([^/]+)\/([^/]+)\/[^/]+$/u;
const DISCORD_GALLERY_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const DISCORD_GALLERY_ATTACHMENT_ORIGINS = new Set([
  "https://cdn.discordapp.com",
  "https://media.discordapp.net",
  "https://media.discordapp.com",
]);
const FORBIDDEN_ZERO_WIDTH_NO_BREAK_SPACE = "\uFEFF";

export type DiscordGalleryIngestHmacKeys = Readonly<Record<string, string>>;
export type DiscordGalleryAuthorizationContext = Readonly<{
  authorizationContextVersion:
    typeof DISCORD_GALLERY_AUTHORIZATION_CONTEXT_VERSION;
  authorizationContextSha256: string;
}>;

export function canonicalDiscordIdentifier(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    !CANONICAL_DISCORD_IDENTIFIER_RE.test(value)
  ) return null;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_UINT64 &&
        parsed.toString(10) === value
      ? value
      : null;
  } catch {
    return null;
  }
}

export function canonicalDiscordGalleryRequiredRoleIds(
  value: unknown,
): readonly string[] | null {
  if (typeof value !== "string" || !value) return null;
  return canonicalDiscordGalleryRequiredRoleIdArray(value.split(","));
}

function canonicalDiscordGalleryRequiredRoleIdArray(
  value: unknown,
): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const roleIds = value;
  if (
    roleIds.length !== 2 ||
    roleIds.some((roleId) => canonicalDiscordIdentifier(roleId) !== roleId) ||
    new Set(roleIds).size !== roleIds.length
  ) return null;
  return Object.freeze([...roleIds].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  ));
}

export function createDiscordGalleryAuthorizationContext(input: {
  guildId: unknown;
  galleryChannelId: unknown;
  requiredRoleIds: unknown;
}): DiscordGalleryAuthorizationContext | null {
  const guildId = canonicalDiscordIdentifier(input.guildId);
  const galleryChannelId = canonicalDiscordIdentifier(input.galleryChannelId);
  const requiredRoleIds = canonicalDiscordGalleryRequiredRoleIdArray(
    input.requiredRoleIds,
  );
  if (!guildId || !galleryChannelId || !requiredRoleIds) return null;
  const canonical = [
    `version\0${DISCORD_GALLERY_AUTHORIZATION_CONTEXT_VERSION}\n`,
    `guild\0${guildId}\n`,
    `gallery-channel\0${galleryChannelId}\n`,
    `required-role-count\0${requiredRoleIds.length}\n`,
    `required-role-match\0${DISCORD_GALLERY_REQUIRED_ROLE_MATCH}\n`,
    ...requiredRoleIds.map((roleId) => `required-role\0${roleId}\n`),
  ].join("");
  return Object.freeze({
    authorizationContextVersion:
      DISCORD_GALLERY_AUTHORIZATION_CONTEXT_VERSION,
    authorizationContextSha256: createHash("sha256")
      .update(canonical, "utf8")
      .digest("hex"),
  });
}

export function parseDiscordGalleryAttachmentOrigins(
  value: unknown,
): readonly string[] | null {
  if (typeof value !== "string" || !value) return null;
  const origins = value.split(",");
  if (
    origins.length < 1 || origins.length > 3 ||
    new Set(origins).size !== origins.length
  ) return null;
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (
        !DISCORD_GALLERY_ATTACHMENT_ORIGINS.has(origin) ||
        url.protocol !== "https:" || url.username || url.password ||
        url.port || url.pathname !== "/" || url.search || url.hash ||
        url.origin !== origin
      ) return null;
    } catch {
      return null;
    }
  }
  return Object.freeze([...origins].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  ));
}

export function exactDiscordGalleryString(
  value: unknown,
  maximumLength: number,
): string | null {
  return typeof value === "string" && value.length > 0 &&
      value.length <= maximumLength && value === value.trim() &&
      !value.includes(FORBIDDEN_ZERO_WIDTH_NO_BREAK_SPACE)
    ? value
    : null;
}

export function canonicalDiscordGalleryAttachmentUrl(
  value: unknown,
  expectedChannelId: string,
  expectedAttachmentId: string,
  allowedOrigins: readonly string[],
): string | null {
  const text = exactDiscordGalleryString(
    value,
    MAX_ATTACHMENT_URL_CHARACTERS,
  );
  if (!text || text.includes("#")) return null;
  try {
    const url = new URL(text);
    const path = DISCORD_GALLERY_ATTACHMENT_PATH.exec(url.pathname);
    if (
      url.protocol !== "https:" ||
      !allowedOrigins.includes(url.origin) ||
      !path || canonicalDiscordIdentifier(path[1]) !== expectedChannelId ||
      canonicalDiscordIdentifier(path[2]) !== expectedAttachmentId ||
      url.username || url.password || url.hash || url.port ||
      url.toString() !== text
    ) return null;
    return text;
  } catch {
    return null;
  }
}

export function canonicalDiscordGalleryImageMime(
  value: unknown,
): string | null {
  return typeof value === "string" &&
      DISCORD_GALLERY_IMAGE_MIME_TYPES.has(value)
    ? value
    : null;
}

export function canonicalDiscordGalleryAttachmentSize(
  value: unknown,
): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) &&
      value > 0 && value <= DISCORD_GALLERY_ATTACHMENT_MAX_BYTES
    ? value
    : null;
}

export function discordGalleryFilenameMatchesMime(
  filenameValue: unknown,
  mimeValue: unknown,
): boolean {
  const filename = exactDiscordGalleryString(filenameValue, 255)
    ?.toLowerCase() || "";
  const mime = canonicalDiscordGalleryImageMime(mimeValue);
  if (!filename || !mime) return false;
  if (mime === "image/jpeg") return /\.jpe?g$/u.test(filename);
  if (mime === "image/png") return /\.png$/u.test(filename);
  return mime === "image/webp" && /\.webp$/u.test(filename);
}

function secretIsValid(secret: string): boolean {
  const length = Buffer.byteLength(secret, "utf8");
  return length >= MIN_HMAC_KEY_BYTES && length <= MAX_HMAC_KEY_BYTES;
}

function skipJsonWhitespace(source: string, start: number): number {
  let index = start;
  while (
    source[index] === " " || source[index] === "\t" ||
    source[index] === "\r" || source[index] === "\n"
  ) index += 1;
  return index;
}

function jsonStringAt(
  source: string,
  start: number,
): { value: string; end: number } | null {
  if (source[start] !== '"') return null;
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index] || "";
    if (character.charCodeAt(0) < 0x20) return null;
    if (character === "\\") {
      const escape = source[index + 1] || "";
      if (escape === "u") {
        if (!/^[0-9a-fA-F]{4}$/u.test(source.slice(index + 2, index + 6))) {
          return null;
        }
        index += 5;
      } else if ('"\\/bfnrt'.includes(escape)) {
        index += 1;
      } else {
        return null;
      }
      continue;
    }
    if (character !== '"') continue;
    try {
      const value = JSON.parse(source.slice(start, index + 1)) as unknown;
      return typeof value === "string" ? { value, end: index + 1 } : null;
    } catch {
      return null;
    }
  }
  return null;
}

function parseExactStringMap(source: string): Record<string, string> | null {
  let index = skipJsonWhitespace(source, 0);
  if (source[index] !== "{") return null;
  index = skipJsonWhitespace(source, index + 1);
  const result = Object.create(null) as Record<string, string>;
  const names = new Set<string>();
  if (source[index] === "}") {
    index = skipJsonWhitespace(source, index + 1);
    return index === source.length ? result : null;
  }

  while (index < source.length) {
    const name = jsonStringAt(source, index);
    if (!name || names.has(name.value)) return null;
    names.add(name.value);
    index = skipJsonWhitespace(source, name.end);
    if (source[index] !== ":") return null;
    index = skipJsonWhitespace(source, index + 1);
    const value = jsonStringAt(source, index);
    if (!value) return null;
    result[name.value] = value.value;
    index = skipJsonWhitespace(source, value.end);
    if (source[index] === "}") {
      index = skipJsonWhitespace(source, index + 1);
      return index === source.length ? result : null;
    }
    if (source[index] !== ",") return null;
    index = skipJsonWhitespace(source, index + 1);
  }
  return null;
}

export function parseDiscordGalleryIngestHmacKeys(
  rawValue: string | null | undefined,
): DiscordGalleryIngestHmacKeys | null {
  const raw = String(rawValue || "").trim();
  if (!raw || Buffer.byteLength(raw, "utf8") > MAX_KEY_SET_BYTES) return null;
  const parsed = parseExactStringMap(raw);
  if (!parsed) return null;

  const entries = Object.entries(parsed);
  if (entries.length < 1 || entries.length > MAX_KEY_COUNT) return null;

  const keys = Object.create(null) as Record<string, string>;
  const uniqueSecrets = new Set<string>();
  for (const [keyId, secret] of entries) {
    if (
      !KEY_ID_RE.test(keyId) || !secretIsValid(secret) ||
      uniqueSecrets.has(secret)
    ) return null;
    uniqueSecrets.add(secret);
    keys[keyId] = secret;
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
  return randomBytes(16).toString("hex");
}

export function discordGalleryIngestCanonicalMessage(input: {
  keyId: string;
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
    DISCORD_GALLERY_INGEST_METHOD,
    DISCORD_GALLERY_INGEST_PATH,
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
}): string {
  if (
    !secretIsValid(input.secret) || !KEY_ID_RE.test(input.keyId) ||
    !TIMESTAMP_RE.test(input.timestamp) || !NONCE_RE.test(input.nonce) ||
    typeof input.rawBody !== "string" ||
    input.rawBody.includes(FORBIDDEN_ZERO_WIDTH_NO_BREAK_SPACE) ||
    Buffer.byteLength(input.rawBody, "utf8") >
      DISCORD_GALLERY_INGEST_MAX_BODY_BYTES
  ) throw new Error("gallery_ingest_hmac_invalid");

  const canonical = discordGalleryIngestCanonicalMessage(input);
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

  const timestamp = Math.floor((input.nowMs ?? Date.now()) / 1_000).toString();
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
  const raw = String(supabaseFunctionsUrl || "");
  if (
    !raw || raw !== raw.trim() || raw.length > MAX_FUNCTIONS_URL_CHARACTERS ||
    raw.includes("?") || raw.includes("#")
  ) throw new Error("SUPABASE_FUNCTIONS_URL is invalid.");

  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw new Error("SUPABASE_FUNCTIONS_URL is invalid.");
  }
  if (
    base.protocol !== "https:" || base.username || base.password ||
    (base.port && base.port !== "443") || !base.hostname ||
    base.pathname.replace(/\/+$/u, "") !== "/functions/v1"
  ) throw new Error("SUPABASE_FUNCTIONS_URL is invalid.");

  return `${base.origin}${DISCORD_GALLERY_INGEST_PATH}`;
}
