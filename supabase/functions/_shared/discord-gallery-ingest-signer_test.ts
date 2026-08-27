import {
  createDiscordGalleryIngestHeaders,
  createDiscordGalleryIngestSignature,
  DISCORD_GALLERY_INGEST_HEADERS,
  DISCORD_GALLERY_INGEST_MAX_BODY_BYTES,
  discordGalleryIngestActiveKey,
  parseDiscordGalleryIngestHmacKeys,
} from "./discord-gallery-ingest-signer.ts";

const SECRET_A = "a".repeat(32);
const SECRET_B = "b".repeat(32);
const NOW_MS = 1_790_000_000_000;
const NONCE = "0123456789abcdef0123456789abcdef";
const RAW_BODY = JSON.stringify({ guildId: "900000000000000004" });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("gallery ingest signer accepts only a bounded unique key set", () => {
  const keys = parseDiscordGalleryIngestHmacKeys(JSON.stringify({
    current: SECRET_A,
    next: SECRET_B,
  }));
  assert(keys?.current === SECRET_A, "the current key should parse");
  assert(keys?.next === SECRET_B, "the next key should parse");
  assert(Object.isFrozen(keys), "the parsed key set should be immutable");

  for (
    const value of [
      "",
      "not-json",
      "[]",
      "{}",
      JSON.stringify({ INVALID: SECRET_A }),
      JSON.stringify({ current: "short" }),
      JSON.stringify({ current: SECRET_A, duplicate: SECRET_A }),
      `{"current":"${SECRET_A}","current":"${SECRET_B}"}`,
      `{"current":"${SECRET_A}","curr\\u0065nt":"${SECRET_B}"}`,
      JSON.stringify({
        a: SECRET_A,
        b: SECRET_B,
        c: "c".repeat(32),
        d: "d".repeat(32),
      }),
    ]
  ) {
    assert(
      parseDiscordGalleryIngestHmacKeys(value) === null,
      `invalid key set should fail closed: ${value.slice(0, 24)}`,
    );
  }
});

Deno.test("gallery ingest signer selects only an existing valid active key", () => {
  const keys = parseDiscordGalleryIngestHmacKeys(
    JSON.stringify({ current: SECRET_A }),
  );
  assert(keys, "the synthetic key set should parse");
  assert(
    discordGalleryIngestActiveKey(keys, "current")?.secret === SECRET_A,
    "the configured active key should be selected",
  );
  assert(
    discordGalleryIngestActiveKey(keys, "missing") === null,
    "an unknown active key should fail closed",
  );
});

Deno.test("gallery ingest signer binds headers to exact body and protocol fields", async () => {
  type HeaderInput = Parameters<
    typeof createDiscordGalleryIngestHeaders
  >[0];
  const overrideFieldsAreNotPublic: Extract<
    keyof HeaderInput,
    "method" | "path"
  > extends never ? true : false = true;
  assert(
    overrideFieldsAreNotPublic,
    "the public signer type must expose no method/path override",
  );
  const keys = parseDiscordGalleryIngestHmacKeys(
    JSON.stringify({ current: SECRET_A }),
  );
  assert(keys, "the synthetic key set should parse");
  const headers = await createDiscordGalleryIngestHeaders({
    keys,
    activeKeyId: "current",
    rawBody: RAW_BODY,
    nowMs: NOW_MS,
    nonce: NONCE,
  });

  assert(
    headers[DISCORD_GALLERY_INGEST_HEADERS.keyId] === "current",
    "the key ID header should match",
  );
  assert(
    headers[DISCORD_GALLERY_INGEST_HEADERS.timestamp] === "1790000000",
    "the timestamp should use Unix seconds",
  );
  assert(
    headers[DISCORD_GALLERY_INGEST_HEADERS.nonce] === NONCE,
    "the nonce should be preserved exactly",
  );
  assert(
    /^v1=[0-9a-f]{64}$/.test(
      headers[DISCORD_GALLERY_INGEST_HEADERS.signature] || "",
    ),
    "the signature header should use v1 HMAC-SHA256",
  );

  const surplusOverrides = await createDiscordGalleryIngestHeaders({
    keys,
    activeKeyId: "current",
    rawBody: RAW_BODY,
    nowMs: NOW_MS,
    nonce: NONCE,
    method: "PUT",
    path: "/other",
  } as unknown as HeaderInput);
  assert(
    surplusOverrides[DISCORD_GALLERY_INGEST_HEADERS.signature] ===
      headers[DISCORD_GALLERY_INGEST_HEADERS.signature],
    "surplus method/path fields must not alter the fixed wire signature",
  );

  const changedBodySignature = await createDiscordGalleryIngestSignature({
    secret: SECRET_A,
    keyId: "current",
    timestamp: "1790000000",
    nonce: NONCE,
    rawBody: `${RAW_BODY} `,
  });
  assert(
    changedBodySignature !==
      headers[DISCORD_GALLERY_INGEST_HEADERS.signature],
    "changing the exact body bytes must change the signature",
  );
});

Deno.test("gallery ingest signer rejects malformed and oversized inputs", async () => {
  for (
    const input of [
      {
        keyId: "INVALID",
        timestamp: "1790000000",
        nonce: NONCE,
        rawBody: RAW_BODY,
      },
      { keyId: "current", timestamp: "0", nonce: NONCE, rawBody: RAW_BODY },
      {
        keyId: "current",
        timestamp: "1790000000",
        nonce: "short",
        rawBody: RAW_BODY,
      },
      {
        keyId: "current",
        timestamp: "1790000000",
        nonce: NONCE,
        rawBody: "x".repeat(DISCORD_GALLERY_INGEST_MAX_BODY_BYTES + 1),
      },
    ]
  ) {
    let failed = false;
    try {
      await createDiscordGalleryIngestSignature({ secret: SECRET_A, ...input });
    } catch {
      failed = true;
    }
    assert(failed, "invalid signature input should fail closed");
  }

  for (const rawBody of [`\uFEFF${RAW_BODY}`, `{"title":"a\uFEFFb"}`]) {
    let failed = false;
    try {
      await createDiscordGalleryIngestSignature({
        secret: SECRET_A,
        keyId: "current",
        timestamp: "1790000000",
        nonce: NONCE,
        rawBody,
      });
    } catch {
      failed = true;
    }
    assert(
      failed,
      "literal leading or embedded U+FEFF must be rejected before HMAC signing",
    );
  }

  const valid = await createDiscordGalleryIngestSignature({
    secret: SECRET_A,
    keyId: "current",
    timestamp: "1790000000",
    nonce: NONCE,
    rawBody: RAW_BODY,
  });
  assert(/^v1=[0-9a-f]{64}$/.test(valid), "valid input should sign");
});
