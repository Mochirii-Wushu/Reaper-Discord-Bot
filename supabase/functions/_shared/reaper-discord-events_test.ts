import {
  desiredEventsFromSchedule,
  DISCORD_EVENT_ENTITY_EXTERNAL,
  DISCORD_EVENT_PRIVACY_GUILD_ONLY,
  eventCoverImageData,
  eventLocation,
  managedEventLine,
  recurrenceRule,
  scheduledEventBody,
} from "./reaper-discord-events.ts";
import {
  indexManagedEventResources,
  selectExistingScheduledEvent,
  supersededManagedEventResources,
} from "./reaper-event-sync-workflow.ts";
import { siteUrl } from "./public-origins.ts";

Deno.test("desiredEventsFromSchedule shapes monthly and weekly website schedule events", () => {
  const events = desiredEventsFromSchedule(
    {
      timezone: { offsetMinutes: 0 },
      discordCoverVersion: "v2",
      monthly: {
        gathering: {
          id: "monthly-gathering",
          title: "Monthly Gathering",
          rule: "next-first-wednesday",
          description: "Guild monthly gathering",
          location: siteUrl("events#gathering"),
          startTime: "21:30",
          endTime: "22:00",
          discordRecurrenceRule: {
            frequency: 1,
            interval: 1,
            by_n_weekday: [{ n: 1, day: 2 }],
          },
        },
        raffle: {
          id: "monthly-raffle",
          title: "Monthly Raffle",
          rule: "next-first-saturday",
          description: "Guild monthly raffle",
          location: siteUrl("events#raffle"),
          discordLocation: "Mochirii Hall",
          startTime: "20:00",
          endTime: "21:00",
          discordCoverImage: "assets/images/reaper.webp",
          discordEventId: "123456789012345678",
          discordDuplicateEventIds: ["223456789012345678", "bad"],
          discordRecurrenceRule: {
            frequency: 1,
            interval: 1,
            by_n_weekday: [{ n: 1, day: 6 }],
          },
        },
      },
      weekly: [
        {
          id: "training",
          discord: true,
          title: "Training",
          description: "Weekly training",
          location: siteUrl("events#training"),
          discordLocation: "Training Grounds",
          startTime: "22:00",
          endTime: "23:00",
          days: [5],
        },
      ],
    },
    new Date("2026-07-02T12:00:00.000Z"),
  );

  assertEquals(events.length, 3);

  const gathering = events.find((event) => event.key === "monthly-gathering");
  assert(gathering, "monthly gathering should exist");
  assertEquals(gathering.startIso, "2026-08-05T21:30:00.000Z");
  assertEquals(gathering.endIso, "2026-08-05T22:00:00.000Z");
  assertEquals(gathering.recurrenceRule?.by_n_weekday, [{ n: 1, day: 2 }]);

  const monthly = events.find((event) => event.key === "monthly-raffle");
  assert(monthly, "monthly event should exist");
  assertEquals(monthly.startIso, "2026-07-04T20:00:00.000Z");
  assertEquals(monthly.endIso, "2026-07-04T21:00:00.000Z");
  assertEquals(monthly.location, "Mochirii Hall");
  assertEquals(monthly.canonicalEventId, "123456789012345678");
  assertEquals(monthly.duplicateEventIds, ["223456789012345678"]);
  assert(
    monthly.coverImageUrl?.startsWith(
      siteUrl("assets/images/reaper.webp?v=v2"),
    ),
  );
  assertEquals(monthly.recurrenceRule?.start, monthly.startIso);

  const weekly = events.find((event) => event.key === "training-5");
  assert(weekly, "weekly event should exist");
  assertEquals(weekly.startIso, "2026-07-03T22:00:00.000Z");
  assertEquals(weekly.endIso, "2026-07-03T23:00:00.000Z");
});

Deno.test("the monthly gathering takes its exact slot and advances the colliding Guild Party event", () => {
  const events = desiredEventsFromSchedule(
    {
      timezone: { offsetMinutes: 480 },
      monthly: {
        gathering: {
          id: "monthly-gathering",
          title: "Monthly Guild Gathering",
          rule: "next-first-wednesday",
          location: siteUrl("events"),
          startTime: "21:30",
          endTime: "22:00",
          discordRecurrenceRule: {
            frequency: 1,
            interval: 1,
            by_n_weekday: [{ n: 1, day: 2 }],
          },
        },
      },
      weekly: [{
        id: "guild-party",
        discord: true,
        title: "Guild Party",
        location: siteUrl("events"),
        startTime: "21:30",
        endTime: "22:00",
        days: [3],
      }],
    },
    new Date("2026-08-04T14:00:00.000Z"),
  );

  assertEquals(events.map((event) => event.key), [
    "monthly-gathering",
    "guild-party-3",
  ]);
  const guildParty = events.find((event) => event.key === "guild-party-3");
  assertEquals(guildParty?.startIso, "2026-08-12T13:30:00.000Z");
  assertEquals(guildParty?.endIso, "2026-08-12T14:00:00.000Z");
});

Deno.test("scheduledEventBody preserves Discord event contract and limits text fields", async () => {
  const body = await scheduledEventBody(
    {
      key: "long",
      title: "T".repeat(120),
      description: "D".repeat(1_200),
      location: "L".repeat(140),
      websiteLocation: siteUrl("events"),
      startIso: "2026-07-04T20:00:00.000Z",
      endIso: "2026-07-04T21:00:00.000Z",
      coverImageUrl: null,
      canonicalEventId: null,
      duplicateEventIds: [],
      recurrenceRule: recurrenceRule(
        { frequency: 1, interval: 1 },
        "2026-07-04T20:00:00.000Z",
      ),
    },
    false,
  );

  assertEquals(body.channel_id, null);
  assertEquals(String(body.name).length, 100);
  assertEquals(String(body.description).length, 1_000);
  assertEquals(body.privacy_level, DISCORD_EVENT_PRIVACY_GUILD_ONLY);
  assertEquals(body.entity_type, DISCORD_EVENT_ENTITY_EXTERNAL);
  assertEquals(String(asRecord(body.entity_metadata).location).length, 100);
  assertEquals(
    asRecord(body.recurrence_rule).start,
    "2026-07-04T20:00:00.000Z",
  );
});

Deno.test("eventCoverImageData sends Discord-safe headers and rejects unsupported images", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; accept: string; userAgent: string }> = [];
  try {
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        url: String(input),
        accept: String(new Headers(init?.headers).get("Accept") || ""),
        userAgent: String(new Headers(init?.headers).get("User-Agent") || ""),
      });
      return Promise.resolve(
        new Response(Uint8Array.from(syntheticJpeg()).buffer, {
          headers: { "Content-Type": "image/jpeg" },
        }),
      );
    }) as typeof fetch;

    const data = await eventCoverImageData(
      siteUrl("assets/test-cover.jpg?v=valid"),
      "Mochirii-Test/1.0",
    );
    assert(data.startsWith("data:image/jpeg;base64,"));
    assertEquals(calls[0], {
      url: siteUrl("assets/test-cover.jpg?v=valid"),
      accept: "image/png,image/jpeg,image/webp",
      userAgent: "Mochirii-Test/1.0",
    });

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "text/html" },
        }),
      )) as typeof fetch;

    await assertRejects(
      () =>
        eventCoverImageData(
          siteUrl("assets/test-cover.html?v=invalid"),
          "Mochirii-Test/1.0",
        ),
      "unsupported content type should reject",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function syntheticJpeg(): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    0x00,
    0x01,
    0x00,
    0x01,
    0x03,
    0x01,
    0x11,
    0x00,
    0x02,
    0x11,
    0x00,
    0x03,
    0x11,
    0x00,
    0xff,
    0xda,
    0x00,
    0x0c,
    0x03,
    0x01,
    0x00,
    0x02,
    0x00,
    0x03,
    0x00,
    0x00,
    0x3f,
    0x00,
    0x01,
    0xff,
    0x00,
    0x02,
    0xff,
    0xd9,
  ]);
}

Deno.test("eventLocation and managedEventLine preserve Reaper summary formatting", () => {
  assertEquals(
    eventLocation({ entity_metadata: { location: "Training Grounds" } }),
    "Training Grounds",
  );
  assertEquals(
    managedEventLine("Updated", eventStub("Training"), "event 123"),
    "Updated: Training (event 123)",
  );
  assertEquals(
    managedEventLine("Created", eventStub("Training")),
    "Created: Training",
  );
});

Deno.test("managed event registry indexing fails closed on duplicate enabled mappings", () => {
  const resource = (id: string, discordId: string) => ({
    id,
    discord_id: discordId,
    metadata: {
      managedBy: "reaper-event-sync",
      siteEventKey: "monthly-gathering",
    },
  });

  assertThrows(() =>
    indexManagedEventResources([
      resource("row-1", "123456789012345678"),
      resource("row-2", "223456789012345678"),
    ]), "duplicate enabled registry mappings should reject");
});

Deno.test("scheduled event selection rejects ambiguous exact matches", () => {
  const desired = eventStub("Training");
  const matchingEvent = (id: string) => ({
    id,
    name: desired.title,
    scheduled_start_time: desired.startIso,
    entity_type: DISCORD_EVENT_ENTITY_EXTERNAL,
    entity_metadata: { location: desired.location },
  });

  assertThrows(
    () =>
      selectExistingScheduledEvent(
        [
          matchingEvent("123456789012345678"),
          matchingEvent("223456789012345678"),
        ],
        desired,
        undefined,
      ),
    "multiple exact Discord events should reject",
  );
});

Deno.test("superseded managed event resources exclude the current event", () => {
  const resources = [
    { id: "current-row", discord_id: "123456789012345678" },
    { id: "stale-row", discord_id: "223456789012345678" },
  ];

  assertEquals(
    supersededManagedEventResources(resources, "123456789012345678"),
    [{ id: "stale-row", discord_id: "223456789012345678" }],
  );
});

function eventStub(title: string) {
  return {
    key: "event",
    title,
    description: title,
    location: "Training Grounds",
    websiteLocation: siteUrl("events"),
    startIso: "2026-07-04T20:00:00.000Z",
    endIso: "2026-07-04T21:00:00.000Z",
    coverImageUrl: null,
    canonicalEventId: null,
    duplicateEventIds: [],
    recurrenceRule: null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function assert(condition: unknown, message?: string): asserts condition {
  if (!condition) throw new Error(message || "Expected assertion to pass.");
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }.`,
    );
  }
}

async function assertRejects(
  fn: () => Promise<unknown>,
  message: string,
): Promise<void> {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(message);
}

function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message);
}
