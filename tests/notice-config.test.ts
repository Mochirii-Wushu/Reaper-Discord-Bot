import { describe, expect, test } from "bun:test";
import { loadCommunityNoticeConfig } from "../src/config.js";
import { SYNTHETIC_DISCORD_IDS as ids } from "./discord-fixtures.js";

const enabled = {
  DISCORD_GUILD_ID: ids.guild, DISCORD_API_ORIGIN: "https://discord-api.example.test",
  WELCOME_DM_ENABLED: "false", REAPER_MEMBER_NOTICES_ENABLED: "true",
  REAPER_MEMBER_NOTICE_CHANNEL_ID: ids.galleryChannel, REAPER_NOTICE_STATE_PATH: "/private/notices",
  REAPER_SPOTLIGHT_ANNOUNCEMENT_ENABLED: "true", REAPER_SPOTLIGHT_CHANNEL_ID: ids.otherChannel,
  REAPER_SPOTLIGHT_WINNER_URL: "https://functions.example.test/functions/v1/get-current-spotlight-winner",
};
describe("community notice configuration", () => {
  test("remains inert without explicit route enablement", () => {
    expect(loadCommunityNoticeConfig({}).welcomeChannelId).toBeNull();
    expect(loadCommunityNoticeConfig({}).spotlightUrl).toBeNull();
  });
  test("accepts the fixed reader and explicit routes", () => {
    expect(loadCommunityNoticeConfig(enabled).welcomeChannelId).toBe(ids.galleryChannel);
    expect(loadCommunityNoticeConfig(enabled).spotlightChannelId).toBe(ids.otherChannel);
  });
  test("rejects simultaneous DM and public welcome", () => {
    expect(() => loadCommunityNoticeConfig({ ...enabled, WELCOME_DM_ENABLED: "true" })).toThrow();
    expect(() => loadCommunityNoticeConfig({ ...enabled, WELCOME_DM_ENABLED: undefined })).toThrow();
  });
  test("rejects invalid enable flags, routes and endpoint alterations", () => {
    for (const patch of [
      { REAPER_MEMBER_NOTICES_ENABLED: "yes" }, { REAPER_SPOTLIGHT_ANNOUNCEMENT_ENABLED: "1" },
      { REAPER_MEMBER_NOTICE_CHANNEL_ID: "0" }, { DISCORD_GUILD_ID: " 100000000000000001" },
      { REAPER_NOTICE_STATE_PATH: "" }, { DISCORD_API_ORIGIN: "http://discord-api.example.test" },
      { DISCORD_API_ORIGIN: "https://discord-api.example.test/path" },
      { REAPER_SPOTLIGHT_WINNER_URL: enabled.REAPER_SPOTLIGHT_WINNER_URL + "?x=1" },
      { REAPER_SPOTLIGHT_WINNER_URL: enabled.REAPER_SPOTLIGHT_WINNER_URL.replace("get-current-spotlight-winner", "select") },
    ]) expect(() => loadCommunityNoticeConfig({ ...enabled, ...patch })).toThrow();
  });
});
