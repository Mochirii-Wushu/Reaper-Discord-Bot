import { Client, Events, GatewayIntentBits } from "discord.js";
import { loadConfig } from "./config.js";
import { memberRolesChanged } from "./pending-verification.js";
import { MemberSyncForwarder } from "./member-forwarder.js";
import { createRuntimeHealthReporter, type GatewayHealthStatus } from "./runtime-health.js";
import { createGalleryGatewayInteractionHandler } from "./submit.js";
import { sendWelcomeDm } from "./welcome.js";

const config = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const health = createRuntimeHealthReporter();
let shuttingDown = false;
let forwardingFault = false;
const forwarder = new MemberSyncForwarder(config, {
  path: process.env.REAPER_MEMBER_SYNC_STATE_PATH,
  onFault: () => { forwardingFault = true; publishHealth("error"); },
});

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function publishHealth(status: GatewayHealthStatus): void {
  void health.publish(forwardingFault && status === "ready" ? "error" : status).catch((error) => {
    console.error("gateway readiness write failed", { error: errorName(error) });
    client.destroy();
    process.exitCode = 1;
  });
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  forwarder.stop();
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
await forwarder.initialize();
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
  forwarder.start();
  publishHealth("ready");
  console.log("Mōchirīī guild assistant is online.");
});

client.on(Events.ShardReconnecting, () => publishHealth("reconnecting"));
client.on(Events.ShardDisconnect, () => publishHealth("disconnected"));
client.on(Events.ShardReady, () => publishHealth("ready"));
client.on(Events.ShardResume, () => {
  void (forwardingFault ? health.publish("error") : health.resumed()).catch((error) => {
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
    forwarder.enqueue(member, "guildMemberAdd"),
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
  try { await forwarder.enqueue(after, "guildMemberUpdate"); }
  catch { console.warn("guild member update forwarding admission failed"); }
});

client.on(
  Events.InteractionCreate,
  createGalleryGatewayInteractionHandler(config),
);

try {
  await client.login(config.discordBotToken);
} catch (error) {
  await health.publish("error");
  throw error;
}
