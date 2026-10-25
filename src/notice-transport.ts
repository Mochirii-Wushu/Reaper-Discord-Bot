import { canonicalDiscordIdentifier } from "./gallery-ingest-auth.js";
import { readNoticeJsonResponse, type NoticeFetch } from "./community-notices.js";

// A separate one-shot transport avoids the SDK's automatic POST retries.
export function createNoticeSender(options: {
  apiOrigin: string;
  botToken: string;
  botUserId: () => string | undefined;
  fetch?: NoticeFetch;
}) {
  const origin = new URL(options.apiOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.apiOrigin || origin.username || origin.password || origin.port) {
    throw new Error("Community notice API origin is invalid.");
  }
  const request = options.fetch ?? fetch;
  return async (channelId: string, content: string, nonce: string): Promise<{ id: string; channelId: string }> => {
    const botId = canonicalDiscordIdentifier(options.botUserId());
    if (!canonicalDiscordIdentifier(channelId) || !botId || !content || content.length > 2000 ||
      !/^[0-9a-f]{25}$/u.test(nonce)) throw new Error("Community notice dispatch is invalid.");
    const signal = AbortSignal.timeout(5000);
    const response = await request(`${origin.origin}/api/v10/channels/${channelId}/messages`, {
      method: "POST", redirect: "error", signal,
      headers: { authorization: `Bot ${options.botToken}`, "content-type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] }, nonce, enforce_nonce: true }),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error("Community notice dispatch needs reconciliation.");
    }
    const value = await readNoticeJsonResponse(response, 16_384, signal) as {
      id?: unknown; channel_id?: unknown; content?: unknown; nonce?: unknown;
      author?: { id?: unknown; bot?: unknown };
    };
    if (!value || !canonicalDiscordIdentifier(value.id) || value.channel_id !== channelId ||
      value.author?.id !== botId || value.author.bot !== true || value.content !== content || value.nonce !== nonce) {
      throw new Error("Community notice acknowledgement needs reconciliation.");
    }
    return { id: value.id as string, channelId };
  };
}
