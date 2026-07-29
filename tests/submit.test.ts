import { describe, expect, test } from "bun:test";
import type { GalleryConfig } from "../src/config.js";
import { ReaperError } from "../src/errors.js";
import { buildDiscordGalleryPayload, formatSubmitResponse, type SubmitInput } from "../src/submit.js";
import { SYNTHETIC_DISCORD_IDS, syntheticDiscordAttachmentUrl } from "./discord-fixtures.js";

const config: Pick<GalleryConfig, "discordGuildId" | "discordGalleryChannelId"> = {
  discordGuildId: SYNTHETIC_DISCORD_IDS.guild,
  discordGalleryChannelId: SYNTHETIC_DISCORD_IDS.galleryChannel,
};

function input(overrides: Partial<SubmitInput> = {}): SubmitInput {
  return {
    guildId: SYNTHETIC_DISCORD_IDS.guild,
    channelId: SYNTHETIC_DISCORD_IDS.galleryChannel,
    messageId: SYNTHETIC_DISCORD_IDS.message,
    discordUserId: SYNTHETIC_DISCORD_IDS.member,
    image: {
      id: SYNTHETIC_DISCORD_IDS.attachment,
      url: syntheticDiscordAttachmentUrl(),
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
    expect(() =>
      buildDiscordGalleryPayload(input({ channelId: SYNTHETIC_DISCORD_IDS.otherChannel }), config),
    ).toThrow(ReaperError);
  });

  test("uses the public Mōchirīī brand for wrong-guild guidance", () => {
    expect(() =>
      buildDiscordGalleryPayload(input({ guildId: SYNTHETIC_DISCORD_IDS.otherGuild }), config),
    ).toThrow("Gallery submissions are only available inside the Mōchirīī Discord server.");
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
