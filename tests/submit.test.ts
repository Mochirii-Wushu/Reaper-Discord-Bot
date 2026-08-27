import { describe, expect, test } from "bun:test";
import type { GalleryConfig, ReaperConfig } from "../src/config.js";
import { ReaperError } from "../src/errors.js";
import { createDiscordGalleryAuthorizationContext } from "../src/gallery-ingest-auth.js";
import {
  buildDiscordGalleryPayload,
  createGalleryGatewayInteractionHandler,
  formatSubmitResponse,
  handleSubmitCommand,
  submitReplyOptions,
  type SubmitInput,
} from "../src/submit.js";
import { SYNTHETIC_DISCORD_IDS, syntheticDiscordAttachmentUrl } from "./discord-fixtures.js";

const authorizationContext = createDiscordGalleryAuthorizationContext({
  guildId: SYNTHETIC_DISCORD_IDS.guild,
  galleryChannelId: SYNTHETIC_DISCORD_IDS.galleryChannel,
  requiredRoleIds: [SYNTHETIC_DISCORD_IDS.roleOne, SYNTHETIC_DISCORD_IDS.roleTwo],
});
if (!authorizationContext) throw new Error("Synthetic Gallery authorization context was rejected.");
const config: Pick<
  GalleryConfig,
  | "discordGuildId"
  | "discordGalleryChannelId"
  | "discordGalleryAttachmentOrigins"
  | "discordGalleryAuthorizationContext"
> = {
  discordGuildId: SYNTHETIC_DISCORD_IDS.guild,
  discordGalleryChannelId: SYNTHETIC_DISCORD_IDS.galleryChannel,
  discordGalleryAttachmentOrigins: ["https://cdn.discordapp.com"],
  discordGalleryAuthorizationContext: authorizationContext,
};
const galleryConfig: GalleryConfig = {
  discordBotToken: "synthetic-token",
  discordGuildId: SYNTHETIC_DISCORD_IDS.guild,
  galleryGatewayRollbackEnabled: true,
  welcomeDmEnabled: false,
  pendingVerificationSyncEnabled: false,
  pendingVerificationSyncUrl: "",
  pendingVerificationSyncSecret: "",
  pendingVerificationSyncTimeoutMs: 5_000,
  pendingVerificationSyncMaxAttempts: 2,
  discordApplicationId: SYNTHETIC_DISCORD_IDS.otherGuild,
  discordGalleryChannelId: SYNTHETIC_DISCORD_IDS.galleryChannel,
  discordGalleryAttachmentOrigins: ["https://cdn.discordapp.com"],
  supabaseFunctionsUrl: "https://functions.synthetic.test/functions/v1",
  discordGalleryIngestHmacKeys: {
    primary: "0123456789abcdef0123456789abcdef",
  },
  discordGalleryIngestHmacActiveKeyId: "primary",
  discordGalleryRequiredRoleIds: [
    SYNTHETIC_DISCORD_IDS.roleOne,
    SYNTHETIC_DISCORD_IDS.roleTwo,
  ],
  discordGalleryAuthorizationContext: authorizationContext,
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

    expect(Object.keys(payload)).toEqual([
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
    ]);
    expect(payload.caption).toBe("A quiet gallery submission.");
    expect(payload.instagramOptIn).toBe(false);
    expect(payload.authorizationContextVersion).toBe(
      "discord-gallery-authorization-context.v1",
    );
    expect(payload.authorizationContextSha256).toBe(
      authorizationContext.authorizationContextSha256,
    );
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

  test("rejects every malformed signed field without coercion", () => {
    const valid = input();
    const invalid: SubmitInput[] = [
      { ...valid, messageId: `0${SYNTHETIC_DISCORD_IDS.message}` },
      { ...valid, discordUserId: "1844674407" + "3709551616" },
      { ...valid, title: " Lantern Moment" },
      { ...valid, subtitle: `caption\uFEFF` },
      { ...valid, image: { ...valid.image, id: "invalid" } },
      {
        ...valid,
        image: {
          ...valid.image,
          url:
            `https://outside.synthetic.test/attachments/${SYNTHETIC_DISCORD_IDS.galleryChannel}/${SYNTHETIC_DISCORD_IDS.attachment}/image.jpg`,
        },
      },
      {
        ...valid,
        image: {
          ...valid.image,
          url:
            `https://cdn.discordapp.com/attachments/${SYNTHETIC_DISCORD_IDS.otherChannel}/${SYNTHETIC_DISCORD_IDS.attachment}/image.jpg`,
        },
      },
      { ...valid, image: { ...valid.image, contentType: "image/svg+xml" } },
      { ...valid, image: { ...valid.image, contentType: "image/jpeg; charset=utf-8" } },
      { ...valid, image: { ...valid.image, size: 0 } },
      { ...valid, image: { ...valid.image, size: 8 * 1024 * 1024 + 1 } },
      { ...valid, image: { ...valid.image, name: "image.png" } },
      { ...valid, image: { ...valid.image, name: " image.jpg" } },
    ];
    for (const candidate of invalid) {
      expect(() => buildDiscordGalleryPayload(candidate, config)).toThrow(
        "Attach a contract-valid JPEG, PNG, or WebP image",
      );
    }
  });
});

describe("formatSubmitResponse", () => {
  test("reports duplicate submissions without changing consent", () => {
    const text = formatSubmitResponse(
      {
        ok: true,
        duplicate: true,
        data: { submissionId: null, status: "pending", createdAt: null },
        message: "That Discord image is already in the moderation queue.",
      },
      true,
    );

    expect(text).toContain("already in the moderation queue");
    expect(text).toContain("Instagram sharing is enabled");
  });

  test("builds explicit mention-free Discord reply options", () => {
    const content = `Hello <@everyone> <@${SYNTHETIC_DISCORD_IDS.member}>`;
    expect(submitReplyOptions(content)).toEqual({
      content,
      allowedMentions: { parse: [] },
    });
  });

  test("keeps mention-bearing receiver messages inert in /submit edits", async () => {
    const edits: unknown[] = [];
    const interaction = {
      deferred: true,
      replied: false,
      guildId: SYNTHETIC_DISCORD_IDS.guild,
      channelId: SYNTHETIC_DISCORD_IDS.galleryChannel,
      id: SYNTHETIC_DISCORD_IDS.message,
      user: { id: SYNTHETIC_DISCORD_IDS.member },
      options: {
        getAttachment: () => ({
          id: SYNTHETIC_DISCORD_IDS.attachment,
          url: syntheticDiscordAttachmentUrl(),
          contentType: "image/jpeg",
          size: 12_345,
          name: "image.jpg",
        }),
        getString: (name: string) => name === "title"
          ? "Lantern Moment"
          : "A quiet gallery submission.",
        getBoolean: () => false,
      },
      deferReply: () => Promise.resolve(),
      editReply: (options: unknown) => {
        edits.push(options);
        return Promise.resolve();
      },
    } as unknown as Parameters<typeof handleSubmitCommand>[0];

    await handleSubmitCommand(
      interaction,
      galleryConfig,
      () => Promise.resolve({
        ok: false,
        error: "invalid_request",
        message: `Review <@everyone> and <@${SYNTHETIC_DISCORD_IDS.member}>.`,
      }),
    );

    expect(edits).toEqual([{
      content: `Review <@everyone> and <@${SYNTHETIC_DISCORD_IDS.member}>.`,
      allowedMentions: { parse: [] },
    }]);
  });
});

describe("Gallery Gateway rollback gate", () => {
  function interaction(replies: unknown[]) {
    return {
      isChatInputCommand: () => true,
      commandName: "submit",
      deferred: false,
      replied: false,
      reply: (options: unknown) => {
        replies.push(options);
        return Promise.resolve();
      },
      editReply: () => Promise.resolve(),
    } as unknown as Parameters<
      ReturnType<typeof createGalleryGatewayInteractionHandler>
    >[0];
  }

  test("disabled state replies safely without loading or handling Gallery config", async () => {
    const replies: unknown[] = [];
    let loadCalls = 0;
    let handlerCalls = 0;
    const runtimeConfig: ReaperConfig = {
      ...galleryConfig,
      galleryGatewayRollbackEnabled: false,
    };
    const handler = createGalleryGatewayInteractionHandler(runtimeConfig, {
      loadGalleryConfig: () => {
        loadCalls += 1;
        return galleryConfig;
      },
      handleSubmitCommand: async () => {
        handlerCalls += 1;
      },
      logger: { error: () => undefined },
    });

    await handler(interaction(replies));

    expect(loadCalls).toBe(0);
    expect(handlerCalls).toBe(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      allowedMentions: { parse: [] },
    });
  });

  test("enabled state loads one exact Gallery config and invokes one handler", async () => {
    const replies: unknown[] = [];
    let loadCalls = 0;
    let handlerCalls = 0;
    const handler = createGalleryGatewayInteractionHandler(galleryConfig, {
      loadGalleryConfig: () => {
        loadCalls += 1;
        return galleryConfig;
      },
      handleSubmitCommand: async () => {
        handlerCalls += 1;
      },
      logger: { error: () => undefined },
    });

    await handler(interaction(replies));

    expect(loadCalls).toBe(1);
    expect(handlerCalls).toBe(1);
    expect(replies).toEqual([]);
  });
});
