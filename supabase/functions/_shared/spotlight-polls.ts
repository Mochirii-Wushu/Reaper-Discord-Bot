import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getServiceRoleKey } from "./supabase-service-role.ts";
import { readBoundedUtf8RequestBody } from "./bounded-request-body.ts";
import { parseJsonObjectNoDuplicateKeys } from "./strict-json.ts";
import {
  SPOTLIGHT_EXCLUDED_MEMBER_IDS,
  SPOTLIGHT_EXCLUDED_MEMBER_PROFILE_IDS,
} from "./runtime-config.ts";
import {
  asArray,
  asRecord,
  dateInTimeZone,
  type DiscordFetch,
  EXPECTED_DISCORD_GUILD_ID,
  type JsonRecord,
  safeString,
  snowflake,
} from "./vote-reminders.ts";

export const SPOTLIGHT_POLL_MANAGED_BY = "monthly-member-spotlight-poll";
export const SPOTLIGHT_POLL_TIME_ZONE = "Asia/Singapore";
export const SPOTLIGHT_POLL_DURATION_HOURS = 168;
export const SPOTLIGHT_POLL_MAX_ANSWERS = 10;
export const SPOTLIGHT_POLL_MAX_ANSWER_LENGTH = 55;
export const SPOTLIGHT_POLL_SECRET_HEADER = "x-mochirii-spotlight-poll-secret";
export const SPOTLIGHT_POLL_QUESTION =
  "Who should be our guild member of the month?";
export const RECENT_MEMBER_VERIFICATION_MS = 7 * 24 * 60 * 60 * 1000;
export const SPOTLIGHT_POLL_MAX_REQUEST_BYTES = 16 * 1024;
export const SPOTLIGHT_POLL_EXCLUDED_MEMBER_PROFILE_IDS = new Set(
  SPOTLIGHT_EXCLUDED_MEMBER_PROFILE_IDS,
);
export const SPOTLIGHT_POLL_EXCLUDED_DISCORD_USER_IDS = new Set(
  SPOTLIGHT_EXCLUDED_MEMBER_IDS,
);

export type SpotlightCandidate = {
  memberProfileId: string;
  discordUserId: string;
  displayName: string;
  answerLabel: string;
  candidateOrder: number;
  discordUsername: string;
};

export type SpotlightCycle = {
  id: string;
  cycleMonth: string;
  discordGuildId: string;
  discordChannelId: string;
  discordMessageId: string;
  status: string;
  voteCloseAt: string;
};

export function jsonResponse(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        `authorization, x-client-info, apikey, content-type, ${SPOTLIGHT_POLL_SECRET_HEADER}`,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Content-Type": "application/json",
    },
  });
}

export async function readJson(req: Request): Promise<JsonRecord> {
  if (req.method === "GET") return {};
  const body = await readBoundedUtf8RequestBody(
    req,
    SPOTLIGHT_POLL_MAX_REQUEST_BYTES,
  );
  if (!body.ok) throw new Error("Request body must be valid JSON.");
  if (!body.text.trim()) return {};
  return asRecord(parseJsonObjectNoDuplicateKeys(body.text, {
    maximumBytes: SPOTLIGHT_POLL_MAX_REQUEST_BYTES,
    maximumDepth: 16,
  }));
}

export function createAdminClient(): SupabaseClient | null {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = getServiceRoleKey();
  if (!supabaseUrl || !serviceRoleKey) return null;

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

export function bearerOrHeaderSecret(req: Request): string {
  const header = req.headers.get(SPOTLIGHT_POLL_SECRET_HEADER) || "";
  if (header) return header;

  const authorization = req.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

export function cycleMonthFor(
  now = new Date(),
  timeZone = SPOTLIGHT_POLL_TIME_ZONE,
): string {
  return `${dateInTimeZone(now, timeZone).slice(0, 7)}-01`;
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function randomIntBelow(upperExclusive: number): number {
  if (!Number.isInteger(upperExclusive) || upperExclusive <= 0) return 0;

  const maxUint = 0x100000000;
  const limit = maxUint - (maxUint % upperExclusive);
  const buffer = new Uint32Array(1);
  let value = 0;

  do {
    crypto.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= limit);

  return value % upperExclusive;
}

export function secureShuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIntBelow(index + 1);
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }
  return shuffled;
}

function recentVerification(value: unknown, now = Date.now()): boolean {
  const verifiedAt = new Date(String(value || "")).getTime();
  return Number.isFinite(verifiedAt) &&
    now - verifiedAt <= RECENT_MEMBER_VERIFICATION_MS;
}

function cleanPollText(value: unknown, fallback = "Mōchirīī Member"): string {
  return (safeString(value, 160) || fallback)
    .replace(/\s+/g, " ")
    .replace(/@/g, "at ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, 120) || fallback;
}

function truncateAnswerLabel(base: string, suffix = ""): string {
  const cleanSuffix = suffix ? ` ${suffix}` : "";
  const maxBase = SPOTLIGHT_POLL_MAX_ANSWER_LENGTH - cleanSuffix.length;
  if (maxBase <= 0) {
    return `${base.slice(0, SPOTLIGHT_POLL_MAX_ANSWER_LENGTH - 1)}…`;
  }
  if ((base + cleanSuffix).length <= SPOTLIGHT_POLL_MAX_ANSWER_LENGTH) {
    return base + cleanSuffix;
  }
  return `${base.slice(0, Math.max(1, maxBase - 1)).trimEnd()}…${cleanSuffix}`;
}

export function spotlightPollProfileIsExcluded(profile: JsonRecord): boolean {
  const memberProfileId = safeString(profile.id, 80) || "";
  const discordUserId = snowflake(profile.discord_user_id) || "";
  return SPOTLIGHT_POLL_EXCLUDED_MEMBER_PROFILE_IDS.has(memberProfileId) ||
    SPOTLIGHT_POLL_EXCLUDED_DISCORD_USER_IDS.has(discordUserId);
}

export function buildCandidateSnapshots(
  profiles: JsonRecord[],
  shuffle: <T>(items: T[]) => T[] = secureShuffle,
  now = Date.now(),
): SpotlightCandidate[] {
  const eligible = profiles
    .filter((profile) =>
      profile.member_status === "active" &&
      profile.has_required_discord_roles === true &&
      recentVerification(profile.discord_verified_at, now) &&
      !spotlightPollProfileIsExcluded(profile) &&
      Boolean(snowflake(profile.discord_user_id))
    )
    .map((profile) => {
      const discordUserId = snowflake(profile.discord_user_id) || "";
      const discordUsername = cleanPollText(
        profile.discord_handle || profile.discord_username || "",
        "",
      );
      const displayName = cleanPollText(
        profile.display_name || profile.discord_global_name ||
          profile.discord_username || `Member ${discordUserId.slice(-4)}`,
      );
      return {
        memberProfileId: safeString(profile.id, 80) || "",
        discordUserId,
        discordUsername,
        displayName,
      };
    })
    .filter((profile) =>
      profile.memberProfileId && profile.discordUserId && profile.displayName
    );

  const selected = shuffle(eligible).slice(0, SPOTLIGHT_POLL_MAX_ANSWERS);
  const baseCounts = new Map<string, number>();
  selected.forEach((candidate) => {
    const key = candidate.displayName.toLowerCase();
    baseCounts.set(key, (baseCounts.get(key) || 0) + 1);
  });

  return selected.map((candidate, index) => {
    const duplicate =
      (baseCounts.get(candidate.displayName.toLowerCase()) || 0) > 1;
    const suffix = duplicate
      ? `(${candidate.discordUsername || candidate.discordUserId.slice(-4)})`
      : "";
    return {
      ...candidate,
      answerLabel: truncateAnswerLabel(candidate.displayName, suffix),
      candidateOrder: index + 1,
    };
  });
}

export async function loadEligibleProfiles(
  adminClient: SupabaseClient,
): Promise<JsonRecord[]> {
  const { data, error } = await adminClient
    .from("member_profiles")
    .select(
      "id,display_name,discord_user_id,discord_username,discord_global_name,discord_handle,member_status,has_required_discord_roles,discord_verified_at",
    )
    .eq("member_status", "active")
    .eq("has_required_discord_roles", true)
    .not("discord_user_id", "is", null);

  if (error) throw error;
  return asArray(data).map(asRecord);
}

export function buildDiscordPollPayload(
  candidates: SpotlightCandidate[],
): JsonRecord {
  return {
    content:
      "Monthly member spotlight vote is open. Choose one guildie below; voting closes in 7 days.",
    allowed_mentions: { parse: [] },
    poll: {
      question: {
        text: SPOTLIGHT_POLL_QUESTION,
      },
      answers: candidates.map((candidate) => ({
        poll_media: {
          text: candidate.answerLabel,
        },
      })),
      duration: SPOTLIGHT_POLL_DURATION_HOURS,
      allow_multiselect: false,
      layout_type: 1,
    },
  };
}

export function pollAnswerIds(message: JsonRecord): number[] {
  const poll = asRecord(message.poll);
  return asArray(poll.answers)
    .map((answer) => Number(asRecord(answer).answer_id ?? asRecord(answer).id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

export function pollResults(
  message: JsonRecord,
): { finalized: boolean; counts: Map<number, number> } {
  const results = asRecord(asRecord(message.poll).results);
  const counts = new Map<number, number>();

  asArray(results.answer_counts).forEach((entry) => {
    const record = asRecord(entry);
    const id = Number(record.id ?? record.answer_id);
    const count = Number(record.count);
    if (Number.isInteger(id) && id > 0 && Number.isFinite(count)) {
      counts.set(id, Math.max(0, count));
    }
  });

  return {
    finalized: results.is_finalized === true,
    counts,
  };
}

export function spotlightPollConfig(): {
  guildId: string;
  channelId: string;
  secret: string;
  ready: boolean;
} {
  const guildId = Deno.env.get("DISCORD_GUILD_ID") || "";
  const channelId = Deno.env.get("DISCORD_SPOTLIGHT_POLL_CHANNEL_ID") || "";
  const secret = Deno.env.get("SPOTLIGHT_POLL_CRON_SECRET") || "";
  return {
    guildId,
    channelId,
    secret,
    ready: guildId === EXPECTED_DISCORD_GUILD_ID &&
      Boolean(snowflake(channelId)) && Boolean(secret),
  };
}

export async function fetchPollAnswerVoterCount(
  discordFetch: DiscordFetch,
  channelId: string,
  messageId: string,
  answerId: number,
): Promise<number | null> {
  let after = "";
  let total = 0;

  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ limit: "100" });
    if (after) query.set("after", after);
    const response = await discordFetch(
      `/channels/${channelId}/polls/${messageId}/answers/${answerId}?${query.toString()}`,
    );
    if (!response.ok) return null;

    const users = asArray(asRecord(response.data).users);
    total += users.length;
    const lastUserId = snowflake(asRecord(users.at(-1)).id);
    if (users.length < 100 || !lastUserId) break;
    after = lastUserId;
  }

  return total;
}
