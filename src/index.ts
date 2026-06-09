import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { loadConfig, loadGalleryConfig } from "./config.js";
import { handleSubmitCommand } from "./submit.js";
import { sendWelcomeDm } from "./welcome.js";

const config = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Reaper is online as ${readyClient.user.tag}.`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  await sendWelcomeDm(member, config);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== "submit") return;

  try {
    await handleSubmitCommand(interaction, loadGalleryConfig());
  } catch (error) {
    console.error("Reaper gallery fallback is not configured.", {
      error: error instanceof Error ? error.message : "Unknown error",
    });

    const message = "Gallery submission fallback is not configured on this Reaper runtime.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message);
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  }
});

await client.login(config.discordBotToken);
