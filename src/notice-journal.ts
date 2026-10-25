import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readPrivateFile } from "./member-forwarder.js";

const MAX_RECEIPTS = 4096;
const MAX_BYTES = 1024;
const LOCK = "admission.lock";
const RECEIPT = /^[0-9a-f]{64}\.json$/u;
const UINT64_MAX = 18_446_744_073_709_551_615n;
type NoticeReceipt = {
  schemaVersion: 1;
  identity: string;
  channelId: string;
  contentSha256: string;
  status: "dispatching" | "sent" | "cancelled";
  messageId: string | null;
};

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]{0,19}$/u.test(value) && BigInt(value) <= UINT64_MAX;
}

function validIdentity(value: string): boolean {
  if (/^(?:welcome|goodbye):[0-9a-f]{64}$/u.test(value)) return true;
  const match = /^spotlight:([0-9]{4})-(0[1-9]|1[0-2])-01$/u.exec(value);
  return !!match && match[1] !== "0000";
}

function held(): Error {
  return new Error("Notice journal is held; operator reconciliation required.");
}

function dispatchAllowed(predicate?: () => boolean): boolean {
  const allowed = predicate ? predicate() : true;
  if (typeof allowed !== "boolean") throw held();
  return allowed;
}

function privateDirectory(metadata: Stats): boolean {
  return metadata.isDirectory() && !metadata.isSymbolicLink() &&
    (process.platform === "win32" || ((metadata.mode & 0o777) === 0o700 && metadata.uid === process.getuid?.()));
}

function sameDirectory(left: Stats, right: Stats): boolean {
  return privateDirectory(right) && left.dev === right.dev && left.ino === right.ino;
}

async function syncDirectory(path: string): Promise<void> {
  // Windows synthetic tests cannot fsync directories; Linux production must.
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

function parseReceipt(source: string, filename: string): NoticeReceipt {
  const value = JSON.parse(source) as NoticeReceipt;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    JSON.stringify(value) + "\n" !== source ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([
      "channelId", "contentSha256", "identity", "messageId", "schemaVersion", "status",
    ]) || value.schemaVersion !== 1 || typeof value.identity !== "string" || !validIdentity(value.identity) ||
    filename !== `${hash(value.identity)}.json` || !identifier(value.channelId) ||
    typeof value.contentSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.contentSha256) ||
    !(((value.status === "dispatching" || value.status === "cancelled") && value.messageId === null) ||
      (value.status === "sent" && identifier(value.messageId)))) throw held();
  return value;
}

/** Durable at-most-once admission. Ambiguous sends are never automatically replayed. */
export class NoticeJournal {
  readonly path: string;
  #parent: Stats | undefined;
  #directory: Stats | undefined;
  #ready = false;
  #held = false;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(path: string) {
    if (!isAbsolute(path) || resolve(path) !== path || dirname(path) === path) throw held();
    this.path = path;
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #directories(): Promise<void> {
    if (!this.#parent || !this.#directory ||
      !sameDirectory(this.#parent, await lstat(dirname(this.path))) ||
      !sameDirectory(this.#directory, await lstat(this.path))) throw held();
  }

  async #receipts(ownLock = false): Promise<Map<string, NoticeReceipt>> {
    await this.#directories();
    const filenames = await readdir(this.path);
    if (filenames.length > MAX_RECEIPTS + Number(ownLock)) throw held();
    const result = new Map<string, NoticeReceipt>();
    for (const filename of filenames) {
      if (ownLock && filename === LOCK) continue;
      if (!RECEIPT.test(filename)) throw held();
      const value = parseReceipt(await readPrivateFile(join(this.path, filename), MAX_BYTES), filename);
      if (result.has(value.identity) || value.status === "dispatching") throw held();
      result.set(value.identity, value);
    }
    await this.#directories();
    return result;
  }

  initialize(): Promise<void> {
    return this.#serialize(async () => {
      if (this.#ready || this.#held) throw held();
      try {
        this.#parent = await lstat(dirname(this.path));
        if (!privateDirectory(this.#parent)) throw held();
        await mkdir(this.path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        this.#directory = await lstat(this.path);
        if (!privateDirectory(this.#directory)) throw held();
        await syncDirectory(dirname(this.path));
        await this.#receipts();
        this.#ready = true;
      } catch {
        this.#held = true;
        throw held();
      }
    });
  }

  async #complete(filename: string, source: string, receipt: NoticeReceipt): Promise<void> {
    await this.#directories();
    const target = join(this.path, filename);
    if (await readPrivateFile(target, MAX_BYTES) !== source) throw held();
    const completed = JSON.stringify(receipt) + "\n";
    const temporary = join(this.path, `${filename}.${randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(completed, "utf8"); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
    await syncDirectory(this.path);
  }

  deliver(
    identity: string,
    channelId: string,
    content: string,
    send: (nonce: string) => Promise<{ id: string; channelId: string }>,
    canDispatch?: () => boolean,
  ): Promise<"sent" | "duplicate" | "skipped"> {
    if (typeof identity !== "string" || !validIdentity(identity) || !identifier(channelId) ||
      typeof content !== "string" || !content.trim() || content.length > 2000 ||
      Buffer.from(content, "utf8").toString("utf8") !== content || typeof send !== "function" ||
      (canDispatch !== undefined && typeof canDispatch !== "function")) {
      return Promise.reject(held());
    }
    return this.#serialize(async () => {
      if (!this.#ready || this.#held) throw held();
      const filename = `${hash(identity)}.json`;
      const target = join(this.path, filename);
      const intent: NoticeReceipt = {
        schemaVersion: 1, identity, channelId, contentSha256: hash(content), status: "dispatching", messageId: null,
      };
      const source = JSON.stringify(intent) + "\n";
      try {
        if (!dispatchAllowed(canDispatch)) return "skipped";
        await this.#directories();
        // Short exclusive admission covers capacity as well as same-key races.
        // A crash leaves this owned fence in place for explicit reconciliation.
        const lock = await open(join(this.path, LOCK), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
        try {
          await lock.writeFile(randomUUID() + "\n");
          await lock.sync();
          await syncDirectory(this.path);
          const receipts = await this.#receipts(true);
          const previous = receipts.get(identity);
          if (previous) {
            if (previous.channelId !== channelId || previous.contentSha256 !== intent.contentSha256) throw held();
          } else {
            if (receipts.size >= MAX_RECEIPTS || Buffer.byteLength(source, "utf8") > MAX_BYTES) throw held();
            const file = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
            try { await file.writeFile(source, "utf8"); await file.sync(); } finally { await file.close(); }
            await syncDirectory(this.path);
          }
          const lockMetadata = await lock.stat();
          const namedLock = await lstat(join(this.path, LOCK));
          if (!namedLock.isFile() || namedLock.isSymbolicLink() || namedLock.nlink !== 1 ||
            namedLock.dev !== lockMetadata.dev || namedLock.ino !== lockMetadata.ino) throw held();
          await unlink(join(this.path, LOCK));
          await syncDirectory(this.path);
          if (previous) return "duplicate";
        } finally { await lock.close(); }

        // Only a fully durable intent authorizes this one POST attempt.
        if (!dispatchAllowed(canDispatch)) {
          await this.#complete(filename, source, { ...intent, status: "cancelled" });
          return "skipped";
        }
        const acknowledgement = await send(hash(identity).slice(0, 25));
        if (!acknowledgement || !identifier(acknowledgement.id) || acknowledgement.channelId !== channelId) throw held();
        await this.#complete(filename, source, { ...intent, status: "sent", messageId: acknowledgement.id });
        return "sent";
      } catch {
        this.#held = true;
        throw held();
      }
    });
  }
}
