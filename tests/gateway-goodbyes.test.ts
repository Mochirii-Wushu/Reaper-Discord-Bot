import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { GatewayGoodbyes } from "../src/gateway-goodbyes.js";
import { SYNTHETIC_DISCORD_IDS as ids } from "./discord-fixtures.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const ready = (session = "synthetic-session-a", s = 1) => ({ op: 0, t: "READY", s, d: { session_id: session } });
const remove = (s: unknown = 2, user: unknown = { id: ids.member }, guild: unknown = ids.guild) => ({
  op: 0, t: "GUILD_MEMBER_REMOVE", s, d: { guild_id: guild, user },
});

describe("raw Gateway goodbye identities", () => {
  test("supports uncached member removal without a join timestamp or member roster", () => {
    const reader = new GatewayGoodbyes(ids.guild);
    expect(reader.read(ready(), 0)).toBeNull();
    expect(reader.read(remove(), 0)).toEqual({
      guild: { id: ids.guild }, user: { id: ids.member },
      eventIdentity: digest(`${digest("synthetic-session-a")}\n${ids.guild}\n${ids.member}\n2`),
    });
  });

  test("duplicate and resumed dispatches retain the same identity; later removals differ", () => {
    const reader = new GatewayGoodbyes(ids.guild);
    reader.read(ready(), 0);
    const first = reader.read(remove(), 0);
    expect(reader.read(remove(), 0)).toEqual(first);
    expect(reader.read({ op: 0, t: "RESUMED", s: 3, d: {} }, 0)).toBeNull();
    expect(reader.read(remove(), 0)).toEqual(first);
    expect(reader.read(remove(4), 0)?.eventIdentity).not.toBe(first?.eventIdentity);
    reader.read(ready("synthetic-session-b", 0), 0);
    expect(reader.read(remove(), 0)?.eventIdentity).not.toBe(first?.eventIdentity);
  });

  test("retains only a session hash and does not depend on later packet mutation", () => {
    const reader = new GatewayGoodbyes(ids.guild);
    const packet = ready();
    reader.read(packet, 0);
    packet.d.session_id = "changed-after-ready";
    expect(reader.read(remove(), 0)?.eventIdentity).toBe(digest(`${digest("synthetic-session-a")}\n${ids.guild}\n${ids.member}\n2`));
    expect(JSON.stringify(reader)).toBe("{}");
  });

  test("shards have independent sessions and a bounded sixteen-entry map", () => {
    const reader = new GatewayGoodbyes(ids.guild);
    for (let shard = 0; shard < 16; shard++) reader.read(ready(`synthetic-shard-${shard}`), shard);
    expect(reader.read(remove(), 0)?.eventIdentity).not.toBe(reader.read(remove(), 1)?.eventIdentity);
    expect(() => reader.read(ready(), 16)).toThrow("context is invalid");
    expect(() => reader.read(ready("replacement-existing-shard"), 0)).not.toThrow();
  });

  test("ignores foreign guilds and bots without acquiring a session or fetching", () => {
    const reader = new GatewayGoodbyes(ids.guild);
    expect(reader.read(remove(undefined, { id: ids.member }, ids.otherGuild), 0)).toBeNull();
    expect(reader.read(remove(undefined, { id: ids.member, bot: true }), 0)).toBeNull();
  });

  test("ignores irrelevant operations and dispatch types without changing context", () => {
    const reader = new GatewayGoodbyes(ids.guild);
    reader.read(ready(), 0);
    const first = reader.read(remove(), 0);
    for (const packet of [null, [], 1, "packet", {}, { op: 1, t: "READY", s: 1, d: { session_id: "ignored" } },
      { op: 0, t: "GUILD_MEMBER_ADD", s: 1, d: {} }, { op: 0, t: "RESUMED", s: 1, d: { session_id: "ignored" } }]) {
      expect(reader.read(packet, 0)).toBeNull();
    }
    expect(reader.read(remove(), 0)).toEqual(first);
  });

  test("requires current READY context for the configured guild and shard", () => {
    const reader = new GatewayGoodbyes(ids.guild);
    expect(() => reader.read(remove(), 0)).toThrow("context is invalid");
    reader.read(ready(), 0);
    expect(() => reader.read(remove(), 1)).toThrow("context is invalid");
  });

  test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "2", null])(
    "rejects invalid relevant sequence %p", (value) => {
      const reader = new GatewayGoodbyes(ids.guild);
      expect(() => reader.read({ ...ready(), s: value }, 0)).toThrow("context is invalid");
      reader.read(ready(), 0);
      expect(() => reader.read(remove(value), 0)).toThrow("context is invalid");
    },
  );

  test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid shard %p for relevant packets", (shard) => {
      const reader = new GatewayGoodbyes(ids.guild);
      expect(() => reader.read(ready(), shard)).toThrow("context is invalid");
      expect(() => reader.read(remove(), shard)).toThrow("context is invalid");
    },
  );

  test.each(["", "0", "01", (1n << 64n).toString(10), "member", 1, null])(
    "rejects noncanonical configured/user/guild identifiers %p", (value) => {
      expect(() => new GatewayGoodbyes(value as string)).toThrow("context is invalid");
      const reader = new GatewayGoodbyes(ids.guild);
      reader.read(ready(), 0);
      expect(() => reader.read(remove(2, { id: value }), 0)).toThrow("context is invalid");
      expect(() => reader.read(remove(2, { id: ids.member }, value), 0)).toThrow("context is invalid");
    },
  );

  test.each([
    { label: "missing", value: undefined }, { label: "null", value: null },
    { label: "object", value: {} }, { label: "array", value: [] },
    { label: "empty", value: "" }, { label: "oversize", value: "x".repeat(257) },
    { label: "numeric", value: 1 },
  ])("rejects missing, invalid or oversized READY session ($label)", ({ value: session }) => {
      const reader = new GatewayGoodbyes(ids.guild);
      expect(() => reader.read({ ...ready(), d: { session_id: session } }, 0)).toThrow("context is invalid");
    },
  );

  test.each([
    { label: "null", value: null }, { label: "array", value: [] },
    { label: "bot flag", value: { id: ids.member, bot: "false" } },
    { label: "empty", value: {} }, { label: "missing id", value: { bot: false } },
  ])("rejects malformed configured-guild removal data ($label)", ({ value: user }) => {
      const reader = new GatewayGoodbyes(ids.guild);
      reader.read(ready(), 0);
      expect(() => reader.read(remove(2, user), 0)).toThrow("context is invalid");
    },
  );
});
