import type { GalleryConfig } from "./config.js";
import {
  createDiscordGalleryIngestHeaders,
  discordGalleryIngestEndpoint,
  DISCORD_GALLERY_INGEST_MAX_RESPONSE_BYTES,
  DISCORD_GALLERY_INGEST_REQUEST_TIMEOUT_MS,
} from "./gallery-ingest-auth.js";

export interface DiscordGalleryPayload {
  guildId: string;
  channelId: string;
  messageId: string;
  attachmentId: string;
  discordUserId: string;
  attachmentUrl: string;
  mimeType: string;
  sizeBytes: number;
  title: string;
  caption: string;
  instagramOptIn: boolean;
  originalFilename: string;
}

export type SupabaseIngestResponse =
  | {
    ok: true;
    duplicate: boolean;
    data: {
      submissionId: string | null;
      status: string | null;
      createdAt: string | null;
    };
    message: string;
  }
  | {
    ok: false;
    error: string;
    message: string;
    missingRoleIds?: string[];
  };

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const DISCORD_GALLERY_INGEST_MESSAGE_MAX_CHARACTERS = 300;
export const DISCORD_GALLERY_INGEST_ERROR_MAX_CHARACTERS = 80;
export const DISCORD_GALLERY_INGEST_MAX_MISSING_ROLE_IDS = 2;
export const DISCORD_GALLERY_INGEST_MISSING_ROLE_ID_PATTERN = "^[0-9]{17,20}$";
const DISCORD_SNOWFLAKE_RE = /^[0-9]{17,20}$/;
export const DISCORD_GALLERY_INGEST_ERROR_CODES = [
  "attachment_fetch_failed",
  "attachment_too_large",
  "discord_account_not_linked",
  "discord_gallery_ingest_not_configured",
  "discord_gallery_not_eligible",
  "duplicate_lookup_failed",
  "invalid_attachment_content",
  "invalid_discord_submission",
  "invalid_json",
  "invalid_request",
  "invalid_request_body",
  "profile_lookup_failed",
  "replayed_request",
  "request_too_large",
  "source_validation_commit_failed",
  "storage_upload_failed",
  "submission_insert_failed",
  "verification_unavailable",
] as const;
const DISCORD_GALLERY_INGEST_ERROR_CODE_SET = new Set<string>(
  DISCORD_GALLERY_INGEST_ERROR_CODES,
);
const ELIGIBILITY_ERROR_CODES = new Set([
  "discord_account_not_linked",
  "discord_gallery_not_eligible",
]);

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function boundedString(value: unknown, maximumCharacters: number): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumCharacters &&
    value === value.trim();
}

function boundedNullableString(
  value: unknown,
  maximumCharacters: number,
): value is string | null {
  return value === null || boundedString(value, maximumCharacters);
}

function validMissingRoleIds(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length <= DISCORD_GALLERY_INGEST_MAX_MISSING_ROLE_IDS &&
    value.every((roleId) =>
      typeof roleId === "string" && DISCORD_SNOWFLAKE_RE.test(roleId)
    ) &&
    new Set(value).size === value.length;
}

function validatedIngestResponse(value: unknown): SupabaseIngestResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!boundedString(
    record.message,
    DISCORD_GALLERY_INGEST_MESSAGE_MAX_CHARACTERS,
  )) return null;

  if (record.ok === true) {
    if (!exactKeys(record, ["data", "duplicate", "message", "ok"])) return null;
    if (typeof record.duplicate !== "boolean") return null;
    if (!record.data || typeof record.data !== "object" || Array.isArray(record.data)) {
      return null;
    }
    const data = record.data as Record<string, unknown>;
    if (!exactKeys(data, ["createdAt", "status", "submissionId"])) return null;
    if (
      !boundedNullableString(data.submissionId, 80) ||
      !boundedNullableString(data.status, 40) ||
      !boundedNullableString(data.createdAt, 80)
    ) return null;
    return record as unknown as SupabaseIngestResponse;
  }

  if (record.ok !== false) return null;
  if (!boundedString(
    record.error,
    DISCORD_GALLERY_INGEST_ERROR_MAX_CHARACTERS,
  ) || !DISCORD_GALLERY_INGEST_ERROR_CODE_SET.has(record.error)) return null;

  const eligibilityError = ELIGIBILITY_ERROR_CODES.has(record.error);
  if (eligibilityError) {
    if (!exactKeys(record, ["error", "message", "missingRoleIds", "ok"])) {
      return null;
    }
    if (!validMissingRoleIds(record.missingRoleIds)) return null;
  } else if (!exactKeys(record, ["error", "message", "ok"])) {
    return null;
  }
  return record as unknown as SupabaseIngestResponse;
}

function invalidIngestResponse(status: number): SupabaseIngestResponse {
  return {
    ok: false,
    error: "invalid_supabase_response",
    message: `Gallery submission returned HTTP ${status}.`,
  };
}

function abortError(): Error {
  return new DOMException("Gallery ingest response read aborted.", "AbortError");
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
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readBoundedResponseText(
  response: Response,
  signal: AbortSignal,
): Promise<string | null> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    const bytes = Number(declaredLength);
    if (
      !Number.isSafeInteger(bytes) ||
      bytes > DISCORD_GALLERY_INGEST_MAX_RESPONSE_BYTES
    ) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await readChunkWithAbort(reader, signal);
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > DISCORD_GALLERY_INGEST_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch {
    void reader.cancel().catch(() => undefined);
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Best-effort cleanup after a cancelled or aborted response body.
    }
  }
}

export async function submitDiscordGalleryImage(
  config: Pick<
    GalleryConfig,
    | "supabaseFunctionsUrl"
    | "discordGalleryIngestHmacKeys"
    | "discordGalleryIngestHmacActiveKeyId"
  >,
  payload: DiscordGalleryPayload,
  fetchImpl: FetchLike = fetch,
  requestInput: { nowMs?: number; nonce?: string; signal?: AbortSignal } = {},
): Promise<SupabaseIngestResponse> {
  const rawBody = JSON.stringify(payload);
  const requestSignal = requestInput.signal ||
    AbortSignal.timeout(DISCORD_GALLERY_INGEST_REQUEST_TIMEOUT_MS);
  const authHeaders = createDiscordGalleryIngestHeaders({
    keys: config.discordGalleryIngestHmacKeys,
    activeKeyId: config.discordGalleryIngestHmacActiveKeyId,
    rawBody,
    nowMs: requestInput.nowMs,
    nonce: requestInput.nonce,
  });
  const response = await fetchImpl(discordGalleryIngestEndpoint(config.supabaseFunctionsUrl), {
    method: "POST",
    redirect: "error",
    signal: requestSignal,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...authHeaders,
    },
    body: rawBody,
  });

  const mediaType = (response.headers.get("content-type") || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    await response.body?.cancel().catch(() => undefined);
    return invalidIngestResponse(response.status);
  }

  const text = await readBoundedResponseText(response, requestSignal);
  let body: SupabaseIngestResponse | null;

  try {
    body = validatedIngestResponse(text ? JSON.parse(text) as unknown : null);
  } catch {
    body = null;
  }

  if (!body || response.ok !== body.ok) {
    return invalidIngestResponse(response.status);
  }

  return body;
}
