import type {
  Attachment,
  ChatInputCommandInteraction,
  Interaction,
} from "discord.js";
import { MessageFlags } from "discord.js";
import {
  type GalleryConfig,
  loadGalleryConfig,
  type ReaperConfig,
} from "./config.js";
import { ReaperError } from "./errors.js";
import {
  submitDiscordGalleryImage,
  type DiscordGalleryPayload,
  type SupabaseIngestResponse,
  validateDiscordGalleryPayload,
} from "./supabase.js";

export interface SubmitInput {
  guildId: string | null;
  channelId: string;
  messageId: string;
  discordUserId: string;
  image: Pick<Attachment, "id" | "url" | "contentType" | "size" | "name">;
  title: string;
  subtitle: string;
  shareToInstagram?: boolean | null;
}

export function submitReplyOptions(content: string): {
  content: string;
  allowedMentions: { parse: [] };
} {
  return { content, allowedMentions: { parse: [] } };
}

export function buildDiscordGalleryPayload(
  input: SubmitInput,
  config: Pick<
    GalleryConfig,
    | "discordGuildId"
    | "discordGalleryChannelId"
    | "discordGalleryAttachmentOrigins"
    | "discordGalleryAuthorizationContext"
  >,
): DiscordGalleryPayload {
  if (input.guildId !== config.discordGuildId) {
    throw new ReaperError("wrong_guild", "Gallery submissions are only available inside the Mōchirīī Discord server.");
  }

  if (input.channelId !== config.discordGalleryChannelId) {
    throw new ReaperError("wrong_channel", "Use the gallery submissions channel for /submit.");
  }

  const payload = {
    guildId: input.guildId,
    channelId: input.channelId,
    messageId: input.messageId,
    attachmentId: input.image.id,
    discordUserId: input.discordUserId,
    attachmentUrl: input.image.url,
    mimeType: input.image.contentType,
    sizeBytes: input.image.size,
    originalFilename: input.image.name,
    title: input.title,
    caption: input.subtitle,
    instagramOptIn: input.shareToInstagram === true,
  };
  const validated = validateDiscordGalleryPayload({
    ...payload,
    authorizationContextVersion:
      config.discordGalleryAuthorizationContext.authorizationContextVersion,
    authorizationContextSha256:
      config.discordGalleryAuthorizationContext.authorizationContextSha256,
  }, config);
  if (!validated) {
    throw new ReaperError(
      "invalid_gallery_payload",
      "Attach a contract-valid JPEG, PNG, or WebP image for the gallery submission.",
    );
  }
  return validated;
}

export function formatSubmitResponse(response: SupabaseIngestResponse, instagramOptIn: boolean): string {
  if (!response.ok) {
    return response.message || "That image could not be added to the gallery queue.";
  }

  const consentLine = instagramOptIn
    ? "Instagram sharing is enabled if a moderator approves it for publishing."
    : "Instagram sharing is off for this submission.";

  if (response.duplicate) {
    return `That image is already in the moderation queue. ${consentLine}`;
  }

  return `Image submitted to the pending gallery queue. ${consentLine}`;
}

export function inputFromInteraction(interaction: ChatInputCommandInteraction): SubmitInput {
  return {
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: interaction.id,
    discordUserId: interaction.user.id,
    image: interaction.options.getAttachment("image", true),
    title: interaction.options.getString("title", true),
    subtitle: interaction.options.getString("subtitle", true),
    shareToInstagram: interaction.options.getBoolean("share_to_instagram") ?? false,
  };
}

export async function handleSubmitCommand(
  interaction: ChatInputCommandInteraction,
  config: GalleryConfig,
  submit = submitDiscordGalleryImage,
): Promise<void> {
  if (!config.galleryGatewayRollbackEnabled) {
    throw new ReaperError(
      "gallery_gateway_rollback_disabled",
      "The Gallery Gateway rollback path is disabled.",
    );
  }
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  try {
    const input = inputFromInteraction(interaction);
    const payload = buildDiscordGalleryPayload(input, config);
    const response = await submit(config, payload);
    await interaction.editReply(
      submitReplyOptions(formatSubmitResponse(response, payload.instagramOptIn)),
    );
  } catch (error) {
    const message = error instanceof ReaperError
      ? error.message
      : "Gallery submission failed before it reached the moderation queue.";
    await interaction.editReply(submitReplyOptions(message));
  }
}

type GalleryGatewayDependencies = {
  loadGalleryConfig?: () => GalleryConfig;
  handleSubmitCommand?: typeof handleSubmitCommand;
  logger?: Pick<Console, "error">;
};

export function createGalleryGatewayInteractionHandler(
  runtimeConfig: ReaperConfig,
  dependencies: GalleryGatewayDependencies = {},
): (interaction: Interaction) => Promise<void> {
  const galleryConfigLoader = dependencies.loadGalleryConfig ||
    (() => loadGalleryConfig());
  const submitHandler = dependencies.handleSubmitCommand ||
    handleSubmitCommand;
  const logger = dependencies.logger || console;
  return async (interaction: Interaction): Promise<void> => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== "submit") return;

    const message = "Mōchirīī gallery submissions are temporarily unavailable.";
    if (!runtimeConfig.galleryGatewayRollbackEnabled) {
      await interaction.reply({
        ...submitReplyOptions(message),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      await submitHandler(interaction, galleryConfigLoader());
    } catch {
      logger.error("Reaper Gallery Gateway rollback is unavailable.", {
        error: "GalleryGatewayUnavailable",
      });
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(submitReplyOptions(message));
      } else {
        await interaction.reply({
          ...submitReplyOptions(message),
          flags: MessageFlags.Ephemeral,
        });
      }
    }
  };
}
