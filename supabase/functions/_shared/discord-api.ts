import {
  fetchWithTimeout,
  OutboundHttpError,
  readBoundedResponseText,
} from "./outbound-http.ts";
import { DISCORD_API_ORIGIN, discordApiUrl } from "./runtime-config.ts";
import { parseJsonNoDuplicateKeys } from "./strict-json.ts";

export type JsonRecord = Record<string, unknown>;

export type DiscordFetchOptions = Omit<RequestInit, "body" | "headers"> & {
  body?: BodyInit | JsonRecord | JsonRecord[] | null;
  headers?: HeadersInit;
  token?: string;
  tokenEnvName?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  maximumResponseBytes?: number;
};

export type DiscordFetchResult = {
  ok: boolean;
  status: number;
  statusText: string;
  data: unknown;
  error: unknown;
  headers: Headers;
};

export type DiscordMemberRoleState = {
  roles: string[];
  pending: boolean;
};

export const DISCORD_API_TIMEOUT_MS = 10_000;
export const DISCORD_API_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function getRequiredEnv(name: string): string {
  const value = Deno.env.get(name)?.trim() || "";
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}.`);
  }
  return value;
}

export function getDiscordBotToken(envName = "DISCORD_BOT_TOKEN"): string {
  return getRequiredEnv(envName);
}

export function buildDiscordApiUrl(path: string): string {
  const cleanPath = String(path || "").trim();
  if (!cleanPath) throw new Error("Discord API path is required.");
  if (
    /^[a-z][a-z\d+.-]*:/iu.test(cleanPath) || cleanPath.startsWith("//") ||
    cleanPath.includes("\\")
  ) {
    throw new Error("Discord API path must be relative.");
  }

  const value = discordApiUrl(
    `api/v10/${cleanPath.replace(/^\/+/, "")}`,
  );
  if (!value) throw new Error("Discord API origin is not configured.");
  const candidate = new URL(value);
  if (
    candidate.origin !== DISCORD_API_ORIGIN ||
    !candidate.pathname.startsWith("/api/v10/") || candidate.port ||
    candidate.username || candidate.password || candidate.hash
  ) throw new Error("Discord API path must stay within the v10 API.");
  return candidate.toString();
}

export function discordMemberRoleState(
  value: unknown,
  expectedUserId?: string,
): DiscordMemberRoleState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as JsonRecord;
  if (!Array.isArray(record.roles) || record.roles.length > 250) return null;
  if (!record.roles.every((role) => typeof role === "string")) return null;
  const roles = [...record.roles] as string[];
  if (!roles.every((role) => /^\d{16,22}$/u.test(role))) return null;
  if (record.pending != null && typeof record.pending !== "boolean") {
    return null;
  }
  if (expectedUserId) {
    const user = record.user;
    if (!user || typeof user !== "object" || Array.isArray(user)) return null;
    if ((user as JsonRecord).id !== expectedUserId) return null;
  }
  return { roles, pending: record.pending === true };
}

export function discordRetryAfterSeconds(headers: Headers): number | null {
  const value = headers.get("retry-after")?.trim() || "";
  if (!/^\d{1,4}$/u.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 3_600
    ? seconds
    : null;
}

export function redactSecret(value: unknown, visible = 4): string {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= visible * 2) return "[redacted]";
  return `${text.slice(0, visible)}...[redacted]...${text.slice(-visible)}`;
}

export function safeJsonResponse(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...Object.fromEntries(new Headers(headers)),
      "Content-Type": "application/json",
    },
  });
}

function isBodyInit(value: unknown): value is BodyInit {
  if (value == null) return false;
  if (typeof value === "string") return true;
  if (typeof FormData !== "undefined" && value instanceof FormData) return true;
  if (
    typeof URLSearchParams !== "undefined" && value instanceof URLSearchParams
  ) return true;
  if (typeof Blob !== "undefined" && value instanceof Blob) return true;
  if (value instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(value)) return true;
  if (
    typeof ReadableStream !== "undefined" && value instanceof ReadableStream
  ) return true;
  return false;
}

function normalizeBody(
  body: DiscordFetchOptions["body"],
): { body?: BodyInit; jsonBody: boolean } {
  if (body == null) return { body: undefined, jsonBody: false };
  if (isBodyInit(body)) return { body, jsonBody: false };
  return { body: JSON.stringify(body), jsonBody: true };
}

async function readDiscordPayload(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const raw = await readBoundedResponseText(response, maximumBytes);
  if (!raw) return null;

  const contentType = response.headers.get("content-type")?.split(";", 1)[0]
    ?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new OutboundHttpError("response_json_invalid");
  }

  try {
    return parseJsonNoDuplicateKeys(raw, {
      maximumBytes,
      maximumDepth: 64,
    });
  } catch {
    throw new OutboundHttpError("response_json_invalid");
  }
}

export async function discordFetch(
  path: string,
  options: DiscordFetchOptions = {},
): Promise<DiscordFetchResult> {
  const {
    body: rawBody,
    headers: rawHeaders,
    token,
    tokenEnvName,
    fetcher,
    timeoutMs = DISCORD_API_TIMEOUT_MS,
    maximumResponseBytes = DISCORD_API_MAX_RESPONSE_BYTES,
    ...init
  } = options;
  const { body, jsonBody } = normalizeBody(rawBody);
  const headers = new Headers(rawHeaders || {});
  if (!headers.has("Authorization")) {
    const botToken = token?.trim() || getDiscordBotToken(tokenEnvName);
    headers.set("Authorization", `Bot ${botToken}`);
  }
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (jsonBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetchWithTimeout(
    buildDiscordApiUrl(path),
    { ...init, body, headers },
    { fetcher, timeoutMs },
  );
  const payload = await readDiscordPayload(response, maximumResponseBytes);

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    data: response.ok ? payload : null,
    error: response.ok ? null : payload,
    headers: response.headers,
  };
}
