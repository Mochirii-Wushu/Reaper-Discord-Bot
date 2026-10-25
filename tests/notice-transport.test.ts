import { describe, expect, test } from "bun:test";
import type { NoticeFetch } from "../src/community-notices.js";
import { createNoticeSender } from "../src/notice-transport.js";
import { SYNTHETIC_DISCORD_IDS as ids } from "./discord-fixtures.js";

const content = "Welcome to the guild!";
const nonce = "a".repeat(25);
const acknowledgement = { id: ids.message, channel_id: ids.galleryChannel, content, nonce,
  author: { id: ids.member, bot: true } };
const response = (value: unknown) => new Response(JSON.stringify(value), {
  headers: { "content-type": "application/json" },
});
function sender(request: NoticeFetch, botUserId = () => ids.member as string | undefined) {
  return createNoticeSender({ apiOrigin: "https://discord-api.example.test", botToken: "synthetic-token",
    botUserId, fetch: request });
}
describe("community notice one-shot transport", () => {
  test("binds the exact channel, bot, content and stable nonce with mentions disabled", async () => {
    let count = 0;
    const send = sender((async (url, init) => {
      count++;
      expect(String(url)).toBe(`https://discord-api.example.test/api/v10/channels/${ids.galleryChannel}/messages`);
      expect(init?.method).toBe("POST");
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(init?.body))).toEqual({ content, allowed_mentions: { parse: [] }, nonce, enforce_nonce: true });
      return response(acknowledgement);
    }) as NoticeFetch);
    expect(await send(ids.galleryChannel, content, nonce)).toEqual({ id: ids.message, channelId: ids.galleryChannel });
    expect(count).toBe(1);
  });
  test("never retries HTTP failures, rate limits or ambiguous network results", async () => {
    for (const status of [301, 400, 401, 403, 429, 500, 503]) {
      let count = 0;
      const send = sender((async () => { count++; return new Response(null, { status }); }) as NoticeFetch);
      await expect(send(ids.galleryChannel, content, nonce)).rejects.toThrow();
      expect(count).toBe(1);
    }
    let count = 0;
    const send = sender((async () => { count++; throw new Error("synthetic timeout"); }) as NoticeFetch);
    await expect(send(ids.galleryChannel, content, nonce)).rejects.toThrow();
    expect(count).toBe(1);
  });
  test("rejects mismatched acknowledgements without replay", async () => {
    for (const patch of [ { id: "0" }, { channel_id: ids.otherChannel }, { content: "different" },
      { nonce: "b".repeat(25) }, { author: { id: ids.otherGuild, bot: true } }, { author: { id: ids.member, bot: false } },
    ]) {
      let count = 0;
      const send = sender((async () => { count++; return response({ ...acknowledgement, ...patch }); }) as NoticeFetch);
      await expect(send(ids.galleryChannel, content, nonce)).rejects.toThrow();
      expect(count).toBe(1);
    }
  });
  test("bounds and validates response bodies", async () => {
    for (const make of [
      () => new Response("broken", { headers: { "content-type": "application/json" } }),
      () => new Response(" ".repeat(16_385), { headers: { "content-type": "application/json" } }),
      () => new Response(JSON.stringify(acknowledgement), { headers: { "content-type": "text/html" } }),
      () => response(null),
    ]) await expect(sender((async () => make()) as NoticeFetch)(ids.galleryChannel, content, nonce)).rejects.toThrow();
  });
  test("rejects invalid dispatch inputs before network", async () => {
    let count = 0;
    const request = (async () => { count++; return response(acknowledgement); }) as NoticeFetch;
    const send = sender(request);
    for (const args of [["0", content, nonce], [ids.galleryChannel, "", nonce], [ids.galleryChannel, "x".repeat(2001), nonce],
      [ids.galleryChannel, content, "bad"]]) await expect(send(args[0], args[1], args[2])).rejects.toThrow();
    await expect(sender(request, () => undefined)(ids.galleryChannel, content, nonce)).rejects.toThrow();
    expect(count).toBe(0);
  });
  test("rejects API-origin credentials, paths and insecure transport", () => {
    for (const apiOrigin of ["http://discord-api.example.test", "https://discord-api.example.test/api", "https://user@discord-api.example.test"]) {
      expect(() => createNoticeSender({ apiOrigin, botToken: "synthetic", botUserId: () => ids.member })).toThrow();
    }
  });
});
