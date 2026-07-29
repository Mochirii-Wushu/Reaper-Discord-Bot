import { withProtectedCors } from "../_shared/cors.ts";
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { discordFetch, type JsonRecord } from "../_shared/discord-api.ts";
import {
  constantTimeSecretEqual,
  dispatchSpinnerOutboxRow,
  readBoundedJsonObject,
  spinnerDispatcherSecret,
  type SpinnerOutboxRow,
} from "../_shared/spinner-discord-outbox.ts";
import {
  attachSpinnerMedia,
  createJobCapability,
  recreateJobCapability,
  type SpinnerMediaJobRow,
} from "../_shared/spinner-media-dispatch.ts";
import {
  animationManifestHash,
  parseAnimationManifest,
  SPINNER_MEDIA_MAX_MP4_BYTES,
  SPINNER_MEDIA_MAX_PNG_BYTES,
  spinnerMediaTokenHash,
  validateSpinnerMedia,
  verifySpinnerMediaToken,
} from "../_shared/spinner-media.ts";
import {
  DISCORD_RAFFLE_CHANNEL_ID as SPINNER_DISCORD_CHANNEL_ID,
  runtimeProfileReady,
  siteUrl,
  unavailableResponse,
} from "../_shared/runtime-config.ts";
import { SPINNER_DISCORD_CHANNEL_KEY } from "../_shared/spinner-consumer-contract.ts";
import { getServiceRoleKey } from "../_shared/supabase-service-role.ts";

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

const MEDIA_TOKEN_HEADER = "x-mochirii-spinner-media-capability";
const MEDIA_RENDER_URL = siteUrl("spinner/media/render");
const RENDER_TIMEOUT_MS = 55_000;

Deno.serve((req: Request) =>
  runtimeProfileReady("reaper-spinner-dispatch")
    ? withProtectedCors(req, handleRequest(req))
    : unavailableResponse()
);

async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return privateJson({ ok: true });
  if (req.method !== "POST") return opaqueDenied();

  const dispatchSecret =
    Deno.env.get("REAPER_SPINNER_DISPATCH_SECRET")?.trim() || "";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")?.trim() || "";
  const serviceRoleKey = getServiceRoleKey();
  if (
    dispatchSecret.length < 32 || dispatchSecret.length > 512 ||
    !supabaseUrl || !serviceRoleKey
  ) return opaqueDenied();

  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const capability = req.headers.get(MEDIA_TOKEN_HEADER)?.trim() || "";
  if (capability) {
    const mediaType = (req.headers.get("content-type") || "").split(";", 1)[0]
      .trim().toLowerCase();
    if (mediaType !== "application/json") return opaqueDenied();
    const actionBody = await readBoundedJsonObject(req);
    if (!actionBody.ok || actionBody.value.action !== "manifest") {
      return opaqueDenied();
    }
    return handleManifestCapability(dispatchSecret, adminClient, capability);
  }

  if (
    !await constantTimeSecretEqual(spinnerDispatcherSecret(req), dispatchSecret)
  ) {
    return opaqueDenied();
  }

  const configuredChannelId =
    Deno.env.get("DISCORD_RAFFLE_CHANNEL_ID")?.trim() || "";
  const botToken = Deno.env.get("DISCORD_BOT_TOKEN")?.trim() || "";
  if (configuredChannelId !== SPINNER_DISCORD_CHANNEL_ID || !botToken) {
    console.error("reaper-spinner-dispatch delivery configuration mismatch", {
      channelConfigMatches: configuredChannelId === SPINNER_DISCORD_CHANNEL_ID,
      hasBotToken: Boolean(botToken),
    });
    return privateJson({
      ok: false,
      message: "Raffle delivery is not configured.",
    }, 500);
  }

  const bodyResult = await readBoundedJsonObject(req);
  if (!bodyResult.ok) return privateJson({ ok: false }, bodyResult.status);
  const requestedLimit = Number(bodyResult.value.limit ?? 10);
  const limit = Number.isSafeInteger(requestedLimit) && requestedLimit >= 1 &&
      requestedLimit <= 10
    ? requestedLimit
    : 10;

  const delivery = await dispatchPrimaryOutbox(adminClient, limit);
  const provisioned = await provisionMediaJobs(
    adminClient,
    dispatchSecret,
    Math.min(limit, 5),
  );
  const fallback = await provisionFallbackMediaJobs(
    adminClient,
    dispatchSecret,
    Math.min(limit, 5),
  );

  return privateJson({
    ok: delivery.ok,
    data: {
      channelKey: SPINNER_DISCORD_CHANNEL_KEY,
      claimed: delivery.claimed,
      completed: delivery.completed,
      retried: delivery.retried,
      failed: delivery.failed,
      results: delivery.results,
      mediaProvisioned: provisioned,
      mediaFallbacks: fallback,
    },
  }, delivery.ok ? 200 : 503);
}

async function dispatchPrimaryOutbox(
  adminClient: SupabaseClient,
  limit: number,
) {
  const claimToken = crypto.randomUUID();
  const { data, error } = await adminClient.rpc(
    "spinner_claim_discord_outbox",
    {
      p_claim_token: claimToken,
      p_limit: limit,
    },
  );
  if (error) {
    console.error("reaper-spinner-dispatch outbox claim failed", {
      code: error.code,
    });
    return {
      ok: false,
      claimed: 0,
      completed: 0,
      retried: 0,
      failed: 0,
      results: [],
    };
  }
  const claimed = Array.isArray(data) ? data as SpinnerOutboxRow[] : [];
  const outcomes: string[] = [];
  const results: Array<{ id: string; drawId: string; outcome: string }> = [];
  for (const row of claimed) {
    const result = await dispatchSpinnerOutboxRow(row, {
      discordFetch: (path, options) => discordFetch(path, options),
      finishClaim: async (claimedRow, outcome, fields = {}) => {
        const completion = await adminClient.rpc(
          "spinner_finish_discord_outbox_claim",
          {
            p_id: claimedRow.id,
            p_claim_token: claimToken,
            p_outcome: outcome,
            p_message_id: fields.messageId || null,
            p_error_code: fields.errorCode || null,
            p_retry_at: fields.retryAt || null,
          },
        );
        if (completion.error) {
          console.error("reaper-spinner-dispatch outbox completion failed", {
            code: completion.error.code,
            outcome,
          });
          return false;
        }
        return completion.data === true;
      },
    });
    outcomes.push(result.outcome);
    results.push({ id: row.id, drawId: row.draw_id, outcome: result.outcome });
  }
  return {
    ok: true,
    claimed: claimed.length,
    completed:
      outcomes.filter((outcome) =>
        outcome === "start_sent" || outcome === "result_sent"
      ).length,
    retried: outcomes.filter((outcome) => outcome === "retry").length,
    failed:
      outcomes.filter((outcome) =>
        outcome === "fatal" || outcome === "claim_lost"
      ).length,
    results,
  };
}

async function provisionMediaJobs(
  adminClient: SupabaseClient,
  dispatchSecret: string,
  limit: number,
): Promise<number> {
  const claimToken = crypto.randomUUID();
  const { data, error } = await adminClient.rpc("spinner_claim_media_jobs", {
    p_claim_token: claimToken,
    p_mode: "dispatch",
    p_limit: limit,
  });
  if (error) {
    console.error("reaper-spinner-dispatch media claim failed", {
      code: error.code,
    });
    return 0;
  }
  const jobs = Array.isArray(data) ? data as SpinnerMediaJobRow[] : [];
  let provisioned = 0;
  for (const job of jobs) {
    const capability = await createJobCapability(job, dispatchSecret);
    const bound = await adminClient.rpc("spinner_bind_media_capability", {
      p_id: job.id,
      p_claim_token: claimToken,
      p_token_hash_sha256: capability.tokenHashSha256,
      p_expires_at: capability.expiresAt,
    });
    if (bound.error || bound.data !== true) continue;
    provisioned += 1;
    scheduleMediaBackgroundTask(
      renderAndAttach(adminClient, job, capability.token),
    );
  }
  return provisioned;
}

function scheduleMediaBackgroundTask(task: Promise<void>): void {
  EdgeRuntime.waitUntil(task.catch(() => undefined));
}

async function renderAndAttach(
  adminClient: SupabaseClient,
  job: SpinnerMediaJobRow,
  token: string,
  existingClaimToken?: string,
): Promise<void> {
  const media = await requestRenderedMedia(token);
  if (!media) return;
  await attachWithAdminClient(
    adminClient,
    job,
    token,
    media.mediaType,
    media.bytes,
    existingClaimToken,
  );
}

async function provisionFallbackMediaJobs(
  adminClient: SupabaseClient,
  dispatchSecret: string,
  limit: number,
): Promise<number> {
  const claimToken = crypto.randomUUID();
  const { data, error } = await adminClient.rpc("spinner_claim_media_jobs", {
    p_claim_token: claimToken,
    p_mode: "fallback",
    p_limit: limit,
  });
  if (error) {
    console.error("reaper-spinner-dispatch fallback claim failed", {
      code: error.code,
    });
    return 0;
  }
  const jobs = Array.isArray(data) ? data as SpinnerMediaJobRow[] : [];
  let provisioned = 0;
  for (const job of jobs) {
    let token = await recreateJobCapability(job, dispatchSecret);
    if (!token) {
      const refreshed = await createJobCapability(job, dispatchSecret);
      const bound = await adminClient.rpc("spinner_bind_media_capability", {
        p_id: job.id,
        p_claim_token: claimToken,
        p_token_hash_sha256: refreshed.tokenHashSha256,
        p_expires_at: refreshed.expiresAt,
      });
      if (bound.error || bound.data !== true) continue;
      token = refreshed.token;
    }
    provisioned += 1;
    scheduleMediaBackgroundTask(
      renderAndAttach(adminClient, job, token, claimToken),
    );
  }
  return provisioned;
}

async function requestRenderedMedia(
  token: string,
): Promise<{ mediaType: "image/png" | "video/mp4"; bytes: Uint8Array } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    const response = await fetch(MEDIA_RENDER_URL, {
      method: "POST",
      cache: "no-store",
      headers: { [MEDIA_TOKEN_HEADER]: token },
      signal: controller.signal,
    });
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]
      .trim().toLowerCase();
    if (
      !response.ok || (mediaType !== "image/png" && mediaType !== "video/mp4")
    ) return null;
    const limit = mediaType === "image/png"
      ? SPINNER_MEDIA_MAX_PNG_BYTES
      : SPINNER_MEDIA_MAX_MP4_BYTES;
    const bytes = await readBoundedBytes(response, limit);
    return bytes && validateSpinnerMedia(mediaType, bytes).ok
      ? { mediaType, bytes }
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function handleManifestCapability(
  dispatchSecret: string,
  adminClient: SupabaseClient,
  token: string,
): Promise<Response> {
  const payload = await verifySpinnerMediaToken(token, dispatchSecret);
  if (!payload) return opaqueDenied();
  const tokenHash = await spinnerMediaTokenHash(token);

  const { data, error } = await adminClient.rpc(
    "spinner_authorize_media_manifest",
    {
      p_id: payload.jobId,
      p_token_hash_sha256: tokenHash,
    },
  );
  const row = !error && Array.isArray(data)
    ? data[0] as JsonRecord | undefined
    : undefined;
  const manifest = parseAnimationManifest(row?.animation_manifest);
  if (
    !manifest || row?.manifest_hash_sha256 !== payload.manifestHashSha256 ||
    await animationManifestHash(manifest) !== payload.manifestHashSha256
  ) return opaqueDenied();
  return privateJson({ ok: true, data: { manifest } });
}

async function attachWithAdminClient(
  adminClient: SupabaseClient,
  job: SpinnerMediaJobRow,
  token: string,
  mediaType: string,
  bytes: Uint8Array,
  existingClaimToken?: string,
) {
  const tokenHash = await spinnerMediaTokenHash(token);
  return attachSpinnerMedia(job, mediaType, bytes, {
    reserve: async (fields) => {
      const result = await adminClient.rpc("spinner_reserve_media_attachment", {
        p_id: job.id,
        p_token_hash_sha256: tokenHash,
        p_claim_token: fields.claimToken,
        p_media_type: fields.mediaType,
        p_size_bytes: fields.sizeBytes,
        p_media_sha256: fields.mediaSha256,
        p_filename: fields.filename,
      });
      return result.error ? null : result.data as JsonRecord;
    },
    finish: async (attachmentClaim, outcome, fields = {}) => {
      const result = await adminClient.rpc("spinner_finish_media_attachment", {
        p_id: job.id,
        p_claim_token: attachmentClaim,
        p_outcome: outcome,
        p_attachment_id: fields.attachmentId || null,
        p_error_code: fields.errorCode || null,
        p_retry_at: fields.retryAt || null,
      });
      return !result.error && result.data === true;
    },
    discordFetch: (path, options) => discordFetch(path, options),
    ...(existingClaimToken ? { uuid: () => existingClaimToken } : {}),
  });
}

async function readBoundedBytes(
  source: Request | Response,
  limit: number,
): Promise<Uint8Array | null> {
  const declared = source.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    return null;
  }
  if (!source.body) return null;
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (total < 1) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function privateHeaders(contentType?: string): HeadersInit {
  return {
    "Cache-Control": "private, no-store, max-age=0",
    ...(contentType ? { "Content-Type": contentType } : {}),
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
  };
}

function opaqueDenied(): Response {
  return new Response(null, { status: 404, headers: privateHeaders() });
}

function privateJson(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: privateHeaders("application/json; charset=utf-8"),
  });
}
