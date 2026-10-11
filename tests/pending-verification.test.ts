import { describe, expect, test } from "bun:test";
import { loadConfig, type ReaperConfig } from "../src/config.js";
import {
  createMemberSyncRequest, deliverMemberSyncRequest, memberRolesChanged, validateMemberSyncRequest,
  type PendingVerificationMemberLike, type FetchLike,
} from "../src/pending-verification.js";
import { SYNTHETIC_DISCORD_IDS } from "./discord-fixtures.js";

const baseConfig: ReaperConfig = {
  discordBotToken: "unused-offline", discordGuildId: SYNTHETIC_DISCORD_IDS.guild,
  galleryGatewayRollbackEnabled: false, welcomeDmEnabled: true,
  pendingVerificationSyncEnabled: true,
  pendingVerificationSyncUrl: "https://functions.example.test/functions/v1/reaper-discord-member-sync",
  pendingVerificationSyncSecret: "unused-offline-secret", pendingVerificationSyncTimeoutMs: 5000,
  pendingVerificationSyncMaxAttempts: 2,
};
const counts = { discordWrites: 1, dbWrites: 2, staleRecordsCleared: 0 };
const noWait = async () => undefined;
function member(roles: string[] = [SYNTHETIC_DISCORD_IDS.roleOne]): PendingVerificationMemberLike {
  return { guild: { id: SYNTHETIC_DISCORD_IDS.guild }, user: { id: SYNTHETIC_DISCORD_IDS.member },
    roles: { cache: new Map(roles.map((id) => [id, true])) } };
}
function reply(requestId: string, status: string, httpStatus?: number): Response {
  return Response.json({ ok: true, request_id: requestId, status,
    result: status === "completed" ? counts : null },
  { status: httpStatus ?? (["blocked", "rejected"].includes(status) ? 409 : 200) });
}
function scripted(handler: (method: string, id: string, init: RequestInit, call: number) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    const id = init.method === "POST" ? JSON.parse(String(init.body)).request_id
      : new URL(url).searchParams.get("request_id")!;
    return handler(init.method || "GET", id, init, calls.length);
  };
  return { calls, fetch };
}

describe("durable member forwarding protocol", () => {
  test("creates one canonical UUID-bound immutable request and snapshots role order", () => {
    const roles = [SYNTHETIC_DISCORD_IDS.roleTwo, SYNTHETIC_DISCORD_IDS.roleOne];
    const request = createMemberSyncRequest(member(roles), "guildMemberUpdate", 123);
    const body = JSON.parse(request.body);
    expect(request.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(body).toEqual({ request_id: request.requestId, event_type: "guildMemberUpdate",
      guild_id: SYNTHETIC_DISCORD_IDS.guild, discord_user_id: SYNTHETIC_DISCORD_IDS.member,
      roles: [...roles].sort(), gateway_sequence: 123, occurred_at: expect.any(String) });
    expect(validateMemberSyncRequest(request)).toEqual(request);
    for (const mutation of [
      { ...request, requestId: "00000000-0000-0000-0000-000000000000" },
      { ...request, body: request.body + " " },
      { ...request, body: JSON.stringify({ ...body, roles: [...body.roles, body.roles[0]] }) },
      { ...request, body: JSON.stringify({ ...body, gateway_sequence: -1 }) },
      { ...request, body: JSON.stringify({ ...body, discord_user_id: (2n ** 64n).toString() }) },
    ]) expect(() => validateMemberSyncRequest(mutation)).toThrow();
  });

  test("reads status before POST and accepts only strict completed receipts", async () => {
    const request = createMemberSyncRequest(member(), "guildMemberAdd");
    const mock = scripted((method, id) => reply(id, method === "GET" ? "missing" : "completed"));
    expect(await deliverMemberSyncRequest(request, baseConfig, mock.fetch, noWait)).toEqual({ status: "completed", result: counts });
    expect(mock.calls.map(({ init }) => init.method)).toEqual(["GET", "POST"]);
    expect(mock.calls[0]?.url).toBe(baseConfig.pendingVerificationSyncUrl + "/status?request_id=" + request.requestId);
    expect(mock.calls[0]?.init.body).toBeUndefined();
    expect(mock.calls[1]?.init.body).toBe(request.body);
    for (const { init } of mock.calls) {
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(init.headers).get("x-mochirii-reaper-member-sync-secret")).toBe(baseConfig.pendingVerificationSyncSecret);
    }
  });

  test("completed recovery performs no POST, even after a process restart", async () => {
    const request = createMemberSyncRequest(member(), "guildMemberUpdate");
    const mock = scripted((_method, id) => reply(id, "completed"));
    expect((await deliverMemberSyncRequest(request, baseConfig, mock.fetch)).status).toBe("completed");
    expect(mock.calls.map(({ init }) => init.method)).toEqual(["GET"]);
  });

  test("a lost POST acknowledgement is resolved by status without replay", async () => {
    for (const failure of ["network", "500", "408", "429", "malformed-success"]) {
      const request = createMemberSyncRequest(member(), "guildMemberUpdate");
      const mock = scripted((method, id, _init, call) => {
        if (call === 1) return reply(id, "missing");
        if (method === "GET") return reply(id, "completed");
        if (failure === "network") throw new TypeError("private response must not be logged");
        return failure === "malformed-success" ? Response.json({ ok: true, status: "preview" })
          : Response.json({ ok: false }, { status: Number(failure) });
      });
      expect((await deliverMemberSyncRequest(request, baseConfig, mock.fetch, noWait)).status).toBe("completed");
      expect(mock.calls.filter(({ init }) => init.method === "POST")).toHaveLength(1);
    }
  });

  test("resends only the exact original UUID/body after authenticated missing", async () => {
    const request = createMemberSyncRequest(member(), "guildMemberAdd");
    const mock = scripted((method, id, _init, call) => {
      if (method === "GET") return reply(id, "missing");
      if (call === 2) throw new TypeError("lost pre-acquisition wire");
      return reply(id, "completed");
    });
    expect((await deliverMemberSyncRequest(request, baseConfig, mock.fetch, noWait)).status).toBe("completed");
    const bodies = mock.calls.filter(({ init }) => init.method === "POST").map(({ init }) => init.body);
    expect(bodies).toEqual([request.body, request.body]);
  });

  test("busy waits within the declared budget, then recovers through status", async () => {
    const request = createMemberSyncRequest(member(), "guildMemberAdd");
    const waits: number[] = [];
    const mock = scripted((method, id, _init, call) => method === "GET" ? reply(id, "missing")
      : call === 2 ? Response.json({ ok: false, request_id: id, status: "busy", result: null, retry_after_ms: 1000 }, { status: 409 })
      : reply(id, "completed"));
    expect((await deliverMemberSyncRequest(request, baseConfig, mock.fetch, async (ms) => { waits.push(ms); })).status).toBe("completed");
    expect(waits).toEqual([1000]);
    expect(mock.calls.map(({ init }) => init.method)).toEqual(["GET", "POST", "GET", "POST"]);
  });

  test("reserved/writing stay pending and never admit POST or timed takeover", async () => {
    for (const state of ["reserved", "writing"]) {
      const request = createMemberSyncRequest(member(), "guildMemberAdd");
      const mock = scripted((_method, id) => reply(id, state));
      expect((await deliverMemberSyncRequest(request, baseConfig, mock.fetch, noWait)).status).toBe("pending");
      expect(mock.calls.map(({ init }) => init.method)).toEqual(["GET", "GET"]);
    }
  });

  test("disabled waits within its bound and recovers with the same immutable request", async () => {
    const request = createMemberSyncRequest(member(), "guildMemberAdd");
    const waits: number[] = [];
    const mock = scripted((method, id, _init, call) => method === "GET" ? reply(id, "missing")
      : call === 2 ? Response.json({ ok: false, request_id: id, status: "disabled", result: null, retry_after_ms: 1000 }, { status: 409 })
      : reply(id, "completed"));
    expect((await deliverMemberSyncRequest(request, baseConfig, mock.fetch, async (ms) => { waits.push(ms); })).status).toBe("completed");
    expect(waits).toEqual([1000]);
    expect(mock.calls.map(({ init }) => init.method)).toEqual(["GET", "POST", "GET", "POST"]);
    expect(mock.calls.filter(({ init }) => init.method === "POST").map(({ init }) => init.body)).toEqual([request.body, request.body]);
  });

  test("disabled remains pending when maintenance outlasts the bounded pass", async () => {
    const request = createMemberSyncRequest(member(), "guildMemberAdd");
    const waits: number[] = [];
    const mock = scripted((method, id) => method === "GET" ? reply(id, "missing")
      : Response.json({ ok: false, request_id: id, status: "disabled", result: null, retry_after_ms: 1000 }, { status: 409 }));
    expect(await deliverMemberSyncRequest(request, baseConfig, mock.fetch, async (ms) => { waits.push(ms); })).toEqual({
      status: "pending", reason: "receipt_not_completed", retryAfterMs: 5000,
    });
    expect(waits).toEqual([1000]);
    expect(mock.calls.map(({ init }) => init.method)).toEqual(["GET", "POST", "GET", "POST"]);
  });

  test("blocked/rejected/identity conflicts quarantine instead of replay", async () => {
    for (const state of ["blocked", "rejected", "identity_conflict"]) {
      const request = createMemberSyncRequest(member(), "guildMemberAdd");
      const mock = scripted((method, id) => {
        if (state === "blocked" || state === "rejected") return reply(id, state);
        if (method === "GET") return reply(id, "missing");
        return Response.json({ ok: false, request_id: id, status: state, result: null }, { status: 409 });
      });
      expect(await deliverMemberSyncRequest(request, baseConfig, mock.fetch, noWait)).toEqual({ status: "blocked", reason: state });
      expect(mock.calls.filter(({ init }) => init.method === "POST")).toHaveLength(state === "blocked" || state === "rejected" ? 0 : 1);
    }
  });

  test("rejects false success, wrong identity, wrong counts, duplicate keys and extra metadata", async () => {
    const request = createMemberSyncRequest(member(), "guildMemberAdd");
    const good = { ok: true, request_id: request.requestId, status: "completed", result: counts };
    const mutants: unknown[] = [
      {}, { ...good, ok: false }, { ...good, status: "applied" }, { ...good, status: "preview" },
      { ...good, request_id: "00000000-0000-4000-8000-000000000000" }, { ...good, result: null },
      { ...good, secret: "must never enter logs" }, { ...good, result: { ...counts, discordWrites: "1" } },
      { ...good, result: { ...counts, dbWrites: -1 } }, { ...good, result: { ...counts, staleRecordsCleared: 10001 } },
      { ...good, result: { discordWrites: 1 } },
    ];
    for (const mutant of mutants) {
      const mock = scripted(() => Response.json(mutant));
      expect((await deliverMemberSyncRequest(request, baseConfig, mock.fetch, noWait)).status).toBe("pending");
      expect(mock.calls.every(({ init }) => init.method === "GET")).toBe(true);
    }
    for (const text of [
      JSON.stringify(good).replace('"ok":true', '"ok":false,"ok":true'),
      JSON.stringify(good).replace('"ok"', '"\\u006f\\u006b"'),
      "", "[]", "not-json",
    ]) {
      const mock = scripted(() => new Response(text, { headers: { "Content-Type": "application/json" } }));
      expect((await deliverMemberSyncRequest(request, baseConfig, mock.fetch, noWait)).status).toBe("pending");
    }
  });

  test("rejects mismatched HTTP state, redirects and response URL changes", async () => {
    const request = createMemberSyncRequest(member(), "guildMemberAdd");
    for (const variant of ["http", "redirected", "url", "type"]) {
      const mock = scripted((_method, id) => {
        const response = reply(id, "completed", variant === "http" ? 202 : 200);
        if (variant === "redirected") Object.defineProperty(response, "redirected", { value: true });
        if (variant === "url") Object.defineProperty(response, "url", { value: "https://attacker.test/status" });
        if (variant === "type") response.headers.set("Content-Type", "text/html");
        return response;
      });
      expect((await deliverMemberSyncRequest(request, baseConfig, mock.fetch, noWait)).status).toBe("pending");
      expect(mock.calls.every(({ init }) => init.method === "GET")).toBe(true);
    }
  });

  test("bounds declared/chunked bodies and never awaits unbounded cancellation", async () => {
    const request = createMemberSyncRequest(member(), "guildMemberAdd");
    for (const declared of [true, false]) {
      let cancelled = false;
      const mock = scripted(() => new Response(new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(20000)); },
        cancel() { cancelled = true; return new Promise(() => undefined); },
      }), { headers: { "Content-Type": "application/json", ...(declared ? { "Content-Length": "16385" } : {}) } }));
      expect((await deliverMemberSyncRequest(request, { ...baseConfig, pendingVerificationSyncMaxAttempts: 1 }, mock.fetch)).status).toBe("pending");
      expect(cancelled).toBe(true);
      expect(mock.calls).toHaveLength(1);
    }
  });

  test("keeps timeout through stalled body and never posts on uncertain status", async () => {
    const request = createMemberSyncRequest(member(), "guildMemberAdd");
    let cancelled = false;
    const mock = scripted(() => new Response(new ReadableStream({ cancel() { cancelled = true; return new Promise(() => undefined); } }),
      { headers: { "Content-Type": "application/json" } }));
    expect((await deliverMemberSyncRequest(request, { ...baseConfig, pendingVerificationSyncTimeoutMs: 10,
      pendingVerificationSyncMaxAttempts: 1 }, mock.fetch)).status).toBe("pending");
    expect(cancelled).toBe(true);
    expect(mock.calls).toHaveLength(1);
  });

  test("configuration hold performs no network request", async () => {
    const request = createMemberSyncRequest(member(), "guildMemberAdd");
    const mock = scripted(() => { throw new Error("unexpected network"); });
    expect((await deliverMemberSyncRequest(request, { ...baseConfig, pendingVerificationSyncEnabled: false }, mock.fetch)).status).toBe("blocked");
    expect((await deliverMemberSyncRequest(request, { ...baseConfig, discordGuildId: SYNTHETIC_DISCORD_IDS.otherGuild }, mock.fetch)).status).toBe("blocked");
    expect(mock.calls).toHaveLength(0);
  });
});

describe("memberRolesChanged", () => {
  test("compares role sets without depending on role order", () => {
    expect(memberRolesChanged(member(["1", "2"]), member(["2", "1"]))).toBe(false);
    expect(memberRolesChanged(member(["1"]), member(["1", "2"]))).toBe(true);
  });
});

describe("loadConfig pending verification sync", () => {
  test("does not require sync endpoint secrets while disabled", () => {
    const config = loadConfig({
      DISCORD_BOT_TOKEN: "token",
      DISCORD_GUILD_ID: SYNTHETIC_DISCORD_IDS.guild,
      REAPER_PENDING_VERIFICATION_SYNC_ENABLED: "false",
    });

    expect(config.pendingVerificationSyncEnabled).toBe(false);
    expect(config.pendingVerificationSyncUrl).toBe("");
    expect(config.pendingVerificationSyncSecret).toBe("");
    expect(config.pendingVerificationSyncTimeoutMs).toBe(5000);
    expect(config.pendingVerificationSyncMaxAttempts).toBe(2);
  });

  test("requires endpoint URL and secret when enabled", () => {
    expect(() =>
      loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_GUILD_ID: SYNTHETIC_DISCORD_IDS.guild,
        REAPER_PENDING_VERIFICATION_SYNC_ENABLED: "true",
      }),
    ).toThrow("REAPER_PENDING_VERIFICATION_SYNC_URL");
  });

  test("loads bounded sync retry settings", () => {
    const config = loadConfig({
      DISCORD_BOT_TOKEN: "token",
      DISCORD_GUILD_ID: SYNTHETIC_DISCORD_IDS.guild,
      REAPER_PENDING_VERIFICATION_SYNC_ENABLED: "true",
      REAPER_PENDING_VERIFICATION_SYNC_URL: "https://functions.example.test/functions/v1/reaper-discord-member-sync",
      REAPER_PENDING_VERIFICATION_SYNC_SECRET: "secret",
      REAPER_PENDING_VERIFICATION_SYNC_TIMEOUT_MS: "2500",
      REAPER_PENDING_VERIFICATION_SYNC_MAX_ATTEMPTS: "3",
    });

    expect(config.pendingVerificationSyncTimeoutMs).toBe(2500);
    expect(config.pendingVerificationSyncMaxAttempts).toBe(3);
  });

  test("requires a canonical credential-free HTTPS member-sync function target", () => {
    for (const target of [
      "/functions/v1/reaper-discord-member-sync",
      "//functions.example.test/functions/v1/reaper-discord-member-sync",
      "http://functions.example.test/functions/v1/reaper-discord-member-sync",
      "https://user@functions.example.test/functions/v1/reaper-discord-member-sync",
      "https://user:password@functions.example.test/functions/v1/reaper-discord-member-sync",
      "https://functions.example.test@attacker.test/functions/v1/reaper-discord-member-sync",
      "https://functions.example.test/functions/v1/other-function",
      "https://functions.example.test/functions/v1/reaper-discord-member-sync/",
      "https://functions.example.test/functions/v1/reaper-discord-member-sync?",
      "https://functions.example.test/functions/v1/reaper-discord-member-sync#",
      "https://functions.example.test/functions/v1/reaper-discord-member-sync?token=x",
      "https://functions.example.test/functions/v1/reaper-discord-member-sync#fragment",
      "https://functions.example.test:443/functions/v1/reaper-discord-member-sync",
      "https://functions.example.test:8443/functions/v1/reaper-discord-member-sync",
      "https://FUNCTIONS.example.test/functions/v1/reaper-discord-member-sync",
      "https://127.0.0.1/functions/v1/reaper-discord-member-sync",
      "https://[::1]/functions/v1/reaper-discord-member-sync",
      "https://localhost/functions/v1/reaper-discord-member-sync",
      "https://worker.local/functions/v1/reaper-discord-member-sync",
      "https://functions.example.test/functions/v1/%72eaper-discord-member-sync",
      "https://functions.example.test/functions/./v1/reaper-discord-member-sync",
    ]) {
      expect(() => loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_GUILD_ID: SYNTHETIC_DISCORD_IDS.guild,
        REAPER_PENDING_VERIFICATION_SYNC_ENABLED: "true",
        REAPER_PENDING_VERIFICATION_SYNC_URL: target,
        REAPER_PENDING_VERIFICATION_SYNC_SECRET: "secret",
      })).toThrow("canonical absolute HTTPS URL without embedded credentials");
    }
  });

  test("rejects unbounded sync retry settings", () => {
    expect(() =>
      loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_GUILD_ID: SYNTHETIC_DISCORD_IDS.guild,
        REAPER_PENDING_VERIFICATION_SYNC_TIMEOUT_MS: "0",
      }),
    ).toThrow("REAPER_PENDING_VERIFICATION_SYNC_TIMEOUT_MS");

    expect(() =>
      loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_GUILD_ID: SYNTHETIC_DISCORD_IDS.guild,
        REAPER_PENDING_VERIFICATION_SYNC_MAX_ATTEMPTS: "25",
      }),
    ).toThrow("REAPER_PENDING_VERIFICATION_SYNC_MAX_ATTEMPTS");
  });
});
