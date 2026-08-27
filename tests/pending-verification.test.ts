import { describe, expect, test } from "bun:test";
import { loadConfig, type ReaperConfig } from "../src/config.js";
import {
  memberRolesChanged,
  syncPendingVerificationMember,
  type PendingVerificationMemberLike,
} from "../src/pending-verification.js";
import { SYNTHETIC_DISCORD_IDS } from "./discord-fixtures.js";

const baseConfig: ReaperConfig = {
  discordBotToken: "test-token",
  discordGuildId: SYNTHETIC_DISCORD_IDS.guild,
  galleryGatewayRollbackEnabled: false,
  welcomeDmEnabled: true,
  pendingVerificationSyncEnabled: true,
  pendingVerificationSyncUrl: "https://functions.example/reaper-discord-member-sync",
  pendingVerificationSyncSecret: "local-sync-secret",
  pendingVerificationSyncTimeoutMs: 5000,
  pendingVerificationSyncMaxAttempts: 2,
};

const quietLogger = {
  log: () => undefined,
  warn: () => undefined,
};

function member(overrides: {
  guildId?: string;
  userId?: string;
  bot?: boolean;
  roles?: string[];
} = {}): PendingVerificationMemberLike {
  return {
    guild: {
      id: overrides.guildId || SYNTHETIC_DISCORD_IDS.guild,
    },
    user: {
      id: overrides.userId || SYNTHETIC_DISCORD_IDS.member,
      bot: overrides.bot || false,
    },
    roles: {
      cache: new Map((overrides.roles || [SYNTHETIC_DISCORD_IDS.roleOne]).map((roleId) => [roleId, true])),
    },
  };
}

describe("syncPendingVerificationMember", () => {
  test("is disabled by default and does not post", async () => {
    let posted = false;
    const result = await syncPendingVerificationMember(
      member(),
      "guildMemberAdd",
      { ...baseConfig, pendingVerificationSyncEnabled: false },
      quietLogger,
      async () => {
        posted = true;
        return new Response("{}");
      },
    );

    expect(result).toBe("disabled");
    expect(posted).toBe(false);
  });

  test("posts redacted member event payload to the private Edge Function", async () => {
    const requests: Request[] = [];
    const result = await syncPendingVerificationMember(
      member({ roles: [SYNTHETIC_DISCORD_IDS.roleTwo, SYNTHETIC_DISCORD_IDS.roleOne] }),
      "guildMemberUpdate",
      baseConfig,
      quietLogger,
      async (input, init) => {
        requests.push(new Request(input, init));
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return new Response(JSON.stringify({ ok: true, status: "applied", discordWriteCount: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      123,
    );

    expect(result).toBe("posted");
    const request = requests[0];
    expect(request?.url).toBe(baseConfig.pendingVerificationSyncUrl);
    expect(request?.headers.get("x-mochirii-reaper-member-sync-secret")).toBe("local-sync-secret");
    expect(await request?.json()).toEqual({
      event_type: "guildMemberUpdate",
      guild_id: SYNTHETIC_DISCORD_IDS.guild,
      discord_user_id: SYNTHETIC_DISCORD_IDS.member,
      roles: [SYNTHETIC_DISCORD_IDS.roleOne, SYNTHETIC_DISCORD_IDS.roleTwo],
      gateway_sequence: 123,
      occurred_at: expect.any(String),
    });
  });

  test("retries transient Edge responses with one immutable payload and redacted logs", async () => {
    const warnings: unknown[] = [];
    const logs: unknown[] = [];
    const requestBodies: string[] = [];
    const retryDelays: number[] = [];
    let attempts = 0;

    const result = await syncPendingVerificationMember(
      member(),
      "guildMemberAdd",
      { ...baseConfig, pendingVerificationSyncMaxAttempts: 2 },
      {
        log: (...args: unknown[]) => logs.push(args),
        warn: (...args: unknown[]) => warnings.push(args),
      },
      async (_input, init) => {
        attempts += 1;
        requestBodies.push(String(init?.body));
        if (attempts === 1) return new Response(JSON.stringify({ ok: false }), { status: 503 });
        return new Response(JSON.stringify({ ok: true, status: "preview", conflictCount: 0 }), { status: 200 });
      },
      null,
      async (delayMs) => {
        retryDelays.push(delayMs);
      },
    );

    expect(result).toBe("posted");
    expect(attempts).toBe(2);
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[0]).toBe(requestBodies[1]);
    expect(retryDelays).toEqual([250]);
    expect(JSON.stringify(warnings)).toContain("retrying");
    const logText = JSON.stringify([...warnings, ...logs]);
    expect(logText).not.toContain(baseConfig.pendingVerificationSyncSecret);
    expect(logText).not.toContain(SYNTHETIC_DISCORD_IDS.guild);
    expect(logText).not.toContain(SYNTHETIC_DISCORD_IDS.member);
    expect(logText).toContain(`...${SYNTHETIC_DISCORD_IDS.guild.slice(-4)}`);
    expect(logText).toContain(`...${SYNTHETIC_DISCORD_IDS.member.slice(-4)}`);
  });

  test("honors a bounded Retry-After response before retrying", async () => {
    const retryDelays: number[] = [];
    let attempts = 0;
    const result = await syncPendingVerificationMember(
      member(),
      "guildMemberUpdate",
      baseConfig,
      quietLogger,
      async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response("", { status: 429, headers: { "Retry-After": "1" } });
        }
        return new Response(JSON.stringify({ ok: true, status: "applied" }), { status: 200 });
      },
      null,
      async (delayMs) => {
        retryDelays.push(delayMs);
      },
    );

    expect(result).toBe("posted");
    expect(attempts).toBe(2);
    expect(retryDelays).toEqual([1000]);
  });

  test("fails closed when Retry-After exceeds the retry-delay budget", async () => {
    const warnings: unknown[] = [];
    let attempts = 0;
    const result = await syncPendingVerificationMember(
      member(),
      "guildMemberUpdate",
      baseConfig,
      {
        log: () => undefined,
        warn: (...args: unknown[]) => warnings.push(args),
      },
      async () => {
        attempts += 1;
        return new Response("", { status: 429, headers: { "Retry-After": "6" } });
      },
      null,
      async () => {
        throw new Error("wait must not run");
      },
    );

    expect(result).toBe("post_failed");
    expect(attempts).toBe(1);
    expect(JSON.stringify(warnings)).toContain("retry_after_exceeds_budget");
  });

  test("sanitizes the successful response summary before logging", async () => {
    const logs: unknown[] = [];
    const result = await syncPendingVerificationMember(
      member(),
      "guildMemberAdd",
      baseConfig,
      {
        log: (...args: unknown[]) => logs.push(args),
        warn: () => undefined,
      },
      async () => new Response(JSON.stringify({
        ok: true,
        status: `applied-${baseConfig.pendingVerificationSyncSecret}`,
        discordWriteCount: Number.MAX_SAFE_INTEGER,
        registryWriteCount: -1,
        conflictCount: "not-a-count",
      }), { status: 200 }),
    );

    expect(result).toBe("posted");
    const logText = JSON.stringify(logs);
    expect(logText).not.toContain(baseConfig.pendingVerificationSyncSecret);
    expect(logText).toContain('"status":"unknown"');
    expect(logText).toContain('"discordWriteCount":0');
    expect(logText).toContain('"registryWriteCount":0');
    expect(logText).toContain('"conflictCount":0');
  });

  test("does not read a response whose declared body exceeds the summary limit", async () => {
    const logs: unknown[] = [];
    const result = await syncPendingVerificationMember(
      member(),
      "guildMemberAdd",
      baseConfig,
      {
        log: (...args: unknown[]) => logs.push(args),
        warn: () => undefined,
      },
      async () => new Response(`{"status":"${baseConfig.pendingVerificationSyncSecret}"}`, {
        status: 200,
        headers: { "Content-Length": "16385" },
      }),
    );

    expect(result).toBe("posted");
    const logText = JSON.stringify(logs);
    expect(logText).not.toContain(baseConfig.pendingVerificationSyncSecret);
    expect(logText).toContain('"status":"unknown"');
  });

  test("stops reading a chunked response after the summary byte limit", async () => {
    const logs: unknown[] = [];
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(10_000));
        controller.enqueue(new Uint8Array(10_000));
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await syncPendingVerificationMember(
      member(),
      "guildMemberAdd",
      baseConfig,
      {
        log: (...args: unknown[]) => logs.push(args),
        warn: () => undefined,
      },
      async () => new Response(body, { status: 200 }),
    );

    await Promise.resolve();
    expect(result).toBe("posted");
    expect(cancelled).toBe(true);
    expect(JSON.stringify(logs)).toContain('"status":"unknown"');
  });

  test("does not retry non-transient Edge conflicts", async () => {
    let attempts = 0;
    const result = await syncPendingVerificationMember(
      member(),
      "guildMemberAdd",
      { ...baseConfig, pendingVerificationSyncMaxAttempts: 3 },
      quietLogger,
      async () => {
        attempts += 1;
        return new Response(JSON.stringify({ ok: false, conflictCount: 1 }), { status: 409 });
      },
    );

    expect(result).toBe("post_failed");
    expect(attempts).toBe(1);
  });

  test("handles fetch failures without logging secrets", async () => {
    const warnings: unknown[] = [];
    const result = await syncPendingVerificationMember(
      member(),
      "guildMemberUpdate",
      { ...baseConfig, pendingVerificationSyncMaxAttempts: 1 },
      {
        log: () => undefined,
        warn: (...args: unknown[]) => warnings.push(args),
      },
      async () => {
        throw new TypeError(`network failed for ${baseConfig.pendingVerificationSyncSecret}`);
      },
    );

    expect(result).toBe("post_failed");
    const warningText = JSON.stringify(warnings);
    expect(warningText).toContain("TypeError");
    expect(warningText).not.toContain(baseConfig.pendingVerificationSyncSecret);
  });

  test("aborts an attempt after the configured timeout", async () => {
    const warnings: unknown[] = [];
    const result = await syncPendingVerificationMember(
      member(),
      "guildMemberUpdate",
      {
        ...baseConfig,
        pendingVerificationSyncTimeoutMs: 10,
        pendingVerificationSyncMaxAttempts: 1,
      },
      {
        log: () => undefined,
        warn: (...args: unknown[]) => warnings.push(args),
      },
      async (_input, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("request timed out", "AbortError"));
        }, { once: true });
      }),
    );

    expect(result).toBe("post_failed");
    expect(JSON.stringify(warnings)).toContain("AbortError");
  });

  test("does not retry a timed-out request when remote completion is unknown", async () => {
    const warnings: unknown[] = [];
    let attempts = 0;
    let waits = 0;

    const result = await syncPendingVerificationMember(
      member(),
      "guildMemberUpdate",
      {
        ...baseConfig,
        pendingVerificationSyncTimeoutMs: 10,
        pendingVerificationSyncMaxAttempts: 3,
      },
      {
        log: () => undefined,
        warn: (...args: unknown[]) => warnings.push(args),
      },
      async (_input, init) => {
        attempts += 1;
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("request timed out", "AbortError"));
          }, { once: true });
        });
      },
      null,
      async () => {
        waits += 1;
      },
    );

    expect(result).toBe("post_failed");
    expect(attempts).toBe(1);
    expect(waits).toBe(0);
    expect(JSON.stringify(warnings)).toContain("request_completion_unknown");
  });

  test("keeps the attempt timeout active while reading the response body", async () => {
    const warnings: unknown[] = [];
    let cancelled = false;
    let pendingChunk: ReturnType<typeof setTimeout> | null = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        pendingChunk = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode('{"status":"applied"}'));
          controller.close();
        }, 100);
      },
      cancel() {
        if (pendingChunk) clearTimeout(pendingChunk);
        cancelled = true;
      },
    });

    const result = await syncPendingVerificationMember(
      member(),
      "guildMemberUpdate",
      {
        ...baseConfig,
        pendingVerificationSyncTimeoutMs: 10,
        pendingVerificationSyncMaxAttempts: 1,
      },
      {
        log: () => undefined,
        warn: (...args: unknown[]) => warnings.push(args),
      },
      async () => new Response(body, { status: 200 }),
    );

    await Promise.resolve();
    expect(result).toBe("post_failed");
    expect(cancelled).toBe(true);
    expect(JSON.stringify(warnings)).toContain("AbortError");
  });

  test("ignores bots and other guilds", async () => {
    let posted = false;
    const fetchImpl = async () => {
      posted = true;
      return new Response("{}");
    };

    expect(await syncPendingVerificationMember(member({ bot: true }), "guildMemberAdd", baseConfig, quietLogger, fetchImpl)).toBe("ignored_bot");
    expect(
      await syncPendingVerificationMember(
        member({ guildId: SYNTHETIC_DISCORD_IDS.otherGuild }),
        "guildMemberAdd",
        baseConfig,
        quietLogger,
        fetchImpl,
      ),
    ).toBe("ignored_guild");
    expect(posted).toBe(false);
  });

  test("reports failed Edge responses without throwing", async () => {
    const result = await syncPendingVerificationMember(
      member(),
      "guildMemberAdd",
      baseConfig,
      quietLogger,
      async () => new Response(JSON.stringify({ ok: false }), { status: 409 }),
    );

    expect(result).toBe("post_failed");
  });
});

describe("memberRolesChanged", () => {
  test("compares role sets without depending on role order", () => {
    expect(
      memberRolesChanged(
        member({ roles: ["1", "2"] }),
        member({ roles: ["2", "1"] }),
      ),
    ).toBe(false);

    expect(
      memberRolesChanged(
        member({ roles: ["1"] }),
        member({ roles: ["1", "2"] }),
      ),
    ).toBe(true);
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
      REAPER_PENDING_VERIFICATION_SYNC_URL: "https://example.com/functions/v1/reaper-discord-member-sync",
      REAPER_PENDING_VERIFICATION_SYNC_SECRET: "secret",
      REAPER_PENDING_VERIFICATION_SYNC_TIMEOUT_MS: "2500",
      REAPER_PENDING_VERIFICATION_SYNC_MAX_ATTEMPTS: "3",
    });

    expect(config.pendingVerificationSyncTimeoutMs).toBe(2500);
    expect(config.pendingVerificationSyncMaxAttempts).toBe(3);
  });

  test("requires an absolute credential-free HTTPS sync target when enabled", () => {
    for (const target of [
      "/functions/v1/reaper-discord-member-sync",
      "//example.com/functions/v1/reaper-discord-member-sync",
      "http://example.com/functions/v1/reaper-discord-member-sync",
      "https://user@example.com/functions/v1/reaper-discord-member-sync",
      "https://user:password@example.com/functions/v1/reaper-discord-member-sync",
      "https://example.com@attacker.invalid/functions/v1/reaper-discord-member-sync",
    ]) {
      expect(() => loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_GUILD_ID: SYNTHETIC_DISCORD_IDS.guild,
        REAPER_PENDING_VERIFICATION_SYNC_ENABLED: "true",
        REAPER_PENDING_VERIFICATION_SYNC_URL: target,
        REAPER_PENDING_VERIFICATION_SYNC_SECRET: "secret",
      })).toThrow("absolute HTTPS URL without embedded credentials");
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
