import { describe, expect, test } from "bun:test";
import { submitDiscordGalleryImage, type DiscordGalleryPayload } from "../src/supabase.js";
import { SYNTHETIC_DISCORD_IDS, syntheticDiscordAttachmentUrl } from "./discord-fixtures.js";

const payload: DiscordGalleryPayload = {
  guildId: SYNTHETIC_DISCORD_IDS.guild,
  channelId: SYNTHETIC_DISCORD_IDS.galleryChannel,
  messageId: SYNTHETIC_DISCORD_IDS.message,
  attachmentId: SYNTHETIC_DISCORD_IDS.attachment,
  discordUserId: SYNTHETIC_DISCORD_IDS.member,
  attachmentUrl: syntheticDiscordAttachmentUrl(),
  mimeType: "image/jpeg",
  sizeBytes: 12345,
  title: "Lantern Moment",
  caption: "A quiet gallery submission.",
  instagramOptIn: true,
  originalFilename: "image.jpg",
};

describe("submitDiscordGalleryImage", () => {
  test("posts the existing Supabase ingest contract with the Reaper secret header", async () => {
    const requests: Request[] = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));

      return new Response(JSON.stringify({ ok: true, duplicate: false, message: "Queued." }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const response = await submitDiscordGalleryImage(
      {
        supabaseFunctionsUrl: "https://functions.example",
        discordGalleryIngestSecret: "local-test-secret",
      },
      payload,
      fetchImpl,
    );

    expect(response.ok).toBe(true);
    const request = requests[0];
    expect(request?.url).toBe("https://functions.example/submit-discord-gallery-image");
    expect(request?.headers.get("x-mochirii-reaper-secret")).toBe("local-test-secret");
    expect(await request?.json()).toEqual(payload);
  });
});
