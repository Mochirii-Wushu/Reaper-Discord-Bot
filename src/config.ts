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
  pendingVerificationSyncTimeoutMs: number;
  pendingVerificationSyncMaxAttempts: number;
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

function validatePendingVerificationSyncUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      "REAPER_PENDING_VERIFICATION_SYNC_URL must be an absolute HTTPS URL without embedded credentials.",
    );
  }

  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(
      "REAPER_PENDING_VERIFICATION_SYNC_URL must be an absolute HTTPS URL without embedded credentials.",
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ReaperConfig {
  const pendingVerificationSyncEnabled = optionalBoolean(env, "REAPER_PENDING_VERIFICATION_SYNC_ENABLED", false);
  const pendingVerificationSyncUrl = String(env.REAPER_PENDING_VERIFICATION_SYNC_URL || "").trim().replace(/\/+$/, "");
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
  if (pendingVerificationSyncEnabled) validatePendingVerificationSyncUrl(pendingVerificationSyncUrl);

  return {
    discordBotToken: requireEnv(env, "DISCORD_BOT_TOKEN"),
    discordGuildId: requireEnv(env, "DISCORD_GUILD_ID"),
    welcomeDmEnabled: optionalBoolean(env, "WELCOME_DM_ENABLED", true),
    pendingVerificationSyncEnabled,
    pendingVerificationSyncUrl,
    pendingVerificationSyncSecret,
    pendingVerificationSyncTimeoutMs,
    pendingVerificationSyncMaxAttempts,
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
