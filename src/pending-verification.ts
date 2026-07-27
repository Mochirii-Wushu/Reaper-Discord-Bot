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
const SYNC_RESPONSE_BODY_MAX_BYTES = 16_384;
const SAFE_SYNC_STATUSES = new Set(["applied", "ok", "preview"]);

const wait: WaitLike = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

type SyncResponseSummary = {
  status: string;
  discordWriteCount: number;
  registryWriteCount: number;
  conflictCount: number;
};

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

function zeroSummary(status = "unknown"): SyncResponseSummary {
  return { status, discordWriteCount: 0, registryWriteCount: 0, conflictCount: 0 };
}

function abortError(): Error {
  const error = new Error("Pending-verification response handling timed out.");
  error.name = "AbortError";
  return error;
}

async function readChunkWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  if (signal.aborted) throw abortError();

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function boundedResponseText(response: Response, signal: AbortSignal): Promise<string | null> {
  const contentLength = String(response.headers.get("Content-Length") || "").trim();
  if (/^\d+$/.test(contentLength)) {
    const bytes = Number(contentLength);
    if (!Number.isSafeInteger(bytes) || bytes > SYNC_RESPONSE_BODY_MAX_BYTES) {
      void response.body?.cancel().catch(() => undefined);
      return null;
    }
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    while (true) {
      const chunk = await readChunkWithAbort(reader, signal);
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > SYNC_RESPONSE_BODY_MAX_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Best-effort cleanup after an aborted pending read.
    }
  }
}

async function responseSummary(response: Response, signal: AbortSignal): Promise<SyncResponseSummary> {
  const text = await boundedResponseText(response, signal);
  if (text === null) return zeroSummary();
  if (!text) {
    return zeroSummary("ok");
  }

  try {
    const body: unknown = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return zeroSummary();
    }
    const record = body as Record<string, unknown>;
    return {
      status: safeStatus(record.status),
      discordWriteCount: safeCount(record.discordWriteCount),
      registryWriteCount: safeCount(record.registryWriteCount),
      conflictCount: safeCount(record.conflictCount),
    };
  } catch {
    return zeroSummary();
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

      if (response.ok) {
        const summary = await responseSummary(response, controller.signal);
        clearTimeout(timeout);
        logger.log("pending verification member sync posted", {
          guildId: redactedSnowflake(member.guild.id),
          userId: redactedSnowflake(member.user.id),
          eventType,
          attempts: attempt,
          ...summary,
        });
        return "posted";
      }

      void response.body?.cancel().catch(() => undefined);
      clearTimeout(timeout);
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
