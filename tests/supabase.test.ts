import { describe, expect, test } from "bun:test";
import {
  DISCORD_GALLERY_INGEST_HEADERS,
  DISCORD_GALLERY_INGEST_MAX_RESPONSE_BYTES,
  DISCORD_GALLERY_INGEST_PATH,
  createDiscordGalleryAuthorizationContext,
  parseDiscordGalleryIngestHmacKeys,
} from "../src/gallery-ingest-auth.js";
import { submitDiscordGalleryImage, type DiscordGalleryPayload } from "../src/supabase.js";
import { SYNTHETIC_DISCORD_IDS, syntheticDiscordAttachmentUrl } from "./discord-fixtures.js";

const authorizationContext = createDiscordGalleryAuthorizationContext({
  guildId: SYNTHETIC_DISCORD_IDS.guild,
  galleryChannelId: SYNTHETIC_DISCORD_IDS.galleryChannel,
  requiredRoleIds: [SYNTHETIC_DISCORD_IDS.roleOne, SYNTHETIC_DISCORD_IDS.roleTwo],
});
if (!authorizationContext) throw new Error("Synthetic Gallery authorization context was rejected.");
const payload: DiscordGalleryPayload = {
  guildId: SYNTHETIC_DISCORD_IDS.guild,
  channelId: SYNTHETIC_DISCORD_IDS.galleryChannel,
  messageId: SYNTHETIC_DISCORD_IDS.message,
  attachmentId: SYNTHETIC_DISCORD_IDS.attachment,
  discordUserId: SYNTHETIC_DISCORD_IDS.member,
  attachmentUrl: syntheticDiscordAttachmentUrl(),
  mimeType: "image/jpeg",
  sizeBytes: 12345,
  originalFilename: "image.jpg",
  title: "Lantern Moment",
  caption: "A quiet gallery submission.",
  instagramOptIn: true,
  authorizationContextVersion: authorizationContext.authorizationContextVersion,
  authorizationContextSha256: authorizationContext.authorizationContextSha256,
};

const secret = "0123456789abcdef0123456789abcdef";
const functionsOrigin = "https://functions.synthetic.test";
const endpoint = `${functionsOrigin}${DISCORD_GALLERY_INGEST_PATH}`;
const keys = parseDiscordGalleryIngestHmacKeys(JSON.stringify({ primary: secret }));
if (!keys) throw new Error("Synthetic Gallery ingest key was rejected.");
const config = {
  supabaseFunctionsUrl: `${functionsOrigin}/functions/v1`,
  discordGuildId: SYNTHETIC_DISCORD_IDS.guild,
  discordGalleryChannelId: SYNTHETIC_DISCORD_IDS.galleryChannel,
  discordGalleryAttachmentOrigins: ["https://cdn.discordapp.com"],
  discordGalleryAuthorizationContext: authorizationContext,
  discordGalleryIngestHmacKeys: keys,
  discordGalleryIngestHmacActiveKeyId: "primary",
};

function responseAt(response: Response, url = endpoint): Response {
  Object.defineProperty(response, "url", { configurable: true, value: url });
  return response;
}
const authInput = {
  nowMs: 1_790_000_000_000,
  nonce: "0123456789abcdef0123456789abcdef",
};

describe("submitDiscordGalleryImage", () => {
  test("posts exact raw JSON with the four current HMAC and replay headers", async () => {
    const requests: Array<{ request: Request; init?: RequestInit }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ request: new Request(input, init), init });

      return responseAt(new Response(JSON.stringify({
        ok: true,
        duplicate: false,
        data: {
          submissionId: null,
          status: "pending",
          createdAt: null,
        },
        message: "Queued.",
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    };

    const response = await submitDiscordGalleryImage(
      config,
      payload,
      fetchImpl,
      authInput,
    );

    expect(response.ok).toBe(true);
    const request = requests[0]?.request;
    expect(request?.url).toBe(endpoint);
    expect(request?.headers.get(DISCORD_GALLERY_INGEST_HEADERS.keyId)).toBe("primary");
    expect(request?.headers.get(DISCORD_GALLERY_INGEST_HEADERS.timestamp)).toBe("1790000000");
    expect(request?.headers.get(DISCORD_GALLERY_INGEST_HEADERS.nonce))
      .toBe("0123456789abcdef0123456789abcdef");
    expect(request?.headers.get(DISCORD_GALLERY_INGEST_HEADERS.signature))
      .toMatch(/^v1=[0-9a-f]{64}$/);
    expect(request?.headers.get("x-mochirii-reaper-secret")).toBeNull();
    expect(await request?.json()).toEqual(payload);
    expect(requests[0]?.init?.redirect).toBe("manual");
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("rejects every malformed request before signing or fetch", async () => {
    const invalid: unknown[] = [
      { ...payload, guildId: `0${SYNTHETIC_DISCORD_IDS.guild}` },
      { ...payload, guildId: SYNTHETIC_DISCORD_IDS.otherGuild },
      { ...payload, channelId: SYNTHETIC_DISCORD_IDS.otherChannel },
      {
        ...payload,
        channelId: SYNTHETIC_DISCORD_IDS.otherChannel,
        attachmentUrl:
          `https://cdn.discordapp.com/attachments/${SYNTHETIC_DISCORD_IDS.otherChannel}/${SYNTHETIC_DISCORD_IDS.attachment}/image.jpg`,
      },
      { ...payload, messageId: "1844674407" + "3709551616" },
      { ...payload, attachmentId: "invalid" },
      { ...payload, discordUserId: " 100000000000000006" },
      {
        ...payload,
        attachmentUrl:
          `https://outside.synthetic.test/attachments/${SYNTHETIC_DISCORD_IDS.galleryChannel}/${SYNTHETIC_DISCORD_IDS.attachment}/image.jpg`,
      },
      { ...payload, attachmentUrl: `${payload.attachmentUrl}#` },
      { ...payload, mimeType: "image/svg+xml" },
      { ...payload, sizeBytes: -1 },
      { ...payload, sizeBytes: 8 * 1024 * 1024 + 1 },
      { ...payload, originalFilename: "image.png" },
      { ...payload, originalFilename: " image.jpg" },
      { ...payload, title: " title" },
      { ...payload, caption: `caption\uFEFF` },
      { ...payload, instagramOptIn: "true" },
      { ...payload, authorizationContextVersion: "v2" },
      { ...payload, authorizationContextSha256: "a".repeat(64) },
      { ...payload, extra: false },
      Object.fromEntries(
        Object.entries(payload).filter(([key]) => key !== "attachmentId"),
      ),
    ];
    let fetchCalls = 0;
    for (const candidate of invalid) {
      await expect(submitDiscordGalleryImage(
        config,
        candidate as DiscordGalleryPayload,
        () => {
          fetchCalls += 1;
          return Promise.resolve(responseAt(Response.json({ ok: true })));
        },
        authInput,
      )).rejects.toThrow(
        "Gallery submission payload did not match the reviewed contract.",
      );
    }
    expect(fetchCalls).toBe(0);
  });

  test("rejects accessor payload fields without reading or signing them", async () => {
    const candidate = { ...payload } as Record<string, unknown>;
    let titleReads = 0;
    Object.defineProperty(candidate, "title", {
      configurable: true,
      enumerable: true,
      get() {
        titleReads += 1;
        return titleReads === 1 ? "Lantern Moment" : " changed";
      },
    });
    let fetchCalls = 0;

    await expect(submitDiscordGalleryImage(
      config,
      candidate as unknown as DiscordGalleryPayload,
      () => {
        fetchCalls += 1;
        return Promise.resolve(responseAt(Response.json({ ok: true })));
      },
      authInput,
    )).rejects.toThrow(
      "Gallery submission payload did not match the reviewed contract.",
    );

    expect(titleReads).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  test("rejects an unreviewed configured attachment origin before fetch", async () => {
    let fetchCalls = 0;
    await expect(submitDiscordGalleryImage(
      {
        ...config,
        discordGalleryAttachmentOrigins: ["https://outside.synthetic.test"],
      },
      {
        ...payload,
        attachmentUrl:
          `https://outside.synthetic.test/attachments/${SYNTHETIC_DISCORD_IDS.galleryChannel}/${SYNTHETIC_DISCORD_IDS.attachment}/image.jpg`,
      },
      () => {
        fetchCalls += 1;
        return Promise.resolve(responseAt(Response.json({ ok: true })));
      },
      authInput,
    )).rejects.toThrow(
      "Gallery submission payload did not match the reviewed contract.",
    );
    expect(fetchCalls).toBe(0);
  });

  test("rejects non-JSON responses and HTTP/body status drift", async () => {
    const cases = [
      responseAt(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })),
      responseAt(Response.json({ ok: true }, { status: 500 })),
      responseAt(Response.json({ ok: false }, { status: 200 })),
    ];

    for (const candidate of cases) {
      const response = await submitDiscordGalleryImage(
        config,
        payload,
        () => Promise.resolve(candidate),
        authInput,
      );
      expect(response).toEqual({
        ok: false,
        error: "invalid_supabase_response",
        message: `Gallery submission returned HTTP ${candidate.status}.`,
      });
    }
  });

  test("rejects redirects and exact response URL drift before accepting JSON", async () => {
    const validBody = {
      ok: true,
      duplicate: false,
      data: { submissionId: null, status: "pending", createdAt: null },
      message: "Queued.",
    };
    const cases = [
      responseAt(new Response(null, {
        status: 302,
        headers: { Location: "https://outside.synthetic.test/collect" },
      })),
      responseAt(
        Response.json(validBody),
        "https://outside.synthetic.test/functions/v1/submit-discord-gallery-image",
      ),
    ];

    for (const candidate of cases) {
      const response = await submitDiscordGalleryImage(
        config,
        payload,
        () => Promise.resolve(candidate),
        authInput,
      );
      expect(response).toEqual({
        ok: false,
        error: "invalid_supabase_response",
        message: `Gallery submission returned HTTP ${candidate.status}.`,
      });
    }
  });

  test("rejects unknown, malformed, nested, array, and oversized response fields", async () => {
    const invalidBodies: Array<{ body: unknown; status: number }> = [
      {
        body: { ok: false, error: "invalid_request", message: { content: "unsafe" } },
        status: 401,
      },
      {
        body: { ok: false, error: "invalid_request", message: ["unsafe"] },
        status: 401,
      },
      {
        body: [{ ok: false, error: "invalid_request", message: "unsafe" }],
        status: 401,
      },
      {
        body: { ok: false, error: { code: "invalid_request" }, message: "unsafe" },
        status: 401,
      },
      {
        body: { ok: false, error: "unknown_error", message: "unsafe" },
        status: 401,
      },
      {
        body: {
          ok: false,
          error: "invalid_request",
          message: "x".repeat(301),
        },
        status: 401,
      },
      {
        body: {
          ok: false,
          error: "invalid_request",
          message: "unsafe",
          extra: "field",
        },
        status: 401,
      },
      {
        body: {
          ok: true,
          duplicate: false,
          data: {
            submissionId: { nested: "value" },
            status: null,
            createdAt: null,
          },
          message: "Queued.",
        },
        status: 200,
      },
      {
        body: {
          ok: true,
          duplicate: false,
          data: [],
          message: "Queued.",
        },
        status: 200,
      },
      {
        body: {
          ok: true,
          duplicate: false,
          data: {
            submissionId: "x".repeat(81),
            status: "pending",
            createdAt: null,
          },
          message: "Queued.",
        },
        status: 200,
      },
    ];

    for (const candidate of invalidBodies) {
      const response = await submitDiscordGalleryImage(
        config,
        payload,
        () => Promise.resolve(responseAt(Response.json(candidate.body, {
          status: candidate.status,
        }))),
        authInput,
      );
      expect(response).toEqual({
        ok: false,
        error: "invalid_supabase_response",
        message: `Gallery submission returned HTTP ${candidate.status}.`,
      });
    }
  });

  test("preserves a bounded, consistent JSON error response", async () => {
    const response = await submitDiscordGalleryImage(
      config,
      payload,
      () => Promise.resolve(responseAt(Response.json({
        ok: false,
        error: "invalid_request",
        message: "Review <@everyone> before retrying.",
      }, { status: 401 }))),
      authInput,
    );

    expect(response).toEqual({
      ok: false,
      error: "invalid_request",
      message: "Review <@everyone> before retrying.",
    });
  });

  test("accepts the exact bounded Website eligibility error shape", async () => {
    const response = await submitDiscordGalleryImage(
      config,
      payload,
      () => Promise.resolve(responseAt(Response.json({
        ok: false,
        error: "discord_gallery_not_eligible",
        missingRoleIds: [
          SYNTHETIC_DISCORD_IDS.roleOne,
          SYNTHETIC_DISCORD_IDS.roleTwo,
        ],
        message: "Refresh Discord verification before submitting.",
      }, { status: 403 }))),
      authInput,
    );

    expect(response).toEqual({
      ok: false,
      error: "discord_gallery_not_eligible",
      missingRoleIds: [
        SYNTHETIC_DISCORD_IDS.roleOne,
        SYNTHETIC_DISCORD_IDS.roleTwo,
      ],
      message: "Refresh Discord verification before submitting.",
    });
  });

  test("cancels a chunked JSON response above 64 KiB", async () => {
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          `{"ok":true,"padding":"${"x".repeat(DISCORD_GALLERY_INGEST_MAX_RESPONSE_BYTES)}"}`,
        ));
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = await submitDiscordGalleryImage(
      config,
      payload,
      () => Promise.resolve(responseAt(new Response(oversized, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))),
      authInput,
    );

    expect(response).toEqual({
      ok: false,
      error: "invalid_supabase_response",
      message: "Gallery submission returned HTTP 200.",
    });
    expect(cancelled).toBe(true);
  });

  test("aborts a stalled response-body read through the request signal", async () => {
    let cancelled = false;
    const stalled = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const controller = new AbortController();
    const pending = submitDiscordGalleryImage(
      config,
      payload,
      () => Promise.resolve(responseAt(new Response(stalled, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }))),
      { ...authInput, signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();
    const response = await pending;
    await Promise.resolve();

    expect(response).toEqual({
      ok: false,
      error: "invalid_supabase_response",
      message: "Gallery submission returned HTTP 200.",
    });
    expect(controller.signal.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  test("propagates an abort signal while the fetch stage is pending", async () => {
    const controller = new AbortController();
    const observation: { signal?: AbortSignal } = {};
    const pending = submitDiscordGalleryImage(
      config,
      payload,
      (_input, init) => new Promise((_resolve, reject) => {
        observation.signal = init?.signal || undefined;
        if (!observation.signal) {
          reject(new Error("missing request signal"));
          return;
        }
        observation.signal.addEventListener("abort", () => {
          reject(observation.signal?.reason || new Error("request aborted"));
        }, { once: true });
      }),
      { ...authInput, signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort(new Error("synthetic request abort"));

    await expect(pending).rejects.toThrow("synthetic request abort");
    expect(observation.signal).toBe(controller.signal);
  });
});
