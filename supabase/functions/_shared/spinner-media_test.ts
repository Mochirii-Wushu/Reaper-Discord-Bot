import {
  animationManifestHash,
  buildAnimationManifest,
  createSpinnerMediaToken,
  parseAnimationManifest,
  SPINNER_MEDIA_DURATION_MS,
  SPINNER_MEDIA_MAX_MP4_BYTES,
  SPINNER_MEDIA_MAX_PNG_BYTES,
  spinnerMediaFilename,
  spinnerMediaTokenHash,
  validateSpinnerMedia,
  verifySpinnerMediaToken,
  wheelSegmentLabel,
} from "./spinner-media.ts";
import type {
  DrawReceiptV1,
  ParticipantV1,
} from "./spinner-consumer-contract.ts";
import {
  attachSpinnerMedia,
  createJobCapability,
} from "./spinner-media-dispatch.ts";
import type { DiscordFetchResult } from "./discord-api.ts";

const participants: ParticipantV1[] = [
  {
    version: 1,
    id: "11111111-1111-4111-8111-111111111111",
    displayName: "月影",
  },
  {
    version: 1,
    id: "22222222-2222-4222-8222-222222222222",
    displayName: "Lotus 🌸",
  },
];

Deno.test("animation manifest is deterministic, numbered, and validates exactly", async () => {
  const receipt: DrawReceiptV1 = {
    version: 1,
    drawMode: "official",
    drawId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    timestampIso: "2026-07-27T01:00:00.000Z",
    singaporeTime: "2026-07-27 09:00:00 SGT",
    appVersion: "test",
    algorithmVersion: "test",
    rosterSnapshot: { version: 1, participants },
    rosterHashSha256: "a".repeat(64),
    rejectionLimit: 4_294_967_296,
    sampledWords: [1],
    acceptedWord: 1,
    selectedIndex: 1,
    winner: participants[1],
  };
  const manifest = await buildAnimationManifest(receipt, {
    startAt: "2026-07-27T01:00:00.000Z",
    revealAt: "2026-07-27T01:00:04.800Z",
    startRotation: 0,
    finalRotation: 4_050,
  });
  assertEquals(manifest.durationMs, SPINNER_MEDIA_DURATION_MS);
  assertEquals(manifest.participants.map(({ number }) => number), [1, 2]);
  assertEquals(manifest.participants, [
    { version: 1, number: 1, label: "1. 月影" },
    { version: 1, number: 2, label: "2. Lotus 🌸" },
  ]);
  assertEquals(manifest.winner, {
    version: 1,
    number: 2,
    displayName: "Lotus 🌸",
  });
  assertEquals(parseAnimationManifest(manifest), manifest);
  assertEquals(
    await animationManifestHash(manifest),
    await animationManifestHash({ ...manifest }),
  );
  assertEquals(parseAnimationManifest({ ...manifest, selectedIndex: 0 }), null);
});

Deno.test("wheel labels share Unicode-safe page truncation", () => {
  assertEquals(
    wheelSegmentLabel("ABCDEFGHIJKLMNO🌸PQRS", 20, 0),
    "1. ABCDEFGHIJKLMNO🌸PQ…",
  );
  assertEquals(
    wheelSegmentLabel("一二三四五六七八九十甲乙丙丁戊己庚辛壬癸", 21, 20),
    "21. 一二三四五六七八九十甲乙丙…",
  );
  assertEquals(wheelSegmentLabel("A👨‍👩‍👧‍👦BCDEFG", 73, 72), "73. A👨‍👩‍👧‍👦BCDE…");
});

Deno.test("media capability is signed, bound, expiring, and hashable", async () => {
  const payload = {
    version: 1 as const,
    jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    manifestHashSha256: "a".repeat(64),
    expiresAt: 2_000,
  };
  const token = await createSpinnerMediaToken(payload, "test-only-secret");
  assertEquals(
    await verifySpinnerMediaToken(token, "test-only-secret", 1_999),
    payload,
  );
  assertEquals(
    await verifySpinnerMediaToken(token, "wrong-secret", 1_999),
    null,
  );
  assertEquals(
    await verifySpinnerMediaToken(token, "test-only-secret", 2_000),
    null,
  );
  assertEquals((await spinnerMediaTokenHash(token)).length, 64);
});

Deno.test("job capability uses a bounded twenty-minute lease", async () => {
  const capability = await createJobCapability(
    {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      manifest_hash_sha256: "b".repeat(64),
    },
    "test-only-secret",
    new Date("2026-07-27T01:00:00.000Z"),
  );
  assertEquals(capability.expiresAt, "2026-07-27T01:20:00.000Z");
  assertEquals(capability.tokenHashSha256.length, 64);
});

Deno.test("media validation enforces platform-safe byte ceilings and signatures", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const mp4 = new Uint8Array([
    0,
    0,
    0,
    12,
    0x66,
    0x74,
    0x79,
    0x70,
    0x69,
    0x73,
    0x6f,
    0x6d,
  ]);
  assertEquals(validateSpinnerMedia("image/png", png).ok, true);
  assertEquals(validateSpinnerMedia("video/mp4", mp4).ok, true);
  assertEquals(validateSpinnerMedia("text/plain", png), {
    ok: false,
    reason: "invalid_type",
  });
  assertEquals(
    validateSpinnerMedia(
      "image/png",
      new Uint8Array(SPINNER_MEDIA_MAX_PNG_BYTES + 1),
    ),
    {
      ok: false,
      reason: "too_large",
    },
  );
  assertEquals(
    validateSpinnerMedia(
      "video/mp4",
      new Uint8Array(SPINNER_MEDIA_MAX_MP4_BYTES + 1),
    ),
    {
      ok: false,
      reason: "too_large",
    },
  );
  assertEquals(
    spinnerMediaFilename("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "png"),
    "mochirii-raffle-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png",
  );
});

Deno.test("a successful upload with a lost response is reconciled without posting twice", async () => {
  const filename = "mochirii-raffle-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.png";
  const fallbackClaimToken = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const calls: string[] = [];
  const finishes: unknown[] = [];
  const result = await attachSpinnerMedia(
    {
      draw_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      attachment_attempt_count: 1,
    },
    "image/png",
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    {
      uuid: () => fallbackClaimToken,
      reserve: (fields) =>
        Promise.resolve(
          fields.claimToken === fallbackClaimToken
            ? {
              ok: true,
              alreadyAttached: false,
              channelId: "900000000000000011",
              messageId: "900000000000000017",
            }
            : null,
        ),
      discordFetch: (path, options) => {
        calls.push(`${options.method} ${path}`);
        return Promise.resolve(discordResult(200, {
          attachments: [{ id: "900000000000000018", filename }],
        }));
      },
      finish: (_claim, outcome, fields) => {
        finishes.push({ outcome, fields });
        return Promise.resolve(true);
      },
    },
  );
  assertEquals(result, { ok: true, outcome: "reconciled" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].startsWith("GET "), true);
  assertEquals(finishes, [{
    outcome: "attached",
    fields: { attachmentId: "900000000000000018" },
  }]);
});

Deno.test("media stays retryable when the winner message is not ready", async () => {
  let discordCalled = false;
  const result = await attachSpinnerMedia(
    {
      draw_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      attachment_attempt_count: 0,
    },
    "video/mp4",
    new Uint8Array([
      0,
      0,
      0,
      12,
      0x66,
      0x74,
      0x79,
      0x70,
      0x69,
      0x73,
      0x6f,
      0x6d,
    ]),
    {
      reserve: () => Promise.resolve(null),
      discordFetch: () => {
        discordCalled = true;
        return Promise.resolve(discordResult(500, null));
      },
      finish: () => Promise.resolve(false),
    },
  );
  assertEquals(result, { ok: false, outcome: "not_ready" });
  assertEquals(discordCalled, false);
});

Deno.test("valid PNG and MP4 media append through one same-message multipart edit", async () => {
  const cases = [
    {
      mediaType: "image/png",
      extension: "png",
      bytes: new Uint8Array([
        0x89,
        0x50,
        0x4e,
        0x47,
        0x0d,
        0x0a,
        0x1a,
        0x0a,
      ]),
    },
    {
      mediaType: "video/mp4",
      extension: "mp4",
      bytes: new Uint8Array([
        0,
        0,
        0,
        12,
        0x66,
        0x74,
        0x79,
        0x70,
        0x69,
        0x73,
        0x6f,
        0x6d,
      ]),
    },
  ] as const;

  for (const testCase of cases) {
    const filename =
      `mochirii-raffle-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.${testCase.extension}`;
    const calls: string[] = [];
    const finishes: unknown[] = [];
    const result = await attachSpinnerMedia(
      {
        draw_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        attachment_attempt_count: 0,
      },
      testCase.mediaType,
      testCase.bytes,
      {
        uuid: () => "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        reserve: (fields) => {
          assertEquals(fields.mediaType, testCase.mediaType);
          assertEquals(fields.filename, filename);
          return Promise.resolve({
            ok: true,
            alreadyAttached: false,
            channelId: "900000000000000011",
            messageId: "900000000000000017",
          });
        },
        discordFetch: (_path, options) => {
          calls.push(options.method);
          if (options.method === "GET") {
            return Promise.resolve(discordResult(200, {
              attachments: [{
                id: "900000000000000019",
                filename: "existing-keepsake.png",
              }],
            }));
          }
          if (!(options.body instanceof FormData)) {
            throw new Error("Expected a multipart message edit.");
          }
          const payload = JSON.parse(
            String(options.body.get("payload_json") || "{}"),
          );
          assertEquals(payload.allowed_mentions, {
            parse: [],
            users: [],
            roles: [],
            replied_user: false,
          });
          assertEquals(payload.attachments, [
            {
              id: "900000000000000019",
              filename: "existing-keepsake.png",
            },
            {
              id: 0,
              filename,
              description: "Mōchirīī raffle replay",
            },
          ]);
          const upload = options.body.get("files[0]");
          if (!(upload instanceof Blob)) {
            throw new Error("Expected the replay attachment.");
          }
          assertEquals(upload.type, testCase.mediaType);
          return Promise.resolve(discordResult(200, {
            attachments: [
              {
                id: "900000000000000019",
                filename: "existing-keepsake.png",
              },
              { id: "900000000000000018", filename },
            ],
          }));
        },
        finish: (_claim, outcome, fields) => {
          finishes.push({ outcome, fields });
          return Promise.resolve(true);
        },
      },
    );
    assertEquals(result, { ok: true, outcome: "attached" });
    assertEquals(calls, ["GET", "PATCH"]);
    assertEquals(finishes, [{
      outcome: "attached",
      fields: { attachmentId: "900000000000000018" },
    }]);
  }
});

Deno.test("message lookup 429 honors the longest bounded retry delay", async () => {
  const finishes: unknown[] = [];
  const now = new Date("2026-07-27T01:00:00.000Z");
  const result = await attachSpinnerMedia(
    {
      draw_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      attachment_attempt_count: 0,
    },
    "image/png",
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    {
      now: () => now,
      reserve: () =>
        Promise.resolve({
          ok: true,
          alreadyAttached: false,
          channelId: "900000000000000011",
          messageId: "900000000000000017",
        }),
      discordFetch: () =>
        Promise.resolve(discordResult(429, null, {
          headers: { "Retry-After": "65" },
          error: { retry_after: 2.5 },
        })),
      finish: (_claim, outcome, fields) => {
        finishes.push({ outcome, fields });
        return Promise.resolve(true);
      },
    },
  );
  assertEquals(result, { ok: false, outcome: "retry" });
  assertEquals(finishes, [{
    outcome: "retry",
    fields: {
      errorCode: "message_lookup_429",
      retryAt: "2026-07-27T01:01:05.000Z",
    },
  }]);
});

Deno.test("media upload 429 honors the JSON retry delay", async () => {
  const finishes: unknown[] = [];
  const now = new Date("2026-07-27T01:00:00.000Z");
  let requestCount = 0;
  const result = await attachSpinnerMedia(
    {
      draw_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      attachment_attempt_count: 1,
    },
    "image/png",
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    {
      now: () => now,
      reserve: () =>
        Promise.resolve({
          ok: true,
          alreadyAttached: false,
          channelId: "900000000000000011",
          messageId: "900000000000000017",
        }),
      discordFetch: () => {
        requestCount += 1;
        return Promise.resolve(
          requestCount === 1
            ? discordResult(200, { attachments: [] })
            : discordResult(429, null, { error: { retry_after: 2.5 } }),
        );
      },
      finish: (_claim, outcome, fields) => {
        finishes.push({ outcome, fields });
        return Promise.resolve(true);
      },
    },
  );
  assertEquals(result, { ok: false, outcome: "retry" });
  assertEquals(finishes, [{
    outcome: "retry",
    fields: {
      errorCode: "media_upload_429",
      retryAt: "2026-07-27T01:00:02.500Z",
    },
  }]);
});

Deno.test("a deleted winner message ends attachment work without retrying", async () => {
  const finishes: unknown[] = [];
  const result = await attachSpinnerMedia(
    {
      draw_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      attachment_attempt_count: 0,
    },
    "image/png",
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    {
      reserve: () =>
        Promise.resolve({
          ok: true,
          alreadyAttached: false,
          channelId: "900000000000000011",
          messageId: "900000000000000017",
        }),
      discordFetch: () => Promise.resolve(discordResult(404, null)),
      finish: (_claim, outcome, fields) => {
        finishes.push({ outcome, fields });
        return Promise.resolve(true);
      },
    },
  );
  assertEquals(result, { ok: false, outcome: "fatal" });
  assertEquals(finishes, [{
    outcome: "fatal",
    fields: { errorCode: "message_lookup_404" },
  }]);
});

Deno.test("malformed media never reserves or mutates attachment state", async () => {
  const calls: string[] = [];
  const result = await attachSpinnerMedia(
    {
      draw_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      attachment_attempt_count: 0,
    },
    "image/png",
    new Uint8Array([0x89, 0x50, 0x4e]),
    {
      reserve: () => {
        calls.push("reserve");
        return Promise.resolve(null);
      },
      discordFetch: () => {
        calls.push("discord");
        return Promise.resolve(discordResult(500, null));
      },
      finish: () => {
        calls.push("finish");
        return Promise.resolve(false);
      },
    },
  );
  assertEquals(result, { ok: false, outcome: "invalid_signature" });
  assertEquals(calls, []);
});

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

function discordResult(
  status: number,
  data: unknown,
  options: { headers?: HeadersInit; error?: unknown } = {},
): DiscordFetchResult {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    data,
    error: status >= 200 && status < 300 ? null : options.error ?? {},
    headers: new Headers(options.headers),
  };
}
