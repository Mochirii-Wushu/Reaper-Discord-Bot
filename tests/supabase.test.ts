import { describe, expect, test } from "bun:test";
import {
  DISCORD_GALLERY_INGEST_HEADERS,
  DISCORD_GALLERY_INGEST_MAX_RESPONSE_BYTES,
  DISCORD_GALLERY_INGEST_ORIGIN,
  parseDiscordGalleryIngestHmacKeys,
} from "../src/gallery-ingest-auth.js";
import { submitDiscordGalleryImage, type DiscordGalleryPayload } from "../src/supabase.js";
import { SYNTHETIC_DISCORD_IDS, syntheticDiscordAttachmentUrl } from "./discord-fixtures.js";

const payload: DiscordGalleryPayload = {
  guildId: SYNTHETIC_DISCORD_IDS.guild,
  channelId: SYNTHETIC_DISCORD_IDS.galleryChannel,
  messageId: SYNTHETIC_DISCORD_IDS.message,
  attachmentId: SYNTHETIC_DISCORD_IDS.attachment,
  discordUserId: SYNTHETIC_DISCORD_IDS.member,
  attachmentUrl: syntheticDiscordAttachmentUrl(),
  mimeType: "image/jpeg",
  sizeBytes: 12345,
  title: "Lantern Moment",
  caption: "A quiet gallery submission.",
  instagramOptIn: true,
  originalFilename: "image.jpg",
};

const secret = "0123456789abcdef0123456789abcdef";
const keys = parseDiscordGalleryIngestHmacKeys(JSON.stringify({ primary: secret }));
if (!keys) throw new Error("Synthetic Gallery ingest key was rejected.");
const config = {
  supabaseFunctionsUrl: `${DISCORD_GALLERY_INGEST_ORIGIN}/functions/v1`,
  discordGalleryIngestHmacKeys: keys,
  discordGalleryIngestHmacActiveKeyId: "primary",
};
const authInput = {
  nowMs: 1_790_000_000_000,
  nonce: "0123456789abcdef0123456789abcdef",
};

describe("submitDiscordGalleryImage", () => {
  test("posts exact raw JSON with the four current HMAC and replay headers", async () => {
    const requests: Array<{ request: Request; init?: RequestInit }> = [];
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ request: new Request(input, init), init });

      return new Response(JSON.stringify({
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
      });
    };

    const response = await submitDiscordGalleryImage(
      config,
      payload,
      fetchImpl,
      authInput,
    );

    expect(response.ok).toBe(true);
    const request = requests[0]?.request;
    expect(request?.url).toBe("https://deyvmtncimmcinldjyqe.supabase.co/functions/v1/submit-discord-gallery-image");
    expect(request?.headers.get(DISCORD_GALLERY_INGEST_HEADERS.keyId)).toBe("primary");
    expect(request?.headers.get(DISCORD_GALLERY_INGEST_HEADERS.timestamp)).toBe("1790000000");
    expect(request?.headers.get(DISCORD_GALLERY_INGEST_HEADERS.nonce))
      .toBe("0123456789abcdef0123456789abcdef");
    expect(request?.headers.get(DISCORD_GALLERY_INGEST_HEADERS.signature))
      .toMatch(/^v1=[0-9a-f]{64}$/);
    expect(request?.headers.get("x-mochirii-reaper-secret")).toBeNull();
    expect(await request?.json()).toEqual(payload);
    expect(requests[0]?.init?.redirect).toBe("error");
    expect(requests[0]?.init?.signal).toBeInstanceOf(AbortSignal);
  });

  test("rejects non-JSON responses and HTTP/body status drift", async () => {
    const cases = [
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
      Response.json({ ok: true }, { status: 500 }),
      Response.json({ ok: false }, { status: 200 }),
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
        () => Promise.resolve(Response.json(candidate.body, {
          status: candidate.status,
        })),
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
      () => Promise.resolve(Response.json({
        ok: false,
        error: "invalid_request",
        message: "Review <@everyone> before retrying.",
      }, { status: 401 })),
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
      () => Promise.resolve(Response.json({
        ok: false,
        error: "discord_gallery_not_eligible",
        missingRoleIds: [
          SYNTHETIC_DISCORD_IDS.roleOne,
          SYNTHETIC_DISCORD_IDS.roleTwo,
        ],
        message: "Refresh Discord verification before submitting.",
      }, { status: 403 })),
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
      () => Promise.resolve(new Response(oversized, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
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
      () => Promise.resolve(new Response(stalled, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })),
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
