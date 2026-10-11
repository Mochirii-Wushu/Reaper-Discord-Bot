import { randomUUID, createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { MAX_RECORDS, parseMemberForwardingRecord, readPrivateFile, type ForwardingCheckpointState } from "./member-forwarder.js";
export { readPrivateFile } from "./member-forwarder.js";

export const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;
export const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export type ForwardingCheckpoint = ForwardingCheckpointState & {
  schemaVersion: 1; checkpointId: string; createdAt: string;
};
export type CheckpointStatus = {
  schemaVersion: 1; checkpointId: string; checkpointSha256: string;
  checkpointCreatedAt: string; checkedAt: string;
};
const keys = (value: object, expected: string[]) => JSON.stringify(Object.keys(value).sort()) === JSON.stringify(expected.sort());
const utc = (value: unknown): value is string => typeof value === "string" && UTC.test(value) && new Date(value).toISOString() === value;
const object = (value: unknown): value is { [key: string]: unknown } => !!value && typeof value === "object" && !Array.isArray(value);
export const checkpointDigest = (source: string) => createHash("sha256").update(source, "utf8").digest("hex");

export function parseCheckpoint(source: string): ForwardingCheckpoint {
  if (Buffer.byteLength(source, "utf8") > MAX_CHECKPOINT_BYTES) throw new Error("Checkpoint is too large.");
  const value: unknown = JSON.parse(source);
  if (!object(value) || JSON.stringify(value) + "\n" !== source ||
    !keys(value, ["schemaVersion", "checkpointId", "createdAt", "forwardingEnabled", "admissionHeld", "entries"]) ||
    value.schemaVersion !== 1 || typeof value.checkpointId !== "string" || !UUID.test(value.checkpointId) || !utc(value.createdAt) ||
    typeof value.forwardingEnabled !== "boolean" || typeof value.admissionHeld !== "boolean" ||
    !Array.isArray(value.entries) || value.entries.length > MAX_RECORDS ||
    (!value.forwardingEnabled && (value.admissionHeld || value.entries.length))) throw new Error("Checkpoint is invalid.");
  let previous = "";
  const requestIds = new Set<string>();
  const sequences = new Set<number>();
  for (const entry of value.entries) {
    if (!object(entry) || !keys(entry, ["filename", "record"]) || typeof entry.filename !== "string" || entry.filename <= previous) {
      throw new Error("Checkpoint entries are invalid.");
    }
    const record = parseMemberForwardingRecord(JSON.stringify(entry.record) + "\n", entry.filename);
    if (requestIds.has(record.requestId) || sequences.has(record.sequence)) throw new Error("Duplicate checkpoint identity.");
    requestIds.add(record.requestId); sequences.add(record.sequence); previous = entry.filename;
  }
  return value as ForwardingCheckpoint;
}

export function parseCheckpointStatus(source: string, checkpointSource: string): CheckpointStatus {
  if (Buffer.byteLength(source, "utf8") > 1024) throw new Error("Checkpoint status is too large.");
  const value: unknown = JSON.parse(source);
  const checkpoint = parseCheckpoint(checkpointSource);
  if (!object(value) || JSON.stringify(value) + "\n" !== source ||
    !keys(value, ["schemaVersion", "checkpointId", "checkpointSha256", "checkpointCreatedAt", "checkedAt"]) ||
    value.schemaVersion !== 1 || value.checkpointId !== checkpoint.checkpointId || value.checkpointSha256 !== checkpointDigest(checkpointSource) ||
    value.checkpointCreatedAt !== checkpoint.createdAt || !utc(value.checkedAt) || value.checkedAt < checkpoint.createdAt) {
    throw new Error("Checkpoint status is invalid.");
  }
  return value as CheckpointStatus;
}

export async function assertPrivateDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
    (process.platform !== "win32" && ((metadata.mode & 0o777) !== 0o700 || metadata.uid !== process.getuid?.()))) {
    throw new Error("Checkpoint directory is not private.");
  }
}

export async function syncPrivateDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function writePrivateFile(path: string, source: string): Promise<void> {
  const bytes = Buffer.from(source, "utf8");
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  let completed = false;
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const remaining = bytes.length - offset;
      const { bytesWritten } = await handle.write(bytes, offset, remaining, offset);
      if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > remaining) throw new Error("Invalid checkpoint write progress.");
      offset += bytesWritten;
    }
    await handle.sync();
    completed = true;
  } finally {
    await handle.close();
    if (!completed) await unlink(path);
  }
}

async function atomicWrite(path: string, source: string, maximum: number): Promise<void> {
  const parent = dirname(path);
  await assertPrivateDirectory(parent);
  try { await readPrivateFile(path, maximum); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  let created = false;
  try {
    // Track only our exclusive temporary; never clean unknown queue/evidence files.
    await writePrivateFile(temporary, source); created = true;
    await rename(temporary, path); created = false;
    await syncPrivateDirectory(parent);
  } finally {
    if (created) await unlink(temporary);
  }
}

export class CheckpointExporter {
  readonly enabled: boolean;
  readonly path: string;
  #capture: () => Promise<ForwardingCheckpointState>;
  #clock: () => number;
  #onError: () => void;
  #requested = false;
  #running: Promise<void> | null = null;
  #lastSuccess = Number.NEGATIVE_INFINITY;
  #closed = false;

  constructor(options: { path?: string; capture: () => Promise<ForwardingCheckpointState>; clock?: () => number; onError?: () => void }) {
    this.path = options.path || "";
    this.enabled = !!this.path;
    if (this.enabled && (!isAbsolute(this.path) || basename(this.path) !== "checkpoint.json")) throw new Error("Private checkpoint path is invalid.");
    this.#capture = options.capture; this.#clock = options.clock || Date.now; this.#onError = options.onError || (() => undefined);
  }

  request(): Promise<void> {
    if (!this.enabled || this.#closed) return Promise.resolve();
    this.#requested = true;
    if (!this.#running) {
      this.#running = this.#run().catch(() => { this.#onError(); }).finally(() => {
        this.#running = null;
        if (this.#requested) void this.request();
      });
    }
    return this.#running;
  }

  due(): Promise<void> {
    return this.#clock() - this.#lastSuccess >= CHECKPOINT_INTERVAL_MS ? this.request() : Promise.resolve();
  }

  async close(graceMs = 5000): Promise<boolean> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 1 || graceMs > 5000) throw new Error("Checkpoint shutdown grace is invalid.");
    const pending = this.#closed ? (this.#running || Promise.resolve()) : this.request();
    this.#closed = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), graceMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async #run(): Promise<void> {
    while (this.#requested) {
      this.#requested = false;
      const state = await this.#capture();
      const now = this.#clock();
      const checkedAt = new Date(now).toISOString();
      // The capture promise has released the queue barrier before serialization and I/O.
      const stateSource = JSON.stringify(state);
      let priorSource: string | undefined;
      let prior: ForwardingCheckpoint | undefined;
      await assertPrivateDirectory(dirname(this.path));
      try { priorSource = await readPrivateFile(this.path, MAX_CHECKPOINT_BYTES); prior = parseCheckpoint(priorSource); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const priorState = prior && JSON.stringify({ forwardingEnabled: prior.forwardingEnabled, admissionHeld: prior.admissionHeld, entries: prior.entries });
      const source = prior && priorState === stateSource ? priorSource! : JSON.stringify({
        schemaVersion: 1, checkpointId: randomUUID(), createdAt: checkedAt, ...state,
      }) + "\n";
      const checkpoint = parseCheckpoint(source);
      if (source !== priorSource) await atomicWrite(this.path, source, MAX_CHECKPOINT_BYTES);
      const status: CheckpointStatus = { schemaVersion: 1, checkpointId: checkpoint.checkpointId,
        checkpointSha256: checkpointDigest(source), checkpointCreatedAt: checkpoint.createdAt, checkedAt };
      const statusSource = JSON.stringify(status) + "\n";
      parseCheckpointStatus(statusSource, source);
      await atomicWrite(join(dirname(this.path), "checkpoint-status.json"), statusSource, 1024);
      this.#lastSuccess = now;
    }
  }
}
