import type { GalleryConfig } from "./config.js";

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

export interface SupabaseIngestResponse {
  ok: boolean;
  duplicate?: boolean;
  data?: {
    submissionId?: string | null;
    status?: string | null;
    createdAt?: string | null;
  };
  error?: string;
  message?: string;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function submitDiscordGalleryImage(
  config: Pick<GalleryConfig, "supabaseFunctionsUrl" | "discordGalleryIngestSecret">,
  payload: DiscordGalleryPayload,
  fetchImpl: FetchLike = fetch,
): Promise<SupabaseIngestResponse> {
  const response = await fetchImpl(`${config.supabaseFunctionsUrl}/submit-discord-gallery-image`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-mochirii-reaper-secret": config.discordGalleryIngestSecret,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let body: SupabaseIngestResponse | null = null;

  try {
    body = text ? JSON.parse(text) as SupabaseIngestResponse : null;
  } catch {
    body = null;
  }

  if (!body) {
    return {
      ok: false,
      error: "invalid_supabase_response",
      message: `Gallery submission returned HTTP ${response.status}.`,
    };
  }

  return body;
}
