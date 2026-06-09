import { describe, expect, test } from "bun:test";
import type { GalleryConfig } from "../src/config.js";
import { ReaperError } from "../src/errors.js";
import { buildDiscordGalleryPayload, formatSubmitResponse, type SubmitInput } from "../src/submit.js";

const config: Pick<GalleryConfig, "discordGuildId" | "discordGalleryChannelId"> = {
  discordGuildId: "1078630751077142608",
  discordGalleryChannelId: "1508077313965817856",
};

function input(overrides: Partial<SubmitInput> = {}): SubmitInput {
  return {
    guildId: "1078630751077142608",
    channelId: "1508077313965817856",
    messageId: "1508077313965817857",
    discordUserId: "1508077313965817858",
    image: {
      id: "1508077313965817859",
      url: "https://cdn.discordapp.com/attachments/1508077313965817856/1508077313965817859/image.jpg",
      contentType: "image/jpeg",
      size: 12345,
      name: "image.jpg",
    },
    title: "Lantern Moment",
    subtitle: "A quiet gallery submission.",
    ...overrides,
  };
}

describe("buildDiscordGalleryPayload", () => {
  test("defaults omitted Instagram opt-in to false", () => {
    const payload = buildDiscordGalleryPayload(input(), config);

    expect(payload.caption).toBe("A quiet gallery submission.");
    expect(payload.instagramOptIn).toBe(false);
  });

  test("maps explicit false Instagram opt-in to false", () => {
    const payload = buildDiscordGalleryPayload(input({ shareToInstagram: false }), config);

    expect(payload.instagramOptIn).toBe(false);
  });

  test("maps explicit true Instagram opt-in to true", () => {
    const payload = buildDiscordGalleryPayload(input({ shareToInstagram: true }), config);

    expect(payload.instagramOptIn).toBe(true);
  });

  test("rejects the wrong gallery channel before Supabase ingest", () => {
    expect(() => buildDiscordGalleryPayload(input({ channelId: "1508077313965817000" }), config)).toThrow(ReaperError);
  });
});

describe("formatSubmitResponse", () => {
  test("reports duplicate submissions without changing consent", () => {
    const text = formatSubmitResponse(
      {
        ok: true,
        duplicate: true,
        message: "That Discord image is already in the moderation queue.",
      },
      true,
    );

    expect(text).toContain("already in the moderation queue");
    expect(text).toContain("Instagram sharing is enabled");
  });
});
