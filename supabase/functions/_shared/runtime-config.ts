import {
  MAX_SHARED_SECRET_BYTES,
  MIN_SHARED_SECRET_BYTES,
} from "./secret-auth.ts";

export type ReaperRuntimeProfile =
  | "reaper-discord-interactions"
  | "reaper-discord-member-sync"
  | "reaper-spinner-dispatch"
  | "send-vote-reminder"
  | "send-member-spotlight-poll"
  | "publish-member-spotlight-winner";

const SNOWFLAKE_PATTERN = /^\d{16,22}$/u;
const HEX_PUBLIC_KEY_PATTERN = /^[0-9a-f]{64}$/iu;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

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
export const DISCORD_REQUIRED_ROLE_IDS = snowflakes(
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

export function siteUrl(pathname: string): string {
  if (!SITE_ORIGIN) return "";
  const normalized = pathname.replace(/^\/+/, "");
  return new URL(normalized, `${SITE_ORIGIN}/`).toString();
}

function present(name: string): boolean {
  return env(name).length > 0;
}

const encoder = new TextEncoder();

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

function commonSupabaseReady(): boolean {
  return serviceUrl("SUPABASE_URL").length > 0 &&
    (present("SUPABASE_SECRET_KEYS") || present("SUPABASE_SERVICE_ROLE_KEY"));
}

export function runtimeProfileReady(profile: ReaperRuntimeProfile): boolean {
  if (!SITE_ORIGIN) return false;

  if (profile === "reaper-discord-interactions") {
    return commonSupabaseReady() &&
      validSnowflake("DISCORD_GUILD_ID") &&
      validSnowflake("DISCORD_APPLICATION_ID") &&
      validSnowflake("DISCORD_GALLERY_CHANNEL_ID") &&
      validSnowflake("DISCORD_VOTE_CHANNEL_ID") &&
      validSnowflake("DISCORD_PHOTO_DAY_CHANNEL_ID") &&
      validSnowflakes("DISCORD_REQUIRED_ROLE_IDS") &&
      validSnowflakes("DISCORD_MODERATOR_ROLE_IDS") &&
      validSnowflake("DISCORD_PENDING_BASE_ROLE_ID") &&
      validSnowflake("DISCORD_VERIFIED_ROLE_ID") &&
      validSnowflakes("DISCORD_PENDING_ALLOWED_CHANNEL_IDS") &&
      validSnowflake("DISCORD_MODMAIL_BOT_USER_ID") &&
      validSnowflake("DISCORD_MODMAIL_LOG_CHANNEL_ID") &&
      validSnowflake("DISCORD_MODMAIL_MODERATOR_ROLE_ID") &&
      HEX_PUBLIC_KEY_PATTERN.test(env("DISCORD_PUBLIC_KEY")) &&
      present("DISCORD_BOT_TOKEN") &&
      strongSharedSecret("DISCORD_GALLERY_INGEST_SECRET");
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
