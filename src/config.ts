import { config as loadDotenv } from "dotenv";

if (process.env.NODE_ENV !== "production") {
  loadDotenv({ path: process.env.DOTENV_CONFIG_PATH || ".env.local" });
}

export interface ReaperConfig {
  discordBotToken: string;
  discordGuildId: string;
  welcomeDmEnabled: boolean;
  pendingVerificationSyncEnabled: boolean;
  pendingVerificationSyncUrl: string;
  pendingVerificationSyncSecret: string;
}

export interface GalleryConfig extends ReaperConfig {
  discordApplicationId: string;
  discordGalleryChannelId: string;
  supabaseFunctionsUrl: string;
  discordGalleryIngestSecret: string;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ReaperConfig {
  const pendingVerificationSyncEnabled = optionalBoolean(env, "REAPER_PENDING_VERIFICATION_SYNC_ENABLED", false);
  const pendingVerificationSyncUrl = String(env.REAPER_PENDING_VERIFICATION_SYNC_URL || "").trim().replace(/\/+$/, "");
  const pendingVerificationSyncSecret = String(env.REAPER_PENDING_VERIFICATION_SYNC_SECRET || "").trim();

  if (pendingVerificationSyncEnabled && (!pendingVerificationSyncUrl || !pendingVerificationSyncSecret)) {
    throw new Error(
      "REAPER_PENDING_VERIFICATION_SYNC_URL and REAPER_PENDING_VERIFICATION_SYNC_SECRET are required when pending verification sync is enabled.",
    );
  }

  return {
    discordBotToken: requireEnv(env, "DISCORD_BOT_TOKEN"),
    discordGuildId: requireEnv(env, "DISCORD_GUILD_ID"),
    welcomeDmEnabled: optionalBoolean(env, "WELCOME_DM_ENABLED", true),
    pendingVerificationSyncEnabled,
    pendingVerificationSyncUrl,
    pendingVerificationSyncSecret,
  };
}

export function loadGalleryConfig(env: NodeJS.ProcessEnv = process.env): GalleryConfig {
  return {
    ...loadConfig(env),
    discordApplicationId: requireEnv(env, "DISCORD_APPLICATION_ID"),
    discordGalleryChannelId: requireEnv(env, "DISCORD_GALLERY_CHANNEL_ID"),
    supabaseFunctionsUrl: requireEnv(env, "SUPABASE_FUNCTIONS_URL").replace(/\/+$/, ""),
    discordGalleryIngestSecret: requireEnv(env, "DISCORD_GALLERY_INGEST_SECRET"),
  };
}
