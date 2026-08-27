export type OutboundFetchOptions = {
  fetcher?: typeof fetch;
  timeoutMs: number;
};

export type ExactHttpsUrlOptions = {
  allowedOrigins: ReadonlySet<string>;
  exactPathname?: string;
  pathPrefix?: string;
  allowedSearchParams?: ReadonlySet<string>;
};

export class OutboundHttpError extends Error {
  constructor(
    public readonly code:
      | "invalid_url"
      | "request_timeout"
      | "response_length_invalid"
      | "response_too_large"
      | "response_encoding_invalid"
      | "response_json_invalid",
  ) {
    super(code);
    this.name = "OutboundHttpError";
  }
}

export function exactHttpsUrl(
  value: unknown,
  options: ExactHttpsUrlOptions,
): string | null {
  let url: URL;
  try {
    url = new URL(String(value || ""));
  } catch {
    return null;
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    url.pathname.includes("%") ||
    !options.allowedOrigins.has(url.origin)
  ) {
    return null;
  }
  if (options.exactPathname && url.pathname !== options.exactPathname) {
    return null;
  }
  if (options.pathPrefix) {
    const prefix = options.pathPrefix.endsWith("/")
      ? options.pathPrefix
      : `${options.pathPrefix}/`;
    if (
      url.pathname !== options.pathPrefix &&
      !url.pathname.startsWith(prefix)
    ) {
      return null;
    }
  }

  const allowedSearchParams = options.allowedSearchParams || new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowedSearchParams.has(key)) return null;
  }

  return url.toString();
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  options: OutboundFetchOptions,
): Promise<Response> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new RangeError("Outbound HTTP timeout must be a positive integer.");
  }

  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;

  try {
    return await (options.fetcher || fetch)(input, {
      ...init,
      redirect: "error",
      signal,
    });
  } catch (error) {
    if (timeoutSignal.aborted && !init.signal?.aborted) {
      throw new OutboundHttpError("request_timeout");
    }
    throw error;
  }
}

function declaredResponseLength(response: Response): number | null {
  const header = response.headers.get("content-length");
  if (header == null || header === "") return null;
  if (!/^\d+$/.test(header)) {
    throw new OutboundHttpError("response_length_invalid");
  }
  const value = Number(header);
  if (!Number.isSafeInteger(value)) {
    throw new OutboundHttpError("response_length_invalid");
  }
  return value;
}

export async function readBoundedResponseBytes(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new RangeError(
      "Outbound HTTP response limit must be a non-negative integer.",
    );
  }

  const declaredLength = declaredResponseLength(response);
  if (declaredLength !== null && declaredLength > maximumBytes) {
    await response.body?.cancel("response_too_large").catch(() => undefined);
    throw new OutboundHttpError("response_too_large");
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel("response_too_large").catch(() => undefined);
        throw new OutboundHttpError("response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const bytes = await readBoundedResponseBytes(response, maximumBytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new OutboundHttpError("response_encoding_invalid");
  }
}

export async function readBoundedResponseJson(
  response: Response,
  maximumBytes: number,
): Promise<unknown> {
  const text = await readBoundedResponseText(response, maximumBytes);
  if (!text) return null;
  try {
    return parseJsonNoDuplicateKeys(text, {
      maximumBytes,
      maximumDepth: 64,
    });
  } catch {
    throw new OutboundHttpError("response_json_invalid");
  }
}
import { parseJsonNoDuplicateKeys } from "./strict-json.ts";
