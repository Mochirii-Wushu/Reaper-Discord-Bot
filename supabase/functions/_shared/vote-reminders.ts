import { DISCORD_GUILD_ID, DISCORD_VOTE_CHANNEL_ID } from "./runtime-config.ts";
import { parseJsonNoDuplicateKeys } from "./strict-json.ts";

export type JsonRecord = Record<string, unknown>;

export type DiscordFetchResult = {
  ok: boolean;
  status: number;
  data: unknown;
  error?: unknown;
};

export type DiscordFetch = (
  path: string,
  init?: RequestInit,
) => Promise<DiscordFetchResult>;

export type VoteReminderLink = {
  label: string;
  url: string;
};

export const EXPECTED_DISCORD_GUILD_ID = DISCORD_GUILD_ID;
export const EXPECTED_DISCORD_VOTE_CHANNEL_ID = DISCORD_VOTE_CHANNEL_ID;
export const VOTE_LINKS_MARKER = "[vote-links]";
export const VOTE_DONE_CUSTOM_ID_PREFIX = "vote_done:";
export const VOTE_REMINDER_MANAGED_BY = "manual-vote-reminder";
export const DEFAULT_VOTE_TIME_ZONE = "America/Los_Angeles";
export const MAX_VOTE_LINKS = 20;
export const MAX_LEADERBOARD_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function safeString(value: unknown, maxLength: number): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

export function snowflake(value: unknown): string | null {
  const id = safeString(value, 24);
  return id && /^\d{16,22}$/.test(id) ? id : null;
}

export function customIdForVoteDate(voteDate: string): string {
  return `${VOTE_DONE_CUSTOM_ID_PREFIX}${voteDate}`;
}

export function voteDateFromCustomId(customId: unknown): string | null {
  const value = safeString(customId, 100);
  if (!value?.startsWith(VOTE_DONE_CUSTOM_ID_PREFIX)) return null;

  const voteDate = value.slice(VOTE_DONE_CUSTOM_ID_PREFIX.length);
  return isVoteDate(voteDate) ? voteDate : null;
}

export function isVoteDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function dateInTimeZone(
  now = new Date(),
  timeZone = DEFAULT_VOTE_TIME_ZONE,
): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return `${byType.get("year")}-${byType.get("month")}-${byType.get("day")}`;
}

export function addDays(dateKey: string, days: number): string {
  if (!isVoteDate(dateKey)) return dateKey;
  const [year, month, day] = dateKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day) + days * MS_PER_DAY);
  return `${next.getUTCFullYear()}-${
    String(next.getUTCMonth() + 1).padStart(2, "0")
  }-${String(next.getUTCDate()).padStart(2, "0")}`;
}

export function leaderboardWindowStart(
  today: string,
  days = MAX_LEADERBOARD_DAYS,
): string {
  return addDays(today, -Math.max(days - 1, 0));
}

export function currentStreak(voteDates: string[], today: string): number {
  const dates = new Set(voteDates.filter(isVoteDate));
  let cursor = today;
  let streak = 0;

  while (dates.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }

  return streak;
}

function fallbackLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").slice(0, 80) ||
      "Vote link";
  } catch {
    return "Vote link";
  }
}

function cleanLabel(value: unknown, url: string): string {
  const label = safeString(value, 80)
    ?.replace(/^[\s*#.\-:|>]+/, "")
    .replace(/[\s\-:|>]+$/, "")
    .trim();
  return label || fallbackLabel(url);
}

function cleanUrl(value: unknown): string | null {
  const text = safeString(value, 600)?.replace(/[),.;!?]+$/g, "") || "";
  if (!text) return null;

  try {
    const url = new URL(text);
    if (url.protocol !== "https:") return null;
    return url.toString().slice(0, 512);
  } catch {
    return null;
  }
}

export function normalizeVoteLinks(
  links: VoteReminderLink[],
): VoteReminderLink[] {
  const seenUrls = new Set<string>();
  const normalized: VoteReminderLink[] = [];

  for (const link of links) {
    const url = cleanUrl(link.url);
    if (!url || seenUrls.has(url)) continue;
    normalized.push({
      label: cleanLabel(link.label, url),
      url,
    });
    seenUrls.add(url);
    if (normalized.length >= MAX_VOTE_LINKS) break;
  }

  return normalized;
}

export function parseVoteLinksFromText(content: string): VoteReminderLink[] {
  const markerIndex = content.toLowerCase().indexOf(VOTE_LINKS_MARKER);
  if (markerIndex < 0) return [];

  const scoped = content.slice(markerIndex + VOTE_LINKS_MARKER.length);
  const discovered: VoteReminderLink[] = [];
  const seenUrls = new Set<string>();
  const markdownPattern =
    /\[([^\]\r\n]{1,80})\]\((https:\/\/[^\s<>"\r\n)]{1,512})\)/gi;
  let markdownMatch: RegExpExecArray | null;

  while ((markdownMatch = markdownPattern.exec(scoped)) !== null) {
    const url = cleanUrl(markdownMatch[2]);
    if (!url || seenUrls.has(url)) continue;
    discovered.push({ label: cleanLabel(markdownMatch[1], url), url });
    seenUrls.add(url);
  }

  for (const line of scoped.split(/\r?\n/)) {
    const urlMatch = line.match(/https:\/\/[^\s<>"\r\n]+/i);
    const url = cleanUrl(urlMatch?.[0]);
    if (!url || seenUrls.has(url)) continue;
    const label = line.slice(0, urlMatch?.index || 0).replace(
      /\[[^\]]+\]\(/g,
      "",
    );
    discovered.push({ label: cleanLabel(label, url), url });
    seenUrls.add(url);
  }

  return normalizeVoteLinks(discovered);
}

export function parseVoteLinksJson(value: string): VoteReminderLink[] {
  if (!value.trim()) return [];

  const parsed = parseJsonNoDuplicateKeys(value, {
    maximumBytes: 16 * 1024,
    maximumDepth: 16,
  });
  const rawLinks = Array.isArray(parsed)
    ? parsed
    : asArray(asRecord(parsed).links);
  return normalizeVoteLinks(
    rawLinks.map((item) => {
      const record = asRecord(item);
      return {
        label: safeString(record.label || record.name, 80) || "",
        url: safeString(record.url || record.href, 600) || "",
      };
    }),
  );
}

function pinnedMessagesFromPayload(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return payload.map(asRecord);

  const record = asRecord(payload);
  return asArray(record.items).map((item) => {
    const itemRecord = asRecord(item);
    return asRecord(itemRecord.message || itemRecord);
  });
}

export async function loadVoteLinks(options: {
  channelId: string;
  discordFetch: DiscordFetch;
  linksJson?: string;
}): Promise<VoteReminderLink[]> {
  const configuredLinks = parseVoteLinksJson(options.linksJson || "");
  if (configuredLinks.length) return configuredLinks;

  const pins = await options.discordFetch(
    `/channels/${options.channelId}/pins`,
    {
      method: "GET",
    },
  );
  if (!pins.ok) {
    throw new Error(
      `Could not read pinned vote-link message from Discord (HTTP ${pins.status}).`,
    );
  }

  return normalizeVoteLinks(
    pinnedMessagesFromPayload(pins.data)
      .flatMap((message) =>
        parseVoteLinksFromText(safeString(message.content, 4000) || "")
      ),
  );
}

function buttonRows(links: VoteReminderLink[], voteDate: string): JsonRecord[] {
  const rows: JsonRecord[] = [];
  const linkButtons = links.map((link) => ({
    type: 2,
    style: 5,
    label: link.label,
    url: link.url,
  }));

  for (let index = 0; index < linkButtons.length; index += 5) {
    rows.push({
      type: 1,
      components: linkButtons.slice(index, index + 5),
    });
  }

  rows.push({
    type: 1,
    components: [
      {
        type: 2,
        style: 3,
        label: "Done voting",
        custom_id: customIdForVoteDate(voteDate),
      },
    ],
  });

  return rows;
}

export function buildVoteReminderPayload(
  links: VoteReminderLink[],
  voteDate: string,
): JsonRecord {
  return {
    content:
      `Daily vote reminder for ${voteDate}. Vote manually with the links below, then tap Done voting when finished. This does not automate any third-party vote.`,
    allowed_mentions: {
      parse: [],
    },
    components: buttonRows(normalizeVoteLinks(links), voteDate),
  };
}

export function previewText(
  links: VoteReminderLink[],
  voteDate: string,
): string {
  const lines = normalizeVoteLinks(links).map((link, index) =>
    `${index + 1}. ${link.label}: ${link.url}`
  );
  return [
    `Vote reminder preview for ${voteDate}.`,
    "No Discord message was sent.",
    ...lines,
  ].join("\n").slice(0, 1900);
}
