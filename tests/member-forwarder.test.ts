import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReaperConfig } from "../src/config.js";
import { MemberSyncForwarder } from "../src/member-forwarder.js";
import { deliverMemberSyncRequest, type FetchLike, type MemberSyncRequest, type PendingVerificationMemberLike } from "../src/pending-verification.js";
import { SYNTHETIC_DISCORD_IDS as ids } from "./discord-fixtures.js";

const config: ReaperConfig = { discordBotToken: "unused-offline", discordGuildId: ids.guild,
  galleryGatewayRollbackEnabled: false, welcomeDmEnabled: true, pendingVerificationSyncEnabled: true,
  pendingVerificationSyncUrl: "https://functions.example.test/functions/v1/reaper-discord-member-sync",
  pendingVerificationSyncSecret: "unused-offline-secret", pendingVerificationSyncTimeoutMs: 5000, pendingVerificationSyncMaxAttempts: 2 };
const member = (): PendingVerificationMemberLike => ({ guild: { id: ids.guild }, user: { id: ids.member }, roles: { cache: new Map([[ids.roleOne, true]]) } });
const completed = { status: "completed" as const, result: { discordWrites: 1, dbWrites: 1, staleRecordsCleared: 0 } };
const quiet = { log() {}, warn() {} };
const queueFiles = async (path: string) => (await readdir(path)).filter((name) => name !== "admission.json");
const paths: string[] = [];
const workers: MemberSyncForwarder[] = [];
async function fixture(options: ConstructorParameters<typeof MemberSyncForwarder>[1] = {}) {
  const parent = await mkdtemp(join(tmpdir(), "mochirii-gateway-spool-"));
  paths.push(parent);
  const path = join(parent, "member-sync");
  const worker = new MemberSyncForwarder(config, { path, logger: quiet, ...options });
  workers.push(worker);
  await worker.initialize();
  return { parent, path, worker };
}
afterEach(async () => {
  for (const worker of workers.splice(0)) worker.stop();
  for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("private durable member forwarding spool", () => {
  test("persists the exact private request before delivery and deletes only on completion", async () => {
    let fileBody = "";
    const { path, worker } = await fixture({ deliver: async (request) => {
      const files = await queueFiles(path);
      expect(files).toHaveLength(1);
      const source = await readFile(join(path, files[0]!), "utf8");
      fileBody = JSON.parse(source).body;
      expect(fileBody).toBe(request.body);
      if (process.platform !== "win32") expect((await stat(join(path, files[0]!))).mode & 0o777).toBe(0o600);
      return completed;
    } });
    expect(await worker.enqueue(member(), "guildMemberAdd")).toBe("queued");
    expect(await queueFiles(path)).toHaveLength(1);
    await worker.drainOnce();
    expect(JSON.parse(fileBody).event_type).toBe("guildMemberAdd");
    expect(await queueFiles(path)).toHaveLength(0);
  });

  test("admission remains durable while a previous network request is in flight", async () => {
    let release!: () => void;
    let admitted!: () => void;
    const inFlight = new Promise<void>((resolve) => { admitted = resolve; });
    const { path, worker } = await fixture({ deliver: async () => {
      admitted();
      await new Promise<void>((resolve) => { release = resolve; });
      return completed;
    } });
    await worker.enqueue(member(), "guildMemberAdd");
    const draining = worker.drainOnce();
    await inFlight;
    expect(await worker.enqueue(member(), "guildMemberUpdate")).toBe("queued");
    expect(await queueFiles(path)).toHaveLength(2);
    release();
    await draining;
    expect(await queueFiles(path)).toHaveLength(1);
  });

  test("restart preserves UUID/body/backoff and does not replace uncertain work", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const requests: MemberSyncRequest[] = [];
    const { path, worker } = await fixture({ clock: () => now, deliver: async (request) => {
      requests.push(request);
      return { status: "pending", reason: "receipt_not_completed", retryAfterMs: 5000 };
    } });
    await worker.enqueue(member(), "guildMemberAdd");
    await worker.drainOnce();
    worker.stop();
    const restarted = new MemberSyncForwarder(config, { path, logger: quiet, clock: () => now,
      deliver: async (request) => { requests.push(request); return completed; } });
    workers.push(restarted);
    await restarted.initialize();
    await restarted.drainOnce();
    expect(requests).toHaveLength(1);
    now += 5000;
    await restarted.drainOnce();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(await queueFiles(path)).toHaveLength(0);
  });

  test("disabled transport persists pending work and resumes the same UUID after restart", async () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    let enabled = false;
    let faults = 0;
    let acquisitions = 0;
    let acquired: MemberSyncRequest | null = null;
    const calls: { method: string; id: string; body?: string }[] = [];
    const transportConfig = { ...config, pendingVerificationSyncMaxAttempts: 1 };
    const fetch: FetchLike = async (input, init = {}) => {
      const method = init.method || "GET";
      const body = method === "POST" ? String(init.body) : undefined;
      const id = body ? JSON.parse(body).request_id : new URL(String(input)).searchParams.get("request_id")!;
      calls.push({ method, id, body });
      if (method === "GET") return Response.json({ ok: true, request_id: id,
        status: acquired ? "completed" : "missing", result: acquired ? completed.result : null });
      if (!enabled) return Response.json({ ok: false, request_id: id, status: "disabled",
        result: null, retry_after_ms: 1000 }, { status: 409 });
      if (!acquired) { acquired = { requestId: id, body: body! }; acquisitions++; }
      expect({ requestId: id, body }).toEqual(acquired);
      return Response.json({ ok: true, request_id: id, status: "completed", result: completed.result });
    };
    const deliver = (request: MemberSyncRequest) => deliverMemberSyncRequest(request, transportConfig, fetch,
      async () => { throw new Error("One-attempt transport must not wait"); });
    const options = { logger: quiet, clock: () => now, deliver, onFault: () => { faults++; } };
    const { path, worker } = await fixture(options);
    await worker.enqueue(member(), "guildMemberAdd");
    const [filename] = await queueFiles(path);
    const original = JSON.parse(await readFile(join(path, filename!), "utf8"));
    const request = { requestId: original.requestId, body: original.body };
    await worker.drainOnce();
    const pending = JSON.parse(await readFile(join(path, filename!), "utf8"));
    expect(pending).toMatchObject({ ...request, status: "pending", failures: 1,
      retryAt: new Date(now + 5000).toISOString() });
    expect(acquisitions).toBe(0);
    expect(faults).toBe(0);
    worker.stop();
    const restarted = new MemberSyncForwarder(config, { path, ...options });
    workers.push(restarted);
    await restarted.initialize();
    enabled = true;
    now += 4999;
    await restarted.drainOnce();
    expect(calls.map(({ method }) => method)).toEqual(["GET", "POST"]);
    now++;
    await restarted.drainOnce();
    expect(await queueFiles(path)).toHaveLength(0);
    expect(acquisitions).toBe(1);
    expect(acquired as MemberSyncRequest | null).toEqual(request);
    // Re-observing the completed receipt reads status and cannot acquire a second effect.
    expect(await deliver(request)).toEqual(completed);
    expect(calls.map(({ method }) => method)).toEqual(["GET", "POST", "GET", "POST", "GET"]);
    expect(calls.map(({ id }) => id)).toEqual(Array(5).fill(request.requestId));
    expect(calls.filter(({ method }) => method === "POST").map(({ body }) => body)).toEqual([request.body, request.body]);
    expect(acquisitions).toBe(1);
    expect(faults).toBe(0);
  });

  test("generic conflicts and identity conflicts never permit spool identity takeover", async () => {
    for (const conflict of ["generic", "identity_conflict"]) {
      let now = Date.parse("2026-01-01T00:00:00.000Z");
      const calls: { method: string; id: string; body?: string }[] = [];
      const fetch: FetchLike = async (input, init = {}) => {
        const method = init.method || "GET";
        const body = method === "POST" ? String(init.body) : undefined;
        const id = body ? JSON.parse(body).request_id : new URL(String(input)).searchParams.get("request_id")!;
        calls.push({ method, id, body });
        if (method === "GET") return Response.json({ ok: true, request_id: id,
          status: calls.length === 1 ? "missing" : "writing", result: null });
        return Response.json(conflict === "generic" ? { error: "conflict" }
          : { ok: false, request_id: id, status: "identity_conflict", result: null }, { status: 409 });
      };
      const deliver = (request: MemberSyncRequest) => deliverMemberSyncRequest(request,
        { ...config, pendingVerificationSyncMaxAttempts: 1 }, fetch,
        async () => { throw new Error("One-attempt transport must not wait"); });
      const options = { logger: quiet, clock: () => now, deliver };
      const { path, worker } = await fixture(options);
      await worker.enqueue(member(), "guildMemberUpdate");
      const [filename] = await queueFiles(path);
      const original = JSON.parse(await readFile(join(path, filename!), "utf8"));
      await worker.drainOnce();
      worker.stop();
      const restarted = new MemberSyncForwarder(config, { path, ...options });
      workers.push(restarted);
      await restarted.initialize();
      now += 5000;
      await restarted.drainOnce();
      const retained = JSON.parse(await readFile(join(path, filename!), "utf8"));
      expect(retained).toMatchObject({ requestId: original.requestId, body: original.body,
        status: conflict === "generic" ? "pending" : "blocked" });
      expect(calls.map(({ method }) => method)).toEqual(conflict === "generic" ? ["GET", "POST", "GET"] : ["GET", "POST"]);
      expect(calls.every(({ id }) => id === original.requestId)).toBe(true);
      expect(calls.filter(({ method }) => method === "POST").map(({ body }) => body)).toEqual([original.body]);
      expect(await queueFiles(path)).toEqual([filename!]);
    }
  });

  test("blocked work is retained, later events stay queued, and readiness faults without takeover", async () => {
    let faults = 0;
    let deliveries = 0;
    const { path, worker } = await fixture({ onFault: () => { faults++; }, deliver: async () => {
      deliveries++;
      return { status: "blocked", reason: "blocked" };
    } });
    await worker.enqueue(member(), "guildMemberAdd");
    await worker.enqueue(member(), "guildMemberUpdate");
    await worker.drainOnce();
    await worker.drainOnce();
    expect(deliveries).toBe(1);
    expect(faults).toBeGreaterThan(0);
    const files = await queueFiles(path);
    expect(files).toHaveLength(2);
    expect(JSON.parse(await readFile(join(path, files.sort()[0]!), "utf8")).status).toBe("blocked");
  });

  test("one drainer cannot deliver the same record concurrently", async () => {
    let deliveries = 0;
    const { worker } = await fixture({ deliver: async () => { deliveries++; await Bun.sleep(10); return completed; } });
    await worker.enqueue(member(), "guildMemberAdd");
    await Promise.all([worker.drainOnce(), worker.drainOnce(), worker.drainOnce()]);
    expect(deliveries).toBe(1);
  });

  test("disabled, foreign guild and bot events never enter the spool", async () => {
    const worker = new MemberSyncForwarder({ ...config, pendingVerificationSyncEnabled: false });
    expect(await worker.enqueue(member(), "guildMemberAdd")).toBe("disabled");
    const { path, worker: active } = await fixture();
    expect(await active.enqueue({ ...member(), guild: { id: ids.otherGuild } }, "guildMemberAdd")).toBe("ignored_guild");
    expect(await active.enqueue({ ...member(), user: { id: ids.member, bot: true } }, "guildMemberAdd")).toBe("ignored_bot");
    expect(await queueFiles(path)).toHaveLength(0);
  });

  test("capacity256 is readable but admission257 fails explicitly with no delivery", async () => {
    let faults = 0;
    const { path, worker } = await fixture({ onFault: () => { faults++; } });
    await worker.enqueue(member(), "guildMemberAdd");
    const [first] = await queueFiles(path);
    const seed = JSON.parse(await readFile(join(path, first!), "utf8"));
    for (let sequence = 2; sequence <= 256; sequence++) {
      const requestId = randomUUID();
      const record = { ...seed, sequence, requestId,
        body: JSON.stringify({ ...JSON.parse(seed.body), request_id: requestId }) };
      await writeFile(join(path, `${String(sequence).padStart(16, "0")}-${requestId}.json`), JSON.stringify(record) + "\n", { mode: 0o600 });
    }
    const restarted = new MemberSyncForwarder(config, { path, logger: quiet, onFault: () => { faults++; } });
    workers.push(restarted);
    await restarted.initialize();
    await expect(restarted.enqueue(member(), "guildMemberAdd")).rejects.toThrow("admission is full");
    expect(faults).toBe(1);
    expect(await queueFiles(path)).toHaveLength(256);
    let deliveries = 0;
    const held = new MemberSyncForwarder(config, { path, logger: quiet, onFault: () => { faults++; },
      deliver: async () => { deliveries++; return completed; } });
    workers.push(held);
    await held.initialize();
    await held.drainOnce();
    expect(deliveries).toBe(0);
    expect(faults).toBeGreaterThan(1);
    await expect(held.enqueue(member(), "guildMemberUpdate")).rejects.toThrow("requires reconciliation");
  });

  test("preallocated admission journal holds an interrupted admission across restart", async () => {
    const { path, worker } = await fixture();
    await worker.enqueue(member(), "guildMemberAdd");
    const journal = JSON.stringify({ schemaVersion: 1, held: true }).padEnd(255, " ") + "\n";
    await writeFile(join(path, "admission.json"), journal);
    let faults = 0;
    let deliveries = 0;
    const held = new MemberSyncForwarder(config, { path, logger: quiet, onFault: () => { faults++; },
      deliver: async () => { deliveries++; return completed; } });
    workers.push(held);
    await held.initialize();
    await held.drainOnce();
    expect(faults).toBeGreaterThan(0);
    expect(deliveries).toBe(0);
    expect(await queueFiles(path)).toHaveLength(1);
    expect(await readFile(join(path, "admission.json"), "utf8")).toBe(journal);
  });

  test("bounds waiting admissions before payload retention and preserves a durable overflow hold", async () => {
    const { path, worker } = await fixture();
    const admissions = Array.from({ length: 257 }, () => worker.enqueue(member(), "guildMemberUpdate"));
    const outcomes = await Promise.allSettled(admissions);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(JSON.parse(await readFile(join(path, "admission.json"), "utf8")).held).toBe(true);
    const held = new MemberSyncForwarder(config, { path, logger: quiet });
    workers.push(held);
    await held.initialize();
    await expect(held.enqueue(member(), "guildMemberUpdate")).rejects.toThrow("requires reconciliation");
  });

  test("overflow during journal clear is durable before the first fault or rejection", async () => {
    const { path } = await fixture();
    // Isolate the builtin mock from every other test and load the real implementation afterward.
    const script = `
      import assert from "node:assert/strict";
      import { mock } from "bun:test";
      import { join } from "node:path";
      const fs = await import("node:fs/promises");
      const originalOpen = fs.open;
      const timeout = setTimeout(() => { console.error("Race fixture timed out"); process.exit(1); }, 8000);
      const path = ${JSON.stringify(path)};
      const journalPath = join(path, "admission.json");
      let pauseClear = false;
      let durableHeld = false;
      let enteredClear;
      let releaseClear;
      const clearStarted = new Promise((resolve) => { enteredClear = resolve; });
      const clearReleased = new Promise((resolve) => { releaseClear = resolve; });
      mock.module("node:fs/promises", () => ({ ...fs, open: async (...args) => {
        const handle = await originalOpen(...args);
        const journal = String(args[0]) === journalPath;
        let clear = false;
        return new Proxy(handle, { get(value, key) {
          if (key === "write") return async (...values) => {
            if (journal && values[0].length === 256 && values[1] === 0 && values[2] === 256 && values[3] === 0) {
              clear = JSON.parse(values[0].toString("utf8")).held === false;
            }
            return handle.write(...values);
          };
          if (key === "sync") return async () => {
            if (clear && pauseClear) {
              pauseClear = false;
              enteredClear();
              await clearReleased;
            }
            await handle.sync();
            if (journal) {
              const source = await fs.readFile(journalPath, "utf8");
              durableHeld = source !== JSON.stringify({ schemaVersion: 1, held: false }).padEnd(255, " ") + String.fromCharCode(10);
            }
          };
          const property = Reflect.get(value, key, value);
          return typeof property === "function" ? property.bind(value) : property;
        } });
      } }));
      const { MemberSyncForwarder } = await import(${JSON.stringify(new URL("../src/member-forwarder.ts", import.meta.url).href)});
      const config = ${JSON.stringify(config)};
      const member = () => ({ guild: { id: config.discordGuildId },
        user: { id: ${JSON.stringify(ids.member)} }, roles: { cache: new Map([[${JSON.stringify(ids.roleOne)}, true]]) } });
      let providerCalls = 0;
      let firstFaultDurable;
      let faulted;
      const firstFault = new Promise((resolve) => { faulted = resolve; });
      const options = { path, logger: { log() {}, warn() {} },
        onFault: () => { if (firstFaultDurable === undefined) firstFaultDurable = durableHeld; faulted(); },
        deliver: async () => { providerCalls++; throw new Error("Offline fixture must not deliver"); } };
      globalThis.fetch = async () => { providerCalls++; throw new Error("Offline fixture must not fetch"); };
      const worker = new MemberSyncForwarder(config, options);
      await worker.initialize();
      pauseClear = true;
      const original = worker.enqueue(member(), "guildMemberAdd");
      await clearStarted;
      const rejectionDurability = [];
      const observed = (admission) => admission.catch((error) => { rejectionDurability.push(durableHeld); throw error; });
      const burst = Array.from({ length: 256 }, () => observed(worker.enqueue(member(), "guildMemberUpdate")));
      const outcomes = Promise.allSettled([original, ...burst]);
      releaseClear();
      await firstFault;
      assert.equal(firstFaultDurable, true);
      assert.notEqual(await fs.readFile(journalPath, "utf8"),
        JSON.stringify({ schemaVersion: 1, held: false }).padEnd(255, " ") + String.fromCharCode(10));
      const statuses = await outcomes;
      assert.equal(rejectionDurability.length, 256);
      assert.equal(rejectionDurability.every(Boolean), true);
      assert.equal(statuses.filter((outcome) => outcome.status === "fulfilled").length, 1);
      assert.equal(statuses.filter((outcome) => outcome.status === "rejected").length, 256);
      assert.equal(JSON.parse(await fs.readFile(journalPath, "utf8")).held, true);
      const restarted = new MemberSyncForwarder(config, options);
      await restarted.initialize();
      await restarted.drainOnce();
      await assert.rejects(restarted.enqueue(member(), "guildMemberUpdate"), /requires reconciliation/);
      assert.equal(JSON.parse(await fs.readFile(journalPath, "utf8")).held, true);
      assert.equal(providerCalls, 0);
      assert.equal((await fs.readdir(path)).filter((name) => name !== "admission.json").length, 1);
      worker.stop();
      restarted.stop();
      clearTimeout(timeout);
      console.log("durable-overflow-race: passed");
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
      env: { NODE_ENV: "production" }, stdout: "pipe", stderr: "pipe",
    });
    const [output, errors, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect({ exitCode, errors }).toEqual({ exitCode: 0, errors: "" });
    expect(output.trim()).toBe("durable-overflow-race: passed");
  }, 10_000);

  for (const failure of ["short_then_error", "chunks_then_queue_error", "zero_marker", "invalid_marker"]) {
    test(`journal write progress fails closed: ${failure}`, async () => {
      const { path } = await fixture();
      const script = `
        import assert from "node:assert/strict";
        import { mock } from "bun:test";
        import { join } from "node:path";
        const fs = await import("node:fs/promises");
        const originalOpen = fs.open;
        const path = ${JSON.stringify(path)};
        const failure = ${JSON.stringify(failure)};
        const journalPath = join(path, "admission.json");
        const timeout = setTimeout(() => { console.error("Journal fixture timed out"); process.exit(1); }, 8000);
        let armed = false;
        let journalWrites = 0;
        let payloadWrites = 0;
        let queueFailureReached = false;
        const acknowledged = [];
        const durableSnapshots = [];
        mock.module("node:fs/promises", () => ({ ...fs, open: async (...args) => {
          const journal = String(args[0]) === journalPath;
          if (armed && !journal && String(args[0]).endsWith(".json") && failure === "chunks_then_queue_error") {
            queueFailureReached = true;
            assert.equal(JSON.parse(await fs.readFile(journalPath, "utf8")).held, true);
            throw new Error("injected_queue_failure");
          }
          const handle = await originalOpen(...args);
          return new Proxy(handle, { get(value, key) {
            if (key === "write") return async (...values) => {
              if (!armed || !journal) return handle.write(...values);
              journalWrites++;
              const [bytes, offset, length, position] = values;
              if (failure === "zero_marker") return { bytesWritten: 0, buffer: bytes };
              if (failure === "invalid_marker") return { bytesWritten: length + 1, buffer: bytes };
              let limit = length;
              if (failure === "short_then_error" && position >= 1) {
                if (++payloadWrites > 1) throw new Error("injected_payload_failure");
                limit = Math.min(2, length);
              }
              if (failure === "chunks_then_queue_error") limit = Math.min(7, length);
              const result = await handle.write(bytes, offset, limit, position);
              acknowledged.push(result.bytesWritten);
              return result;
            };
            if (key === "sync") return async () => {
              await handle.sync();
              if (armed && journal) durableSnapshots.push(await fs.readFile(journalPath, "utf8"));
            };
            const property = Reflect.get(value, key, value);
            return typeof property === "function" ? property.bind(value) : property;
          } });
        } }));
        const { MemberSyncForwarder } = await import(${JSON.stringify(new URL("../src/member-forwarder.ts", import.meta.url).href)});
        const config = ${JSON.stringify(config)};
        const member = () => ({ guild: { id: config.discordGuildId },
          user: { id: ${JSON.stringify(ids.member)} }, roles: { cache: new Map([[${JSON.stringify(ids.roleOne)}, true]]) } });
        let faults = 0;
        let providerCalls = 0;
        const options = { path, logger: { log() {}, warn() {} }, onFault: () => { faults++; },
          deliver: async () => { providerCalls++; throw new Error("Offline fixture must not deliver"); } };
        globalThis.fetch = async () => { providerCalls++; throw new Error("Offline fixture must not fetch"); };
        const worker = new MemberSyncForwarder(config, options);
        await worker.initialize();
        armed = true;
        const expectedError = failure === "short_then_error" ? /injected_payload_failure/
          : failure === "chunks_then_queue_error" ? /injected_queue_failure/ : /invalid progress/;
        await assert.rejects(worker.enqueue(member(), "guildMemberUpdate"), expectedError);
        assert.equal(faults, 1);
        assert.equal(providerCalls, 0);
        assert.equal((await fs.readdir(path)).filter((name) => name !== "admission.json").length, 0);
        worker.stop();
        armed = false;
        const restarted = new MemberSyncForwarder(config, options);
        const source = await fs.readFile(journalPath, "utf8");
        if (failure === "short_then_error") {
          assert.deepEqual(acknowledged, [1, 2]);
          assert.equal(journalWrites, 3);
          assert.equal(durableSnapshots.length, 1);
          assert.equal(durableSnapshots[0][0], "!");
          assert.equal(source[0], "!");
          await assert.rejects(restarted.initialize());
        } else if (failure === "chunks_then_queue_error") {
          assert.equal(queueFailureReached, true);
          assert.equal(durableSnapshots.length, 3);
          assert.equal(durableSnapshots[0][0], "!");
          assert.equal(durableSnapshots[1][0], "!");
          assert.equal(JSON.parse(durableSnapshots[2]).held, true);
          assert.equal(acknowledged.reduce((sum, count) => sum + count, 0), 257);
          assert.ok(journalWrites > 3 && journalWrites <= 257);
          assert.equal(JSON.parse(source).held, true);
          await restarted.initialize();
          await restarted.drainOnce();
          await assert.rejects(restarted.enqueue(member(), "guildMemberUpdate"), /requires reconciliation/);
        } else {
          // No acknowledged marker progress proves no persisted hold; report the fault without inventing one.
          assert.equal(journalWrites, 1);
          assert.equal(durableSnapshots.length, 0);
          assert.equal(JSON.parse(source).held, false);
          await restarted.initialize();
          await restarted.drainOnce();
        }
        assert.equal(providerCalls, 0);
        restarted.stop();
        clearTimeout(timeout);
        console.log("journal-progress: passed");
      `;
      const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
        env: { NODE_ENV: "production" }, stdout: "pipe", stderr: "pipe",
      });
      const [output, errors, exitCode] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect({ exitCode, errors }).toEqual({ exitCode: 0, errors: "" });
      expect(output.trim()).toBe("journal-progress: passed");
    }, 10_000);
  }

  test("invalid event faults immediately when its admission hold cannot be persisted", async () => {
    let faults = 0;
    let deliveries = 0;
    const { path, worker } = await fixture({ onFault: () => { faults++; }, deliver: async () => {
      deliveries++;
      throw new Error("No provider call permitted during an admission failure");
    } });
    // Corrupt only the owned temporary journal after initialization; no platform-specific permissions.
    await writeFile(join(path, "admission.json"), "invalid journal");
    const invalidMember = { ...member(), roles: { cache: new Map([["invalid-role", true]]) } };
    await expect(worker.enqueue(invalidMember, "guildMemberUpdate")).rejects.toThrow("admission journal is invalid");
    expect(faults).toBe(1);
    expect(deliveries).toBe(0);
    expect(await queueFiles(path)).toHaveLength(0);
  });

  test("corrupt, unknown or oversized disk records fail closed before provider access", async () => {
    for (const kind of ["unknown", "corrupt", "oversized"]) {
      const { path, worker } = await fixture();
      await worker.enqueue(member(), "guildMemberAdd");
      const [filename] = await queueFiles(path);
      if (kind === "unknown") await writeFile(join(path, "unknown.tmp"), "{}", { mode: 0o600 });
      else await writeFile(join(path, filename!), kind === "corrupt" ? "{}\n" : "x".repeat(32769));
      const restarted = new MemberSyncForwarder(config, { path, logger: quiet, deliver: async () => { throw new Error("must not deliver"); } });
      await expect(restarted.initialize()).rejects.toThrow();
    }
  });

  test("role snapshot cannot be changed by cache updates while awaiting admission", async () => {
    const { path, worker } = await fixture();
    const cache = new Map<string, boolean>([[ids.roleOne, true]]);
    const pending = worker.enqueue({ ...member(), roles: { cache } }, "guildMemberUpdate");
    cache.set(ids.roleTwo, true);
    await pending;
    const [filename] = await queueFiles(path);
    const body = JSON.parse(JSON.parse(await readFile(join(path, filename!), "utf8")).body);
    expect(body.roles).toEqual([ids.roleOne]);
  });

  test("delivery exceptions preserve pending work", async () => {
    const { path, worker } = await fixture({ deliver: async () => { throw new Error("offline failure"); } });
    await worker.enqueue(member(), "guildMemberAdd");
    await expect(worker.drainOnce()).rejects.toThrow();
    expect(await queueFiles(path)).toHaveLength(1);
  });
});
