import { describe, expect, test } from "bun:test";
import type { ReaperConfig } from "../src/config.js";
import { sendWelcomeDm, WELCOME_DM_MESSAGE } from "../src/welcome.js";

const config: ReaperConfig = {
  discordBotToken: "test-token",
  discordGuildId: "1078630751077142608",
  welcomeDmEnabled: true,
};
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
      id: overrides.guildId || "1078630751077142608",
    },
    user: {
      id: "1508077313965817858",
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
    expect(messages[0]?.content).toBe(WELCOME_DM_MESSAGE);
    expect(messages[0]?.allowedMentions).toEqual({ parse: [] });
  });

  test("ignores members from other guilds", async () => {
    let sent = false;

    const result = await sendWelcomeDm(
      member({
        guildId: "1078630751077142609",
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
