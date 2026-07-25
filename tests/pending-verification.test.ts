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
  welcomeDmEnabled: true,
  pendingVerificationSyncEnabled: true,
  pendingVerificationSyncUrl: "https://deyvmtncimmcinldjyqe.supabase.co/functions/v1/reaper-discord-member-sync",
  pendingVerificationSyncSecret: "local-sync-secret",
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
});
