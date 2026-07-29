import { SlashCommandBuilder } from "discord.js";

export const submitCommand = new SlashCommandBuilder()
  .setName("submit")
  .setDescription("Submit an image to the Mōchirīī gallery moderation queue.")
  .addAttachmentOption((option) =>
    option
      .setName("image")
      .setDescription("The image file to submit.")
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("title")
      .setDescription("A short title for the gallery submission.")
      .setRequired(true)
      .setMaxLength(80),
  )
  .addStringOption((option) =>
    option
      .setName("subtitle")
      .setDescription("A short subtitle or caption for the gallery submission.")
      .setRequired(true)
      .setMaxLength(300),
  )
  .addBooleanOption((option) =>
    option
      .setName("share_to_instagram")
      .setDescription("Allow Mōchirīī to share this image on our official Instagram if approved.")
      .setRequired(false),
  );

export const commandData = [submitCommand.toJSON()];
