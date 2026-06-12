import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { loadConfig, loadGalleryConfig } from "./config.js";
import { memberRolesChanged, syncPendingVerificationMember } from "./pending-verification.js";
import { handleSubmitCommand } from "./submit.js";
import { sendWelcomeDm } from "./welcome.js";

const config = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Reaper is online as ${readyClient.user.tag}.`);
});

client.on(Events.GuildMemberAdd, async (member) => {
  const results = await Promise.allSettled([
    sendWelcomeDm(member, config),
    syncPendingVerificationMember(member, "guildMemberAdd", config, console, fetch, null),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("guild member add handler task failed", {
        error: result.reason instanceof Error ? result.reason.message : "Unknown error",
      });
    }
  }
});

client.on(Events.GuildMemberUpdate, async (before, after) => {
  if (!memberRolesChanged(before, after)) return;
  const result = await syncPendingVerificationMember(
    after,
    "guildMemberUpdate",
    config,
    console,
    fetch,
    null,
  );

  if (result === "post_failed") {
    console.warn("guild member update pending verification task failed");
  }
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
