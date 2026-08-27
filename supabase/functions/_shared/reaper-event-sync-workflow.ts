import {
  asArray,
  asRecord,
  type JsonRecord,
  safeString,
} from "./discord-interaction-helpers.ts";
import {
  desiredEventsFromSchedule,
  DISCORD_EVENT_ENTITY_EXTERNAL,
  eventLocation,
  managedEventLine,
  scheduledEventBody,
  type ScheduleEvent,
} from "./reaper-discord-events.ts";
import {
  exactHttpsUrl,
  fetchWithTimeout,
  readBoundedResponseJson,
} from "./outbound-http.ts";
import { discordWebUrl, SITE_ORIGIN } from "./runtime-config.ts";

type SupabaseAdminClient = {
  from(table: string): any;
};

type DiscordApiResult = {
  ok: boolean;
  status: number;
  data: unknown;
};

export type ReaperEventSyncDependencies = {
  expectedGuildId: string;
  guildScheduleUrl: string;
  discordApiUserAgent: string;
  discordApi(path: string, init?: RequestInit): Promise<DiscordApiResult>;
  discordApiHeaders(contentType?: boolean): Headers;
  editOriginalInteractionResponse(
    applicationId: string,
    interactionToken: string,
    content: string,
  ): Promise<void>;
  serviceAdminClient(purpose: string): SupabaseAdminClient;
  fetcher?: typeof fetch;
};

const GUILD_SCHEDULE_TIMEOUT_MS = 10_000;
const GUILD_SCHEDULE_MAX_RESPONSE_BYTES = 256 * 1024;
const WEBSITE_ORIGINS = new Set([SITE_ORIGIN]);

export function trustedGuildScheduleUrl(value: unknown): string | null {
  return exactHttpsUrl(value, {
    allowedOrigins: WEBSITE_ORIGINS,
    exactPathname: "/data/guild-schedule.json",
  });
}

function validatedGuildSchedule(value: unknown): JsonRecord {
  const schedule = asRecord(value);
  const timezone = asRecord(schedule.timezone);
  const monthly = asRecord(schedule.monthly);
  const weekly = schedule.weekly;
  const offsetMinutes = Number(timezone.offsetMinutes);
  if (
    !Object.keys(schedule).length || !Object.keys(timezone).length ||
    !Number.isInteger(offsetMinutes) || offsetMinutes < -840 ||
    offsetMinutes > 840 || !Object.keys(monthly).length ||
    Object.keys(monthly).length > 32 || !Array.isArray(weekly) ||
    weekly.length > 32
  ) throw new Error("Website schedule response was invalid.");
  return schedule;
}

export async function fetchGuildSchedule(
  deps: ReaperEventSyncDependencies,
): Promise<JsonRecord> {
  const scheduleUrl = trustedGuildScheduleUrl(deps.guildScheduleUrl);
  if (!scheduleUrl) throw new Error("Website schedule URL is not allowed.");
  const response = await fetchWithTimeout(
    scheduleUrl,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": deps.discordApiUserAgent,
      },
    },
    { fetcher: deps.fetcher, timeoutMs: GUILD_SCHEDULE_TIMEOUT_MS },
  );

  if (!response.ok) {
    throw new Error(`Schedule fetch failed with HTTP ${response.status}.`);
  }
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]
    ?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new Error("Website schedule response type was invalid.");
  }

  return validatedGuildSchedule(
    await readBoundedResponseJson(
      response,
      GUILD_SCHEDULE_MAX_RESPONSE_BYTES,
    ),
  );
}

async function loadManagedEventResources(
  deps: ReaperEventSyncDependencies,
): Promise<JsonRecord[]> {
  const adminClient = deps.serviceAdminClient("event registry lookup");
  const { data, error } = await adminClient
    .from("discord_resources")
    .select("id,label,discord_id,metadata,enabled")
    .eq("kind", "scheduled_event")
    .eq("enabled", true);

  if (error) {
    console.error(
      "reaper-discord-interactions scheduled event registry lookup failed",
      {
        code: error.code,
        errorType: "database_read_failed",
      },
    );
    throw new Error("Scheduled event registry could not be read.");
  }

  return asArray(data).map(asRecord).filter((resource) => {
    const metadata = asRecord(resource.metadata);
    return metadata.managedBy === "reaper-event-sync";
  });
}

export function indexManagedEventResources(
  resources: JsonRecord[],
): Map<string, JsonRecord> {
  const indexed = new Map<string, JsonRecord>();
  for (const resource of resources) {
    const key = safeString(asRecord(resource.metadata).siteEventKey, 100);
    if (!key) continue;
    if (indexed.has(key)) {
      throw new Error(
        `Multiple enabled managed event resources exist for ${key}.`,
      );
    }
    indexed.set(key, resource);
  }
  return indexed;
}

export function selectExistingScheduledEvent(
  existingEvents: JsonRecord[],
  desired: ScheduleEvent,
  resource: JsonRecord | undefined,
): JsonRecord | null {
  const resourceEventId = safeString(resource?.discord_id, 24);
  const explicitIds = [
    ...new Set(
      [desired.canonicalEventId, resourceEventId].filter((
        value,
      ): value is string => Boolean(value)),
    ),
  ];
  const explicitMatches = existingEvents.filter((event) =>
    explicitIds.includes(safeString(event.id, 24) || "")
  );
  const exactMatches = existingEvents.filter((event) =>
    safeString(event.name, 100) === desired.title &&
    safeString(event.scheduled_start_time, 60) === desired.startIso &&
    Number(event.entity_type) === DISCORD_EVENT_ENTITY_EXTERNAL &&
    eventLocation(event) === desired.location
  );

  const explicitMatchIds = new Set(
    explicitMatches.map((event) => safeString(event.id, 24)).filter(Boolean),
  );
  const exactMatchIds = new Set(
    exactMatches.map((event) => safeString(event.id, 24)).filter(Boolean),
  );
  if (explicitMatchIds.size > 1 || exactMatchIds.size > 1) {
    throw new Error(
      `Discord scheduled event identity is ambiguous for ${desired.key}.`,
    );
  }

  const explicit = explicitMatches[0] || null;
  const exact = exactMatches[0] || null;
  if (
    explicit && exact &&
    safeString(explicit.id, 24) !== safeString(exact.id, 24)
  ) {
    throw new Error(
      `Discord scheduled event identity conflicts for ${desired.key}.`,
    );
  }

  return explicit || exact;
}

export function supersededManagedEventResources(
  resources: JsonRecord[],
  currentEventId: string,
): JsonRecord[] {
  return resources.filter((resource) => {
    const resourceEventId = safeString(resource.discord_id, 24);
    return resourceEventId && resourceEventId !== currentEventId;
  });
}

async function retireSupersededEventResources(
  deps: ReaperEventSyncDependencies,
  resources: JsonRecord[],
  currentEventId: string,
  desired: ScheduleEvent,
): Promise<void> {
  const superseded = supersededManagedEventResources(resources, currentEventId);
  if (!superseded.length) return;

  const adminClient = deps.serviceAdminClient(
    "superseded event registry updates",
  );
  for (const resource of superseded) {
    const resourceId = safeString(resource.id, 80);
    if (!resourceId) {
      throw new Error("Superseded scheduled event registry id is missing.");
    }
    const { error } = await adminClient
      .from("discord_resources")
      .update({
        enabled: false,
        description: `Retired superseded scheduled event for ${desired.title}.`,
        metadata: {
          ...asRecord(resource.metadata),
          supersededBy: currentEventId,
          retiredBy: "reaper-event-sync",
          retiredReason: "superseded-managed-event",
          retiredAt: new Date().toISOString(),
        },
      })
      .eq("id", resourceId)
      .eq("kind", "scheduled_event")
      .eq("enabled", true);

    if (error) {
      console.error(
        "reaper-discord-interactions superseded event registry update failed",
        {
          code: error.code,
          errorType: "database_update_failed",
        },
      );
      throw new Error(
        "Scheduled event was recorded but its superseded registry row could not be retired.",
      );
    }
  }
}

async function upsertDiscordEventResource(
  deps: ReaperEventSyncDependencies,
  event: JsonRecord,
  desired: ScheduleEvent,
  priorResources: JsonRecord[],
): Promise<void> {
  const eventId = safeString(event.id, 24);

  if (!eventId) {
    throw new Error("Discord scheduled event id is missing.");
  }

  const adminClient = deps.serviceAdminClient("event registry updates");
  const { error } = await adminClient
    .from("discord_resources")
    .upsert(
      {
        kind: "scheduled_event",
        label: desired.title,
        discord_id: eventId,
        discord_parent_id: deps.expectedGuildId,
        enabled: true,
        url: discordWebUrl(`events/${deps.expectedGuildId}/${eventId}`),
        description: desired.description,
        metadata: {
          managedBy: "reaper-event-sync",
          siteEventKey: desired.key,
          location: desired.location,
          websiteLocation: desired.websiteLocation,
          coverImageUrl: desired.coverImageUrl,
          canonicalEventId: desired.canonicalEventId,
          recurrenceRule: desired.recurrenceRule,
          source: "data/guild-schedule.json",
          startIso: desired.startIso,
          endIso: desired.endIso,
          entityType: "EXTERNAL",
        },
      },
      { onConflict: "kind,discord_id" },
    );

  if (error) {
    console.error(
      "reaper-discord-interactions scheduled event registry upsert failed",
      {
        code: error.code,
        errorType: "database_upsert_failed",
      },
    );
    throw new Error(
      "Scheduled event was changed but could not be recorded in the website registry.",
    );
  }

  await retireSupersededEventResources(deps, priorResources, eventId, desired);
}

async function disableDuplicateEventResource(
  deps: ReaperEventSyncDependencies,
  eventId: string,
  desired: ScheduleEvent,
): Promise<void> {
  const adminClient = deps.serviceAdminClient(
    "duplicate event registry updates",
  );
  const { error } = await adminClient
    .from("discord_resources")
    .update({
      enabled: false,
      description: `Retired duplicate scheduled event for ${desired.title}.`,
      metadata: {
        managedBy: "reaper-event-sync",
        siteEventKey: desired.key,
        duplicateOf: desired.canonicalEventId,
        retiredBy: "reaper-event-sync",
        retiredReason: "duplicate-monthly-raffle",
        retiredAt: new Date().toISOString(),
      },
    })
    .eq("kind", "scheduled_event")
    .eq("discord_id", eventId);

  if (error) {
    console.error(
      "reaper-discord-interactions duplicate scheduled event registry update failed",
      {
        code: error.code,
        errorType: "database_update_failed",
      },
    );
    throw new Error(
      "Duplicate scheduled event was removed but could not be retired in the website registry.",
    );
  }
}

async function processDuplicateScheduledEvents(
  deps: ReaperEventSyncDependencies,
  apply: boolean,
  desired: ScheduleEvent,
  existingEvents: JsonRecord[],
  lines: string[],
): Promise<void> {
  for (const duplicateId of desired.duplicateEventIds) {
    if (!duplicateId || duplicateId === desired.canonicalEventId) continue;
    const existingDuplicate = existingEvents.find((event) =>
      safeString(event.id, 24) === duplicateId
    );
    if (!existingDuplicate) {
      lines.push(
        managedEventLine(
          "Duplicate already absent",
          desired,
          `event ${duplicateId}`,
        ),
      );
      continue;
    }

    lines.push(
      managedEventLine(
        apply ? "Removed duplicate" : "Would remove duplicate",
        desired,
        `event ${duplicateId}`,
      ),
    );
    if (!apply) continue;

    const response = await deps.discordApi(
      `/guilds/${deps.expectedGuildId}/scheduled-events/${duplicateId}`,
      {
        method: "DELETE",
        headers: deps.discordApiHeaders(),
      },
    );
    if (!response.ok) {
      lines[lines.length - 1] = managedEventLine(
        "Blocked duplicate removal",
        desired,
        `Discord API ${response.status}`,
      );
      continue;
    }
    await disableDuplicateEventResource(deps, duplicateId, desired);
  }
}

export async function processEventSync(
  mode: string,
  interactionToken: string,
  applicationId: string,
  deps: ReaperEventSyncDependencies,
): Promise<void> {
  const apply = mode === "apply";
  const lines: string[] = [];

  try {
    if (!Deno.env.get("DISCORD_BOT_TOKEN")) {
      await deps.editOriginalInteractionResponse(
        applicationId,
        interactionToken,
        "Reaper event sync is missing the Discord bot token.",
      );
      return;
    }

    const schedule = await fetchGuildSchedule(deps);
    const desiredEvents = desiredEventsFromSchedule(schedule);
    if (!desiredEvents.length) {
      await deps.editOriginalInteractionResponse(
        applicationId,
        interactionToken,
        "Reaper event sync found no website schedule events.",
      );
      return;
    }

    const [resources, eventsResponse] = await Promise.all([
      loadManagedEventResources(deps),
      deps.discordApi(`/guilds/${deps.expectedGuildId}/scheduled-events`, {
        headers: deps.discordApiHeaders(),
      }),
    ]);

    if (!eventsResponse.ok) {
      await deps.editOriginalInteractionResponse(
        applicationId,
        interactionToken,
        "Reaper could not read Discord scheduled events. Check bot event permissions.",
      );
      return;
    }

    const existingEvents = asArray(eventsResponse.data).map(asRecord);
    const resourceByKey = indexManagedEventResources(resources);
    const resolutions = desiredEvents.map((desired) => {
      const resource = resourceByKey.get(desired.key);
      return {
        desired,
        resource,
        existing: selectExistingScheduledEvent(
          existingEvents,
          desired,
          resource,
        ),
      };
    });

    for (const { desired, resource, existing } of resolutions) {
      const priorResources = resource ? [resource] : [];

      if (existing) {
        lines.push(
          managedEventLine(
            apply ? "Updated" : "Would update",
            desired,
            `event ${safeString(existing.id, 24) || "unknown"}`,
          ),
        );
        if (apply) {
          let body: JsonRecord;
          try {
            body = await scheduledEventBody(desired, true, {
              userAgent: deps.discordApiUserAgent,
            });
          } catch {
            lines[lines.length - 1] = managedEventLine(
              "Blocked",
              desired,
              "cover image unavailable",
            );
            continue;
          }
          const response = await deps.discordApi(
            `/guilds/${deps.expectedGuildId}/scheduled-events/${
              safeString(existing.id, 24)
            }`,
            {
              method: "PATCH",
              headers: deps.discordApiHeaders(true),
              body: JSON.stringify(body),
            },
          );
          if (!response.ok) {
            lines[lines.length - 1] = managedEventLine(
              "Blocked",
              desired,
              `Discord API ${response.status}`,
            );
            continue;
          }
          await upsertDiscordEventResource(
            deps,
            asRecord(response.data),
            desired,
            priorResources,
          );
        }
        await processDuplicateScheduledEvents(
          deps,
          apply,
          desired,
          existingEvents,
          lines,
        );
        continue;
      }

      lines.push(
        managedEventLine(
          apply ? "Created" : "Would create",
          desired,
          "external scheduled event",
        ),
      );
      if (apply) {
        let body: JsonRecord;
        try {
          body = await scheduledEventBody(desired, true, {
            userAgent: deps.discordApiUserAgent,
          });
        } catch {
          lines[lines.length - 1] = managedEventLine(
            "Blocked",
            desired,
            "cover image unavailable",
          );
          continue;
        }
        const response = await deps.discordApi(
          `/guilds/${deps.expectedGuildId}/scheduled-events`,
          {
            method: "POST",
            headers: deps.discordApiHeaders(true),
            body: JSON.stringify(body),
          },
        );
        if (!response.ok) {
          lines[lines.length - 1] = managedEventLine(
            "Blocked",
            desired,
            `Discord API ${response.status}`,
          );
          continue;
        }
        await upsertDiscordEventResource(
          deps,
          asRecord(response.data),
          desired,
          priorResources,
        );
      }
      await processDuplicateScheduledEvents(
        deps,
        apply,
        desired,
        existingEvents,
        lines,
      );
    }

    const intro = apply
      ? "Event sync finished. Only Reaper-managed external Discord events were created or updated."
      : "Event sync preview. No Discord scheduled events were changed.";
    await deps.editOriginalInteractionResponse(
      applicationId,
      interactionToken,
      `${intro}\n${lines.slice(0, 25).join("\n")}`,
    );
  } catch {
    console.error("reaper-discord-interactions event sync failed", {
      errorType: "event_sync_failed",
    });
    await deps.editOriginalInteractionResponse(
      applicationId,
      interactionToken,
      "Reaper event sync could not be completed. Check configuration and try preview again.",
    );
  }
}
