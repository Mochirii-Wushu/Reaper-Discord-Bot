import { describe, expect, test } from "bun:test";
import type { ReaperConfig } from "../src/config.js";
import { sendWelcomeDm, WELCOME_DM_MESSAGE } from "../src/welcome.js";
import { SYNTHETIC_DISCORD_IDS } from "./discord-fixtures.js";

const config: ReaperConfig = {
  discordBotToken: "test-token",
  discordGuildId: SYNTHETIC_DISCORD_IDS.guild,
  welcomeDmEnabled: true,
  pendingVerificationSyncEnabled: false,
  pendingVerificationSyncUrl: "",
  pendingVerificationSyncSecret: "",
  pendingVerificationSyncTimeoutMs: 5000,
  pendingVerificationSyncMaxAttempts: 2,
};
const expectedWelcomeDmMessage = `Welcome to Mōchirīī pretty guildies!

For more guild info, flutter over to https://mochirii.com & make sure to sync your Discord account so all the hidden guild doors unlock properly.

To view & interact with the WWM guild channels, you’ll need the Mōchirīī guild role. If you want to submit gallery images to the guild website & enjoy other guild-exclusive features, you’ll also need the Verified role.

Introduce yourself with your in-game guild title so we can add it to your role list & sync it with our guild site ranking system.

Mōchirīī is constantly evolving, if you have any questions, get stuck, or feel a tiny bit lost in the clouds, please DM a Moderator anytime. We’re so excited to have you here!`;
const quietLogger = {
  log: () => undefined,
  warn: () => undefined,
};

function member(overrides: {
  guildId?: string;
  bot?: boolean;
  send?: (message: { content: string; allowedMentions: { parse: [] } }) => Promise<unknown>;
} = {}) {
  return {
    guild: {
      id: overrides.guildId || SYNTHETIC_DISCORD_IDS.guild,
    },
    user: {
      id: SYNTHETIC_DISCORD_IDS.member,
      bot: overrides.bot || false,
      send: overrides.send || (async () => undefined),
    },
  };
}

describe("sendWelcomeDm", () => {
  test("sends the approved welcome copy with mentions disabled", async () => {
    const messages: Array<{ content: string; allowedMentions: { parse: [] } }> = [];

    const result = await sendWelcomeDm(
      member({
        send: async (message) => {
          messages.push(message);
        },
      }),
      config,
      quietLogger,
    );

    expect(result).toBe("sent");
    expect(messages).toHaveLength(1);
    expect(WELCOME_DM_MESSAGE).toBe(expectedWelcomeDmMessage);
    expect(messages[0]?.content).toBe(WELCOME_DM_MESSAGE);
    expect(messages[0]?.content).toBe(expectedWelcomeDmMessage);
    expect(messages[0]?.allowedMentions).toEqual({ parse: [] });
  });

  test("ignores members from other guilds", async () => {
    let sent = false;

    const result = await sendWelcomeDm(
      member({
        guildId: SYNTHETIC_DISCORD_IDS.otherGuild,
        send: async () => {
          sent = true;
        },
      }),
      config,
      quietLogger,
    );

    expect(result).toBe("ignored_guild");
    expect(sent).toBe(false);
  });

  test("ignores bot users", async () => {
    let sent = false;

    const result = await sendWelcomeDm(
      member({
        bot: true,
        send: async () => {
          sent = true;
        },
      }),
      config,
      quietLogger,
    );

    expect(result).toBe("ignored_bot");
    expect(sent).toBe(false);
  });

  test("can be disabled by runtime config", async () => {
    let sent = false;

    const result = await sendWelcomeDm(
      member({
        send: async () => {
          sent = true;
        },
      }),
      { ...config, welcomeDmEnabled: false },
      quietLogger,
    );

    expect(result).toBe("disabled");
    expect(sent).toBe(false);
  });

  test("handles closed DMs without throwing", async () => {
    const result = await sendWelcomeDm(
      member({
        send: async () => {
          throw new Error("Cannot send messages to this user");
        },
      }),
      config,
      quietLogger,
    );

    expect(result).toBe("dm_failed");
  });
});
