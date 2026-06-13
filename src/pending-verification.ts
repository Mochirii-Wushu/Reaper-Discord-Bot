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

export async function syncPendingVerificationMember(
  member: PendingVerificationMemberLike,
  eventType: PendingVerificationEventType,
  config: ReaperConfig,
  logger: PendingVerificationLogger = console,
  fetchImpl: FetchLike = fetch,
  gatewaySequence: number | null = null,
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

  let response: Response | null = null;
  let body: unknown = null;
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= config.pendingVerificationSyncMaxAttempts; attempt += 1) {
    attemptsUsed = attempt;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.pendingVerificationSyncTimeoutMs);
    try {
      response = await fetchImpl(config.pendingVerificationSyncUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-mochirii-reaper-member-sync-secret": config.pendingVerificationSyncSecret,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const text = await response.text();
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }

      if (response.ok) break;
      if (!shouldRetrySyncResponse(response.status) || attempt >= config.pendingVerificationSyncMaxAttempts) {
        logger.warn("pending verification member sync failed", {
          guildId: redactedSnowflake(member.guild.id),
          userId: redactedSnowflake(member.user.id),
          eventType,
          status: response.status,
          attempt,
          maxAttempts: config.pendingVerificationSyncMaxAttempts,
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
      });
    } catch (error) {
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
      logger.warn("pending verification member sync retrying", {
        guildId: redactedSnowflake(member.guild.id),
        userId: redactedSnowflake(member.user.id),
        eventType,
        error: errorName,
        attempt,
        maxAttempts: config.pendingVerificationSyncMaxAttempts,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  if (!response?.ok) return "post_failed";

  const summary = body && typeof body === "object" && !Array.isArray(body)
    ? {
      status: String((body as { status?: unknown }).status || "ok"),
      discordWriteCount: Number((body as { discordWriteCount?: unknown }).discordWriteCount || 0),
      registryWriteCount: Number((body as { registryWriteCount?: unknown }).registryWriteCount || 0),
      conflictCount: Number((body as { conflictCount?: unknown }).conflictCount || 0),
    }
    : { status: "ok", discordWriteCount: 0, registryWriteCount: 0, conflictCount: 0 };

  logger.log("pending verification member sync posted", {
    guildId: redactedSnowflake(member.guild.id),
    userId: redactedSnowflake(member.user.id),
    eventType,
    attempts: attemptsUsed,
    ...summary,
  });
  return "posted";
}

function shouldRetrySyncResponse(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}
