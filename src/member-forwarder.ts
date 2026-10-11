import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ReaperConfig } from "./config.js";
import {
  createMemberSyncRequest, deliverMemberSyncRequest, validateMemberSyncRequest,
  type MemberSyncDelivery, type MemberSyncRequest, type PendingVerificationEventType,
  type PendingVerificationLogger, type PendingVerificationMemberLike,
} from "./pending-verification.js";

export const MAX_RECORDS = 256;
export const MAX_RECORD_BYTES = 32_768;
export const ADMISSION_FILE = "admission.json";
const ADMISSION_BYTES = 256;
const FILE = /^(\d{16})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/u;
export type MemberForwardingRecord = MemberSyncRequest & {
  schemaVersion: 1; sequence: number; status: "pending" | "blocked";
  retryAt: string; failures: number; reason: string | null;
};
type Record = MemberForwardingRecord;
export type ForwardingCheckpointState = {
  forwardingEnabled: boolean; admissionHeld: boolean;
  entries: { filename: string; record: MemberForwardingRecord }[];
};
type Delivery = (request: MemberSyncRequest) => Promise<MemberSyncDelivery>;

async function syncDirectory(path: string): Promise<void> {
  // Linux production requires directory durability. Windows tests cannot fsync a directory.
  if (process.platform === "win32") return;
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await directory.sync(); } finally { await directory.close(); }
}

export function parseMemberForwardingRecord(source: string, filename: string): Record {
  if (Buffer.byteLength(source, "utf8") > MAX_RECORD_BYTES) throw new Error("Member forwarding record is too large.");
  const match = FILE.exec(filename);
  const value = JSON.parse(source) as Record;
  if (!match || !value || typeof value !== "object" || Array.isArray(value) ||
    JSON.stringify(value) + "\n" !== source ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(["body", "failures", "reason", "requestId", "retryAt", "schemaVersion", "sequence", "status"]) ||
    value.schemaVersion !== 1 || !Number.isSafeInteger(value.sequence) || value.sequence < 1 ||
    String(value.sequence).padStart(16, "0") !== match[1] || value.requestId !== match[2] ||
    !["pending", "blocked"].includes(value.status) || !Number.isSafeInteger(value.failures) || value.failures < 0 || value.failures > 1_000_000 ||
    typeof value.retryAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.retryAt) ||
    new Date(value.retryAt).toISOString() !== value.retryAt ||
    !(value.reason === null || (typeof value.reason === "string" && /^[a-z_]{1,64}$/u.test(value.reason))) ||
    (value.status === "blocked" && !value.reason)) throw new Error("Member forwarding spool is invalid.");
  validateMemberSyncRequest({ requestId: value.requestId, body: value.body });
  return value;
}

export function admissionJournalSource(held: boolean): string {
  return JSON.stringify({ schemaVersion: 1, held }).padEnd(ADMISSION_BYTES - 1, " ") + "\n";
}

export function parseAdmissionJournal(source: string): boolean {
  const state = JSON.parse(source) as { schemaVersion: number; held: boolean };
  if (!state || state.schemaVersion !== 1 || typeof state.held !== "boolean" || source !== admissionJournalSource(state.held)) {
    throw new Error("Member forwarding admission journal is invalid.");
  }
  return state.held;
}

export async function readPrivateFile(path: string, maximum: number): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximum ||
    (process.platform !== "win32" && ((before.mode & 0o777) !== 0o600 || before.uid !== process.getuid?.()))) {
    throw new Error("Private forwarding state is not private or bounded.");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (before.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1 || metadata.size < 1 || metadata.size > maximum ||
      metadata.dev !== before.dev || metadata.ino !== before.ino ||
      (process.platform !== "win32" && ((metadata.mode & 0o777) !== 0o600 || metadata.uid !== process.getuid?.()))) {
      throw new Error("Private forwarding state is not private or bounded.");
    }
    // Bound reads even if an external writer grows a file after the metadata check.
    const bytes = Buffer.alloc(metadata.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > bytes.length - offset) throw new Error("Invalid private state read progress.");
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== metadata.size || after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.nlink !== 1) {
      throw new Error("Private forwarding state changed while reading.");
    }
    // Preserve a leading BOM so canonical JSON validation rejects it rather than
    // silently hashing different bytes from the file the host bridge receives.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset));
  } finally { await handle.close(); }
}

export class MemberSyncForwarder {
  readonly enabled: boolean;
  readonly path: string;
  #config: ReaperConfig;
  #logger: PendingVerificationLogger;
  #deliver: Delivery;
  #fault: () => void;
  #checkpointNeeded: () => void;
  #clock: () => number;
  #tail: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #stopped = true;
  #ready = false;
  #draining: Promise<void> | null = null;
  #nextSequence = 0;
  #held = false;
  #pendingAdmissions = 0;
  #holdPromise: Promise<void> | null = null;

  constructor(config: ReaperConfig, options: {
    path?: string; logger?: PendingVerificationLogger; deliver?: Delivery;
    onFault?: () => void; clock?: () => number; onCheckpointNeeded?: () => void;
  } = {}) {
    this.enabled = config.pendingVerificationSyncEnabled;
    this.path = options.path || "";
    this.#config = config;
    this.#logger = options.logger || console;
    this.#deliver = options.deliver || ((request) => deliverMemberSyncRequest(request, config));
    this.#fault = options.onFault || (() => undefined);
    this.#checkpointNeeded = options.onCheckpointNeeded || (() => undefined);
    this.#clock = options.clock || Date.now;
    if (this.enabled && (!this.path || !isAbsolute(this.path))) throw new Error("Private member forwarding state path is required.");
  }

  async initialize(): Promise<void> {
    if (!this.enabled) { this.#ready = true; return; }
    const parent = await lstat(join(this.path, ".."));
    if (!parent.isDirectory() || parent.isSymbolicLink() ||
      (process.platform !== "win32" && ((parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid?.()))) {
      throw new Error("Member forwarding state parent is not private.");
    }
    await mkdir(this.path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const metadata = await lstat(this.path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
      (process.platform !== "win32" && ((metadata.mode & 0o777) !== 0o700 || metadata.uid !== process.getuid?.()))) {
      throw new Error("Member forwarding state directory is not private.");
    }
    await syncDirectory(join(this.path, ".."));
    try {
      const journal = await open(join(this.path, ADMISSION_FILE), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { await journal.writeFile(admissionJournalSource(false)); await journal.sync(); } finally { await journal.close(); }
      await syncDirectory(this.path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    this.#held = await this.#readAdmissionHold();
    const records = await this.#records();
    this.#nextSequence = records.at(-1)?.record.sequence || 0;
    this.#ready = true;
    if (this.#held) this.#fail("admission_uncertain");
  }

  async #readAdmissionHold(): Promise<boolean> {
    return parseAdmissionJournal(await readPrivateFile(join(this.path, ADMISSION_FILE), ADMISSION_BYTES));
  }

  async #admissionHold(held: boolean): Promise<void> {
    const journal = await open(join(this.path, ADMISSION_FILE), constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const metadata = await journal.stat();
      if (!metadata.isFile() || metadata.size !== ADMISSION_BYTES || metadata.nlink !== 1 ||
        (process.platform !== "win32" && ((metadata.mode & 0o777) !== 0o600 || metadata.uid !== process.getuid?.()))) {
        throw new Error("Member forwarding admission journal is invalid.");
      }
      const source = Buffer.from(admissionJournalSource(held), "utf8");
      const writeAll = async (bytes: Buffer, position: number): Promise<void> => {
        let offset = 0;
        while (offset < bytes.length) {
          const remaining = bytes.length - offset;
          const { bytesWritten } = await journal.write(bytes, offset, remaining, position + offset);
          if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > remaining) {
            throw new Error("Member forwarding admission journal write made invalid progress.");
          }
          offset += bytesWritten;
        }
      };
      if (held) {
        // Keep the journal invalid until its complete true body is durable.
        // A later short-write/error cannot restore the old valid false state.
        await writeAll(Buffer.from("!"), 0);
        await journal.sync();
        await writeAll(source.subarray(1), 1);
        await journal.sync();
        await writeAll(source.subarray(0, 1), 0);
      } else {
        await writeAll(source, 0);
      }
      await journal.sync();
    } finally { await journal.close(); }
  }

  async #records(): Promise<{ filename: string; record: Record }[]> {
    const files = (await readdir(this.path)).filter((name) => name !== ADMISSION_FILE);
    if (files.length > MAX_RECORDS) throw new Error("Member forwarding spool capacity exceeded.");
    const result = [];
    for (const filename of files.sort()) {
      if (!FILE.test(filename)) throw new Error("Unknown member forwarding spool file.");
      const path = join(this.path, filename);
      result.push({ filename, record: parseMemberForwardingRecord(await readPrivateFile(path, MAX_RECORD_BYTES), filename) });
    }
    if (new Set(result.map(({ record }) => record.sequence)).size !== result.length ||
      new Set(result.map(({ record }) => record.requestId)).size !== result.length) throw new Error("Duplicate member forwarding identity.");
    return result;
  }

  async #write(filename: string, record: Record, initial: boolean): Promise<void> {
    const source = JSON.stringify(record) + "\n";
    if (Buffer.byteLength(source, "utf8") > MAX_RECORD_BYTES) throw new Error("Member forwarding record is too large.");
    const target = join(this.path, filename);
    const temporary = initial ? target : `${target}.tmp`;
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(source, "utf8"); await file.sync(); } finally { await file.close(); }
    if (!initial) await rename(temporary, target);
    await syncDirectory(this.path);
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  captureCheckpoint(): Promise<ForwardingCheckpointState> {
    if (!this.enabled) return Promise.resolve({ forwardingEnabled: false, admissionHeld: false, entries: [] });
    return this.#serialize(async () => {
      if (!this.#ready) throw new Error("Member forwarding spool has not initialized.");
      const diskHeld = await this.#readAdmissionHold();
      const entries = await this.#records();
      // Synchronous admission faults may set memory held while these reads await.
      // Reading the journal must never overwrite that conservative state.
      return { forwardingEnabled: true, admissionHeld: this.#held || diskHeld, entries };
    });
  }

  enqueue(member: PendingVerificationMemberLike, event: PendingVerificationEventType, sequence: number | null = null): Promise<string> {
    if (!this.enabled) return Promise.resolve("disabled");
    if (member.guild.id !== this.#config.discordGuildId) return Promise.resolve("ignored_guild");
    if (member.user.bot) return Promise.resolve("ignored_bot");
    if (this.#held) {
      return (this.#holdPromise || Promise.resolve()).then(() => {
        this.#fail("admission_failed");
        throw new Error("Member forwarding admission requires reconciliation.");
      });
    }
    if (this.#pendingAdmissions >= MAX_RECORDS) {
      this.#held = true;
      this.#checkpointNeeded();
      this.#holdPromise = this.#serialize(async () => {
        await this.#admissionHold(true);
      });
      return this.#holdPromise.then(() => {
        throw new Error("Member forwarding admission requires reconciliation.");
      }).catch((error: unknown) => { this.#fail("admission_failed"); throw error; });
    }
    this.#pendingAdmissions++;
    // Snapshot before asynchronous work so a later Discord cache mutation cannot change this event.
    let request: MemberSyncRequest;
    try { request = createMemberSyncRequest(member, event, sequence); }
    catch {
      this.#pendingAdmissions--;
      this.#held = true;
      this.#checkpointNeeded();
      this.#holdPromise = this.#serialize(() => this.#admissionHold(true));
      return this.#holdPromise.then(() => {
        this.#fail("invalid_event");
        throw new Error("Member forwarding admission is invalid and requires reconciliation.");
      }).catch((error: unknown) => { this.#fail("admission_failed"); throw error; });
    }
    return this.#serialize(async () => {
      if (!this.#ready) throw new Error("Member forwarding spool has not initialized.");
      if (this.#held) {
        await this.#admissionHold(true);
        throw new Error("Member forwarding admission requires reconciliation.");
      }
      // Preallocated journal survives overflow/disk-full faults and startup.
      // Clearing it is allowed only after the immutable queue record is durable.
      await this.#admissionHold(true);
      const records = await this.#records();
      if (records.length >= MAX_RECORDS || this.#nextSequence >= Number.MAX_SAFE_INTEGER) throw new Error("Member forwarding admission is full.");
      const record: Record = { schemaVersion: 1, sequence: ++this.#nextSequence, ...request,
        status: "pending", retryAt: new Date(this.#clock()).toISOString(), failures: 0, reason: null };
      await this.#write(`${String(record.sequence).padStart(16, "0")}-${request.requestId}.json`, record, true);
      await this.#admissionHold(this.#held);
      this.#logger.log("member forwarding event durably queued", { queued: records.length + 1 });
      this.#schedule(0);
      return "queued";
    }).catch((error: unknown) => { this.#held = true; this.#fail("admission_failed"); throw error; })
      .finally(() => { this.#pendingAdmissions--; });
  }

  start(): void {
    if (!this.enabled) return;
    if (!this.#ready) throw new Error("Member forwarding spool has not initialized.");
    this.#stopped = false;
    this.#schedule(0);
  }

  #schedule(delay: number): void {
    if (this.#stopped || this.#timer || this.#draining) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.drainOnce().then(() => this.#schedule(5000), () => this.#fail("drain_failed"));
    }, delay);
    this.#timer.unref();
  }

  #fail(reason: string): void {
    this.stop();
    this.#logger.warn("member forwarding requires operator reconciliation", { reason });
    this.#fault();
    this.#checkpointNeeded();
  }

  drainOnce(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.#draining) return this.#draining;
    this.#draining = this.#drain().finally(() => { this.#draining = null; });
    return this.#draining;
  }

  async #drain(): Promise<void> {
    const item = await this.#serialize(async () => {
      if (!this.#ready) throw new Error("Member forwarding spool has not initialized.");
      if (this.#held) { this.#fail("admission_uncertain"); return undefined; }
      return (await this.#records())[0];
    });
    if (!item) return;
    if (item.record.status === "blocked") { this.#fail("blocked_receipt"); return; }
    if (Date.parse(item.record.retryAt) > this.#clock()) return;
    // Network latency must not delay durably admitting later Gateway events.
    const delivery = await this.#deliver({ requestId: item.record.requestId, body: item.record.body });
    await this.#serialize(async () => {
      const current = (await this.#records())[0];
      if (!current || current.filename !== item.filename || current.record.body !== item.record.body ||
        current.record.status !== "pending") throw new Error("Member forwarding spool changed during delivery.");
      if (delivery.status === "completed") {
        await unlink(join(this.path, item.filename));
        await syncDirectory(this.path);
        this.#logger.log("member forwarding completed", delivery.result);
        return;
      }
      item.record.failures = Math.min(item.record.failures + 1, 1_000_000);
      item.record.status = delivery.status === "blocked" ? "blocked" : "pending";
      item.record.reason = delivery.reason;
      const backoff = delivery.status === "pending" ? Math.max(delivery.retryAfterMs,
        Math.min(60_000, 5000 * 2 ** Math.min(item.record.failures - 1, 4))) : 60_000;
      item.record.retryAt = new Date(this.#clock() + backoff).toISOString();
      await this.#write(item.filename, item.record, false);
      this.#logger.warn("member forwarding work retained", { state: item.record.status, queued: (await this.#records()).length });
      if (delivery.status === "blocked") this.#fail("blocked_receipt");
    });
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }
}
