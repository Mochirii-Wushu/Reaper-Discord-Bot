export type JsonRecord = Record<string, unknown>;

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
const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

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
): Promise<void> {
  const endpoint =
    `${DISCORD_API_BASE_URL}/webhooks/${applicationId}/${interactionToken}/messages/@original`;
  const response = await fetch(endpoint, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    console.error("reaper-discord-interactions original response edit failed", {
      status: response.status,
      statusText: response.statusText,
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
  const id = safeString(value, 24);
  return id && /^\d{16,22}$/.test(id) ? id : null;
}

export function normalizedMime(value: unknown): string | null {
  const mime = safeString(value, 80)?.split(";")[0]?.trim().toLowerCase() ||
    null;
  if (mime === "image/jpg") return "image/jpeg";
  return mime && ALLOWED_IMAGE_MIME_TYPES.has(mime) ? mime : null;
}

export function allowedImageFilename(value: unknown): boolean {
  const filename = safeString(value, 255)?.toLowerCase() || "";
  return /\.(jpe?g|png|webp)$/i.test(filename);
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
    id: attachmentId,
    ...asRecord(attachments[attachmentId]),
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
