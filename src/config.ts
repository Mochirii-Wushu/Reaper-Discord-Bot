import { config as loadDotenv } from "dotenv";
import {
  canonicalDiscordGalleryRequiredRoleIds,
  canonicalDiscordIdentifier,
  createDiscordGalleryAuthorizationContext,
  discordGalleryIngestActiveKey,
  discordGalleryIngestEndpoint,
  parseDiscordGalleryAttachmentOrigins,
  parseDiscordGalleryIngestHmacKeys,
  type DiscordGalleryAuthorizationContext,
  type DiscordGalleryIngestHmacKeys,
} from "./gallery-ingest-auth.js";

if (process.env.NODE_ENV !== "production") {
  loadDotenv({ path: process.env.DOTENV_CONFIG_PATH || ".env.local" });
}

export interface ReaperConfig {
  discordBotToken: string;
  discordGuildId: string;
  galleryGatewayRollbackEnabled: boolean;
  welcomeDmEnabled: boolean;
  pendingVerificationSyncEnabled: boolean;
  pendingVerificationSyncUrl: string;
  pendingVerificationSyncSecret: string;
  pendingVerificationSyncTimeoutMs: number;
  pendingVerificationSyncMaxAttempts: number;
}

export interface GalleryConfig extends ReaperConfig {
  galleryGatewayRollbackEnabled: true;
  discordApplicationId: string;
  discordGalleryChannelId: string;
  discordGalleryAttachmentOrigins: readonly string[];
  supabaseFunctionsUrl: string;
  discordGalleryIngestHmacKeys: DiscordGalleryIngestHmacKeys;
  discordGalleryIngestHmacActiveKeyId: string;
  discordGalleryRequiredRoleIds: readonly string[];
  discordGalleryAuthorizationContext: DiscordGalleryAuthorizationContext;
}

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = String(env[key] || "").trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalBoolean(env: NodeJS.ProcessEnv, key: string, defaultValue: boolean): boolean {
  const value = String(env[key] || "").trim().toLowerCase();
  if (!value) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value);
}

function exactDefaultFalseBoolean(
  env: NodeJS.ProcessEnv,
  key: string,
): boolean {
  const value = env[key];
  if (value === undefined || value === "" || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${key} must be exactly true or false.`);
}

function optionalInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
  { min, max }: { min: number; max: number },
): number {
  const value = String(env[key] || "").trim();
  if (!value) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${key} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

export function pendingVerificationSyncEndpoint(value: string): string {
  const invalid = () => new Error(
    "REAPER_PENDING_VERIFICATION_SYNC_URL must be a canonical absolute HTTPS URL without embedded credentials, query, or fragment, ending in /functions/v1/reaper-discord-member-sync.",
  );
  if (!value || value !== value.trim() || value.length > 2048) throw invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }

  if (
    url.protocol !== "https:" || url.username || url.password || url.port ||
    url.search || url.hash || value.includes("?") || value.includes("#") ||
    url.pathname !== "/functions/v1/reaper-discord-member-sync" ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/u.test(url.hostname) ||
    url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local") ||
    value !== url.href
  ) throw invalid();
  return url.href;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ReaperConfig {
  const galleryGatewayRollbackEnabled = exactDefaultFalseBoolean(
    env,
    "REAPER_GALLERY_GATEWAY_ROLLBACK_ENABLED",
  );
  const pendingVerificationSyncEnabled = optionalBoolean(env, "REAPER_PENDING_VERIFICATION_SYNC_ENABLED", false);
  const pendingVerificationSyncUrl = String(env.REAPER_PENDING_VERIFICATION_SYNC_URL || "").trim();
  const pendingVerificationSyncSecret = String(env.REAPER_PENDING_VERIFICATION_SYNC_SECRET || "").trim();
  const pendingVerificationSyncTimeoutMs = optionalInteger(
    env,
    "REAPER_PENDING_VERIFICATION_SYNC_TIMEOUT_MS",
    5000,
    { min: 500, max: 15000 },
  );
  const pendingVerificationSyncMaxAttempts = optionalInteger(
    env,
    "REAPER_PENDING_VERIFICATION_SYNC_MAX_ATTEMPTS",
    2,
    { min: 1, max: 3 },
  );

  if (pendingVerificationSyncEnabled && (!pendingVerificationSyncUrl || !pendingVerificationSyncSecret)) {
    throw new Error(
      "REAPER_PENDING_VERIFICATION_SYNC_URL and REAPER_PENDING_VERIFICATION_SYNC_SECRET are required when pending verification sync is enabled.",
    );
  }
  if (pendingVerificationSyncEnabled) pendingVerificationSyncEndpoint(pendingVerificationSyncUrl);

  return {
    discordBotToken: requireEnv(env, "DISCORD_BOT_TOKEN"),
    discordGuildId: requireEnv(env, "DISCORD_GUILD_ID"),
    galleryGatewayRollbackEnabled,
    welcomeDmEnabled: optionalBoolean(env, "WELCOME_DM_ENABLED", true),
    pendingVerificationSyncEnabled,
    pendingVerificationSyncUrl,
    pendingVerificationSyncSecret,
    pendingVerificationSyncTimeoutMs,
    pendingVerificationSyncMaxAttempts,
  };
}

export function loadGalleryConfig(env: NodeJS.ProcessEnv = process.env): GalleryConfig {
  const reaperConfig = loadConfig(env);
  if (!reaperConfig.galleryGatewayRollbackEnabled) {
    throw new Error("Reaper Gallery Gateway rollback is disabled.");
  }
  const discordGuildId = canonicalDiscordIdentifier(env.DISCORD_GUILD_ID);
  const discordApplicationId = canonicalDiscordIdentifier(
    env.DISCORD_APPLICATION_ID,
  );
  const discordGalleryChannelId = canonicalDiscordIdentifier(
    env.DISCORD_GALLERY_CHANNEL_ID,
  );
  const discordGalleryAttachmentOrigins = parseDiscordGalleryAttachmentOrigins(
    env.DISCORD_GALLERY_ATTACHMENT_ORIGINS,
  );
  const discordGalleryRequiredRoleIds =
    canonicalDiscordGalleryRequiredRoleIds(env.DISCORD_REQUIRED_ROLE_IDS);
  const discordGalleryAuthorizationContext =
    discordGuildId && discordGalleryChannelId && discordGalleryRequiredRoleIds
      ? createDiscordGalleryAuthorizationContext({
        guildId: discordGuildId,
        galleryChannelId: discordGalleryChannelId,
        requiredRoleIds: discordGalleryRequiredRoleIds,
      })
      : null;
  if (
    !discordGuildId || !discordApplicationId || !discordGalleryChannelId ||
    !discordGalleryAttachmentOrigins || !discordGalleryRequiredRoleIds ||
    !discordGalleryAuthorizationContext
  ) {
    throw new Error("Discord Gallery authorization configuration is invalid.");
  }
  const supabaseFunctionsUrl = requireEnv(env, "SUPABASE_FUNCTIONS_URL")
    .replace(/\/+$/u, "");
  discordGalleryIngestEndpoint(supabaseFunctionsUrl);
  const discordGalleryIngestHmacKeys = parseDiscordGalleryIngestHmacKeys(
    requireEnv(env, "DISCORD_GALLERY_INGEST_HMAC_KEYS_JSON"),
  );
  const discordGalleryIngestHmacActiveKeyId = requireEnv(
    env,
    "DISCORD_GALLERY_INGEST_HMAC_ACTIVE_KEY_ID",
  );
  if (
    !discordGalleryIngestHmacKeys ||
    !discordGalleryIngestActiveKey(
      discordGalleryIngestHmacKeys,
      discordGalleryIngestHmacActiveKeyId,
    )
  ) throw new Error("Discord Gallery ingest HMAC configuration is invalid.");

  return {
    ...reaperConfig,
    galleryGatewayRollbackEnabled: true,
    discordGuildId,
    discordApplicationId,
    discordGalleryChannelId,
    discordGalleryAttachmentOrigins,
    supabaseFunctionsUrl,
    discordGalleryIngestHmacKeys,
    discordGalleryIngestHmacActiveKeyId,
    discordGalleryRequiredRoleIds,
    discordGalleryAuthorizationContext,
  };
}
