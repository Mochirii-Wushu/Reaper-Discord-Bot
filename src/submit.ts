import type { Attachment, ChatInputCommandInteraction } from "discord.js";
import { MessageFlags } from "discord.js";
import type { GalleryConfig } from "./config.js";
import { ReaperError } from "./errors.js";
import { submitDiscordGalleryImage, type DiscordGalleryPayload, type SupabaseIngestResponse } from "./supabase.js";

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
  return {
    content,
    allowedMentions: { parse: [] },
  };
}

export function buildDiscordGalleryPayload(
  input: SubmitInput,
  config: Pick<GalleryConfig, "discordGuildId" | "discordGalleryChannelId">,
): DiscordGalleryPayload {
  if (input.guildId !== config.discordGuildId) {
    throw new ReaperError("wrong_guild", "Gallery submissions are only available inside the Mōchirīī Discord server.");
  }

  if (input.channelId !== config.discordGalleryChannelId) {
    throw new ReaperError("wrong_channel", "Use the gallery submissions channel for /submit.");
  }

  const mimeType = String(input.image.contentType || "").split(";")[0]?.trim().toLowerCase();
  if (!mimeType) {
    throw new ReaperError("missing_mime_type", "Discord did not provide an image content type for that attachment.");
  }

  return {
    guildId: input.guildId,
    channelId: input.channelId,
    messageId: input.messageId,
    attachmentId: input.image.id,
    discordUserId: input.discordUserId,
    attachmentUrl: input.image.url,
    mimeType,
    sizeBytes: Number(input.image.size || 0),
    title: input.title.trim(),
    caption: input.subtitle.trim(),
    instagramOptIn: input.shareToInstagram === true,
    originalFilename: input.image.name || `discord-${input.image.id}`,
  };
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
