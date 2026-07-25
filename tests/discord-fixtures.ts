export const SYNTHETIC_DISCORD_IDS = {
  guild: "100000000000000001",
  otherGuild: "100000000000000002",
  galleryChannel: "100000000000000003",
  otherChannel: "100000000000000004",
  message: "100000000000000005",
  member: "100000000000000006",
  attachment: "100000000000000007",
  roleOne: "100000000000000008",
  roleTwo: "100000000000000009",
} as const;

export const SYNTHETIC_DISCORD_SNOWFLAKES = new Set<string>(Object.values(SYNTHETIC_DISCORD_IDS));

export function syntheticDiscordAttachmentUrl(
  channelId = SYNTHETIC_DISCORD_IDS.galleryChannel,
  attachmentId = SYNTHETIC_DISCORD_IDS.attachment,
) {
  return `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/image.jpg`;
}
