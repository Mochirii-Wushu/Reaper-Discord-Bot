export type JsonRecord = Record<string, unknown>;

export type DiscordFetchOptions = Omit<RequestInit, "body" | "headers"> & {
  body?: BodyInit | JsonRecord | JsonRecord[] | null;
  headers?: HeadersInit;
  token?: string;
  tokenEnvName?: string;
};

export type DiscordFetchResult = {
  ok: boolean;
  status: number;
  statusText: string;
  data: unknown;
  error: unknown;
  headers: Headers;
};

export const DISCORD_API_BASE = "https://discord.com/api/v10";

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
  if (/^https?:\/\//i.test(cleanPath)) {
    throw new Error("Discord API path must be relative.");
  }

  return new URL(cleanPath.replace(/^\/+/, ""), `${DISCORD_API_BASE}/`)
    .toString();
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

async function readDiscordPayload(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
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
    ...init
  } = options;
  const { body, jsonBody } = normalizeBody(rawBody);
  const headers = new Headers(rawHeaders || {});
  const botToken = token?.trim() || getDiscordBotToken(tokenEnvName);

  if (!headers.has("Authorization")) {
    headers.set("Authorization", `Bot ${botToken}`);
  }
  if (!headers.has("Accept")) headers.set("Accept", "application/json");
  if (jsonBody && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(buildDiscordApiUrl(path), {
    ...init,
    body,
    headers,
  });
  const payload = await readDiscordPayload(response);

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    data: response.ok ? payload : null,
    error: response.ok ? null : payload,
    headers: response.headers,
  };
}
