import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { NoticeJournal } from "../src/notice-journal.js";
import { SYNTHETIC_DISCORD_IDS as ids } from "./discord-fixtures.js";

const identity = `welcome:${"a".repeat(64)}`;
const content = "Welcome, guild member.";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const filename = (key: string) => `${digest(key)}.json`;
const ack = () => Promise.resolve({ id: ids.member, channelId: ids.galleryChannel });
const parents: string[] = [];

async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), "mochirii-notice-test-"));
  await chmod(parent, 0o700);
  parents.push(parent);
  const path = join(parent, "notices");
  const journal = new NoticeJournal(path);
  await journal.initialize();
  return { parent, path, journal };
}

function receipt(key: string, status: "sent" | "dispatching" | "cancelled" = "sent") {
  return JSON.stringify({ schemaVersion: 1, identity: key, channelId: ids.galleryChannel,
    contentSha256: digest(content), status, messageId: status === "sent" ? ids.member : null }) + "\n";
}

afterEach(async () => {
  const temporaryRoot = resolve(tmpdir()) + sep;
  for (const parent of parents.splice(0)) {
    if (!resolve(parent).startsWith(temporaryRoot) || !parent.includes("mochirii-notice-test-")) throw new Error("Unexpected synthetic fixture path.");
    await rm(parent, { recursive: true, force: true });
  }
});

describe("durable notice journal", () => {
  test("durably admits once, stores no copy, and suppresses exact repeats after restart", async () => {
    const { path, journal } = await fixture();
    let observedNonce = "";
    expect(await journal.deliver(identity, ids.galleryChannel, content, async (nonce) => {
      observedNonce = nonce;
      const source = await readFile(join(path, filename(identity)), "utf8");
      expect(source).toBe(receipt(identity, "dispatching"));
      expect(source.includes(content)).toBe(false);
      expect(await readdir(path)).toEqual([filename(identity)]);
      return ack();
    })).toBe("sent");
    expect(observedNonce).toBe(digest(identity).slice(0, 25));
    const restarted = new NoticeJournal(path);
    await restarted.initialize();
    let calls = 0;
    expect(await restarted.deliver(identity, ids.galleryChannel, content, async () => { calls++; return ack(); })).toBe("duplicate");
    expect(calls).toBe(0);
    expect(await readFile(join(path, filename(identity)), "utf8")).toBe(receipt(identity));
  });

  test("serializes concurrent deliveries and sends different monthly identities once each", async () => {
    const { journal } = await fixture();
    let calls = 0;
    const send = async () => { calls++; await Promise.resolve(); return ack(); };
    expect(await Promise.all([journal.deliver(identity, ids.galleryChannel, content, send), journal.deliver(identity, ids.galleryChannel, content, send)])).toEqual(["sent", "duplicate"]);
    expect(await journal.deliver("spotlight:2026-10-01", ids.galleryChannel, content, send)).toBe("sent");
    expect(await journal.deliver("spotlight:2026-11-01", ids.galleryChannel, content, send)).toBe("sent");
    expect(calls).toBe(3);
  });

  test("a queued cancellation rechecks at admission and creates no intent or POST", async () => {
    const { path, journal } = await fixture();
    let finish!: () => void;
    let admitted!: () => void;
    const started = new Promise<void>((resolve) => { admitted = resolve; });
    const first = journal.deliver(identity, ids.galleryChannel, content, async () => {
      admitted(); await new Promise<void>((resolve) => { finish = resolve; }); return ack();
    });
    await started;
    let activeMonth = true;
    let guardCalls = 0;
    let posts = 0;
    const queued = journal.deliver("spotlight:2026-10-01", ids.galleryChannel, content,
      async () => { posts++; return ack(); }, () => { guardCalls++; return activeMonth; });
    activeMonth = false;
    finish();
    expect(await first).toBe("sent");
    expect(await queued).toBe("skipped");
    expect(guardCalls).toBe(1);
    expect(posts).toBe(0);
    expect(await readdir(path)).toEqual([filename(identity)]);
  });

  test("a guard changing after durable intent preserves cancellation across restart", async () => {
    const { path, journal } = await fixture();
    let guardCalls = 0;
    let posts = 0;
    expect(await journal.deliver(identity, ids.galleryChannel, content,
      async () => { posts++; return ack(); }, () => ++guardCalls === 1)).toBe("skipped");
    expect(guardCalls).toBe(2);
    expect(posts).toBe(0);
    expect(await readFile(join(path, filename(identity)), "utf8")).toBe(receipt(identity, "cancelled"));
    const restarted = new NoticeJournal(path);
    await restarted.initialize();
    expect(await restarted.deliver(identity, ids.galleryChannel, content,
      async () => { posts++; return ack(); }, () => true)).toBe("duplicate");
    expect(posts).toBe(0);
  });

  test("two successful guard reads permit the normal single POST", async () => {
    const { journal } = await fixture();
    let guardCalls = 0;
    let posts = 0;
    expect(await journal.deliver(identity, ids.galleryChannel, content,
      async () => { posts++; return ack(); }, () => { guardCalls++; return true; })).toBe("sent");
    expect(guardCalls).toBe(2);
    expect(posts).toBe(1);
  });

  test("goodbye identity uses its own durable receipt and suppresses duplicates", async () => {
    const { path, journal } = await fixture();
    const goodbye = `goodbye:${"b".repeat(64)}`;
    let posts = 0;
    const send = async () => { posts++; return ack(); };
    expect(await journal.deliver(goodbye, ids.galleryChannel, content, send)).toBe("sent");
    const restarted = new NoticeJournal(path);
    await restarted.initialize();
    expect(await restarted.deliver(goodbye, ids.galleryChannel, content, send)).toBe("duplicate");
    expect(posts).toBe(1);
  });

  test.each([1, 2])("guard failure at read %i holds the journal without a POST", async (failureAt) => {
    const { path, journal } = await fixture();
    let guardCalls = 0;
    let posts = 0;
    await expect(journal.deliver(identity, ids.galleryChannel, content,
      async () => { posts++; return ack(); }, () => {
        if (++guardCalls === failureAt) throw new Error("Synthetic predicate failure");
        return true;
      })).rejects.toThrow("held");
    await expect(journal.deliver(identity, ids.galleryChannel, content, ack)).rejects.toThrow("held");
    expect(posts).toBe(0);
    if (failureAt === 1) {
      expect(await readdir(path)).toHaveLength(0);
    } else {
      expect(await readFile(join(path, filename(identity)), "utf8")).toBe(receipt(identity, "dispatching"));
      await expect(new NoticeJournal(path).initialize()).rejects.toThrow("held");
    }
  });

  test.each(["route", "content"])("never resends an identity with %s drift", async (drift) => {
    const { path, journal } = await fixture();
    await journal.deliver(identity, ids.galleryChannel, content, ack);
    let calls = 0;
    await expect(journal.deliver(identity, drift === "route" ? ids.otherChannel : ids.galleryChannel,
      drift === "content" ? "Different welcome." : content, async () => { calls++; return ack(); })).rejects.toThrow("held");
    expect(calls).toBe(0);
    expect(await readFile(join(path, filename(identity)), "utf8")).toBe(receipt(identity));
  });

  test("a failed or uncertain POST holds the original intent across restart without replay", async () => {
    const { path, journal } = await fixture();
    let calls = 0;
    const send = async () => { calls++; throw new Error("Synthetic acknowledgement lost"); };
    await expect(journal.deliver(identity, ids.galleryChannel, content, send)).rejects.toThrow("held");
    await expect(journal.deliver(identity, ids.galleryChannel, content, send)).rejects.toThrow("held");
    const restarted = new NoticeJournal(path);
    await expect(restarted.initialize()).rejects.toThrow("held");
    expect(calls).toBe(1);
    expect(await readFile(join(path, filename(identity)), "utf8")).toBe(receipt(identity, "dispatching"));
  });

  test.each([
    { id: "0", channelId: ids.galleryChannel },
    { id: "01", channelId: ids.galleryChannel },
    { id: (1n << 64n).toString(10), channelId: ids.galleryChannel },
    { id: ids.member, channelId: ids.otherChannel },
  ])("invalid acknowledgements preserve dispatching intent", async (invalid) => {
    const { path, journal } = await fixture();
    await expect(journal.deliver(identity, ids.galleryChannel, content, async () => invalid)).rejects.toThrow("held");
    expect(await readFile(join(path, filename(identity)), "utf8")).toBe(receipt(identity, "dispatching"));
    await expect(new NoticeJournal(path).initialize()).rejects.toThrow("held");
  });

  test("concurrent journal instances cannot issue two POSTs for one identity", async () => {
    const { path, journal } = await fixture();
    const other = new NoticeJournal(path);
    await other.initialize();
    let calls = 0;
    let finish!: () => void;
    let admitted!: () => void;
    const started = new Promise<void>((resolve) => { admitted = resolve; });
    const pending = journal.deliver(identity, ids.galleryChannel, content, async () => {
      calls++; admitted(); await new Promise<void>((resolve) => { finish = resolve; }); return ack();
    });
    await started;
    await expect(other.deliver(identity, ids.galleryChannel, content, async () => { calls++; return ack(); })).rejects.toThrow("held");
    finish();
    expect(await pending).toBe("sent");
    expect(calls).toBe(1);
  });

  test("replaced directory after send cannot create a false sent receipt", async () => {
    const { path, journal } = await fixture();
    const retained = path + "-preserved";
    await expect(journal.deliver(identity, ids.galleryChannel, content, async () => {
      await rename(path, retained);
      await mkdir(path, { mode: 0o700 });
      return ack();
    })).rejects.toThrow("held");
    expect(await readdir(path)).toHaveLength(0);
    expect(await readFile(join(retained, filename(identity)), "utf8")).toBe(receipt(identity, "dispatching"));
  });

  test.each(["admission.lock", "orphan.tmp", "unexpected.json"])("startup refuses retained %s without deleting evidence", async (name) => {
    const { path } = await fixture();
    await writeFile(join(path, name), "synthetic retained evidence\n", { mode: 0o600 });
    await expect(new NoticeJournal(path).initialize()).rejects.toThrow("held");
    expect(await readFile(join(path, name), "utf8")).toBe("synthetic retained evidence\n");
  });

  test.each([
    "{not-json}",
    receipt(identity).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    receipt(identity).replace(digest(content), "not-a-digest"),
    "x".repeat(1025),
  ])("startup rejects corrupt, duplicate-key and oversized receipts", async (source) => {
    const { path } = await fixture();
    await writeFile(join(path, filename(identity)), source, { mode: 0o600 });
    await expect(new NoticeJournal(path).initialize()).rejects.toThrow("held");
    expect(await readFile(join(path, filename(identity)), "utf8")).toBe(source);
  });

  test("startup rejects hard-linked receipts", async () => {
    const { parent, path } = await fixture();
    const original = join(parent, "synthetic-receipt");
    await writeFile(original, receipt(identity), { mode: 0o600 });
    await link(original, join(path, filename(identity)));
    await expect(new NoticeJournal(path).initialize()).rejects.toThrow("held");
  });

  test.skipIf(process.platform === "win32")("rejects nonprivate directories, files and symlinked journal paths", async () => {
    const { parent, path } = await fixture();
    await chmod(path, 0o755);
    await expect(new NoticeJournal(path).initialize()).rejects.toThrow("held");
    await chmod(path, 0o700);
    await writeFile(join(path, filename(identity)), receipt(identity), { mode: 0o644 });
    await expect(new NoticeJournal(path).initialize()).rejects.toThrow("held");
    const alias = join(parent, "alias");
    await symlink(path, alias);
    await expect(new NoticeJournal(alias).initialize()).rejects.toThrow("held");
    await chmod(parent, 0o755);
    await expect(new NoticeJournal(join(parent, "fresh")).initialize()).rejects.toThrow("held");
    await chmod(parent, 0o700);
  });

  test("4096 retained receipts allow duplicates but refuse new admissions without sending", async () => {
    const { path } = await fixture();
    const keys = Array.from({ length: 4096 }, (_, index) => `welcome:${index.toString(16).padStart(64, "0")}`);
    for (let index = 0; index < keys.length; index += 64) {
      await Promise.all(keys.slice(index, index + 64).map((key) => writeFile(join(path, filename(key)), receipt(key), { mode: 0o600 })));
    }
    const journal = new NoticeJournal(path);
    await journal.initialize();
    expect(await journal.deliver(keys[0]!, ids.galleryChannel, content, ack)).toBe("duplicate");
    let calls = 0;
    await expect(journal.deliver(identity, ids.galleryChannel, content, async () => { calls++; return ack(); })).rejects.toThrow("held");
    expect(calls).toBe(0);
    expect((await readdir(path)).filter((name) => name.endsWith(".json"))).toHaveLength(4096);
  }, 30_000);

  test("invalid inputs and uninitialized use never invoke the callback", async () => {
    const { parent, path, journal } = await fixture();
    expect(() => new NoticeJournal("relative")).toThrow("held");
    expect(() => new NoticeJournal(dirname(resolve(path)) + sep + ".." + sep + "notices")).toThrow("held");
    let calls = 0;
    const send = async () => { calls++; return ack(); };
    for (const key of ["welcome:ABC", "spotlight:0000-01-01", "spotlight:2026-13-01", "spotlight:2026-02-02"]) {
      await expect(journal.deliver(key, ids.galleryChannel, content, send)).rejects.toThrow("held");
    }
    for (const channel of ["0", "01", (1n << 64n).toString(10)]) {
      await expect(journal.deliver(identity, channel, content, send)).rejects.toThrow("held");
    }
    for (const text of ["", " ", "x".repeat(2001), "\ud800"]) {
      await expect(journal.deliver(identity, ids.galleryChannel, text, send)).rejects.toThrow("held");
    }
    await expect(new NoticeJournal(join(parent, "uninitialized")).deliver(identity, ids.galleryChannel, content, send)).rejects.toThrow("held");
    expect(calls).toBe(0);
  });
});
