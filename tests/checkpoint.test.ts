import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReaperConfig } from "../src/config.js";
import { MemberSyncForwarder, admissionJournalSource } from "../src/member-forwarder.js";
import { CHECKPOINT_INTERVAL_MS, MAX_CHECKPOINT_BYTES, CheckpointExporter, checkpointDigest, parseCheckpoint, parseCheckpointStatus, readPrivateFile } from "../src/checkpoint.js";
import { restoreCheckpoint } from "../src/restore-checkpoint.js";
import { createMemberSyncRequest, deliverMemberSyncRequest, type PendingVerificationMemberLike } from "../src/pending-verification.js";
import { SYNTHETIC_DISCORD_IDS as ids } from "./discord-fixtures.js";

const config: ReaperConfig = { discordBotToken: "unused-offline", discordGuildId: ids.guild,
  galleryGatewayRollbackEnabled: false, welcomeDmEnabled: false, pendingVerificationSyncEnabled: true,
  pendingVerificationSyncUrl: "https://functions.example.test/functions/v1/reaper-discord-member-sync",
  pendingVerificationSyncSecret: "unused-offline-secret", pendingVerificationSyncTimeoutMs: 5000, pendingVerificationSyncMaxAttempts: 1 };
const member = (): PendingVerificationMemberLike => ({ guild: { id: ids.guild }, user: { id: ids.member }, roles: { cache: new Map([[ids.roleOne, true]]) } });
const completed = { status: "completed" as const, result: { discordWrites: 0, dbWrites: 0, staleRecordsCleared: 0 } };
const quiet = { log() {}, warn() {} };
const paths: string[] = [];
const workers: MemberSyncForwarder[] = [];
async function fixture(options: ConstructorParameters<typeof MemberSyncForwarder>[1] = {}) {
  const parent = await mkdtemp(join(tmpdir(), "mochirii-checkpoint-")); paths.push(parent);
  const path = join(parent, "member-sync");
  const worker = new MemberSyncForwarder(config, { path, logger: quiet, ...options }); workers.push(worker);
  await worker.initialize();
  return { parent, path, worker, checkpointPath: join(parent, "checkpoint.json"), statusPath: join(parent, "checkpoint-status.json") };
}
const envelope = (state: Awaited<ReturnType<MemberSyncForwarder["captureCheckpoint"]>>) => JSON.stringify({
  schemaVersion: 1, checkpointId: randomUUID(), createdAt: "2026-01-01T00:00:00.000Z", ...state,
}) + "\n";
afterEach(async () => {
  for (const worker of workers.splice(0)) worker.stop();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("detached forwarding checkpoints", () => {
  test("captures before/after admissions in order without sharing mutable records", async () => {
    const { worker, path } = await fixture({ deliver: async () => ({ status: "pending", reason: "receipt_not_completed", retryAfterMs: 5000 }) });
    expect((await worker.captureCheckpoint()).entries).toHaveLength(0);
    const enqueue = worker.enqueue(member(), "guildMemberAdd");
    const first = await worker.captureCheckpoint(); await enqueue;
    expect(first.entries).toHaveLength(1);
    expect(JSON.stringify(first.entries[0]!.record) + "\n").toBe(await readFile(join(path, first.entries[0]!.filename), "utf8"));
    await worker.enqueue(member(), "guildMemberUpdate");
    await worker.drainOnce();
    expect(first.entries[0]!.record.failures).toBe(0);
    const later = await worker.captureCheckpoint();
    expect(later.entries.map((entry) => entry.record.sequence)).toEqual([1, 2]);
    expect(later.entries[0]!.record.failures).toBe(1);
    expect(later.entries[0]!.record.requestId).toBe(first.entries[0]!.record.requestId);
  });

  test("capture and new admission continue while provider delivery stalls; completion is subsequent state", async () => {
    let entered!: () => void; let release!: () => void;
    const inFlight = new Promise<void>((resolve) => { entered = resolve; });
    const { worker } = await fixture({ deliver: async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return completed; } });
    await worker.enqueue(member(), "guildMemberAdd");
    const draining = worker.drainOnce(); await inFlight;
    const before = await worker.captureCheckpoint();
    await worker.enqueue(member(), "guildMemberUpdate");
    expect((await worker.captureCheckpoint()).entries).toHaveLength(2);
    release(); await draining;
    expect(before.entries).toHaveLength(1);
    expect((await worker.captureCheckpoint()).entries).toHaveLength(1);
  });

  test("disk hold is preserved without overwriting the in-memory hold or clearing journal", async () => {
    const { path, worker } = await fixture();
    await writeFile(join(path, "admission.json"), admissionJournalSource(true));
    expect((await worker.captureCheckpoint()).admissionHeld).toBe(true);
    await writeFile(join(path, "admission.json"), admissionJournalSource(false));
    const invalid = member(); invalid.user.id = "invalid";
    await expect(worker.enqueue(invalid, "guildMemberAdd")).rejects.toThrow();
    // The disk value alone must not reset the synchronous in-memory hold.
    await writeFile(join(path, "admission.json"), admissionJournalSource(false));
    expect((await worker.captureCheckpoint()).admissionHeld).toBe(true);
    await expect(worker.enqueue(member(), "guildMemberAdd")).rejects.toThrow();
  });

  test("blocked first and later pending records retain exact state and trigger a capture request", async () => {
    let requested = 0;
    const { worker } = await fixture({ onCheckpointNeeded: () => { requested++; }, deliver: async () => ({ status: "blocked", reason: "identity_conflict" }) });
    await worker.enqueue(member(), "guildMemberAdd"); await worker.enqueue(member(), "guildMemberUpdate");
    await worker.drainOnce();
    const snapshot = await worker.captureCheckpoint();
    expect(snapshot.entries.map((entry) => entry.record.status)).toEqual(["blocked", "pending"]);
    expect(snapshot.entries[0]!.record.reason).toBe("identity_conflict");
    expect(requested).toBeGreaterThan(0);
  });

  test("disabled capture never opens an uninitialized queue", async () => {
    const worker = new MemberSyncForwarder({ ...config, pendingVerificationSyncEnabled: false });
    expect(await worker.captureCheckpoint()).toEqual({ forwardingEnabled: false, admissionHeld: false, entries: [] });
  });

  test("stable snapshot identity survives unchanged capture and restart while checkedAt refreshes", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z"); let captures = 0;
    const { worker, checkpointPath, statusPath } = await fixture();
    const options = { path: checkpointPath, clock: () => now, capture: () => { captures++; return worker.captureCheckpoint(); } };
    const exporter = new CheckpointExporter(options);
    await exporter.request();
    const original = await readFile(checkpointPath, "utf8");
    const firstStatus = parseCheckpointStatus(await readFile(statusPath, "utf8"), original);
    now += CHECKPOINT_INTERVAL_MS - 1; await exporter.due(); expect(captures).toBe(1);
    now++; await exporter.due(); expect(captures).toBe(2);
    expect(await readFile(checkpointPath, "utf8")).toBe(original);
    const secondStatus = parseCheckpointStatus(await readFile(statusPath, "utf8"), original);
    expect(secondStatus.checkedAt).not.toBe(firstStatus.checkedAt);
    now += 1000; await new CheckpointExporter(options).request();
    expect(await readFile(checkpointPath, "utf8")).toBe(original);
    if (process.platform !== "win32") expect((await lstat(checkpointPath)).mode & 0o777).toBe(0o600);
  });

  test("coalesces forced requests behind one writer and does not block queue admission", async () => {
    const { worker, checkpointPath } = await fixture();
    let release!: () => void; let entered!: () => void; let captures = 0; let active = 0; let maximum = 0;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const exporter = new CheckpointExporter({ path: checkpointPath, capture: async () => {
      active++; maximum = Math.max(maximum, active); const state = await worker.captureCheckpoint(); captures++;
      if (captures === 1) { entered(); await new Promise<void>((resolve) => { release = resolve; }); }
      active--; return state;
    } });
    const exporting = exporter.request(); await started;
    const forced = Array.from({ length: 20 }, () => exporter.request());
    await worker.enqueue(member(), "guildMemberAdd");
    release(); await Promise.all([exporting, ...forced]);
    expect(captures).toBe(2); expect(maximum).toBe(1);
    expect(parseCheckpoint(await readFile(checkpointPath, "utf8")).entries).toHaveLength(1);
  });

  test("close coalesces a final capture and stops new requests without cancelling a writer", async () => {
    const { worker, checkpointPath } = await fixture(); let captures = 0; let entered!: () => void; let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const exporter = new CheckpointExporter({ path: checkpointPath, capture: async () => {
      captures++; const state = await worker.captureCheckpoint();
      if (captures === 1) { entered(); await new Promise<void>((resolve) => { release = resolve; }); }
      return state;
    } });
    const first = exporter.request(); await started;
    await worker.enqueue(member(), "guildMemberAdd"); const closing = exporter.close();
    await exporter.request(); await exporter.due(); release();
    expect(await closing).toBe(true); await first; expect(captures).toBe(2);
    expect(parseCheckpoint(await readFile(checkpointPath, "utf8")).entries).toHaveLength(1);
    await exporter.request(); expect(captures).toBe(2); expect(await exporter.close()).toBe(true);
  });

  test("close returns a bounded timeout while the owned writer can settle safely", async () => {
    const { worker, checkpointPath } = await fixture(); let release!: () => void; let entered!: () => void; let captures = 0;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const exporter = new CheckpointExporter({ path: checkpointPath, capture: async () => {
      captures++; entered(); await new Promise<void>((resolve) => { release = resolve; }); return worker.captureCheckpoint();
    } });
    const closing = exporter.close(10); await started; expect(await closing).toBe(false);
    await exporter.request(); expect(captures).toBe(1); release(); expect(await exporter.close()).toBe(true);
    expect(parseCheckpoint(await readFile(checkpointPath, "utf8")).entries).toHaveLength(0);
  });

  test("invalid live state preserves the last snapshot and freshness marker without stopping admission", async () => {
    const { worker, path, checkpointPath, statusPath } = await fixture(); let failures = 0;
    const exporter = new CheckpointExporter({ path: checkpointPath, capture: () => worker.captureCheckpoint(), onError: () => { failures++; } });
    await exporter.request(); const source = await readFile(checkpointPath, "utf8"); const status = await readFile(statusPath, "utf8");
    await writeFile(join(path, "unknown.json"), "{}\n", { mode: 0o600 }); await exporter.request();
    expect(failures).toBe(1); expect(await readFile(checkpointPath, "utf8")).toBe(source); expect(await readFile(statusPath, "utf8")).toBe(status);
    await rm(join(path, "unknown.json"));
    expect(await worker.enqueue(member(), "guildMemberAdd")).toBe("queued");
  });

  test("rejects canonical envelope mutations, duplicate identities, traversal and oversized records", async () => {
    const { worker } = await fixture(); await worker.enqueue(member(), "guildMemberAdd");
    const source = envelope(await worker.captureCheckpoint()); const valid = parseCheckpoint(source);
    expect(valid.entries).toHaveLength(1);
    const mutants = [source + " ", source.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
      JSON.stringify({ ...valid, extra: true }) + "\n", JSON.stringify({ ...valid, checkpointId: "invalid" }) + "\n",
      JSON.stringify({ ...valid, createdAt: "2026-02-30T00:00:00.000Z" }) + "\n",
      JSON.stringify({ ...valid, entries: [valid.entries[0], valid.entries[0]] }) + "\n",
      JSON.stringify({ ...valid, entries: [{ ...valid.entries[0], filename: "../admission.json" }] }) + "\n",
      JSON.stringify({ ...valid, entries: [{ ...valid.entries[0], record: { ...valid.entries[0]!.record, body: "x".repeat(32_769) } }] }) + "\n",
      JSON.stringify({ ...valid, forwardingEnabled: false }) + "\n", " ".repeat(MAX_CHECKPOINT_BYTES + 1)];
    for (const mutant of mutants) expect(() => parseCheckpoint(mutant)).toThrow();
    expect(() => parseCheckpointStatus(JSON.stringify({ schemaVersion: 1, checkpointId: valid.checkpointId,
      checkpointSha256: "0".repeat(64), checkpointCreatedAt: valid.createdAt, checkedAt: valid.createdAt }) + "\n", source)).toThrow();
    expect(checkpointDigest(source)).toHaveLength(64);
  });

  test("rejects symlink and unsafe Linux modes rather than following or overwriting them", async () => {
    const { parent, checkpointPath, worker } = await fixture();
    const other = join(parent, "other.json"); await writeFile(other, envelope(await worker.captureCheckpoint()), { mode: 0o600 });
    try { await symlink(other, checkpointPath); }
    catch (error) { if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
    await expect(readPrivateFile(checkpointPath, MAX_CHECKPOINT_BYTES)).rejects.toThrow();
    let failures = 0; await new CheckpointExporter({ path: checkpointPath, capture: () => worker.captureCheckpoint(), onError: () => { failures++; } }).request();
    expect(failures).toBe(1); expect((await lstat(checkpointPath)).isSymbolicLink()).toBe(true);
    if (process.platform !== "win32") {
      await chmod(other, 0o644); await expect(readPrivateFile(other, MAX_CHECKPOINT_BYTES)).rejects.toThrow();
    }
  });

  test("bounded file reads retain BOM for rejection and reject malformed UTF-8 or oversize input", async () => {
    const { checkpointPath, worker } = await fixture(); const source = envelope(await worker.captureCheckpoint());
    await writeFile(checkpointPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(source)]), { mode: 0o600 });
    await expect(restoreCheckpoint(checkpointPath)).rejects.toThrow();
    await writeFile(checkpointPath, Buffer.from([0xff, 0xfe, 0x7b, 0x7d]));
    await expect(readPrivateFile(checkpointPath, MAX_CHECKPOINT_BYTES)).rejects.toThrow();
    await writeFile(checkpointPath, "x".repeat(1025)); await expect(readPrivateFile(checkpointPath, 1024)).rejects.toThrow();
  });

  test("validate-only is read-only; apply preserves exact records/hold and refuses every existing target", async () => {
    const { worker, parent, checkpointPath, path } = await fixture(); await worker.enqueue(member(), "guildMemberAdd");
    await writeFile(join(path, "admission.json"), admissionJournalSource(true));
    const source = envelope(await worker.captureCheckpoint()); await writeFile(checkpointPath, source, { mode: 0o600 });
    const before = (await readdir(parent)).sort();
    expect((await restoreCheckpoint(checkpointPath)).applied).toBe(false); expect((await readdir(parent)).sort()).toEqual(before);
    const target = join(parent, "restored-offline"); const result = await restoreCheckpoint(checkpointPath, target);
    expect(result.admissionHeld).toBe(true); expect(await readFile(join(target, "admission.json"), "utf8")).toBe(admissionJournalSource(true));
    for (const entry of parseCheckpoint(source).entries) expect(await readFile(join(target, entry.filename), "utf8")).toBe(JSON.stringify(entry.record) + "\n");
    await expect(restoreCheckpoint(checkpointPath, target)).rejects.toThrow("already exists");
    let deliveries = 0; const restored = new MemberSyncForwarder(config, { path: target, logger: quiet, deliver: async () => { deliveries++; return completed; } });
    workers.push(restored); await restored.initialize(); await restored.drainOnce(); expect(deliveries).toBe(0);
    await expect(restored.enqueue(member(), "guildMemberUpdate")).rejects.toThrow();
  });

  test("restored pending UUID consults a completed receipt without POST or duplicate effect", async () => {
    const { worker, parent, checkpointPath } = await fixture(); await worker.enqueue(member(), "guildMemberAdd");
    const source = envelope(await worker.captureCheckpoint()); await writeFile(checkpointPath, source, { mode: 0o600 });
    const original = parseCheckpoint(source).entries[0]!.record; const target = join(parent, "receipt-restored");
    await restoreCheckpoint(checkpointPath, target); const calls: string[] = [];
    const restored = new MemberSyncForwarder(config, { path: target, logger: quiet, deliver: (request) => {
      expect(request).toEqual({ requestId: original.requestId, body: original.body });
      return deliverMemberSyncRequest(request, config, async (input, init = {}) => {
        calls.push(init.method || "GET"); expect(new URL(String(input)).searchParams.get("request_id")).toBe(original.requestId);
        return Response.json({ ok: true, request_id: original.requestId, status: "completed", result: completed.result });
      });
    } });
    workers.push(restored); await restored.initialize(); await restored.drainOnce();
    expect(calls).toEqual(["GET"]); expect((await restored.captureCheckpoint()).entries).toHaveLength(0);
  });

  for (const receipt of ["reserved", "writing", "blocked", "rejected", "identity_conflict", "missing"] as const) {
    test(`restored UUID preserves ${receipt} receipt semantics`, async () => {
      const { worker, parent, checkpointPath } = await fixture(); await worker.enqueue(member(), "guildMemberAdd");
      const source = envelope(await worker.captureCheckpoint()); await writeFile(checkpointPath, source, { mode: 0o600 });
      const original = parseCheckpoint(source).entries[0]!.record; const target = join(parent, "state-restored");
      await restoreCheckpoint(checkpointPath, target); const calls: string[] = [];
      const restored = new MemberSyncForwarder(config, { path: target, logger: quiet, deliver: (request) => deliverMemberSyncRequest(request, config, async (input, init = {}) => {
        const method = init.method || "GET"; calls.push(method);
        if (method === "POST") {
          expect(init.body).toBe(original.body);
          return Response.json({ ok: true, request_id: original.requestId, status: "completed", result: completed.result });
        }
        expect(new URL(String(input)).searchParams.get("request_id")).toBe(original.requestId);
        return Response.json({ ok: receipt !== "identity_conflict", request_id: original.requestId, status: receipt, result: null },
          { status: ["blocked", "rejected", "identity_conflict"].includes(receipt) ? 409 : 200 });
      }) });
      workers.push(restored); await restored.initialize(); await restored.drainOnce();
      expect(calls).toEqual(receipt === "missing" ? ["GET", "POST"] : ["GET"]);
      const after = await restored.captureCheckpoint();
      expect(after.entries).toHaveLength(receipt === "missing" ? 0 : 1);
      if (after.entries.length) {
        expect(after.entries[0]!.record.requestId).toBe(original.requestId);
        expect(after.entries[0]!.record.body).toBe(original.body);
        expect(after.entries[0]!.record.status).toBe(["blocked", "rejected", "identity_conflict"].includes(receipt) ? "blocked" : "pending");
      }
    });
  }

  for (const failure of ["short_success", "zero", "invalid", "disk_full", "fsync", "rename", "status_rename"] as const) {
    test(`atomic export handles ${failure} without refreshing failed status or changing the queue`, async () => {
      const { parent } = await fixture();
      const script = `
        import assert from "node:assert/strict";
        import { mock } from "bun:test";
        import { join } from "node:path";
        const fs = await import("node:fs/promises");
        const originalOpen = fs.open;
        const originalRename = fs.rename;
        const parent = ${JSON.stringify(parent)};
        const failure = ${JSON.stringify(failure)};
        let armed = false;
        const timeout = setTimeout(() => { console.error("Checkpoint fixture timed out"); process.exit(1); }, 8000);
        mock.module("node:fs/promises", () => ({ ...fs,
          rename: async (from, to) => {
            if (armed && ((failure === "rename" && String(to).endsWith("checkpoint.json")) ||
              (failure === "status_rename" && String(to).endsWith("checkpoint-status.json")))) throw new Error("injected_rename");
            return originalRename(from, to);
          },
          open: async (...args) => {
            const handle = await originalOpen(...args);
            const temporary = String(args[0]).includes(".checkpoint.json.");
            return new Proxy(handle, { get(value, key) {
              if (key === "write") return async (bytes, offset, length, position) => {
                if (armed && temporary) {
                  if (failure === "zero") return { bytesWritten: 0 };
                  if (failure === "invalid") return { bytesWritten: length + 1 };
                  if (failure === "disk_full") throw new Error("injected_ENOSPC");
                  if (failure === "short_success") length = Math.min(length, 7);
                }
                return handle.write(bytes, offset, length, position);
              };
              if (key === "sync") return async () => {
                if (armed && temporary && failure === "fsync") throw new Error("injected_fsync");
                return handle.sync();
              };
              const property = Reflect.get(value, key, value);
              return typeof property === "function" ? property.bind(value) : property;
            } });
          }
        }));
        const { CheckpointExporter, parseCheckpoint, parseCheckpointStatus } = await import(${JSON.stringify(new URL("../src/checkpoint.ts", import.meta.url).href)});
        let now = Date.parse("2026-01-01T00:00:00.000Z");
        let held = false; let failures = 0;
        const checkpoint = join(parent, "checkpoint.json"); const status = join(parent, "checkpoint-status.json");
        const queueBefore = await fs.readdir(join(parent, "member-sync"));
        const exporter = new CheckpointExporter({ path: checkpoint, clock: () => now,
          capture: async () => ({ forwardingEnabled: true, admissionHeld: held, entries: [] }), onError: () => { failures++; } });
        await exporter.request();
        const before = await fs.readFile(checkpoint, "utf8"); const beforeStatus = await fs.readFile(status, "utf8");
        armed = true; held = true; now += 1000;
        await exporter.request();
        const after = await fs.readFile(checkpoint, "utf8"); const afterStatus = await fs.readFile(status, "utf8");
        if (failure === "short_success") {
          assert.equal(failures, 0); assert.equal(parseCheckpoint(after).admissionHeld, true); parseCheckpointStatus(afterStatus, after);
        } else {
          assert.equal(failures, 1); assert.equal(afterStatus, beforeStatus);
          if (failure === "status_rename") {
            assert.equal(parseCheckpoint(after).admissionHeld, true); assert.throws(() => parseCheckpointStatus(afterStatus, after));
          } else assert.equal(after, before);
        }
        assert.deepEqual(await fs.readdir(join(parent, "member-sync")), queueBefore);
        assert.equal((await fs.readdir(parent)).filter((name) => name.endsWith(".tmp")).length, 0);
        clearTimeout(timeout); console.log("checkpoint-write-fixture: passed");
      `;
      const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], { env: { NODE_ENV: "production" }, stdout: "pipe", stderr: "pipe" });
      const [output, errors, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect({ exitCode, errors }).toEqual({ exitCode: 0, errors: "" }); expect(output.trim()).toBe("checkpoint-write-fixture: passed");
    }, 10_000);
  }

  test("maximum valid queue captures within the envelope bound and preserves all identities", async () => {
    const { worker, path } = await fixture(); const large = member();
    large.roles.cache = new Map(Array.from({ length: 250 }, (_, index) => [String(BigInt(ids.roleOne) + BigInt(index)), true]));
    for (let sequence = 1; sequence <= 256; sequence++) {
      const request = createMemberSyncRequest(large, "guildMemberUpdate");
      await writeFile(join(path, `${String(sequence).padStart(16, "0")}-${request.requestId}.json`), JSON.stringify({ schemaVersion: 1, sequence, ...request,
        status: "pending", retryAt: "2026-01-01T00:00:00.000Z", failures: 0, reason: null }) + "\n", { mode: 0o600 });
    }
    const start = performance.now(); const snapshot = await worker.captureCheckpoint(); const source = envelope(snapshot);
    expect(parseCheckpoint(source).entries).toHaveLength(256);
    expect(new Set(snapshot.entries.map((entry) => entry.record.requestId)).size).toBe(256);
    expect(Buffer.byteLength(source)).toBeLessThan(MAX_CHECKPOINT_BYTES);
    // A local measurement, not a hosted resource or RPO claim.
    console.log(JSON.stringify({ checkpointFixture: "maximum-valid-queue", entries: 256, bytes: Buffer.byteLength(source), captureAndValidationMs: Math.round(performance.now() - start) }));
  });
});
