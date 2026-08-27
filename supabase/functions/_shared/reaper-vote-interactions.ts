import {
  buildVoteReminderPayload,
  currentStreak,
  dateInTimeZone,
  DEFAULT_VOTE_TIME_ZONE,
  EXPECTED_DISCORD_VOTE_CHANNEL_ID,
  leaderboardWindowStart,
  loadVoteLinks,
  previewText,
} from "./vote-reminders.ts";
import {
  asArray,
  asRecord,
  type JsonRecord,
  safeString,
  snowflake,
} from "./discord-interaction-helpers.ts";

type SupabaseAdminClient = {
  from(table: string): any;
};

type DiscordApiResult = {
  ok: boolean;
  status: number;
  data: unknown;
};

export type ReaperVoteDependencies = {
  expectedGuildId: string;
  expectedVoteChannelId?: string;
  adminClient(): SupabaseAdminClient;
  discordApi(path: string, init?: RequestInit): Promise<DiscordApiResult>;
};

export function voteTimeZone(): string {
  return Deno.env.get("VOTE_REMINDER_TIME_ZONE") || DEFAULT_VOTE_TIME_ZONE;
}

export function voteToday(now = new Date()): string {
  return dateInTimeZone(now, voteTimeZone());
}

export function discordDisplayName(member: JsonRecord): string | null {
  const user = asRecord(member.user);
  return safeString(user.global_name || user.username, 80);
}

export async function voteDatesForUser(
  adminClient: SupabaseAdminClient,
  discordUserId: string,
  today: string,
): Promise<string[]> {
  const { data, error } = await adminClient
    .from("vote_confirmations")
    .select("vote_date")
    .eq("discord_user_id", discordUserId)
    .gte("vote_date", leaderboardWindowStart(today, 366))
    .order("vote_date", { ascending: false });

  if (error) throw error;
  return asArray(data).map((row) =>
    safeString(asRecord(row).vote_date, 20) || ""
  ).filter(Boolean);
}

export async function recordVoteConfirmation(
  options: {
    discordUserId: string;
    discordUsername: string | null;
    voteDate: string;
    channelId: string | null;
    interactionId: string;
  },
  deps: ReaperVoteDependencies,
): Promise<{ duplicate: boolean; streak: number }> {
  const adminClient = deps.adminClient();
  const { error } = await adminClient
    .from("vote_confirmations")
    .insert({
      discord_user_id: options.discordUserId,
      discord_username: options.discordUsername,
      vote_date: options.voteDate,
      source: "discord_button",
      discord_guild_id: deps.expectedGuildId,
      discord_channel_id: options.channelId,
      discord_interaction_id: options.interactionId,
      metadata: {
        managedBy: "manual-vote-reminder",
      },
    });

  if (error && error.code !== "23505") throw error;

  const dates = await voteDatesForUser(
    adminClient,
    options.discordUserId,
    options.voteDate,
  );
  return {
    duplicate: error?.code === "23505",
    streak: currentStreak(dates, options.voteDate),
  };
}

export async function voteStatusMessage(
  discordUserId: string,
  deps: ReaperVoteDependencies,
): Promise<string> {
  const today = voteToday();
  const adminClient = deps.adminClient();
  const dates = await voteDatesForUser(adminClient, discordUserId, today);
  const streak = currentStreak(dates, today);
  const todayDone = dates.includes(today);
  const lastDate = dates[0] || "none yet";

  return todayDone
    ? `You are marked done for ${today}. Current streak: ${streak} day(s). Last confirmation: ${lastDate}.`
    : `You are not marked done for ${today} yet. Current streak: ${streak} day(s). Last confirmation: ${lastDate}.`;
}

export async function voteLeaderboardMessage(
  deps: ReaperVoteDependencies,
): Promise<string> {
  const today = voteToday();
  const start = leaderboardWindowStart(today, 30);
  const adminClient = deps.adminClient();
  const { data, error } = await adminClient
    .from("vote_confirmations")
    .select("discord_user_id,discord_username,vote_date,confirmed_at")
    .gte("vote_date", start)
    .order("vote_date", { ascending: false })
    .order("confirmed_at", { ascending: false });

  if (error) throw error;

  const grouped = new Map<
    string,
    { username: string; dates: Set<string>; latest: string }
  >();
  for (const row of asArray(data).map(asRecord)) {
    const userId = snowflake(row.discord_user_id);
    const voteDate = safeString(row.vote_date, 20);
    if (!userId || !voteDate) continue;

    const current = grouped.get(userId) || {
      username: safeString(row.discord_username, 80) ||
        `User ${userId.slice(-4)}`,
      dates: new Set<string>(),
      latest: voteDate,
    };
    current.dates.add(voteDate);
    if (voteDate > current.latest) current.latest = voteDate;
    grouped.set(userId, current);
  }

  const leaders = [...grouped.entries()]
    .map(([userId, record]) => ({
      userId,
      username: record.username,
      count: record.dates.size,
      streak: currentStreak([...record.dates], today),
      latest: record.latest,
    }))
    .sort((left, right) =>
      right.count - left.count || right.streak - left.streak ||
      left.username.localeCompare(right.username)
    )
    .slice(0, 10);

  if (!leaders.length) {
    return `No manual vote confirmations have been recorded since ${start}.`;
  }

  return [
    `Manual vote leaderboard since ${start}:`,
    ...leaders.map((leader, index) =>
      `${
        index + 1
      }. ${leader.username}: ${leader.count} day(s), streak ${leader.streak}, latest ${leader.latest}`
    ),
  ].join("\n");
}

export async function voteReminderPreviewMessage(
  voteDate: string,
  deps: ReaperVoteDependencies,
): Promise<string> {
  const links = await loadVoteLinks({
    channelId: deps.expectedVoteChannelId || EXPECTED_DISCORD_VOTE_CHANNEL_ID,
    discordFetch: (path, init) => deps.discordApi(path, init),
    linksJson: Deno.env.get("DISCORD_VOTE_LINKS_JSON") || "",
  });

  if (!links.length) {
    return "No configured or pinned vote links were found. Add DISCORD_VOTE_LINKS_JSON or pin a message containing [vote-links].";
  }

  const payload = buildVoteReminderPayload(links, voteDate);
  const rowCount = asArray(payload.components).length;
  return `${
    previewText(links, voteDate)
  }\n\nDiscord component rows: ${rowCount}. Done button custom ID: vote_done:${voteDate}.`;
}
