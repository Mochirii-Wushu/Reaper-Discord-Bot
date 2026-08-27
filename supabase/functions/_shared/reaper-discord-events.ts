import {
  asArray,
  asRecord,
  type JsonRecord,
  normalizedMime,
  safeString,
  snowflake,
} from "./discord-interaction-helpers.ts";
import { siteUrl } from "./public-origins.ts";
import {
  GALLERY_SOURCE_IMAGE_MAX_BYTES,
  validateGallerySourceBytes,
} from "./gallery-source-image.ts";
import {
  exactHttpsUrl,
  fetchWithTimeout,
  readBoundedResponseBytes,
} from "./outbound-http.ts";
import { SITE_ORIGIN } from "./runtime-config.ts";

export const DISCORD_EVENT_PRIVACY_GUILD_ONLY = 2;
export const DISCORD_EVENT_ENTITY_EXTERNAL = 3;

export type ScheduleEvent = {
  key: string;
  title: string;
  description: string;
  location: string;
  websiteLocation: string;
  startIso: string;
  endIso: string;
  coverImageUrl: string | null;
  canonicalEventId: string | null;
  duplicateEventIds: string[];
  recurrenceRule: JsonRecord | null;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EVENT_COVER_FETCH_TIMEOUT_MS = 10_000;
const WEBSITE_ORIGINS = new Set([SITE_ORIGIN]);
const EVENT_COVER_SEARCH_PARAMS = new Set(["v"]);
const eventCoverImageCache = new Map<string, string>();
const MONTHLY_RULE_WEEKDAYS: Readonly<Record<string, number>> = {
  "next-first-saturday": 6,
  "next-first-wednesday": 3,
};

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function scheduleOffsetMinutes(schedule: JsonRecord): number {
  const timezone = asRecord(schedule.timezone);
  const value = Number(timezone.offsetMinutes);
  return Number.isFinite(value) ? value : 480;
}

function localParts(now: Date, offset: number) {
  const shifted = new Date(now.getTime() + offset * 60 * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`;
}

function parseDateKey(
  value: string,
): { year: number; month: number; day: number } | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function addDays(value: string, days: number): string {
  const parsed = parseDateKey(value);
  if (!parsed) return value;
  const next = new Date(
    Date.UTC(parsed.year, parsed.month - 1, parsed.day) + days * MS_PER_DAY,
  );
  return dateKey(
    next.getUTCFullYear(),
    next.getUTCMonth() + 1,
    next.getUTCDate(),
  );
}

function parseTime(value: unknown): { hour: number; minute: number } {
  const match = String(value || "00:00").match(/^(\d{2}):(\d{2})$/);
  if (!match) return { hour: 0, minute: 0 };
  return {
    hour: Math.min(Math.max(Number(match[1]), 0), 23),
    minute: Math.min(Math.max(Number(match[2]), 0), 59),
  };
}

function localToUtcIso(
  localDate: string,
  time: string,
  offset: number,
): string {
  const parsed = parseDateKey(localDate);
  if (!parsed) return "";
  const parsedTime = parseTime(time);
  return new Date(
    Date.UTC(
      parsed.year,
      parsed.month - 1,
      parsed.day,
      parsedTime.hour,
      parsedTime.minute,
    ) -
      offset * 60 * 1000,
  ).toISOString();
}

export function scheduleAssetUrl(
  value: unknown,
  versionValue?: unknown,
): string | null {
  const raw = safeString(value, 300);
  if (!raw || raw.split(/[\\/]/u).includes("..")) return null;
  const version = safeString(versionValue, 80);
  const withVersion = (url: string) => {
    if (!version) return url;
    const parsed = new URL(url);
    parsed.searchParams.set("v", version);
    return parsed.toString();
  };
  try {
    const candidate = /^https:\/\/[^\s]+$/iu.test(raw)
      ? raw
      : siteUrl(raw.replace(/^\.?\//u, ""));
    return exactHttpsUrl(withVersion(candidate), {
      allowedOrigins: WEBSITE_ORIGINS,
      pathPrefix: "/assets/",
      allowedSearchParams: EVENT_COVER_SEARCH_PARAMS,
    });
  } catch {
    return null;
  }
}

export function recurrenceRule(
  value: unknown,
  startIso: string,
): JsonRecord | null {
  const rule = asRecord(value);
  const frequency = Number(rule.frequency);
  const interval = Number(rule.interval || 1);
  const byNWeekday = asArray(rule.by_n_weekday)
    .map(asRecord)
    .map((entry) => ({
      n: Number(entry.n),
      day: Number(entry.day),
    }))
    .filter((entry) =>
      Number.isInteger(entry.n) &&
      entry.n >= 1 &&
      entry.n <= 5 &&
      Number.isInteger(entry.day) &&
      entry.day >= 0 &&
      entry.day <= 6
    );

  if (
    !Number.isInteger(frequency) || !Number.isInteger(interval) || interval < 1
  ) return null;

  const normalized: JsonRecord = {
    start: startIso,
    frequency,
    interval,
  };

  if (byNWeekday.length) normalized.by_n_weekday = byNWeekday.slice(0, 1);
  return normalized;
}

function eventEndDate(
  startDate: string,
  startTime: string,
  endTime: string,
): string {
  const start = parseTime(startTime);
  const end = parseTime(endTime);
  const crossesMidnight =
    end.hour * 60 + end.minute <= start.hour * 60 + start.minute;
  return crossesMidnight ? addDays(startDate, 1) : startDate;
}

function firstWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const delta = (weekday - first.getUTCDay() + 7) % 7;
  return dateKey(year, month, 1 + delta);
}

function nextFirstWeekday(
  schedule: JsonRecord,
  weekday: number,
  now: Date,
): string {
  const parts = localParts(now, scheduleOffsetMinutes(schedule));
  const current = firstWeekdayOfMonth(parts.year, parts.month, weekday);
  const today = dateKey(parts.year, parts.month, parts.day);
  if (today <= current) return current;
  const nextMonth = new Date(Date.UTC(parts.year, parts.month, 1));
  return firstWeekdayOfMonth(
    nextMonth.getUTCFullYear(),
    nextMonth.getUTCMonth() + 1,
    weekday,
  );
}

function monthlyDateForRule(
  schedule: JsonRecord,
  rule: unknown,
  now: Date,
): string | null {
  const weekday = MONTHLY_RULE_WEEKDAYS[safeString(rule, 40) || ""];
  return Number.isInteger(weekday)
    ? nextFirstWeekday(schedule, weekday, now)
    : null;
}

function nextWeeklyDate(
  schedule: JsonRecord,
  item: JsonRecord,
  day: number,
  now: Date,
): string {
  const offset = scheduleOffsetMinutes(schedule);
  const parts = localParts(now, offset);
  const current = dateKey(parts.year, parts.month, parts.day);
  const start = parseTime(item.startTime);
  const end = parseTime(item.endTime);
  const nowMinutes = parts.hour * 60 + parts.minute;
  const startMinutes = start.hour * 60 + start.minute;
  const endMinutes = end.hour * 60 + end.minute;
  let delta = (day - parts.weekday + 7) % 7;

  if (delta === 0) {
    const stillUpcoming = endMinutes <= startMinutes
      ? nowMinutes < 24 * 60
      : nowMinutes < endMinutes;
    if (!stillUpcoming) delta = 7;
  }

  return addDays(current, delta);
}

function scheduleEventFromDate(
  schedule: JsonRecord,
  key: string,
  item: JsonRecord,
  localDate: string,
): ScheduleEvent | null {
  const title = safeString(item.title, 100);
  const websiteLocation = safeString(item.location, 300) || siteUrl("events");
  const location = safeString(item.discordLocation, 100) ||
    safeString(item.location, 100) || siteUrl("events");
  const startTime = safeString(item.startTime, 20) || "00:00";
  const endTime = safeString(item.endTime, 20) || "01:00";
  const offset = scheduleOffsetMinutes(schedule);
  const endDate = eventEndDate(localDate, startTime, endTime);
  const startIso = localToUtcIso(localDate, startTime, offset);
  const endIso = localToUtcIso(endDate, endTime, offset);

  if (!title || !startIso || !endIso) return null;

  return {
    key,
    title,
    description:
      safeString(item.description || item.summary || item.timeText, 1000) ||
      title,
    location,
    websiteLocation,
    startIso,
    endIso,
    coverImageUrl: scheduleAssetUrl(
      item.discordCoverImage,
      schedule.discordCoverVersion,
    ),
    canonicalEventId: snowflake(item.discordEventId),
    duplicateEventIds: asArray(item.discordDuplicateEventIds).map(snowflake)
      .filter((id): id is string => Boolean(id)),
    recurrenceRule: recurrenceRule(item.discordRecurrenceRule, startIso),
  };
}

function eventSlotKey(event: ScheduleEvent): string {
  return [event.startIso, event.endIso, event.websiteLocation].join("\n");
}

export function desiredEventsFromSchedule(
  schedule: JsonRecord,
  now = new Date(),
): ScheduleEvent[] {
  const monthly = asRecord(schedule.monthly);
  const events: ScheduleEvent[] = [];

  Object.entries(monthly).forEach(([fallbackKey, value]) => {
    const item = asRecord(value);
    const key = safeString(item.id, 80) || fallbackKey;
    const localDate = monthlyDateForRule(schedule, item.rule, now);
    if (!localDate) return;
    const event = scheduleEventFromDate(schedule, key, item, localDate);
    if (event) events.push(event);
  });

  const monthlySlots = new Set(events.map(eventSlotKey));

  asArray(schedule.weekly).map(asRecord).forEach((item) => {
    if (item.discord !== true) return;
    const key = safeString(item.id, 80);
    if (!key) return;
    asArray(item.days)
      .map((day) => Number(day))
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      .forEach((day) => {
        let localDate = nextWeeklyDate(schedule, item, day, now);
        let event = scheduleEventFromDate(
          schedule,
          `${key}-${day}`,
          item,
          localDate,
        );
        if (event && monthlySlots.has(eventSlotKey(event))) {
          localDate = addDays(localDate, 7);
          event = scheduleEventFromDate(
            schedule,
            `${key}-${day}`,
            item,
            localDate,
          );
        }
        if (event) events.push(event);
      });
  });

  return events;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export async function eventCoverImageData(
  url: string,
  userAgent = "Mochirii-Reaper-RankSync/1.0",
): Promise<string> {
  const trustedUrl = exactHttpsUrl(url, {
    allowedOrigins: WEBSITE_ORIGINS,
    pathPrefix: "/assets/",
    allowedSearchParams: EVENT_COVER_SEARCH_PARAMS,
  });
  if (!trustedUrl) throw new Error("Event cover image URL is not allowed.");

  const cached = eventCoverImageCache.get(trustedUrl);
  if (cached) return cached;

  const response = await fetchWithTimeout(
    trustedUrl,
    {
      headers: {
        Accept: "image/png,image/jpeg,image/webp",
        "User-Agent": userAgent,
      },
    },
    { timeoutMs: EVENT_COVER_FETCH_TIMEOUT_MS },
  );
  const contentType = normalizedMime(response.headers.get("Content-Type"));
  if (!response.ok || !contentType) {
    throw new Error(
      `Event cover image fetch failed with HTTP ${response.status}.`,
    );
  }

  const bytes = await readBoundedResponseBytes(
    response,
    GALLERY_SOURCE_IMAGE_MAX_BYTES,
  );
  if (!bytes.length) {
    throw new Error("Event cover image fetch returned an empty file.");
  }
  const validation = await validateGallerySourceBytes(bytes, contentType);
  if (!validation.ok) {
    throw new Error("Event cover image validation failed.");
  }

  const data = `data:${contentType};base64,${bytesToBase64(bytes)}`;
  eventCoverImageCache.set(trustedUrl, data);
  return data;
}

export async function scheduledEventBody(
  desired: ScheduleEvent,
  includeImage: boolean,
  options: { userAgent?: string } = {},
): Promise<JsonRecord> {
  const body: JsonRecord = {
    channel_id: null,
    name: desired.title.slice(0, 100),
    description: desired.description.slice(0, 1000),
    scheduled_start_time: desired.startIso,
    scheduled_end_time: desired.endIso,
    privacy_level: DISCORD_EVENT_PRIVACY_GUILD_ONLY,
    entity_type: DISCORD_EVENT_ENTITY_EXTERNAL,
    entity_metadata: {
      location: desired.location.slice(0, 100),
    },
  };

  if (desired.recurrenceRule) body.recurrence_rule = desired.recurrenceRule;
  if (includeImage && desired.coverImageUrl) {
    body.image = await eventCoverImageData(
      desired.coverImageUrl,
      options.userAgent,
    );
  }

  return body;
}

export function eventLocation(event: JsonRecord): string {
  return safeString(asRecord(event.entity_metadata).location, 100) || "";
}

export function managedEventLine(
  action: string,
  desired: ScheduleEvent,
  detail = "",
): string {
  return detail
    ? `${action}: ${desired.title} (${detail})`
    : `${action}: ${desired.title}`;
}
