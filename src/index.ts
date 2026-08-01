import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { loadConfig, loadGalleryConfig } from "./config.js";
import { memberRolesChanged, syncPendingVerificationMember } from "./pending-verification.js";
import { GatewayReadiness } from "./runtime-health.js";
import { handleSubmitCommand } from "./submit.js";
import { sendWelcomeDm } from "./welcome.js";

const config = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const readiness = new GatewayReadiness();
let shuttingDown = false;

await readiness.initialize();

function updateReadiness(ready: boolean): void {
  const update = ready ? readiness.markReady() : readiness.markNotReady();
  void update.catch(() => {
    console.error("Reaper Gateway readiness update failed.");
  });
}

async function shutdown(signal: "SIGINT" | "SIGTERM"): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Reaper received ${signal}; closing the Gateway connection.`);
  await readiness.close().catch(() => {
    console.error("Reaper Gateway readiness cleanup failed.");
  });
  client.destroy();
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

client.once(Events.ClientReady, (readyClient) => {
  updateReadiness(true);
  console.log(`Reaper is online as ${readyClient.user.tag}.`);
});

client.on(Events.ShardReady, () => updateReadiness(true));
client.on(Events.ShardDisconnect, () => updateReadiness(false));
client.on(Events.ShardReconnecting, () => updateReadiness(false));
client.on(Events.Invalidated, () => updateReadiness(false));

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
