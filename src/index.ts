import { Client, Events, GatewayIntentBits, PermissionFlagsBits } from "discord.js";
import { loadConfig, loadCommunityNoticeConfig } from "./config.js";
import { memberRolesChanged } from "./pending-verification.js";
import { MemberSyncForwarder } from "./member-forwarder.js";
import { CheckpointExporter } from "./checkpoint.js";
import { createRuntimeHealthReporter, type GatewayHealthStatus } from "./runtime-health.js";
import { createGalleryGatewayInteractionHandler } from "./submit.js";
import { sendWelcomeDm } from "./welcome.js";
import { CommunityNotices } from "./community-notices.js";
import { NoticeJournal } from "./notice-journal.js";
import { createNoticeSender } from "./notice-transport.js";
import { GatewayGoodbyes } from "./gateway-goodbyes.js";

const config = loadConfig();
const noticeConfig = loadCommunityNoticeConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const health = createRuntimeHealthReporter();
let shuttingDown = false;
let forwardingFault = false;
let noticeFault = false;
let lastSpotlightCheck = -Infinity;
const noticeTasks = new Set<Promise<void>>();
let releaseNoticeReadiness: () => void = () => undefined;
const noticeReadiness = new Promise<void>((resolve) => { releaseNoticeReadiness = resolve; });
const notices = noticeConfig.welcomeChannelId || noticeConfig.spotlightChannelId ? new CommunityNotices({
  ...noticeConfig,
  journal: new NoticeJournal(noticeConfig.statePath),
  onFault: () => { noticeFault = true; publishHealth("error"); },
  resolveChannel: async (id) => {
    const channel = await client.channels.fetch(id);
    if (!channel || !("guild" in channel) || !("permissionsFor" in channel) || !client.user) {
      throw new Error("Community notice channel is unavailable.");
    }
    const permissions = channel.permissionsFor(client.user);
    return { id: channel.id, guildId: channel.guild.id, type: channel.type,
      canView: permissions?.has(PermissionFlagsBits.ViewChannel) === true,
      canSend: permissions?.has(PermissionFlagsBits.SendMessages) === true };
  },
  send: noticeConfig.apiOrigin ? createNoticeSender({ apiOrigin: noticeConfig.apiOrigin,
    botToken: config.discordBotToken, botUserId: () => client.user?.id }) : async () => {
      throw new Error("Community notice routes are disabled.");
    },
}) : null;
const goodbyes = noticeConfig.welcomeChannelId ? new GatewayGoodbyes(noticeConfig.guildId) : null;

function trackNotice(task: () => Promise<void>): void {
  if (!notices || shuttingDown || noticeFault) return;
  if (noticeTasks.size >= 256) {
    noticeFault = true;
    console.warn("community notice admission full; operator reconciliation required");
    publishHealth("error");
    return;
  }
  const pending = noticeReadiness.then(async () => {
    if (!shuttingDown && !noticeFault) await task();
  }).catch(() => {
    noticeFault = true;
    console.warn("community notice held; operator reconciliation required");
    publishHealth("error");
  }).finally(() => { noticeTasks.delete(pending); });
  noticeTasks.add(pending);
}

function reconcileSpotlight(): void {
  if (!client.isReady() || noticeTasks.size || Date.now() - lastSpotlightCheck < 60_000) return;
  lastSpotlightCheck = Date.now();
  trackNotice(async () => { await notices?.checkSpotlight(); });
}
let checkpoints: CheckpointExporter | undefined;
const forwarder = new MemberSyncForwarder(config, {
  path: process.env.REAPER_MEMBER_SYNC_STATE_PATH,
  onFault: () => { forwardingFault = true; publishHealth("error"); },
  onCheckpointNeeded: () => { void checkpoints?.request(); },
});
checkpoints = new CheckpointExporter({ path: process.env.REAPER_CHECKPOINT_PATH,
  capture: () => forwarder.captureCheckpoint(),
  onError: () => { console.warn("gateway checkpoint export failed; previous recovery evidence retained"); },
});

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function publishHealth(status: GatewayHealthStatus): void {
  void health.publish((forwardingFault || noticeFault) && status === "ready" ? "error" : status).catch((error) => {
    console.error("gateway readiness write failed", { error: errorName(error) });
    client.destroy();
    process.exitCode = 1;
  });
}

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  releaseNoticeReadiness();
  forwarder.stop();
  notices?.stop();
  clearInterval(heartbeat);
  try {
    await Promise.allSettled([...noticeTasks]);
    if (checkpoints && !await checkpoints.close()) {
      console.warn("gateway checkpoint shutdown grace expired; preserve recovery evidence");
      exitCode = 1;
    }
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
await notices?.initialize();
await forwarder.initialize();
await checkpoints.request();
const heartbeat = setInterval(() => {
  reconcileSpotlight();
  void checkpoints?.due();
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
  releaseNoticeReadiness();
  forwarder.start();
  publishHealth("ready");
  reconcileSpotlight();
  console.log("Mōchirīī guild assistant is online.");
});

client.on(Events.ShardReconnecting, () => publishHealth("reconnecting"));
client.on(Events.ShardDisconnect, () => publishHealth("disconnected"));
client.on(Events.ShardReady, () => { publishHealth("ready"); reconcileSpotlight(); });
client.on(Events.ShardResume, () => {
  reconcileSpotlight();
  void (forwardingFault || noticeFault ? health.publish("error") : health.resumed()).catch((error) => {
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
  trackNotice(async () => { await notices?.welcome(member); });
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

// The SDK's cached-member event omits uncached departures. Read only the raw
// dispatch identity; no member roster, extra intent or message content is needed.
client.on(Events.Raw, (packet, shardId) => {
  if (!goodbyes || shuttingDown || noticeFault) return;
  try {
    const departure = goodbyes.read(packet, shardId);
    if (departure) trackNotice(async () => { await notices?.goodbye(departure); });
  } catch {
    noticeFault = true;
    console.warn("community goodbye context held; operator reconciliation required");
    publishHealth("error");
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
