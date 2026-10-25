import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { CommunityNotices, readNoticeJsonResponse, type CommunityNoticesOptions, type NoticeFetch } from "../src/community-notices.js";
import { NoticeJournal } from "../src/notice-journal.js";
import { WELCOME_DM_MESSAGE } from "../src/welcome.js";
import { SYNTHETIC_DISCORD_IDS as ID } from "./discord-fixtures.js";

const ENDPOINT = "https://backend.example.test/functions/v1/get-current-spotlight-winner";
const NOW = Date.parse("2026-10-26T12:00:00Z");
const JSON_HEADERS = { "Content-Type": "application/json" };
const FAILURE = "Community notice verification failed.";

function json(winnerName: unknown = "Example Member", monthKey: unknown = "2026-10-01") {
  return Response.json({ ok: true, data: { winnerName, monthKey } });
}

function fixture(overrides: Partial<CommunityNoticesOptions> = {}) {
  const state = { initializes: 0, reads: 0, resolutions: 0, faults: 0,
    deliveries: [] as Array<{ key: string; channelId: string; content: string }>,
    sends: [] as Array<{ channelId: string; content: string; nonce: string }>,
    receipts: new Map<string, string>() };
  const options: CommunityNoticesOptions = {
    guildId: ID.guild, welcomeChannelId: ID.galleryChannel, spotlightChannelId: ID.otherChannel,
    spotlightUrl: ENDPOINT, clock: () => NOW,
    journal: {
      initialize: async () => { state.initializes++; },
      deliver: async (key, channelId, content, send, canDispatch) => {
        if (canDispatch && canDispatch() !== true) return "skipped";
        state.deliveries.push({ key, channelId, content });
        const bound = `${channelId}:${content}`;
        if (state.receipts.has(key)) {
          if (state.receipts.get(key) !== bound) throw new Error("fixture identity conflict");
          return "duplicate";
        }
        const nonce = createHash("sha256").update(key).digest("hex").slice(0, 25);
        await send(nonce);
        state.receipts.set(key, bound);
        return "sent";
      },
    },
    fetch: (async () => { state.reads++; return json(); }) as NoticeFetch,
    resolveChannel: async (id) => {
      state.resolutions++; return { id, guildId: ID.guild, type: 0, canView: true, canSend: true };
    },
    send: async (channelId, content, nonce) => {
      state.sends.push({ channelId, content, nonce }); return { id: ID.message, channelId };
    },
    onFault: () => { state.faults++; },
    ...overrides,
  };
  return { notices: new CommunityNotices(options), state, options };
}

function member(joinedTimestamp: number | null = NOW - 1000) {
  return { guild: { id: ID.guild as string }, user: { id: ID.member as string, bot: false }, joinedTimestamp };
}

function leave(eventIdentity = "a".repeat(64)) {
  return { guild: { id: ID.guild as string }, user: { id: ID.member as string, bot: false }, eventIdentity };
}

describe("community welcome notices", () => {
  test("disabled routes perform no journal, fetch, resolution or send", async () => {
    const { notices, state } = fixture({ welcomeChannelId: null, spotlightChannelId: null });
    await notices.initialize(); await notices.welcome(member()); await notices.goodbye(leave()); await notices.checkSpotlight();
    expect(state.initializes).toBe(0); expect(state.reads).toBe(0);
    expect(state.resolutions).toBe(0); expect(state.sends).toHaveLength(0);
  });

  test("routes unchanged welcome copy publicly and deduplicates the same join; a real rejoin is distinct", async () => {
    const { notices, state } = fixture(); await notices.initialize();
    await notices.welcome(member()); await notices.welcome(member());
    expect(state.sends).toHaveLength(1);
    expect(state.sends[0]?.channelId).toBe(ID.galleryChannel);
    expect(state.sends[0]?.content).toBe(`<@${ID.member}>\n\n${WELCOME_DM_MESSAGE}`);
    expect(state.deliveries[0]?.key).toMatch(/^welcome:[0-9a-f]{64}$/);
    await notices.welcome(member(NOW - 500)); expect(state.sends).toHaveLength(2);
    expect(state.deliveries[0]?.key).not.toBe(state.deliveries[2]?.key);
  });

  test("foreign guilds and bots do not inspect routes or send", async () => {
    const { notices, state } = fixture(); await notices.initialize();
    await notices.welcome({ ...member(), guild: { id: ID.otherGuild } });
    await notices.welcome({ ...member(), user: { id: ID.member, bot: true } });
    await notices.goodbye({ ...leave(), guild: { id: ID.otherGuild } });
    await notices.goodbye({ ...leave(), user: { id: ID.member, bot: true } });
    expect(state.resolutions).toBe(0); expect(state.sends).toHaveLength(0); expect(state.faults).toBe(0);
  });

  test("uncached goodbyes use the public channel with separate durable dispatch identities", async () => {
    const { notices, state } = fixture(); await notices.initialize();
    await notices.welcome(member()); await notices.goodbye(leave()); await notices.goodbye(leave());
    expect(state.sends).toHaveLength(2);
    expect(state.sends[1]?.channelId).toBe(ID.galleryChannel);
    expect(state.sends[1]?.content).toBe(`<@${ID.member}> has left Mōchirīī. Wishing you well on your next journey.`);
    expect(state.deliveries[1]?.key).toBe(`goodbye:${"a".repeat(64)}`);
    await notices.goodbye(leave("b".repeat(64))); expect(state.sends).toHaveLength(3);
    expect(state.deliveries[3]?.key).not.toBe(state.deliveries[1]?.key);
  });

  for (const eventIdentity of [undefined, null, "", "a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
    test(`a goodbye without valid session-bound dispatch identity ${eventIdentity} cannot send`, async () => {
      const { notices, state } = fixture(); await notices.initialize();
      await expect(notices.goodbye({ ...leave(), eventIdentity: eventIdentity as string })).rejects.toThrow(FAILURE);
      expect(state.sends).toHaveLength(0);
    });
  }

  for (const joined of [null, 0, -1, NOW + 1, 1.5, Number.NaN]) {
    test(`rejects unverified join timestamp ${joined} before any message`, async () => {
      const { notices, state } = fixture(); await notices.initialize();
      await expect(notices.welcome(member(joined))).rejects.toThrow(FAILURE);
      expect(state.sends).toHaveLength(0); expect(state.faults).toBe(1);
    });
  }

  for (const userId of ["0", "01", (1n << 64n).toString(10), "not-a-member"]) {
    test(`rejects noncanonical member identifier ${userId}`, async () => {
      const { notices, state } = fixture(); await notices.initialize();
      await expect(notices.welcome({ ...member(), user: { id: userId } })).rejects.toThrow(FAILURE);
      expect(state.sends).toHaveLength(0);
    });
  }

  test("an invalid clock cannot authorize an unverified join", async () => {
    const { notices, state } = fixture({ clock: () => Number.NaN }); await notices.initialize();
    await expect(notices.welcome(member())).rejects.toThrow(FAILURE);
    expect(state.sends).toHaveLength(0);
  });

  for (const route of [
    { id: ID.otherChannel }, { guildId: ID.otherGuild }, { type: 2 }, { type: 11 },
    { canView: false }, { canSend: false },
  ]) {
    test(`rejects a mismatched or unpermitted route ${JSON.stringify(route)}`, async () => {
      const { notices, state } = fixture({ resolveChannel: async (id) => ({
        id, guildId: ID.guild, type: 0, canView: true, canSend: true, ...route,
      }) }); await notices.initialize();
      await expect(notices.welcome(member())).rejects.toThrow(FAILURE);
      expect(state.sends).toHaveLength(0); expect(state.deliveries).toHaveLength(0);
    });
  }

  test("accepts an announcement channel without adding a fallback", async () => {
    const { notices, state } = fixture({ resolveChannel: async (id) => ({
      id, guildId: ID.guild, type: 5, canView: true, canSend: true,
    }) }); await notices.initialize(); await notices.welcome(member()); expect(state.sends).toHaveLength(1);
  });

  test("send uncertainty raises one fixed fault and never retries this instance", async () => {
    let calls = 0;
    const { notices, state } = fixture({ send: async () => { calls++; throw new Error("private response"); } });
    await notices.initialize(); await expect(notices.welcome(member())).rejects.toThrow(FAILURE);
    await expect(notices.welcome(member())).rejects.toThrow(FAILURE);
    expect(calls).toBe(1); expect(state.faults).toBe(1);
  });
});

describe("Website-selected spotlight consumer", () => {
  test("reads the canonical public DTO once and announces one escaped current-month name", async () => {
    let request: RequestInit | undefined;
    const { notices, state } = fixture({ fetch: (async (url, init) => {
      expect(url).toBe(ENDPOINT); request = init; return json("Example *Member* @everyone <@100000000000000006>");
    }) as NoticeFetch });
    await notices.initialize(); await notices.checkSpotlight(); await notices.checkSpotlight();
    expect(request?.method).toBe("GET"); expect(request?.redirect).toBe("error"); expect(request?.cache).toBe("no-store");
    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(state.sends).toHaveLength(1); expect(state.sends[0]?.channelId).toBe(ID.otherChannel);
    expect(state.sends[0]?.content).toContain("Mōchirīī Member Spotlight · 2026-10");
    expect(state.sends[0]?.content).toContain("\\*Member\\*");
    expect(state.deliveries[0]?.key).toBe("spotlight:2026-10-01");
  });

  test("a valid null selection remains pending with no fault or send", async () => {
    const { notices, state } = fixture({ fetch: (async () => json(null)) as NoticeFetch });
    await notices.initialize(); await notices.checkSpotlight();
    expect(state.resolutions).toBe(0); expect(state.sends).toHaveLength(0); expect(state.faults).toBe(0);
  });

  for (const body of [
    { ok: false, data: { winnerName: "Name", monthKey: "2026-10-01" } },
    { ok: true, data: { winnerName: "Name", monthKey: "2026-09-01" } },
    { ok: true, data: { winnerName: "Name", monthKey: "2026-11-01" } },
    { ok: true, data: { winnerName: "Name", monthKey: "2026-10-01", profileId: "private" } },
    { ok: true, data: { winnerName: "Name", monthKey: "2026-10-01" }, extra: true },
    { ok: true, data: { winnerName: 42, monthKey: "2026-10-01" } },
    { ok: true, data: { winnerName: "", monthKey: "2026-10-01" } },
    { ok: true, data: { winnerName: " Name ", monthKey: "2026-10-01" } },
    { ok: true, data: { winnerName: "Name\nOther", monthKey: "2026-10-01" } },
    { ok: true, data: { winnerName: "Name\u202eOther", monthKey: "2026-10-01" } },
    { ok: true, data: { winnerName: "Name\ud800", monthKey: "2026-10-01" } },
    { ok: true, data: { winnerName: "x".repeat(121), monthKey: "2026-10-01" } },
  ]) {
    test(`rejects noncanonical winner DTO ${JSON.stringify(body)}`, async () => {
      const { notices, state } = fixture({ fetch: (async () => Response.json(body)) as NoticeFetch });
      await notices.initialize(); await expect(notices.checkSpotlight()).rejects.toThrow(FAILURE);
      expect(state.resolutions).toBe(0); expect(state.sends).toHaveLength(0); expect(state.faults).toBe(1);
    });
  }

  test("accepts the producer's full120-character bounded name", async () => {
    const { notices, state } = fixture({ fetch: (async () => json("界".repeat(120))) as NoticeFetch });
    await notices.initialize(); await notices.checkSpotlight(); expect(state.sends).toHaveLength(1);
  });

  for (const [date, month] of [
    ["2026-10-31T15:59:59.999Z", "2026-10-01"], ["2026-10-31T16:00:00.000Z", "2026-11-01"],
    ["2026-12-31T15:59:59.999Z", "2026-12-01"], ["2026-12-31T16:00:00.000Z", "2027-01-01"],
  ]) {
    test(`uses Singapore month at ${date}`, async () => {
      const { notices, state } = fixture({ clock: () => Date.parse(date!), fetch: (async () => json("Name", month)) as NoticeFetch });
      await notices.initialize(); await notices.checkSpotlight(); expect(state.deliveries[0]?.key).toBe(`spotlight:${month}`);
    });
  }

  test("month changing during a route lookup prevents the old selection send", async () => {
    let now = Date.parse("2026-10-31T15:59:59.999Z");
    const { notices, state } = fixture({ clock: () => now, resolveChannel: async (id) => {
      now++; return { id, guildId: ID.guild, type: 0, canView: true, canSend: true };
    } });
    await notices.initialize(); await notices.checkSpotlight();
    expect(state.deliveries).toHaveLength(0); expect(state.sends).toHaveLength(0); expect(state.faults).toBe(0);
  });

  test("month changing during GET skips harmlessly and the next current-month read may announce", async () => {
    let now = Date.parse("2026-10-31T15:59:59.999Z"); let reads = 0;
    const { notices, state } = fixture({ clock: () => now, fetch: (async () => {
      reads++;
      if (reads === 1) { now++; return json("Name", "2026-10-01"); }
      return json("Name", "2026-11-01");
    }) as NoticeFetch });
    await notices.initialize(); await notices.checkSpotlight();
    expect(state.sends).toHaveLength(0); expect(state.faults).toBe(0);
    await notices.checkSpotlight(); expect(state.sends).toHaveLength(1);
    expect(state.deliveries[0]?.key).toBe("spotlight:2026-11-01");
  });

  test("overlapping checks share one read and one delivery", async () => {
    let release!: (response: Response) => void; let reads = 0;
    const { notices, state } = fixture({ fetch: (() => { reads++; return new Promise((resolve) => { release = resolve; }); }) as NoticeFetch });
    await notices.initialize(); const first = notices.checkSpotlight(); const second = notices.checkSpotlight();
    expect(first).toBe(second); release(json()); await Promise.all([first, second]);
    expect(reads).toBe(1); expect(state.sends).toHaveLength(1);
  });

  for (const fetchImpl of [
    async () => { throw new Error("private network detail"); },
    async () => new Response("", { status: 302, headers: { Location: "https://other.example.test/" } }),
    async () => new Response("", { status: 500 }),
    async () => new Response("<html>no</html>", { headers: { "Content-Type": "text/html" } }),
    async () => new Response("{invalid", { headers: JSON_HEADERS }),
    async () => new Response("x".repeat(16385), { headers: JSON_HEADERS }),
  ]) {
    test("HTTP, network, type and size failures cannot send", async () => {
      const { notices, state } = fixture({ fetch: fetchImpl as NoticeFetch });
      await notices.initialize(); await expect(notices.checkSpotlight()).rejects.toThrow(FAILURE);
      expect(state.sends).toHaveLength(0); expect(state.faults).toBe(1);
    });
  }

  test("stop cancels an active public read without fault or message", async () => {
    let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
    const { notices, state } = fixture({ fetch: (async (_url, init) => {
      started(); return new Promise((_resolve, reject) => { init!.signal!.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); });
    }) as NoticeFetch });
    await notices.initialize(); const pending = notices.checkSpotlight(); await ready; notices.stop(); await pending;
    await notices.welcome(member()); await notices.checkSpotlight();
    expect(state.sends).toHaveLength(0); expect(state.faults).toBe(0);
  });
});

describe("bounded notice JSON reader", () => {
  test("accepts insignificant JSON whitespace", async () => {
    expect(await readNoticeJsonResponse(new Response(' {\n "id" : "100000000000000005" }\n', { headers: JSON_HEADERS }))).toEqual({ id: ID.message });
  });
  test("accepts valid escaped Unicode and slashes in provider JSON", async () => {
    const source = '{"name":"\\u754c","url":"https:\\/\\/example.test"}';
    expect(await readNoticeJsonResponse(new Response(source, { headers: JSON_HEADERS })))
      .toEqual({ name: "界", url: "https://example.test" });
  });
  test("rejects invalid UTF8 and oversized declared content before interpretation", async () => {
    await expect(readNoticeJsonResponse(new Response(new Uint8Array([0xff]), { headers: JSON_HEADERS }))).rejects.toThrow(FAILURE);
    await expect(readNoticeJsonResponse(new Response("{}", { headers: { ...JSON_HEADERS, "Content-Length": "16385" } }))).rejects.toThrow(FAILURE);
  });
  test("a body stream cannot outlive its abort deadline", async () => {
    const stream = new ReadableStream<Uint8Array>({ start() {} }); const controller = new AbortController();
    const pending = readNoticeJsonResponse(new Response(stream, { headers: JSON_HEADERS }), 16384, controller.signal);
    controller.abort(); await expect(pending).rejects.toThrow(FAILURE);
  });
});

describe("community notice durable restart integration", () => {
  async function withDirectory(work: (path: string) => Promise<void>) {
    const parent = await mkdtemp(join(tmpdir(), "mochirii-community-notice-test-"));
    await chmod(parent, 0o700);
    try { await work(join(parent, "notices")); }
    finally {
      if (!resolve(parent).startsWith(resolve(tmpdir()) + sep) || !parent.includes("mochirii-community-notice-test-")) {
        throw new Error("Unexpected synthetic fixture path.");
      }
      await rm(parent, { recursive: true, force: true });
    }
  }

  test("completed welcome, goodbye and selected-month receipts suppress all sends after restart", async () => {
    await withDirectory(async (path) => {
      let sends = 0;
      const options = fixture({ journal: new NoticeJournal(path), send: async (channelId) => {
        sends++; return { id: ID.message, channelId };
      } }).options;
      const first = new CommunityNotices(options); await first.initialize();
      await first.welcome(member()); await first.goodbye(leave()); await first.checkSpotlight(); first.stop();
      expect(sends).toBe(3);
      const restarted = new CommunityNotices({ ...options, journal: new NoticeJournal(path) });
      await restarted.initialize(); await restarted.welcome(member()); await restarted.goodbye(leave());
      await restarted.checkSpotlight(); restarted.stop(); expect(sends).toBe(3);
    });
  });

  test("an ambiguous welcome persists a hold that blocks startup without resending", async () => {
    await withDirectory(async (path) => {
      let sends = 0;
      const options = fixture({ journal: new NoticeJournal(path), send: async () => {
        sends++; throw new Error("synthetic lost acknowledgement");
      } }).options;
      const first = new CommunityNotices(options); await first.initialize();
      await expect(first.welcome(member())).rejects.toThrow(FAILURE); first.stop();
      const restarted = new CommunityNotices({ ...options, journal: new NoticeJournal(path) });
      await expect(restarted.initialize()).rejects.toThrow(FAILURE);
      expect(sends).toBe(1);
    });
  });

  test("normal stop drains both already admitted joins and leaves clean deduplicated restart receipts", async () => {
    await withDirectory(async (path) => {
      const journal = new NoticeJournal(path);
      let admitted = 0; let sent = 0;
      let bothAdmitted!: () => void; const admission = new Promise<void>((resolve) => { bothAdmitted = resolve; });
      let releaseFirst!: () => void; const firstAck = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const options = fixture({
        journal: {
          initialize: () => journal.initialize(),
          deliver: (...args) => {
            const pending = journal.deliver(...args);
            admitted++; if (admitted === 2) bothAdmitted();
            return pending;
          },
        },
        send: async (channelId) => {
          sent++; if (sent === 1) await firstAck;
          return { id: ID.message, channelId };
        },
      }).options;
      const notices = new CommunityNotices(options); await notices.initialize();
      const first = notices.welcome(member()); const second = notices.welcome(member(NOW - 500));
      await admission; notices.stop(); releaseFirst(); await Promise.all([first, second]);
      await notices.welcome(member(NOW - 100)); expect(sent).toBe(2);
      const restarted = new CommunityNotices({ ...options, journal: new NoticeJournal(path) });
      await restarted.initialize(); await restarted.welcome(member()); await restarted.welcome(member(NOW - 500));
      expect(sent).toBe(2); restarted.stop();
    });
  });

  test("a selected month expiring in the journal queue skips without a send or fault and the next month remains usable", async () => {
    await withDirectory(async (path) => {
      const journal = new NoticeJournal(path);
      let now = Date.parse("2026-10-31T15:59:59.999Z"); let admitted = 0; let sent = 0; let faults = 0;
      let bothAdmitted!: () => void; const admission = new Promise<void>((resolve) => { bothAdmitted = resolve; });
      let releaseFirst!: () => void; const firstAck = new Promise<void>((resolve) => { releaseFirst = resolve; });
      const options = fixture({
        clock: () => now, onFault: () => { faults++; },
        fetch: (async () => json("Name", "2026-10-01")) as NoticeFetch,
        journal: {
          initialize: () => journal.initialize(),
          deliver: (...args) => {
            const pending = journal.deliver(...args);
            admitted++; if (admitted === 2) bothAdmitted(); return pending;
          },
        },
        send: async (channelId) => {
          sent++; if (sent === 1) await firstAck;
          return { id: ID.message, channelId };
        },
      }).options;
      const notices = new CommunityNotices(options); await notices.initialize();
      const first = notices.welcome(member()); const queuedSpotlight = notices.checkSpotlight();
      await admission; now++; releaseFirst(); await Promise.all([first, queuedSpotlight]);
      expect(sent).toBe(1); expect(faults).toBe(0); notices.stop();
      const restarted = new CommunityNotices({ ...options, journal: new NoticeJournal(path),
        fetch: (async () => json("New Month Name", "2026-11-01")) as NoticeFetch });
      await restarted.initialize(); await restarted.checkSpotlight(); restarted.stop();
      expect(sent).toBe(2); expect(faults).toBe(0);
    });
  });
});
