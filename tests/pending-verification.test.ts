import { describe, expect, test } from "bun:test";
import { loadConfig, type ReaperConfig } from "../src/config.js";
import {
  memberRolesChanged,
  syncPendingVerificationMember,
  type PendingVerificationMemberLike,
} from "../src/pending-verification.js";

const baseConfig: ReaperConfig = {
  discordBotToken: "test-token",
  discordGuildId: "1078630751077142608",
  welcomeDmEnabled: true,
  pendingVerificationSyncEnabled: true,
  pendingVerificationSyncUrl: "https://deyvmtncimmcinldjyqe.supabase.co/functions/v1/reaper-discord-member-sync",
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
      id: overrides.guildId || "1078630751077142608",
    },
    user: {
      id: overrides.userId || "1508077313965817858",
      bot: overrides.bot || false,
    },
    roles: {
      cache: new Map((overrides.roles || ["1468659807736299520"]).map((roleId) => [roleId, true])),
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
      member({ roles: ["1468659807736299520", "1078630751077142615"] }),
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
      guild_id: "1078630751077142608",
      discord_user_id: "1508077313965817858",
      roles: ["1078630751077142615", "1468659807736299520"],
      gateway_sequence: 123,
      occurred_at: expect.any(String),
    });
  });

  test("retries transient Edge responses with redacted logs", async () => {
    const warnings: unknown[] = [];
    const logs: unknown[] = [];
    let attempts = 0;

    const result = await syncPendingVerificationMember(
      member(),
      "guildMemberAdd",
      { ...baseConfig, pendingVerificationSyncMaxAttempts: 2 },
      {
        log: (...args: unknown[]) => logs.push(args),
        warn: (...args: unknown[]) => warnings.push(args),
      },
      async () => {
        attempts += 1;
        if (attempts === 1) return new Response(JSON.stringify({ ok: false }), { status: 503 });
        return new Response(JSON.stringify({ ok: true, status: "preview", conflictCount: 0 }), { status: 200 });
      },
    );

    expect(result).toBe("posted");
    expect(attempts).toBe(2);
    expect(JSON.stringify(warnings)).toContain("retrying");
    const logText = JSON.stringify([...warnings, ...logs]);
    expect(logText).not.toContain(baseConfig.pendingVerificationSyncSecret);
    expect(logText).not.toContain("1078630751077142608");
    expect(logText).not.toContain("1508077313965817858");
    expect(logText).toContain("...2608");
    expect(logText).toContain("...7858");
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

  test("ignores bots and other guilds", async () => {
    let posted = false;
    const fetchImpl = async () => {
      posted = true;
      return new Response("{}");
    };

    expect(await syncPendingVerificationMember(member({ bot: true }), "guildMemberAdd", baseConfig, quietLogger, fetchImpl)).toBe("ignored_bot");
    expect(
      await syncPendingVerificationMember(
        member({ guildId: "1078630751077142609" }),
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
      DISCORD_GUILD_ID: "1078630751077142608",
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
        DISCORD_GUILD_ID: "1078630751077142608",
        REAPER_PENDING_VERIFICATION_SYNC_ENABLED: "true",
      }),
    ).toThrow("REAPER_PENDING_VERIFICATION_SYNC_URL");
  });

  test("loads bounded sync retry settings", () => {
    const config = loadConfig({
      DISCORD_BOT_TOKEN: "token",
      DISCORD_GUILD_ID: "1078630751077142608",
      REAPER_PENDING_VERIFICATION_SYNC_ENABLED: "true",
      REAPER_PENDING_VERIFICATION_SYNC_URL: "https://example.com/functions/v1/reaper-discord-member-sync",
      REAPER_PENDING_VERIFICATION_SYNC_SECRET: "secret",
      REAPER_PENDING_VERIFICATION_SYNC_TIMEOUT_MS: "2500",
      REAPER_PENDING_VERIFICATION_SYNC_MAX_ATTEMPTS: "3",
    });

    expect(config.pendingVerificationSyncTimeoutMs).toBe(2500);
    expect(config.pendingVerificationSyncMaxAttempts).toBe(3);
  });

  test("rejects unbounded sync retry settings", () => {
    expect(() =>
      loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_GUILD_ID: "1078630751077142608",
        REAPER_PENDING_VERIFICATION_SYNC_TIMEOUT_MS: "0",
      }),
    ).toThrow("REAPER_PENDING_VERIFICATION_SYNC_TIMEOUT_MS");

    expect(() =>
      loadConfig({
        DISCORD_BOT_TOKEN: "token",
        DISCORD_GUILD_ID: "1078630751077142608",
        REAPER_PENDING_VERIFICATION_SYNC_MAX_ATTEMPTS: "25",
      }),
    ).toThrow("REAPER_PENDING_VERIFICATION_SYNC_MAX_ATTEMPTS");
  });
});
