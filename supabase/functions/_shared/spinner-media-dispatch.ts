import type { DiscordFetchResult, JsonRecord } from "./discord-api.ts";
import {
  createSpinnerMediaToken,
  SPINNER_MEDIA_CAPABILITY_LEASE_MS,
  spinnerMediaFilename,
  spinnerMediaTokenHash,
  type SpinnerMediaTokenPayloadV1,
  validateSpinnerMedia,
} from "./spinner-media.ts";
import { DISCORD_RAFFLE_CHANNEL_ID as SPINNER_DISCORD_CHANNEL_ID } from "./runtime-config.ts";

export type SpinnerMediaJobRow = {
  id: string;
  draw_id: string;
  outbox_id: string;
  status: string;
  animation_manifest: JsonRecord;
  manifest_hash_sha256: string;
  reveal_after: string;
  fallback_after: string;
  capability_token_hash_sha256: string | null;
  capability_expires_at: string | null;
  attachment_attempt_count: number;
  media_filename: string | null;
};

export async function createJobCapability(
  job: Pick<SpinnerMediaJobRow, "id" | "manifest_hash_sha256">,
  secret: string,
  now = new Date(),
): Promise<{ token: string; tokenHashSha256: string; expiresAt: string }> {
  const expiresAt = new Date(now.getTime() + SPINNER_MEDIA_CAPABILITY_LEASE_MS);
  const payload: SpinnerMediaTokenPayloadV1 = {
    version: 1,
    jobId: job.id,
    manifestHashSha256: job.manifest_hash_sha256,
    expiresAt: expiresAt.getTime(),
  };
  const token = await createSpinnerMediaToken(payload, secret);
  return {
    token,
    tokenHashSha256: await spinnerMediaTokenHash(token),
    expiresAt: expiresAt.toISOString(),
  };
}

export function recreateJobCapability(
  job: Pick<
    SpinnerMediaJobRow,
    "id" | "manifest_hash_sha256" | "capability_expires_at"
  >,
  secret: string,
): Promise<string | null> {
  const expiresAt = Date.parse(job.capability_expires_at || "");
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) {
    return Promise.resolve(null);
  }
  return createSpinnerMediaToken({
    version: 1,
    jobId: job.id,
    manifestHashSha256: job.manifest_hash_sha256,
    expiresAt,
  }, secret);
}

export type SpinnerMediaAttachmentDependencies = {
  reserve: (fields: {
    claimToken: string;
    mediaType: string;
    sizeBytes: number;
    mediaSha256: string;
    filename: string;
  }) => Promise<JsonRecord | null>;
  finish: (
    claimToken: string,
    outcome: "attached" | "retry" | "fatal",
    fields?: { attachmentId?: string; errorCode?: string; retryAt?: string },
  ) => Promise<boolean>;
  discordFetch: (
    path: string,
    options: { method: string; body?: BodyInit | JsonRecord },
  ) => Promise<DiscordFetchResult>;
  now?: () => Date;
  uuid?: () => string;
};

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function attachments(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function retryable(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

function discordRetryDelayMs(
  response: DiscordFetchResult | null,
): number | null {
  if (response?.status !== 429) return null;
  const error = asRecord(response.error);
  const retrySeconds = [
    response.headers.get("retry-after"),
    error.retry_after,
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!retrySeconds.length) return null;
  return Math.min(
    15 * 60_000,
    Math.max(1_000, Math.ceil(Math.max(...retrySeconds) * 1_000)),
  );
}

function retryAt(
  now: Date,
  attempt: number,
  response: DiscordFetchResult | null,
): string {
  const delay = discordRetryDelayMs(response) ?? Math.min(
    5 * 60_000,
    5_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 6),
  );
  return new Date(now.getTime() + delay).toISOString();
}

export async function attachSpinnerMedia(
  job: Pick<SpinnerMediaJobRow, "draw_id" | "attachment_attempt_count">,
  mediaType: string,
  bytes: Uint8Array,
  dependencies: SpinnerMediaAttachmentDependencies,
): Promise<{ ok: boolean; outcome: string }> {
  const validation = validateSpinnerMedia(mediaType, bytes);
  if (!validation.ok) return { ok: false, outcome: validation.reason };

  const mediaBuffer = new Uint8Array(bytes).buffer;
  const mediaSha256 = await crypto.subtle.digest("SHA-256", mediaBuffer).then((
    digest,
  ) =>
    Array.from(
      new Uint8Array(digest),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("")
  );
  const filename = spinnerMediaFilename(job.draw_id, validation.extension);
  const claimToken = (dependencies.uuid || (() => crypto.randomUUID()))();
  const reservation = await dependencies.reserve({
    claimToken,
    mediaType: validation.mediaType,
    sizeBytes: bytes.byteLength,
    mediaSha256,
    filename,
  });
  if (!reservation?.ok) return { ok: false, outcome: "not_ready" };
  if (reservation.alreadyAttached === true) {
    return { ok: true, outcome: "already_attached" };
  }

  const channelId = String(reservation.channelId || "");
  const messageId = String(reservation.messageId || "");
  if (
    channelId !== SPINNER_DISCORD_CHANNEL_ID || !/^\d{16,22}$/u.test(messageId)
  ) {
    await dependencies.finish(claimToken, "fatal", {
      errorCode: "message_not_allowed",
    });
    return { ok: false, outcome: "fatal" };
  }

  let existing: DiscordFetchResult | null = null;
  try {
    existing = await dependencies.discordFetch(
      `/channels/${channelId}/messages/${messageId}`,
      { method: "GET" },
    );
  } catch {
    existing = null;
  }
  if (!existing?.ok) {
    const status = existing?.status || 0;
    const outcome = retryable(status) ? "retry" : "fatal";
    await dependencies.finish(claimToken, outcome, {
      errorCode: status ? `message_lookup_${status}` : "message_lookup_network",
      ...(outcome === "retry"
        ? {
          retryAt: retryAt(
            dependencies.now?.() || new Date(),
            job.attachment_attempt_count + 1,
            existing,
          ),
        }
        : {}),
    });
    return { ok: false, outcome };
  }

  const currentAttachments = attachments(asRecord(existing.data).attachments);
  const matching = currentAttachments.find((entry) =>
    entry.filename === filename
  );
  if (matching) {
    const attachmentId = String(matching.id || "");
    if (!/^\d{16,22}$/u.test(attachmentId)) {
      await dependencies.finish(claimToken, "retry", {
        errorCode: "attachment_reconcile_invalid_id",
        retryAt: retryAt(
          dependencies.now?.() || new Date(),
          job.attachment_attempt_count + 1,
          existing,
        ),
      });
      return { ok: false, outcome: "retry" };
    }
    const finished = await dependencies.finish(claimToken, "attached", {
      attachmentId,
    });
    return { ok: finished, outcome: finished ? "reconciled" : "claim_lost" };
  }

  const retained = currentAttachments
    .filter((entry) =>
      /^\d{16,22}$/u.test(String(entry.id || "")) &&
      typeof entry.filename === "string"
    )
    .map((entry) => ({
      id: String(entry.id),
      filename: String(entry.filename),
    }));
  const form = new FormData();
  form.set(
    "payload_json",
    JSON.stringify({
      allowed_mentions: {
        parse: [],
        users: [],
        roles: [],
        replied_user: false,
      },
      attachments: [
        ...retained,
        { id: 0, filename, description: "Mōchirīī raffle replay" },
      ],
    }),
  );
  form.set(
    "files[0]",
    new Blob([mediaBuffer], { type: validation.mediaType }),
    filename,
  );

  let response: DiscordFetchResult | null = null;
  try {
    response = await dependencies.discordFetch(
      `/channels/${channelId}/messages/${messageId}`,
      { method: "PATCH", body: form },
    );
  } catch {
    response = null;
  }
  if (response?.ok) {
    const uploaded = attachments(asRecord(response.data).attachments)
      .find((entry) => entry.filename === filename);
    const attachmentId = String(uploaded?.id || "");
    if (!/^\d{16,22}$/u.test(attachmentId)) {
      await dependencies.finish(claimToken, "retry", {
        errorCode: "media_upload_missing_id",
        retryAt: retryAt(
          dependencies.now?.() || new Date(),
          job.attachment_attempt_count + 1,
          response,
        ),
      });
      return { ok: false, outcome: "retry" };
    }
    const finished = await dependencies.finish(claimToken, "attached", {
      attachmentId,
    });
    return { ok: finished, outcome: finished ? "attached" : "claim_lost" };
  }

  const status = response?.status || 0;
  const outcome = retryable(status) ? "retry" : "fatal";
  await dependencies.finish(claimToken, outcome, {
    errorCode: status ? `media_upload_${status}` : "media_upload_network",
    ...(outcome === "retry"
      ? {
        retryAt: retryAt(
          dependencies.now?.() || new Date(),
          job.attachment_attempt_count + 1,
          response,
        ),
      }
      : {}),
  });
  return { ok: false, outcome };
}
