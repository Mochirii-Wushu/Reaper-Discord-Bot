import { Client, Events, GatewayIntentBits, MessageFlags } from "discord.js";
import { loadConfig, loadGalleryConfig } from "./config.js";
import { memberRolesChanged, syncPendingVerificationMember } from "./pending-verification.js";
import { createRuntimeHealthReporter, type GatewayHealthStatus } from "./runtime-health.js";
import { handleSubmitCommand } from "./submit.js";
import { sendWelcomeDm } from "./welcome.js";

const config = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const health = createRuntimeHealthReporter();
let shuttingDown = false;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function publishHealth(status: GatewayHealthStatus): void {
  void health.publish(status).catch((error) => {
    console.error("gateway readiness write failed", { error: errorName(error) });
    client.destroy();
    process.exitCode = 1;
  });
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  try {
    await health.publish("shutting_down");
  } catch (error) {
    console.error("gateway readiness shutdown write failed", {
      error: errorName(error),
    });
    exitCode = 1;
  } finally {
    client.destroy();
    process.exitCode = exitCode;
  }
}

await health.publish("starting");
const heartbeat = setInterval(() => {
  void health.heartbeat().catch((error) => {
    console.error("gateway readiness heartbeat write failed", {
      error: errorName(error),
    });
    client.destroy();
    process.exitCode = 1;
  });
}, health.heartbeatMs);
heartbeat.unref();

client.once(Events.ClientReady, () => {
  publishHealth("ready");
  console.log("Mōchirīī guild assistant is online.");
});

client.on(Events.ShardReconnecting, () => publishHealth("reconnecting"));
client.on(Events.ShardDisconnect, () => publishHealth("disconnected"));
client.on(Events.ShardReady, () => publishHealth("ready"));
client.on(Events.ShardResume, () => {
  void health.resumed().catch((error) => {
    console.error("gateway readiness resume write failed", {
      error: errorName(error),
    });
    client.destroy();
    process.exitCode = 1;
  });
});
client.on(Events.ShardError, (error) => {
  console.error("gateway shard error", { error: errorName(error) });
  publishHealth("error");
});
client.on(Events.Error, (error) => {
  console.error("gateway client error", { error: errorName(error) });
  publishHealth("error");
});
client.on(Events.Invalidated, () => {
  console.error("gateway session invalidated");
  publishHealth("error");
  void shutdown(1);
});

process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));

client.on(Events.GuildMemberAdd, async (member) => {
  const results = await Promise.allSettled([
    sendWelcomeDm(member, config),
    syncPendingVerificationMember(member, "guildMemberAdd", config, console, fetch, null),
  ]);

  for (const result of results) {
    if (result.status === "rejected") {
      console.warn("guild member add handler task failed", {
        error: errorName(result.reason),
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
      error: errorName(error),
    });

    const message = "Gallery submission fallback is not configured on this Reaper runtime.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message);
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
  }
});

try {
  await client.login(config.discordBotToken);
} catch (error) {
  await health.publish("error");
  throw error;
}
