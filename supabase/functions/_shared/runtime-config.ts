import {
  MAX_SHARED_SECRET_BYTES,
  MIN_SHARED_SECRET_BYTES,
} from "./secret-auth.ts";
import {
  DISCORD_GALLERY_INGEST_ACTIVE_KEY_ID_ENV,
  DISCORD_GALLERY_INGEST_HMAC_KEYS_ENV,
  discordGalleryIngestActiveKey,
  parseDiscordGalleryIngestHmacKeys,
} from "./discord-gallery-ingest-signer.ts";

export type ReaperRuntimeProfile =
  | "reaper-discord-interactions"
  | "reaper-discord-member-sync"
  | "reaper-spinner-dispatch"
  | "send-vote-reminder"
  | "send-member-spotlight-poll"
  | "publish-member-spotlight-winner";

const SNOWFLAKE_PATTERN = /^\d{16,22}$/u;
const AUTHORIZATION_SNOWFLAKE_PATTERN = /^[1-9][0-9]{15,19}$/u;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const HEX_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/iu;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DISCORD_GALLERY_AUTHORIZATION_REQUIRED_ROLE_COUNT = 2;

export const DISCORD_GALLERY_AUTHORIZATION_CONTEXT_VERSION =
  "discord-gallery-authorization-context.v1" as const;
export const DISCORD_GALLERY_REQUIRED_ROLE_MATCH = "all" as const;

export type DiscordGalleryAuthorizationContext = Readonly<{
  authorizationContextVersion:
    typeof DISCORD_GALLERY_AUTHORIZATION_CONTEXT_VERSION;
  authorizationContextSha256: string;
}>;

function env(name: string): string {
  return Deno.env.get(name)?.trim() || "";
}

function csv(name: string): string[] {
  return env(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function snowflake(name: string): string {
  const value = env(name);
  return SNOWFLAKE_PATTERN.test(value) ? value : "";
}

function snowflakes(name: string): string[] {
  const values = csv(name);
  return values.length > 0 &&
      values.every((value) => SNOWFLAKE_PATTERN.test(value))
    ? [...new Set(values)]
    : [];
}

function canonicalAuthorizationRoleIds(
  values: readonly string[],
): string[] | null {
  if (values.length !== DISCORD_GALLERY_AUTHORIZATION_REQUIRED_ROLE_COUNT) {
    return null;
  }
  if (values.some((value) => !isCanonicalAuthorizationSnowflake(value))) {
    return null;
  }
  if (new Set(values).size !== values.length) return null;
  return [...values].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
}

function isCanonicalAuthorizationSnowflake(value: string): boolean {
  if (!AUTHORIZATION_SNOWFLAKE_PATTERN.test(value)) return false;
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_UINT64 &&
      parsed.toString(10) === value;
  } catch {
    return false;
  }
}

function authorizationSnowflake(name: string): string {
  const value = Deno.env.get(name);
  return typeof value === "string" && isCanonicalAuthorizationSnowflake(value)
    ? value
    : "";
}

function authorizationSnowflakes(name: string): string[] {
  const value = Deno.env.get(name);
  if (typeof value !== "string" || !value) return [];
  const values = value.split(",");
  return canonicalAuthorizationRoleIds(values) || [];
}

function uuids(name: string): string[] {
  const values = csv(name);
  return values.every((value) => UUID_PATTERN.test(value))
    ? [...new Set(values)]
    : [];
}

function httpsOrigin(name: string): string {
  const value = env(name);
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
        url.origin === value.replace(/\/+$/u, "") && url.pathname === "/"
      ? url.origin
      : "";
  } catch {
    return "";
  }
}

function serviceUrl(name: string): string {
  const value = env(name);
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" &&
        url.password === "" && url.pathname === "/" && url.search === "" &&
        url.hash === "" && url.origin === value.replace(/\/+$/u, "")
      ? url.origin
      : "";
  } catch {
    return "";
  }
}

export const SITE_ORIGIN = httpsOrigin("MOCHIRII_SITE_ORIGIN");
export const DISCORD_API_ORIGIN = httpsOrigin("DISCORD_API_ORIGIN");
export const DISCORD_WEB_ORIGIN = httpsOrigin("DISCORD_WEB_ORIGIN");
export function supabaseOrigin(): string {
  return serviceUrl("SUPABASE_URL");
}
export const DISCORD_GUILD_ID = snowflake("DISCORD_GUILD_ID");
export const DISCORD_APPLICATION_ID = snowflake("DISCORD_APPLICATION_ID");
export const DISCORD_GALLERY_CHANNEL_ID = snowflake(
  "DISCORD_GALLERY_CHANNEL_ID",
);
export const DISCORD_VOTE_CHANNEL_ID = snowflake("DISCORD_VOTE_CHANNEL_ID");
export const DISCORD_PHOTO_DAY_CHANNEL_ID = snowflake(
  "DISCORD_PHOTO_DAY_CHANNEL_ID",
);
export const DISCORD_SPOTLIGHT_POLL_CHANNEL_ID = snowflake(
  "DISCORD_SPOTLIGHT_POLL_CHANNEL_ID",
);
export const DISCORD_RAFFLE_CHANNEL_ID = snowflake("DISCORD_RAFFLE_CHANNEL_ID");
export const DISCORD_REQUIRED_ROLE_IDS = authorizationSnowflakes(
  "DISCORD_REQUIRED_ROLE_IDS",
);
export const DISCORD_MODERATOR_ROLE_IDS = snowflakes(
  "DISCORD_MODERATOR_ROLE_IDS",
);
export const PENDING_BASE_ROLE_ID = snowflake("DISCORD_PENDING_BASE_ROLE_ID");
export const VERIFIED_ROLE_ID = snowflake("DISCORD_VERIFIED_ROLE_ID");
export const PENDING_ALLOWED_CHANNEL_IDS = snowflakes(
  "DISCORD_PENDING_ALLOWED_CHANNEL_IDS",
);
export const MODMAIL_BOT_USER_ID = snowflake("DISCORD_MODMAIL_BOT_USER_ID");
export const MODMAIL_LOG_CHANNEL_ID = snowflake(
  "DISCORD_MODMAIL_LOG_CHANNEL_ID",
);
export const MODMAIL_MODERATOR_ROLE_ID = snowflake(
  "DISCORD_MODMAIL_MODERATOR_ROLE_ID",
);
export const SPOTLIGHT_EXCLUDED_MEMBER_IDS = snowflakes(
  "DISCORD_SPOTLIGHT_EXCLUDED_MEMBER_IDS",
);
export const SPOTLIGHT_EXCLUDED_MEMBER_PROFILE_IDS = uuids(
  "SPOTLIGHT_EXCLUDED_MEMBER_PROFILE_IDS",
);

function relativeServiceUrl(origin: string, pathname: string): string {
  const value = String(pathname || "").trim();
  if (
    !origin || !value || /^[a-z][a-z\d+.-]*:/iu.test(value) ||
    value.startsWith("//") || value.includes("\\")
  ) return "";
  const candidate = new URL(value.replace(/^\/+/, ""), `${origin}/`);
  return candidate.origin === origin && !candidate.username &&
      !candidate.password && !candidate.hash
    ? candidate.toString()
    : "";
}

export function siteUrl(pathname: string): string {
  return relativeServiceUrl(SITE_ORIGIN, pathname);
}

export function discordApiUrl(pathname: string): string {
  return relativeServiceUrl(DISCORD_API_ORIGIN, pathname);
}

export function discordWebUrl(pathname: string): string {
  return relativeServiceUrl(DISCORD_WEB_ORIGIN, pathname);
}

function present(name: string): boolean {
  return env(name).length > 0;
}

const encoder = new TextEncoder();

export function canonicalDiscordGalleryAuthorizationContextBytes(input: {
  guildId: string;
  galleryChannelId: string;
  requiredRoleMatch: string;
  requiredRoleIds: readonly string[];
}): Uint8Array | null {
  if (
    !isCanonicalAuthorizationSnowflake(input.guildId) ||
    !isCanonicalAuthorizationSnowflake(input.galleryChannelId) ||
    input.requiredRoleMatch !== DISCORD_GALLERY_REQUIRED_ROLE_MATCH
  ) return null;
  const roleIds = canonicalAuthorizationRoleIds(input.requiredRoleIds);
  if (!roleIds) return null;

  return encoder.encode([
    `version\0${DISCORD_GALLERY_AUTHORIZATION_CONTEXT_VERSION}\n`,
    `guild\0${input.guildId}\n`,
    `gallery-channel\0${input.galleryChannelId}\n`,
    `required-role-count\0${roleIds.length}\n`,
    `required-role-match\0${DISCORD_GALLERY_REQUIRED_ROLE_MATCH}\n`,
    ...roleIds.map((roleId) => `required-role\0${roleId}\n`),
  ].join(""));
}

export async function createDiscordGalleryAuthorizationContext(input: {
  guildId: string;
  galleryChannelId: string;
  requiredRoleMatch: string;
  requiredRoleIds: readonly string[];
}): Promise<DiscordGalleryAuthorizationContext | null> {
  const canonicalBytes = canonicalDiscordGalleryAuthorizationContextBytes(
    input,
  );
  if (!canonicalBytes) return null;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(canonicalBytes)),
  );
  return Object.freeze({
    authorizationContextVersion: DISCORD_GALLERY_AUTHORIZATION_CONTEXT_VERSION,
    authorizationContextSha256: Array.from(
      digest,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join(""),
  });
}

export function configuredDiscordGalleryAuthorizationContext(): Promise<
  DiscordGalleryAuthorizationContext | null
> {
  return createDiscordGalleryAuthorizationContext({
    guildId: authorizationSnowflake("DISCORD_GUILD_ID"),
    galleryChannelId: authorizationSnowflake("DISCORD_GALLERY_CHANNEL_ID"),
    requiredRoleMatch: DISCORD_GALLERY_REQUIRED_ROLE_MATCH,
    requiredRoleIds: DISCORD_REQUIRED_ROLE_IDS,
  });
}

function strongSharedSecret(name: string): boolean {
  const value = Deno.env.get(name) || "";
  const byteLength = encoder.encode(value).byteLength;
  return byteLength >= MIN_SHARED_SECRET_BYTES &&
    byteLength <= MAX_SHARED_SECRET_BYTES && /^[\x21-\x7e]+$/u.test(value);
}

function validSnowflake(name: string): boolean {
  return snowflake(name).length > 0;
}

function validSnowflakes(name: string): boolean {
  return snowflakes(name).length > 0;
}

function validAuthorizationSnowflakes(name: string): boolean {
  return authorizationSnowflakes(name).length ===
    DISCORD_GALLERY_AUTHORIZATION_REQUIRED_ROLE_COUNT;
}

function validAuthorizationSnowflake(name: string): boolean {
  return Boolean(authorizationSnowflake(name));
}

function commonSupabaseReady(): boolean {
  return Boolean(supabaseOrigin()) &&
    (present("SUPABASE_SECRET_KEYS") || present("SUPABASE_SERVICE_ROLE_KEY"));
}

function discordApiReady(): boolean {
  return Boolean(DISCORD_API_ORIGIN);
}

function galleryIngestHmacReady(): boolean {
  const keys = parseDiscordGalleryIngestHmacKeys(
    Deno.env.get(DISCORD_GALLERY_INGEST_HMAC_KEYS_ENV),
  );
  return Boolean(
    keys &&
      discordGalleryIngestActiveKey(
        keys,
        Deno.env.get(DISCORD_GALLERY_INGEST_ACTIVE_KEY_ID_ENV),
      ),
  );
}

export function runtimeProfileReady(profile: ReaperRuntimeProfile): boolean {
  if (!SITE_ORIGIN || !discordApiReady()) return false;

  if (profile === "reaper-discord-interactions") {
    return commonSupabaseReady() &&
      validAuthorizationSnowflake("DISCORD_GUILD_ID") &&
      validSnowflake("DISCORD_APPLICATION_ID") &&
      validAuthorizationSnowflake("DISCORD_GALLERY_CHANNEL_ID") &&
      validSnowflake("DISCORD_VOTE_CHANNEL_ID") &&
      validSnowflake("DISCORD_PHOTO_DAY_CHANNEL_ID") &&
      validAuthorizationSnowflakes("DISCORD_REQUIRED_ROLE_IDS") &&
      validSnowflakes("DISCORD_MODERATOR_ROLE_IDS") &&
      validSnowflake("DISCORD_PENDING_BASE_ROLE_ID") &&
      validSnowflake("DISCORD_VERIFIED_ROLE_ID") &&
      validSnowflakes("DISCORD_PENDING_ALLOWED_CHANNEL_IDS") &&
      validSnowflake("DISCORD_MODMAIL_BOT_USER_ID") &&
      validSnowflake("DISCORD_MODMAIL_LOG_CHANNEL_ID") &&
      validSnowflake("DISCORD_MODMAIL_MODERATOR_ROLE_ID") &&
      Boolean(DISCORD_WEB_ORIGIN) &&
      HEX_PUBLIC_KEY_PATTERN.test(env("DISCORD_PUBLIC_KEY")) &&
      present("DISCORD_BOT_TOKEN") &&
      galleryIngestHmacReady();
  }

  if (profile === "reaper-discord-member-sync") {
    return commonSupabaseReady() &&
      validSnowflake("DISCORD_GUILD_ID") &&
      validSnowflake("DISCORD_PENDING_BASE_ROLE_ID") &&
      validSnowflake("DISCORD_VERIFIED_ROLE_ID") &&
      validSnowflakes("DISCORD_PENDING_ALLOWED_CHANNEL_IDS") &&
      validSnowflakes("DISCORD_MODERATOR_ROLE_IDS") &&
      present("DISCORD_BOT_TOKEN") &&
      strongSharedSecret("REAPER_PENDING_VERIFICATION_SYNC_SECRET");
  }

  if (profile === "reaper-spinner-dispatch") {
    return commonSupabaseReady() &&
      validSnowflake("DISCORD_RAFFLE_CHANNEL_ID") &&
      present("DISCORD_BOT_TOKEN") &&
      strongSharedSecret("REAPER_SPINNER_DISPATCH_SECRET");
  }

  if (profile === "send-vote-reminder") {
    return commonSupabaseReady() &&
      validSnowflake("DISCORD_GUILD_ID") &&
      validSnowflake("DISCORD_VOTE_CHANNEL_ID") &&
      present("DISCORD_BOT_TOKEN") &&
      present("DISCORD_VOTE_LINKS_JSON") &&
      strongSharedSecret("VOTE_REMINDER_CRON_SECRET") &&
      present("VOTE_REMINDER_TIME_ZONE");
  }

  if (
    profile === "send-member-spotlight-poll" ||
    profile === "publish-member-spotlight-winner"
  ) {
    return commonSupabaseReady() &&
      validSnowflake("DISCORD_GUILD_ID") &&
      validSnowflake("DISCORD_SPOTLIGHT_POLL_CHANNEL_ID") &&
      present("DISCORD_BOT_TOKEN") &&
      strongSharedSecret("SPOTLIGHT_POLL_CRON_SECRET");
  }

  return false;
}

export function unavailableResponse(): Response {
  return new Response(null, {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Content-Length": "0",
    },
  });
}
