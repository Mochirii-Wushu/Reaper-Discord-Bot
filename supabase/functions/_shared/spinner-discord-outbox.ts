import type { DiscordFetchResult, JsonRecord } from "./discord-api.ts";
import { DISCORD_RAFFLE_CHANNEL_ID as SPINNER_DISCORD_CHANNEL_ID } from "./runtime-config.ts";
export { constantTimeSecretEqual } from "./secret-auth.ts";
import { SPINNER_DISCORD_CHANNEL_KEY } from "./spinner-consumer-contract.ts";
import { readBoundedUtf8RequestBody } from "./bounded-request-body.ts";
import { parseJsonObjectNoDuplicateKeys } from "./strict-json.ts";

export type SpinnerOutboxRow = {
  id: string;
  draw_id: string;
  channel_key: string;
  channel_id: string;
  phase: "start_pending" | "result_pending";
  start_payload: JsonRecord;
  result_payload: JsonRecord;
  discord_message_id: string | null;
  attempt_count: number;
};

export type FinishSpinnerOutboxClaim = (
  row: SpinnerOutboxRow,
  outcome: "start_sent" | "result_sent" | "retry" | "fatal",
  fields?: { messageId?: string; errorCode?: string; retryAt?: string },
) => Promise<boolean>;

export type SpinnerOutboxDependencies = {
  discordFetch: (
    path: string,
    options: { method: string; body: JsonRecord },
  ) => Promise<DiscordFetchResult>;
  finishClaim: FinishSpinnerOutboxClaim;
  now?: () => Date;
};

const SNOWFLAKE_PATTERN = /^\d{16,22}$/;
export const SPINNER_DISPATCH_MAX_BODY_BYTES = 1_024;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function snowflake(value: unknown): string {
  const candidate = String(value || "").trim();
  return SNOWFLAKE_PATTERN.test(candidate) ? candidate : "";
}

function safeAllowedMentions(payload: JsonRecord): boolean {
  const mentions = asRecord(payload.allowed_mentions);
  return Array.isArray(mentions.parse) && mentions.parse.length === 0 &&
    Array.isArray(mentions.users) && mentions.users.length === 0 &&
    Array.isArray(mentions.roles) && mentions.roles.length === 0 &&
    mentions.replied_user === false;
}

function retryDelayMs(
  response: DiscordFetchResult | null,
  attemptCount: number,
): number {
  const retryAfter = Number(response?.headers.get("retry-after") || "");
  if (
    response?.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
  ) {
    return Math.min(15 * 60_000, Math.ceil(retryAfter * 1_000));
  }
  return Math.min(
    5 * 60_000,
    5_000 * 2 ** Math.max(0, Math.min(attemptCount - 1, 6)),
  );
}

function retryable(response: DiscordFetchResult | null): boolean {
  return response === null || response.status === 429 || response.status >= 500;
}

export async function dispatchSpinnerOutboxRow(
  row: SpinnerOutboxRow,
  dependencies: SpinnerOutboxDependencies,
): Promise<{ ok: boolean; outcome: string }> {
  if (
    row.channel_key !== SPINNER_DISCORD_CHANNEL_KEY ||
    row.channel_id !== SPINNER_DISCORD_CHANNEL_ID ||
    !SNOWFLAKE_PATTERN.test(row.channel_id)
  ) {
    await dependencies.finishClaim(row, "fatal", {
      errorCode: "channel_not_allowed",
    });
    return { ok: false, outcome: "fatal" };
  }

  const payload = row.phase === "start_pending"
    ? asRecord(row.start_payload)
    : asRecord(row.result_payload);
  if (!safeAllowedMentions(payload)) {
    await dependencies.finishClaim(row, "fatal", {
      errorCode: "unsafe_mentions",
    });
    return { ok: false, outcome: "fatal" };
  }

  let response: DiscordFetchResult | null = null;
  try {
    if (row.phase === "start_pending") {
      if (
        payload.enforce_nonce !== true || typeof payload.nonce !== "string" ||
        payload.nonce.length < 1 || payload.nonce.length > 25
      ) {
        await dependencies.finishClaim(row, "fatal", {
          errorCode: "invalid_nonce",
        });
        return { ok: false, outcome: "fatal" };
      }
      response = await dependencies.discordFetch(
        `/channels/${row.channel_id}/messages`,
        {
          method: "POST",
          body: payload,
        },
      );
      const messageId = snowflake(asRecord(response.data).id);
      if (response.ok && messageId) {
        const finished = await dependencies.finishClaim(row, "start_sent", {
          messageId,
        });
        return {
          ok: finished,
          outcome: finished ? "start_sent" : "claim_lost",
        };
      }
    } else {
      const messageId = snowflake(row.discord_message_id);
      if (!messageId) {
        await dependencies.finishClaim(row, "fatal", {
          errorCode: "missing_message_id",
        });
        return { ok: false, outcome: "fatal" };
      }
      response = await dependencies.discordFetch(
        `/channels/${row.channel_id}/messages/${messageId}`,
        {
          method: "PATCH",
          body: payload,
        },
      );
      if (response.ok) {
        const finished = await dependencies.finishClaim(row, "result_sent", {
          messageId,
        });
        return {
          ok: finished,
          outcome: finished ? "result_sent" : "claim_lost",
        };
      }
    }
  } catch {
    response = null;
  }

  const statusCode = response?.status || 0;
  const errorCode = statusCode
    ? `discord_http_${statusCode}`
    : "discord_network_error";
  if (retryable(response)) {
    const now = dependencies.now ? dependencies.now() : new Date();
    const retryAt = new Date(
      now.getTime() + retryDelayMs(response, row.attempt_count),
    ).toISOString();
    const finished = await dependencies.finishClaim(row, "retry", {
      errorCode,
      retryAt,
    });
    return { ok: false, outcome: finished ? "retry" : "claim_lost" };
  }

  await dependencies.finishClaim(row, "fatal", { errorCode });
  return { ok: false, outcome: "fatal" };
}

export function spinnerDispatcherSecret(req: Request): string {
  const direct = req.headers.get("x-mochirii-reaper-spinner-secret")?.trim() ||
    "";
  if (direct) return direct;
  return (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "")
    .trim();
}

export async function readBoundedJsonObject(
  req: Request,
  maxBytes = SPINNER_DISPATCH_MAX_BODY_BYTES,
): Promise<{ ok: true; value: JsonRecord } | { ok: false; status: 400 | 413 }> {
  const body = await readBoundedUtf8RequestBody(req, maxBytes);
  if (!body.ok) return { ok: false, status: body.status };
  if (!body.text.trim()) return { ok: true, value: {} };

  try {
    const value = parseJsonObjectNoDuplicateKeys(body.text, {
      maximumBytes: maxBytes,
      maximumDepth: 16,
    });
    return { ok: true, value };
  } catch {
    return { ok: false, status: 400 };
  }
}
