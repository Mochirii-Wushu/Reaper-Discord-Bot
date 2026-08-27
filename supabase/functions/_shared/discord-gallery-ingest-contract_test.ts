import {
  createDiscordGalleryIngestHeaders,
  parseDiscordGalleryIngestHmacKeys,
} from "./discord-gallery-ingest-signer.ts";

const SECRET = "k".repeat(32);
const NOW_MS = 1_790_000_000_000;
const NONCE = "0123456789abcdef0123456789abcdef";
const WEBSITE_PATH = "/functions/v1/submit-discord-gallery-image";
const WEBSITE_ORIGIN = "https://project.synthetic.test";
const WEBSITE_URL = `${WEBSITE_ORIGIN}${WEBSITE_PATH}`;
const WEBSITE_MAX_BODY_BYTES = 16 * 1024;
const WEBSITE_HEADERS = {
  keyId: "x-mochirii-gallery-key-id",
  timestamp: "x-mochirii-gallery-timestamp",
  nonce: "x-mochirii-gallery-nonce",
  signature: "x-mochirii-gallery-signature",
} as const;
const encoder = new TextEncoder();
const UTF8_BOM = new Uint8Array([0xef, 0xbb, 0xbf]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function websiteVerifierFixture(input: {
  headers: Headers;
  rawBodyBytes: Uint8Array<ArrayBuffer>;
  method?: string;
  requestUrl?: string;
  nowMs?: number;
  consumed: Set<string>;
  consumeNonce?: (replayKey: string) => void;
}): Promise<"ok" | "invalid" | "replay" | "unavailable"> {
  const requestUrl = new URL(input.requestUrl || WEBSITE_URL);
  const keyId = input.headers.get(WEBSITE_HEADERS.keyId) || "";
  const timestamp = input.headers.get(WEBSITE_HEADERS.timestamp) || "";
  const nonce = input.headers.get(WEBSITE_HEADERS.nonce) || "";
  const signature = input.headers.get(WEBSITE_HEADERS.signature) || "";
  if (
    keyId !== "current" || !/^[1-9][0-9]{9,12}$/u.test(timestamp) ||
    !/^[0-9a-f]{32}$/u.test(nonce) || !/^v1=[0-9a-f]{64}$/u.test(signature) ||
    input.rawBodyBytes.byteLength > WEBSITE_MAX_BODY_BYTES ||
    requestUrl.origin !== WEBSITE_ORIGIN ||
    requestUrl.pathname !== WEBSITE_PATH || requestUrl.search !== "" ||
    requestUrl.hash !== "" || requestUrl.username !== "" ||
    requestUrl.password !== "" ||
    UTF8_BOM.every((value, index) => input.rawBodyBytes[index] === value)
  ) return "invalid";

  const requestSeconds = Number(timestamp);
  const nowSeconds = Math.floor((input.nowMs ?? NOW_MS) / 1000);
  if (Math.abs(nowSeconds - requestSeconds) > 60) return "invalid";

  const bodyHash = hex(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        input.rawBodyBytes,
      ),
    ),
  );
  const canonical = encoder.encode([
    "v1",
    keyId,
    (input.method || "POST").toUpperCase(),
    requestUrl.pathname,
    timestamp,
    nonce,
    bodyHash,
  ].join("\n"));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = hex(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        canonical,
      ),
    ),
  );
  const actual = signature.slice(3);
  let mismatch = expected.length ^ actual.length;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= expected.charCodeAt(index) ^ (actual.charCodeAt(index) || 0);
  }
  if (mismatch !== 0) return "invalid";

  const replayKey = `${keyId}:${nonce}`;
  try {
    if (input.consumed.has(replayKey)) return "replay";
    if (input.consumeNonce) input.consumeNonce(replayKey);
    input.consumed.add(replayKey);
  } catch {
    return "unavailable";
  }
  return "ok";
}

Deno.test("Reaper signer interoperates with an independent Website verifier fixture", async () => {
  const keys = parseDiscordGalleryIngestHmacKeys(
    JSON.stringify({ current: SECRET }),
  );
  assert(keys, "synthetic keys should parse");
  const rawBody = '{"guildId":"900000000000000004"}';
  const rawBodyBytes = encoder.encode(rawBody);
  const headers = new Headers(
    await createDiscordGalleryIngestHeaders({
      keys,
      activeKeyId: "current",
      rawBody,
      nowMs: NOW_MS,
      nonce: NONCE,
    }),
  );
  assert(
    [...headers.keys()].sort().join("\n") === [
      "x-mochirii-gallery-key-id",
      "x-mochirii-gallery-nonce",
      "x-mochirii-gallery-signature",
      "x-mochirii-gallery-timestamp",
    ].join("\n"),
    "the signer must emit exactly four authentication headers",
  );

  const consumed = new Set<string>();
  assert(
    await websiteVerifierFixture({ headers, rawBodyBytes, consumed }) === "ok",
    "fresh request should verify",
  );
  assert(
    await websiteVerifierFixture({ headers, rawBodyBytes, consumed }) ===
      "replay",
    "nonce must be one-use",
  );
  assert(
    await websiteVerifierFixture({
      headers,
      rawBodyBytes: encoder.encode(`${rawBody} `),
      consumed: new Set(),
    }) === "invalid",
    "raw body must be bound",
  );
  const bomPrefixedBody = new Uint8Array(
    UTF8_BOM.byteLength + rawBodyBytes.byteLength,
  );
  bomPrefixedBody.set(UTF8_BOM);
  bomPrefixedBody.set(rawBodyBytes, UTF8_BOM.byteLength);
  assert(
    await websiteVerifierFixture({
      headers,
      rawBodyBytes: bomPrefixedBody,
      consumed: new Set(),
    }) === "invalid",
    "BOM-prefixed bytes must not verify under the original body signature",
  );
  assert(
    await websiteVerifierFixture({
      headers,
      rawBodyBytes,
      method: "PUT",
      consumed: new Set(),
    }) === "invalid",
    "method must be bound",
  );
  assert(
    await websiteVerifierFixture({
      headers,
      rawBodyBytes,
      requestUrl: `${WEBSITE_URL}/other`,
      consumed: new Set(),
    }) === "invalid",
    "path must be bound",
  );
  assert(
    await websiteVerifierFixture({
      headers,
      rawBodyBytes,
      requestUrl:
        `${WEBSITE_ORIGIN}/functions/v1/ignored/../submit-discord-gallery-image`,
      consumed: new Set(),
    }) === "ok",
    "the verifier can bind only the runtime-normalized WHATWG pathname",
  );
  for (
    const requestUrl of [
      `${WEBSITE_URL}?query=forbidden`,
      `${WEBSITE_URL}#fragment`,
      `https://user@project.synthetic.test${WEBSITE_PATH}`,
      `https://project.synthetic.test:8443${WEBSITE_PATH}`,
      `https://other.synthetic.test${WEBSITE_PATH}`,
    ]
  ) {
    assert(
      await websiteVerifierFixture({
        headers,
        rawBodyBytes,
        requestUrl,
        consumed: new Set(),
      }) === "invalid",
      `URL outside the reviewed runtime boundary must fail: ${requestUrl}`,
    );
  }
  assert(
    await websiteVerifierFixture({
      headers,
      rawBodyBytes,
      nowMs: NOW_MS + 61_000,
      consumed: new Set(),
    }) === "invalid",
    "stale timestamp must fail",
  );
  assert(
    await websiteVerifierFixture({
      headers,
      rawBodyBytes,
      consumed: new Set(),
      consumeNonce: () => {
        throw new Error("synthetic nonce store failure");
      },
    }) === "unavailable",
    "nonce storage failure must fail closed as unavailable/503",
  );
});

Deno.test("gallery signer rejects hostile duplicate-key configuration", () => {
  assert(
    parseDiscordGalleryIngestHmacKeys(
      `{"current":"${SECRET}","curr\\u0065nt":"${"z".repeat(32)}"}`,
    ) === null,
    "escaped duplicate key must fail closed",
  );
});
