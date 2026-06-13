import type { ReaperConfig } from "./config.js";

export type PendingVerificationEventType = "guildMemberAdd" | "guildMemberUpdate";
export type PendingVerificationSyncResult =
  | "posted"
  | "disabled"
  | "ignored_guild"
  | "ignored_bot"
  | "post_failed";

export type PendingVerificationMemberLike = {
  guild: {
    id: string;
  };
  user: {
    id: string;
    bot?: boolean;
  };
  roles: {
    cache: {
      keys(): IterableIterator<string>;
    };
  };
};

export type PendingVerificationLogger = Pick<Console, "log" | "warn">;
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type WaitLike = (delayMs: number) => Promise<void>;

const SYNC_RETRY_BASE_DELAY_MS = 250;
const SYNC_RETRY_MAX_DELAY_MS = 5000;
const SYNC_RESPONSE_BODY_MAX_CHARS = 16_384;
const SAFE_SYNC_STATUSES = new Set(["applied", "ok", "preview"]);

const wait: WaitLike = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

function redactedSnowflake(value: string): string {
  return value.length > 4 ? `...${value.slice(-4)}` : "[redacted]";
}

export function memberRoleIds(member: PendingVerificationMemberLike): string[] {
  return [...member.roles.cache.keys()].sort();
}

export function memberRolesChanged(
  before: PendingVerificationMemberLike,
  after: PendingVerificationMemberLike,
): boolean {
  const beforeRoles = memberRoleIds(before);
  const afterRoles = memberRoleIds(after);
  if (beforeRoles.length !== afterRoles.length) return true;
  return beforeRoles.some((roleId, index) => roleId !== afterRoles[index]);
}

function retryBackoffMs(attempt: number): number {
  return Math.min(SYNC_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1)), SYNC_RETRY_MAX_DELAY_MS);
}

function retryAfterMs(response: Response): number | null {
  const value = String(response.headers.get("Retry-After") || "").trim();
  if (!value) return null;

  if (/^\d+$/.test(value)) return Number(value) * 1000;

  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, date - Date.now());
}

function retryDecision(response: Response, attempt: number):
  | { retry: true; delayMs: number }
  | { retry: false; reason: "non_retryable_status" | "retry_after_exceeds_budget" } {
  if (response.status !== 408 && response.status !== 429 && response.status < 500) {
    return { retry: false, reason: "non_retryable_status" };
  }

  const requestedDelayMs = retryAfterMs(response);
  if (requestedDelayMs !== null) {
    if (requestedDelayMs > SYNC_RETRY_MAX_DELAY_MS) {
      return { retry: false, reason: "retry_after_exceeds_budget" };
    }
    return { retry: true, delayMs: requestedDelayMs };
  }

  return { retry: true, delayMs: retryBackoffMs(attempt) };
}

function safeCount(value: unknown): number {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 && count <= 10_000 ? count : 0;
}

function safeStatus(value: unknown): string {
  const status = String(value || "ok").trim();
  return SAFE_SYNC_STATUSES.has(status) ? status : "unknown";
}

async function responseSummary(response: Response): Promise<{
  status: string;
  discordWriteCount: number;
  registryWriteCount: number;
  conflictCount: number;
}> {
  const text = await response.text();
  if (!text || text.length > SYNC_RESPONSE_BODY_MAX_CHARS) {
    return { status: "ok", discordWriteCount: 0, registryWriteCount: 0, conflictCount: 0 };
  }

  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { status: "ok", discordWriteCount: 0, registryWriteCount: 0, conflictCount: 0 };
    }
    const record = body as Record<string, unknown>;
    return {
      status: safeStatus(record.status),
      discordWriteCount: safeCount(record.discordWriteCount),
      registryWriteCount: safeCount(record.registryWriteCount),
      conflictCount: safeCount(record.conflictCount),
    };
  } catch {
    return { status: "ok", discordWriteCount: 0, registryWriteCount: 0, conflictCount: 0 };
  }
}

export async function syncPendingVerificationMember(
  member: PendingVerificationMemberLike,
  eventType: PendingVerificationEventType,
  config: ReaperConfig,
  logger: PendingVerificationLogger = console,
  fetchImpl: FetchLike = fetch,
  gatewaySequence: number | null = null,
  waitImpl: WaitLike = wait,
): Promise<PendingVerificationSyncResult> {
  if (!config.pendingVerificationSyncEnabled) return "disabled";
  if (member.guild.id !== config.discordGuildId) return "ignored_guild";
  if (member.user.bot) return "ignored_bot";

  const payload = {
    event_type: eventType,
    guild_id: member.guild.id,
    discord_user_id: member.user.id,
    roles: memberRoleIds(member),
    gateway_sequence: gatewaySequence,
    occurred_at: new Date().toISOString(),
  };
  const requestBody = JSON.stringify(payload);

  for (let attempt = 1; attempt <= config.pendingVerificationSyncMaxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.pendingVerificationSyncTimeoutMs);
    try {
      const response = await fetchImpl(config.pendingVerificationSyncUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-mochirii-reaper-member-sync-secret": config.pendingVerificationSyncSecret,
        },
        body: requestBody,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (response.ok) {
        const summary = await responseSummary(response);
        logger.log("pending verification member sync posted", {
          guildId: redactedSnowflake(member.guild.id),
          userId: redactedSnowflake(member.user.id),
          eventType,
          attempts: attempt,
          ...summary,
        });
        return "posted";
      }

      const decision = retryDecision(response, attempt);
      if (!decision.retry || attempt >= config.pendingVerificationSyncMaxAttempts) {
        logger.warn("pending verification member sync failed", {
          guildId: redactedSnowflake(member.guild.id),
          userId: redactedSnowflake(member.user.id),
          eventType,
          status: response.status,
          attempt,
          maxAttempts: config.pendingVerificationSyncMaxAttempts,
          reason: decision.retry ? "attempt_budget_exhausted" : decision.reason,
        });
        return "post_failed";
      }
      logger.warn("pending verification member sync retrying", {
        guildId: redactedSnowflake(member.guild.id),
        userId: redactedSnowflake(member.user.id),
        eventType,
        status: response.status,
        attempt,
        maxAttempts: config.pendingVerificationSyncMaxAttempts,
        retryDelayMs: decision.delayMs,
      });
      await waitImpl(decision.delayMs);
    } catch (error) {
      clearTimeout(timeout);
      const errorName = error instanceof Error ? error.name : "UnknownError";
      if (attempt >= config.pendingVerificationSyncMaxAttempts) {
        logger.warn("pending verification member sync failed", {
          guildId: redactedSnowflake(member.guild.id),
          userId: redactedSnowflake(member.user.id),
          eventType,
          error: errorName,
          attempt,
          maxAttempts: config.pendingVerificationSyncMaxAttempts,
        });
        return "post_failed";
      }
      const retryDelayMs = retryBackoffMs(attempt);
      logger.warn("pending verification member sync retrying", {
        guildId: redactedSnowflake(member.guild.id),
        userId: redactedSnowflake(member.user.id),
        eventType,
        error: errorName,
        attempt,
        maxAttempts: config.pendingVerificationSyncMaxAttempts,
        retryDelayMs,
      });
      await waitImpl(retryDelayMs);
    } finally {
      clearTimeout(timeout);
    }
  }

  return "post_failed";
}
