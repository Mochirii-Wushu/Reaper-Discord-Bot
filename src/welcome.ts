import type { ReaperConfig } from "./config.js";

export const WELCOME_DM_MESSAGE = `Welcome to Mōchirīī pretty guildies!

For more guild info, flutter over to https://mochirii.com & make sure to sync your Discord account so all the hidden guild doors unlock properly.

To view & interact with the WWM guild channels, you’ll need the Mōchirīī guild role. If you want to submit gallery images to the guild website & enjoy other guild-exclusive features, you’ll also need the Verified role.

Introduce yourself with your in-game guild title so we can add it to your role list & sync it with our guild site ranking system.

Mōchirīī is constantly evolving, if you have any questions, get stuck, or feel a tiny bit lost in the clouds, please DM a Moderator anytime. We’re so excited to have you here!`;

type WelcomeMemberLike = {
  guild: {
    id: string;
  };
  user: {
    id: string;
    bot?: boolean;
    send(message: { content: string; allowedMentions: { parse: [] } }): Promise<unknown>;
  };
};

export type WelcomeDmResult = "sent" | "disabled" | "ignored_guild" | "ignored_bot" | "dm_failed";
type WelcomeLogger = Pick<Console, "log" | "warn">;

function redactedSnowflake(value: string): string {
  return value.length > 4 ? `...${value.slice(-4)}` : "[redacted]";
}

export async function sendWelcomeDm(
  member: WelcomeMemberLike,
  config: ReaperConfig,
  logger: WelcomeLogger = console,
): Promise<WelcomeDmResult> {
  if (!config.welcomeDmEnabled) return "disabled";
  if (member.guild.id !== config.discordGuildId) return "ignored_guild";
  if (member.user.bot) return "ignored_bot";

  try {
    await member.user.send({
      content: WELCOME_DM_MESSAGE,
      allowedMentions: { parse: [] },
    });
    logger.log("welcome DM sent", {
      guildId: redactedSnowflake(member.guild.id),
      userId: redactedSnowflake(member.user.id),
    });
    return "sent";
  } catch (error) {
    logger.warn("welcome DM failed", {
      guildId: redactedSnowflake(member.guild.id),
      userId: redactedSnowflake(member.user.id),
      error: error instanceof Error ? error.name : "UnknownError",
    });
    return "dm_failed";
  }
}
