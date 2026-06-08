import { describe, expect, test } from "bun:test";
import { submitDiscordGalleryImage, type DiscordGalleryPayload } from "../src/supabase.js";

const payload: DiscordGalleryPayload = {
  guildId: "1078630751077142608",
  channelId: "1508077313965817856",
  messageId: "1508077313965817857",
  attachmentId: "1508077313965817858",
  discordUserId: "1508077313965817859",
  attachmentUrl: "https://cdn.discordapp.com/attachments/1508077313965817856/1508077313965817858/image.jpg",
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
        supabaseFunctionsUrl: "https://deyvmtncimmcinldjyqe.supabase.co/functions/v1",
        discordGalleryIngestSecret: "local-test-secret",
      },
      payload,
      fetchImpl,
    );

    expect(response.ok).toBe(true);
    const request = requests[0];
    expect(request?.url).toBe("https://deyvmtncimmcinldjyqe.supabase.co/functions/v1/submit-discord-gallery-image");
    expect(request?.headers.get("x-mochirii-reaper-secret")).toBe("local-test-secret");
    expect(await request?.json()).toEqual(payload);
  });
});
