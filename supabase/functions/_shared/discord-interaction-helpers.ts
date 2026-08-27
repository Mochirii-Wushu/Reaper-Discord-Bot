import { buildDiscordApiUrl } from "./discord-api.ts";
import { fetchWithTimeout, readBoundedResponseBytes } from "./outbound-http.ts";

export type JsonRecord = Record<string, unknown>;

export const DISCORD_GALLERY_SUBMISSION_PAYLOAD_KEYS = [
  "guildId",
  "channelId",
  "messageId",
  "attachmentId",
  "discordUserId",
  "attachmentUrl",
  "mimeType",
  "sizeBytes",
  "originalFilename",
  "title",
  "caption",
  "instagramOptIn",
  "authorizationContextVersion",
  "authorizationContextSha256",
] as const;

export type DiscordGallerySubmissionPayload = {
  guildId: string;
  channelId: string;
  messageId: string;
  attachmentId: string;
  discordUserId: string;
  attachmentUrl: string;
  mimeType: string;
  sizeBytes: number;
  originalFilename: string;
  title: string | null;
  caption: string | null;
  instagramOptIn: boolean;
  authorizationContextVersion: string;
  authorizationContextSha256: string;
};

export function discordGallerySubmissionPayload(
  input: DiscordGallerySubmissionPayload,
): JsonRecord {
  return {
    guildId: input.guildId,
    channelId: input.channelId,
    messageId: input.messageId,
    attachmentId: input.attachmentId,
    discordUserId: input.discordUserId,
    attachmentUrl: input.attachmentUrl,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    originalFilename: input.originalFilename,
    title: input.title,
    caption: input.caption,
    instagramOptIn: input.instagramOptIn,
    authorizationContextVersion: input.authorizationContextVersion,
    authorizationContextSha256: input.authorizationContextSha256,
  };
}

const EPHEMERAL_FLAG = 1 << 6;
const INTERACTION_RESPONSE_CHANNEL_MESSAGE = 4;
const INTERACTION_RESPONSE_DEFERRED_CHANNEL_MESSAGE = 5;
const INTERACTION_RESPONSE_DEFERRED_MESSAGE_UPDATE = 6;
const INTERACTION_RESPONSE_UPDATE_MESSAGE = 7;
const INTERACTION_RESPONSE_MODAL = 9;
const OPTION_TYPE_STRING = 3;
const OPTION_TYPE_BOOLEAN = 5;
const OPTION_TYPE_ATTACHMENT = 11;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const DISCORD_GALLERY_ATTACHMENT_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
  "media.discordapp.com",
]);
const DISCORD_GALLERY_ATTACHMENT_PATH =
  /^\/(?:ephemeral-)?attachments\/([^/]+)\/([^/]+)\/[^/]+$/u;
const CANONICAL_SNOWFLAKE_PATTERN = /^[1-9][0-9]{15,19}$/u;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const FORBIDDEN_ZERO_WIDTH_NO_BREAK_SPACE = "\uFEFF";
export const DISCORD_GALLERY_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
const DISCORD_INTERACTION_EDIT_TIMEOUT_MS = 10_000;
const DISCORD_INTERACTION_EDIT_MAX_RESPONSE_BYTES = 64 * 1024;

export function jsonResponse(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

export function interactionMessage(content: string): Response {
  return jsonResponse(
    {
      type: INTERACTION_RESPONSE_CHANNEL_MESSAGE,
      data: {
        content,
        flags: EPHEMERAL_FLAG,
        allowed_mentions: {
          parse: [],
        },
      },
    },
  );
}

export function deferredEphemeralResponse(): Response {
  return jsonResponse({
    type: INTERACTION_RESPONSE_DEFERRED_CHANNEL_MESSAGE,
    data: {
      flags: EPHEMERAL_FLAG,
    },
  });
}

export function deferredMessageUpdateResponse(): Response {
  return jsonResponse({
    type: INTERACTION_RESPONSE_DEFERRED_MESSAGE_UPDATE,
  });
}

export function updateMessageResponse(data: JsonRecord): Response {
  return jsonResponse({
    type: INTERACTION_RESPONSE_UPDATE_MESSAGE,
    data,
  });
}

export function modalResponse(data: JsonRecord): Response {
  return jsonResponse({
    type: INTERACTION_RESPONSE_MODAL,
    data,
  });
}

export async function editOriginalInteractionResponse(
  applicationId: string,
  interactionToken: string,
  content: string,
): Promise<void> {
  await editOriginalInteractionPayload(applicationId, interactionToken, {
    content,
    allowed_mentions: {
      parse: [],
    },
  });
}

export async function editOriginalInteractionPayload(
  applicationId: string,
  interactionToken: string,
  payload: JsonRecord,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const endpoint = buildDiscordApiUrl(
    `/webhooks/${encodeURIComponent(applicationId)}/${
      encodeURIComponent(interactionToken)
    }/messages/@original`,
  );
  let response: Response;
  try {
    response = await fetchWithTimeout(
      endpoint,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      },
      {
        fetcher: fetchImpl,
        timeoutMs: DISCORD_INTERACTION_EDIT_TIMEOUT_MS,
      },
    );
    await readBoundedResponseBytes(
      response,
      DISCORD_INTERACTION_EDIT_MAX_RESPONSE_BYTES,
    );
  } catch {
    throw new Error("Discord interaction response transport failed.");
  }

  if (!response.ok) {
    console.error("reaper-discord-interactions original response edit failed", {
      status: response.status,
    });
  }
}

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : [];
}

export function safeString(value: unknown, maxLength: number): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

export function parseCsv(value: string | null | undefined): string[] {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function snowflake(value: unknown): string | null {
  if (typeof value !== "string" || !CANONICAL_SNOWFLAKE_PATTERN.test(value)) {
    return null;
  }
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_UINT64 &&
        parsed.toString(10) === value
      ? value
      : null;
  } catch {
    return null;
  }
}

export function exactBoundedString(
  value: unknown,
  maximumLength: number,
): string | null {
  return typeof value === "string" && value.length > 0 &&
      value.length <= maximumLength && value === value.trim() &&
      !value.includes(FORBIDDEN_ZERO_WIDTH_NO_BREAK_SPACE)
    ? value
    : null;
}

export function canonicalDiscordGalleryAttachmentUrl(
  value: unknown,
  expectedChannelId: string,
  expectedAttachmentId: string,
): string | null {
  const text = exactBoundedString(value, 4096);
  if (!text) return null;
  try {
    const url = new URL(text);
    const path = DISCORD_GALLERY_ATTACHMENT_PATH.exec(url.pathname);
    if (
      url.protocol !== "https:" ||
      !DISCORD_GALLERY_ATTACHMENT_HOSTS.has(url.hostname) ||
      !path || snowflake(path[1]) !== expectedChannelId ||
      snowflake(path[2]) !== expectedAttachmentId ||
      url.username || url.password || url.hash || url.port ||
      url.toString() !== text
    ) return null;
    return text;
  } catch {
    return null;
  }
}

export function normalizedMime(value: unknown): string | null {
  const mime = safeString(value, 80)?.split(";")[0]?.trim().toLowerCase() ||
    null;
  if (mime === "image/jpg") return "image/jpeg";
  return mime && ALLOWED_IMAGE_MIME_TYPES.has(mime) ? mime : null;
}

export function canonicalDeclaredImageMime(value: unknown): string | null {
  return typeof value === "string" && value.length <= 80 &&
      ALLOWED_IMAGE_MIME_TYPES.has(value)
    ? value
    : null;
}

export function canonicalGalleryAttachmentSize(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) &&
      value > 0 &&
      value <= DISCORD_GALLERY_ATTACHMENT_MAX_BYTES
    ? value
    : null;
}

export function allowedImageFilename(value: unknown): boolean {
  const filename = safeString(value, 255)?.toLowerCase() || "";
  return /\.(jpe?g|png|webp)$/i.test(filename);
}

export function imageFilenameMatchesMime(
  filenameValue: unknown,
  mimeValue: unknown,
): boolean {
  const filename = exactBoundedString(filenameValue, 255)?.toLowerCase() || "";
  const mime = canonicalDeclaredImageMime(mimeValue);
  if (!filename || !mime) return false;
  if (mime === "image/jpeg") return /\.jpe?g$/u.test(filename);
  if (mime === "image/png") return /\.png$/u.test(filename);
  return mime === "image/webp" && /\.webp$/u.test(filename);
}

export function exactOptionalStringOption(
  data: JsonRecord,
  name: string,
  maximumLength: number,
): { ok: true; value: string | null } | { ok: false; value: null } {
  const option = optionByName(data, name);
  if (Object.keys(option).length === 0) return { ok: true, value: null };
  if (option.type !== OPTION_TYPE_STRING) return { ok: false, value: null };
  const value = exactBoundedString(option.value, maximumLength);
  return value === null ? { ok: false, value: null } : { ok: true, value };
}

export function exactOptionalBooleanOption(
  data: JsonRecord,
  name: string,
): { ok: true; value: boolean } | { ok: false; value: false } {
  const option = optionByName(data, name);
  if (Object.keys(option).length === 0) return { ok: true, value: false };
  return option.type === OPTION_TYPE_BOOLEAN &&
      typeof option.value === "boolean"
    ? { ok: true, value: option.value }
    : { ok: false, value: false };
}

export function optionByName(data: JsonRecord, name: string): JsonRecord {
  return asRecord(
    asArray(data.options).find((option) =>
      safeString(asRecord(option).name, 80) === name
    ),
  );
}

export function stringOption(
  data: JsonRecord,
  name: string,
  maxLength: number,
): string | null {
  const option = optionByName(data, name);
  if (option.type !== OPTION_TYPE_STRING) return null;
  return safeString(option.value, maxLength);
}

export function booleanOption(data: JsonRecord, name: string): boolean {
  const option = optionByName(data, name);
  return option.type === OPTION_TYPE_BOOLEAN && option.value === true;
}

export function attachmentOption(data: JsonRecord, name: string): JsonRecord {
  const option = optionByName(data, name);
  if (option.type !== OPTION_TYPE_ATTACHMENT) return {};

  const attachmentId = snowflake(option.value);
  if (!attachmentId) return {};

  const resolved = asRecord(data.resolved);
  const attachments = asRecord(resolved.attachments);
  return {
    ...asRecord(attachments[attachmentId]),
    id: attachmentId,
  };
}

export function safeDiscordResponseMessage(
  body: JsonRecord,
  fallback: string,
): string {
  return safeString(body.message, 220) || fallback;
}

export function successMessage(
  instagramOptIn: boolean,
  duplicate: boolean,
): string {
  const status = duplicate
    ? "That image is already in the moderation queue."
    : "Image submitted to the moderation queue.";
  const instagram = instagramOptIn
    ? " Instagram sharing is enabled for moderator review after gallery approval."
    : " Instagram sharing is not enabled for this submission.";
  return `${status}${instagram}`;
}
