import { randomUUID } from "node:crypto";
import { pendingVerificationSyncEndpoint, type ReaperConfig } from "./config.js";

export type PendingVerificationEventType = "guildMemberAdd" | "guildMemberUpdate";
export type PendingVerificationMemberLike = {
  guild: { id: string };
  user: { id: string; bot?: boolean };
  roles: { cache: { keys(): IterableIterator<string> } };
};
export type PendingVerificationLogger = Pick<Console, "log" | "warn">;
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type WaitLike = (delayMs: number) => Promise<void>;
export type MemberSyncRequest = { requestId: string; body: string };
export type MemberSyncCounts = { discordWrites: number; dbWrites: number; staleRecordsCleared: number };
export type MemberSyncDelivery =
  | { status: "completed"; result: MemberSyncCounts }
  | { status: "pending"; reason: string; retryAfterMs: number }
  | { status: "blocked"; reason: string };

const RESPONSE_MAX_BYTES = 16_384;
const REQUEST_MAX_BYTES = 16_384;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SNOWFLAKE = /^[1-9][0-9]{0,19}$/u;
const RECEIPT_STATES = new Set(["missing", "reserved", "writing", "completed", "rejected", "blocked"]);
const wait: WaitLike = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));
type Receipt = { status: string; result: MemberSyncCounts | null; retryAfterMs: number | null };

function exactKeys(value: Record<string, unknown>, names: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify(names.sort());
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 10_000;
}

function discordId(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n;
}

export function memberRoleIds(member: PendingVerificationMemberLike): string[] {
  return [...member.roles.cache.keys()].sort();
}

export function memberRolesChanged(before: PendingVerificationMemberLike, after: PendingVerificationMemberLike): boolean {
  const beforeRoles = memberRoleIds(before);
  const afterRoles = memberRoleIds(after);
  return beforeRoles.length !== afterRoles.length || beforeRoles.some((roleId, index) => roleId !== afterRoles[index]);
}

export function validateMemberSyncRequest(value: unknown): MemberSyncRequest {
  const request = object(value);
  if (!request || !exactKeys(request, ["requestId", "body"]) || typeof request.requestId !== "string" ||
    !UUID.test(request.requestId) || typeof request.body !== "string" ||
    Buffer.byteLength(request.body, "utf8") > REQUEST_MAX_BYTES) throw new Error("Invalid member sync request.");
  const body = object(JSON.parse(request.body));
  if (!body || JSON.stringify(body) !== request.body ||
    !exactKeys(body, ["request_id", "event_type", "guild_id", "discord_user_id", "roles", "gateway_sequence", "occurred_at"]) ||
    body.request_id !== request.requestId || !["guildMemberAdd", "guildMemberUpdate"].includes(String(body.event_type)) ||
    !discordId(body.guild_id) || !discordId(body.discord_user_id) ||
    !Array.isArray(body.roles) || body.roles.length > 250 || !body.roles.every(discordId) ||
    JSON.stringify(body.roles) !== JSON.stringify([...new Set(body.roles)].sort()) ||
    !(body.gateway_sequence === null || (typeof body.gateway_sequence === "number" && Number.isSafeInteger(body.gateway_sequence) && body.gateway_sequence >= 0)) ||
    typeof body.occurred_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(body.occurred_at) ||
    new Date(body.occurred_at).toISOString() !== body.occurred_at) throw new Error("Invalid member sync request.");
  return { requestId: request.requestId, body: request.body };
}

export function createMemberSyncRequest(
  member: PendingVerificationMemberLike,
  eventType: PendingVerificationEventType,
  gatewaySequence: number | null = null,
): MemberSyncRequest {
  const requestId = randomUUID();
  return validateMemberSyncRequest({ requestId, body: JSON.stringify({
    request_id: requestId, event_type: eventType, guild_id: member.guild.id,
    discord_user_id: member.user.id, roles: memberRoleIds(member),
    gateway_sequence: gatewaySequence, occurred_at: new Date().toISOString(),
  }) });
}

function parseReceipt(text: string, requestId: string, httpStatus: number, method: "POST" | "GET"): Receipt | null {
  try {
    const parsed: unknown = JSON.parse(text);
    // The paired endpoint emits JSON.stringify. Canonical round-trip also
    // rejects duplicate/escaped keys and conflicting JSON interpretations.
    const compact = text.replace(/"(?:[^"\\]|\\.)*"|\s+/gu, (token) => token.startsWith('"') ? token : "");
    if (JSON.stringify(parsed) !== compact) return null;
    const record = object(parsed);
    if (!record || record.request_id !== requestId || typeof record.status !== "string") return null;
    if (record.ok === false && ["busy", "disabled"].includes(record.status)) {
      if (method !== "POST" || httpStatus !== 409 ||
        !exactKeys(record, ["ok", "request_id", "status", "result", "retry_after_ms"]) ||
        record.result !== null || !count(record.retry_after_ms) || record.retry_after_ms < 1 || record.retry_after_ms > 5000) return null;
      return { status: record.status, result: null, retryAfterMs: record.retry_after_ms };
    }
    if (!exactKeys(record, ["ok", "request_id", "status", "result"])) return null;
    if (record.ok === false && record.status === "identity_conflict" && record.result === null && httpStatus === 409) {
      return { status: record.status, result: null, retryAfterMs: null };
    }
    if (record.ok !== true || !RECEIPT_STATES.has(record.status)) return null;
    if (record.status === "missing" && method !== "GET") return null;
    const expectedHttp = record.status === "completed" || record.status === "missing" ? 200
      : ["rejected", "blocked"].includes(record.status) ? 409 : method === "POST" ? 202 : 200;
    if (httpStatus !== expectedHttp) return null;
    if (record.status !== "completed") {
      return record.result === null ? { status: record.status, result: null, retryAfterMs: null } : null;
    }
    const result = object(record.result);
    if (!result || !exactKeys(result, ["discordWrites", "dbWrites", "staleRecordsCleared"]) ||
      !count(result.discordWrites) || !count(result.dbWrites) || !count(result.staleRecordsCleared)) return null;
    return { status: "completed", result: result as MemberSyncCounts, retryAfterMs: null };
  } catch {
    return null;
  }
}

function abortError(): Error {
  const error = new Error("Member sync response handling timed out.");
  error.name = "AbortError";
  return error;
}

async function readChunkWithAbort(reader: ReadableStreamDefaultReader<Uint8Array>, signal: AbortSignal): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>> {
  if (signal.aborted) throw abortError();
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener("abort", onAbort); reject(abortError()); };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => { signal.removeEventListener("abort", onAbort); resolve(result); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

async function boundedResponseText(response: Response, signal: AbortSignal): Promise<string | null> {
  const length = response.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > RESPONSE_MAX_BYTES)) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await readChunkWithAbort(reader, signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > RESPONSE_MAX_BYTES) { void reader.cancel().catch(() => undefined); return null; }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* An aborted read may still own its lock. */ }
  }
}

// Call only for an already durably spooled request. Every invocation starts
// with authenticated status recovery; no restart creates a replacement UUID.
export async function deliverMemberSyncRequest(
  value: MemberSyncRequest,
  config: ReaperConfig,
  fetchImpl: FetchLike = fetch,
  waitImpl: WaitLike = wait,
): Promise<MemberSyncDelivery> {
  const request = validateMemberSyncRequest(value);
  const endpoint = pendingVerificationSyncEndpoint(config.pendingVerificationSyncUrl);
  const body = JSON.parse(request.body) as { guild_id: string };
  if (!config.pendingVerificationSyncEnabled || body.guild_id !== config.discordGuildId) {
    return { status: "blocked", reason: "configuration_hold" };
  }
  const deadline = performance.now() + 60_000;
  const statusUrl = `${endpoint}/status?request_id=${request.requestId}`;

  async function readReceipt(method: "POST" | "GET"): Promise<Receipt | null> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(config.pendingVerificationSyncTimeoutMs, remaining));
    const target = method === "POST" ? endpoint : statusUrl;
    try {
      const response = await fetchImpl(target, {
        method, headers: { Accept: "application/json", "Content-Type": "application/json",
          "x-mochirii-reaper-member-sync-secret": config.pendingVerificationSyncSecret },
        ...(method === "POST" ? { body: request.body } : {}), redirect: "error", signal: controller.signal,
      });
      if (response.redirected || (response.url && response.url !== target) ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(response.headers.get("Content-Type") || "")) {
        void response.body?.cancel().catch(() => undefined);
        return null;
      }
      const text = await boundedResponseText(response, controller.signal);
      return text === null ? null : parseReceipt(text, request.requestId, response.status, method);
    } catch {
      return null;
    } finally { clearTimeout(timeout); }
  }

  for (let attempt = 1; attempt <= config.pendingVerificationSyncMaxAttempts; attempt++) {
    let receipt = await readReceipt("GET");
    if (receipt?.status === "missing") receipt = await readReceipt("POST");
    if (receipt?.status === "completed" && receipt.result) return { status: "completed", result: receipt.result };
    if (receipt && ["blocked", "rejected", "identity_conflict"].includes(receipt.status)) {
      return { status: "blocked", reason: receipt.status };
    }
    if (attempt < config.pendingVerificationSyncMaxAttempts) {
      const delay = receipt?.retryAfterMs ?? 1000;
      if (performance.now() + delay >= deadline) break;
      await waitImpl(delay);
    }
  }
  return { status: "pending", reason: "receipt_not_completed", retryAfterMs: 5000 };
}
