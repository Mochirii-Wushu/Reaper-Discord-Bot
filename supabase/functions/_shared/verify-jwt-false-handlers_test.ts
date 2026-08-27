import { readBoundedUtf8RequestBody } from "./bounded-request-body.ts";
import { readBoundedJsonObject } from "./spinner-discord-outbox.ts";
import { createPublishMemberSpotlightWinnerHandler } from "../publish-member-spotlight-winner/index.ts";
import { createReaperDiscordInteractionsHandler } from "../reaper-discord-interactions/index.ts";
import {
  createReaperDiscordMemberSyncHandler,
  memberSyncDiagnosticExtra,
} from "../reaper-discord-member-sync/index.ts";
import { createReaperSpinnerDispatchHandler } from "../reaper-spinner-dispatch/index.ts";
import { createSendMemberSpotlightPollHandler } from "../send-member-spotlight-poll/index.ts";
import { createSendVoteReminderHandler } from "../send-vote-reminder/index.ts";
import type { DiscordInteractionReplayAdapter } from "./discord-interaction-replay.ts";

type JsonRecord = Record<string, unknown>;
type Handler = (req: Request) => Promise<Response>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const SHARED_SECRET = "s".repeat(32);
const syntheticUrl = "https://edge-function.example/handler";

async function parseRequestJson(
  req: Request,
  events: string[],
): Promise<JsonRecord> {
  events.push("parse");
  const text = await req.text();
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object.");
  }
  return value as JsonRecord;
}

type SecretHandlerBuilder = (
  events: string[],
) => Handler;

function registerSecretHandlerMatrix(
  name: string,
  headerName: string,
  build: SecretHandlerBuilder,
): void {
  Deno.test(`${name} authenticates before parsing or effects`, async () => {
    const unauthorizedEvents: string[] = [];
    const unauthorized = await build(unauthorizedEvents)(
      new Request(
        syntheticUrl,
        {
          method: "POST",
          headers: { [headerName]: "x".repeat(32) },
          body: "{",
        },
      ),
    );
    assert(unauthorized.status === 401, `${name} unauthorized status`);
    assert(
      JSON.stringify(unauthorizedEvents) === JSON.stringify(["authenticate"]),
      `${name} parsed or acted before authentication`,
    );

    const malformedEvents: string[] = [];
    const malformed = await build(malformedEvents)(
      new Request(syntheticUrl, {
        method: "POST",
        headers: { [headerName]: SHARED_SECRET },
        body: "{",
      }),
    );
    assert(malformed.status === 400, `${name} malformed status`);
    assert(
      JSON.stringify(malformedEvents) ===
        JSON.stringify(["authenticate", "parse"]),
      `${name} malformed input reached an effect`,
    );

    const validEvents: string[] = [];
    const valid = await build(validEvents)(
      new Request(syntheticUrl, {
        method: "POST",
        headers: { [headerName]: SHARED_SECRET },
        body: "{}",
      }),
    );
    assert(valid.status === 202, `${name} valid status`);
    assert(
      JSON.stringify(validEvents) ===
        JSON.stringify(["authenticate", "parse", "effect"]),
      `${name} valid handler ordering drifted`,
    );
  });
}

registerSecretHandlerMatrix(
  "send-vote-reminder",
  "x-mochirii-vote-reminder-secret",
  (events) =>
    createSendVoteReminderHandler({
      runtimeReady: () => true,
      withCors: async (_req, response) => response,
      cronSecret: () => SHARED_SECRET,
      authenticate: async (provided, expected) => {
        events.push("authenticate");
        return provided === expected;
      },
      parseBody: (req) => parseRequestJson(req, events),
      authorizedEffect: () => {
        events.push("effect");
        return new Response(null, { status: 202 });
      },
    }),
);

registerSecretHandlerMatrix(
  "send-member-spotlight-poll",
  "x-mochirii-spotlight-poll-secret",
  (events) =>
    createSendMemberSpotlightPollHandler({
      runtimeReady: () => true,
      withCors: async (_req, response) => response,
      config: () => ({
        guildId: "900000000000000004",
        channelId: "900000000000000014",
        secret: SHARED_SECRET,
        ready: true,
      }),
      authenticate: async (provided, expected) => {
        events.push("authenticate");
        return provided === expected;
      },
      parseBody: (req) => parseRequestJson(req, events),
      authorizedEffect: () => {
        events.push("effect");
        return new Response(null, { status: 202 });
      },
    }),
);

registerSecretHandlerMatrix(
  "publish-member-spotlight-winner",
  "x-mochirii-spotlight-poll-secret",
  (events) =>
    createPublishMemberSpotlightWinnerHandler({
      runtimeReady: () => true,
      withCors: async (_req, response) => response,
      config: () => ({
        guildId: "900000000000000004",
        channelId: "900000000000000014",
        secret: SHARED_SECRET,
        ready: true,
      }),
      authenticate: async (provided, expected) => {
        events.push("authenticate");
        return provided === expected;
      },
      parseBody: (req) => parseRequestJson(req, events),
      authorizedEffect: () => {
        events.push("effect");
        return new Response(null, { status: 202 });
      },
    }),
);

Deno.test("reaper-discord-member-sync HTTP boundary gates parse and effects", async () => {
  function build(events: string[]): Handler {
    return createReaperDiscordMemberSyncHandler({
      runtimeReady: () => true,
      authenticate: async (req) => {
        events.push("authenticate");
        return req.headers.get("x-mochirii-reaper-member-sync-secret") ===
          SHARED_SECRET;
      },
      discordReady: () => true,
      readBody: async (req) => {
        events.push("read");
        return readBoundedUtf8RequestBody(req, 16 * 1024);
      },
      parseBody: (text) => {
        events.push("parse");
        const value = JSON.parse(text) as JsonRecord;
        if (value.event_type !== "guildMemberAdd") {
          throw new Error("Synthetic malformed member event.");
        }
        return {
          event_type: "guildMemberAdd",
          guild_id: "900000000000000004",
          discord_user_id: "900000000000000015",
          roles: [],
          gateway_sequence: null,
          occurred_at: null,
        };
      },
      authorizedEffect: (_req, payload) => {
        events.push("effect");
        return new Response(
          JSON.stringify(memberSyncDiagnosticExtra(payload)),
          {
            status: 202,
          },
        );
      },
    });
  }

  const unauthorizedEvents: string[] = [];
  const unauthorized = await build(unauthorizedEvents)(
    new Request(
      syntheticUrl,
      {
        method: "POST",
        headers: {
          "x-mochirii-reaper-member-sync-secret": "x".repeat(32),
        },
        body: "{",
      },
    ),
  );
  assert(unauthorized.status === 401, "member sync unauthorized status");
  assert(
    JSON.stringify(unauthorizedEvents) === JSON.stringify(["authenticate"]),
    "member sync unauthorized request reached its body",
  );

  const malformedEvents: string[] = [];
  const malformed = await build(malformedEvents)(
    new Request(syntheticUrl, {
      method: "POST",
      headers: { "x-mochirii-reaper-member-sync-secret": SHARED_SECRET },
      body: "{}",
    }),
  );
  assert(malformed.status === 500, "member sync malformed status");
  assert(
    JSON.stringify(malformedEvents) ===
      JSON.stringify(["authenticate", "read", "parse"]),
    `member sync malformed ordering drifted: ${
      JSON.stringify(malformedEvents)
    }`,
  );

  const validEvents: string[] = [];
  const valid = await build(validEvents)(
    new Request(syntheticUrl, {
      method: "POST",
      headers: { "x-mochirii-reaper-member-sync-secret": SHARED_SECRET },
      body: '{"event_type":"guildMemberAdd"}',
    }),
  );
  assert(valid.status === 202, "member sync valid status");
  const validBody = await valid.text();
  assert(
    !validBody.includes("900000000000000015") &&
      validBody.includes("gateway_member_event"),
    "member sync handler diagnostics exposed a Discord user ID",
  );
  assert(
    JSON.stringify(validEvents) === JSON.stringify([
      "authenticate",
      "read",
      "parse",
      "effect",
    ]),
    "member sync valid handler ordering drifted",
  );
});

Deno.test("reaper-spinner-dispatch dispatcher secret gates parse and effects", async () => {
  function build(events: string[]): Handler {
    return createReaperSpinnerDispatchHandler({
      runtimeReady: () => true,
      withCors: async (_req, response) => response,
      configuration: () => ({
        dispatchSecret: SHARED_SECRET,
        supabaseUrl: "https://database.example",
        serviceRoleKey: "synthetic-service-role",
        configuredChannelId: Deno.env.get("DISCORD_RAFFLE_CHANNEL_ID") || "",
        botToken: "synthetic-discord-token",
      }),
      createAdminClient: () => {
        throw new Error("test effect seam must precede client creation");
      },
      authenticate: async (provided, expected) => {
        events.push("authenticate");
        return provided === expected;
      },
      readBody: async (req) => {
        events.push("parse");
        return readBoundedJsonObject(req);
      },
      authorizedEffect: () => {
        events.push("effect");
        return new Response(null, { status: 202 });
      },
    });
  }

  const unauthorizedEvents: string[] = [];
  const unauthorized = await build(unauthorizedEvents)(
    new Request(
      syntheticUrl,
      {
        method: "POST",
        headers: { "x-mochirii-reaper-spinner-secret": "x".repeat(32) },
        body: "{",
      },
    ),
  );
  assert(unauthorized.status === 404, "spinner unauthorized status");
  assert(
    JSON.stringify(unauthorizedEvents) === JSON.stringify(["authenticate"]),
    "spinner unauthorized request reached parsing or effects",
  );

  const malformedEvents: string[] = [];
  const malformed = await build(malformedEvents)(
    new Request(syntheticUrl, {
      method: "POST",
      headers: { "x-mochirii-reaper-spinner-secret": SHARED_SECRET },
      body: "{",
    }),
  );
  assert(malformed.status === 400, "spinner malformed status");
  assert(
    JSON.stringify(malformedEvents) ===
      JSON.stringify(["authenticate", "parse"]),
    "spinner malformed request reached effects",
  );

  const validEvents: string[] = [];
  const valid = await build(validEvents)(
    new Request(syntheticUrl, {
      method: "POST",
      headers: { "x-mochirii-reaper-spinner-secret": SHARED_SECRET },
      body: "{}",
    }),
  );
  assert(valid.status === 202, "spinner valid status");
  assert(
    JSON.stringify(validEvents) ===
      JSON.stringify(["authenticate", "parse", "effect"]),
    "spinner valid handler ordering drifted",
  );
});

Deno.test("reaper-spinner-dispatch capability gates parse and effects", async () => {
  function build(events: string[], capabilityAccepted: boolean): Handler {
    return createReaperSpinnerDispatchHandler({
      runtimeReady: () => true,
      withCors: async (_req, response) => response,
      configuration: () => ({
        dispatchSecret: SHARED_SECRET,
        supabaseUrl: "https://database.example",
        serviceRoleKey: "synthetic-service-role",
        configuredChannelId: Deno.env.get("DISCORD_RAFFLE_CHANNEL_ID") || "",
        botToken: "synthetic-discord-token",
      }),
      createAdminClient: () => {
        throw new Error("test effect seam must precede client creation");
      },
      verifyCapability: async () => {
        events.push("authenticate");
        return capabilityAccepted ? {} as never : null;
      },
      readBody: async (req) => {
        events.push("parse");
        return readBoundedJsonObject(req);
      },
      authorizedEffect: () => {
        events.push("effect");
        return new Response(null, { status: 202 });
      },
    });
  }
  const headers = {
    "content-type": "application/json",
    "x-mochirii-spinner-media-capability": "synthetic-capability",
  };

  const unauthorizedEvents: string[] = [];
  const unauthorized = await build(unauthorizedEvents, false)(
    new Request(
      syntheticUrl,
      { method: "POST", headers, body: "{" },
    ),
  );
  assert(unauthorized.status === 404, "capability unauthorized status");
  assert(
    JSON.stringify(unauthorizedEvents) === JSON.stringify(["authenticate"]),
    "invalid capability reached parsing or effects",
  );

  const malformedEvents: string[] = [];
  const malformed = await build(malformedEvents, true)(
    new Request(
      syntheticUrl,
      { method: "POST", headers, body: "{" },
    ),
  );
  assert(malformed.status === 404, "capability malformed status");
  assert(
    JSON.stringify(malformedEvents) ===
      JSON.stringify(["authenticate", "parse"]),
    "malformed capability request reached effects",
  );

  const validEvents: string[] = [];
  const valid = await build(validEvents, true)(
    new Request(syntheticUrl, {
      method: "POST",
      headers,
      body: '{"action":"manifest"}',
    }),
  );
  assert(valid.status === 202, "capability valid status");
  assert(
    JSON.stringify(validEvents) ===
      JSON.stringify(["authenticate", "parse", "effect"]),
    "capability valid handler ordering drifted",
  );
});

Deno.test("reaper-discord-interactions verifies bytes before parse and replay effects", async () => {
  function replayAdapter(events: string[]): DiscordInteractionReplayAdapter {
    return {
      bindingStatus: "durable-bound",
      async claim() {
        events.push("claim");
        return { status: "acquired", leaseToken: "synthetic_lease_0001" };
      },
      async complete() {
        events.push("complete");
        return true;
      },
      async recordFailure() {
        events.push("failure");
      },
    };
  }

  function build(events: string[]): Handler {
    return createReaperDiscordInteractionsHandler({
      runtimeReady: () => true,
      readBody: async (req) => {
        events.push("read");
        return readBoundedUtf8RequestBody(req, 64 * 1024);
      },
      publicKey: () => "synthetic-public-key",
      verifySignature: (req) => {
        events.push("authenticate");
        return req.headers.get("x-test-signature") === "valid";
      },
      parseBody: (text) => {
        events.push("parse");
        return JSON.parse(text) as JsonRecord;
      },
      replayAdapter: replayAdapter(events),
      authorizedEffect: () => {
        events.push("effect");
        return new Response(null, { status: 202 });
      },
    });
  }

  const unauthorizedEvents: string[] = [];
  const unauthorized = await build(unauthorizedEvents)(
    new Request(
      syntheticUrl,
      {
        method: "POST",
        headers: { "x-test-signature": "invalid" },
        body: "{",
      },
    ),
  );
  assert(unauthorized.status === 401, "interactions unauthorized status");
  assert(
    JSON.stringify(unauthorizedEvents) ===
      JSON.stringify(["read", "authenticate"]),
    "interactions parsed or acted before signature verification",
  );

  const malformedEvents: string[] = [];
  const malformed = await build(malformedEvents)(
    new Request(syntheticUrl, {
      method: "POST",
      headers: { "x-test-signature": "valid" },
      body: "{",
    }),
  );
  assert(malformed.status === 200, "interactions malformed response status");
  assert(
    JSON.stringify(malformedEvents) ===
      JSON.stringify(["read", "authenticate", "parse"]),
    "malformed interaction reached replay or effects",
  );

  const validEvents: string[] = [];
  const valid = await build(validEvents)(
    new Request(syntheticUrl, {
      method: "POST",
      headers: { "x-test-signature": "valid" },
      body: '{"type":2,"id":"900000000000000001"}',
    }),
  );
  assert(valid.status === 202, "interactions valid status");
  assert(
    JSON.stringify(validEvents) === JSON.stringify([
      "read",
      "authenticate",
      "parse",
      "claim",
      "effect",
      "complete",
    ]),
    "interactions valid handler ordering drifted",
  );
});

Deno.test("reaper-discord-interactions production replay binding is dormant", async () => {
  let effects = 0;
  const handler = createReaperDiscordInteractionsHandler({
    runtimeReady: () => true,
    readBody: (req) => readBoundedUtf8RequestBody(req, 64 * 1024),
    publicKey: () => "synthetic-public-key",
    verifySignature: () => true,
    parseBody: (text) => JSON.parse(text) as JsonRecord,
    authorizedEffect: () => {
      effects += 1;
      return new Response(null, { status: 202 });
    },
  });
  const response = await handler(
    new Request(syntheticUrl, {
      method: "POST",
      body: '{"type":2,"id":"900000000000000001"}',
    }),
  );
  assert(response.status === 503, "dormant replay binding must return 503");
  assert(effects === 0, "dormant replay binding reached an effect");
});
