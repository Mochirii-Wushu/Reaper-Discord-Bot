import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import {
  applyPendingContainmentPlan,
  asArray,
  asRecord,
  buildSingleMemberPendingContainmentPlan,
  DISCORD_MEMBER_OVERWRITE_TYPE,
  type JsonRecord,
  logPendingContainmentSync,
  MAX_PENDING_VERIFICATION_MUTATIONS,
  memberUserId,
  pendingChannelId,
  PendingContainmentApplyError,
  type PendingContainmentChange,
  type PendingContainmentPlan,
  safeString,
  snowflake,
  type SupabaseAdminClient,
  wait,
} from "../_shared/pending-verification-containment.ts";
import { SITE_ORIGIN } from "../_shared/public-origins.ts";
import {
  DISCORD_GUILD_ID as EXPECTED_DISCORD_GUILD_ID,
  runtimeProfileReady,
  unavailableResponse,
} from "../_shared/runtime-config.ts";
import { constantTimeSecretEqual } from "../_shared/secret-auth.ts";
import { getServiceRoleKey } from "../_shared/supabase-service-role.ts";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_API_USER_AGENT =
  `Mochirii-Reaper-MemberSync/1.0 (${SITE_ORIGIN})`;
const PENDING_VERIFICATION_AUDIT_REASON =
  "Reaper pending verification containment";
const MEMBER_SYNC_SECRET_HEADER = "x-mochirii-reaper-member-sync-secret";
const DISCORD_API_MAX_RETRIES = 2;
const DISCORD_FUNCTION_RETRY_BUDGET_MS = 45_000;
const ALLOWED_EVENT_TYPES = new Set(["guildMemberAdd", "guildMemberUpdate"]);

type MemberSyncPayload = {
  event_type: "guildMemberAdd" | "guildMemberUpdate";
  guild_id: string;
  discord_user_id: string;
  roles: string[];
  gateway_sequence: number | null;
  occurred_at: string | null;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function serviceAdminClient(purpose: string): SupabaseAdminClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = getServiceRoleKey();

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      `Supabase service credentials are not configured for ${purpose}.`,
    );
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

function verifyMemberSyncSecret(req: Request): boolean {
  const expected = Deno.env.get("REAPER_PENDING_VERIFICATION_SYNC_SECRET") ||
    "";
  const actual = req.headers.get(MEMBER_SYNC_SECRET_HEADER) || "";
  return constantTimeSecretEqual(actual, expected);
}

function discordApiHeaders(contentType = false): Headers {
  const headers = new Headers({
    Authorization: `Bot ${Deno.env.get("DISCORD_BOT_TOKEN") || ""}`,
    Accept: "application/json",
    "User-Agent": DISCORD_API_USER_AGENT,
  });
  if (contentType) headers.set("Content-Type", "application/json");
  return headers;
}

function retryAfterMs(response: Response, data: unknown): number {
  const headerSeconds = Number(response.headers.get("Retry-After") || "");
  const bodySeconds = Number(asRecord(data).retry_after || "");
  const seconds = Number.isFinite(headerSeconds) && headerSeconds > 0
    ? headerSeconds
    : bodySeconds;
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.ceil(seconds * 1000);
}

async function discordApi(
  path: string,
  init: RequestInit = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  for (let attempt = 0; attempt <= DISCORD_API_MAX_RETRIES; attempt += 1) {
    const response = await fetch(`${DISCORD_API_BASE_URL}${path}`, init);
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (response.status === 429 && attempt < DISCORD_API_MAX_RETRIES) {
      const delay = retryAfterMs(response, data);
      if (delay > 0 && delay <= DISCORD_FUNCTION_RETRY_BUDGET_MS) {
        await wait(delay);
        continue;
      }
      throw new Error(
        "Discord rate limit retry_after exceeds the Edge Function retry budget.",
      );
    }

    return { ok: response.ok, status: response.status, data };
  }

  return {
    ok: false,
    status: 429,
    data: { error: "Discord rate limit retry budget exhausted." },
  };
}

function parsePayload(value: unknown): MemberSyncPayload {
  const record = asRecord(value);
  const eventType = safeString(record.event_type, 40);
  const guildId = snowflake(record.guild_id);
  const discordUserId = snowflake(record.discord_user_id);
  const roles = asArray(record.roles).map((roleId) => String(roleId)).filter((
    roleId,
  ) => Boolean(snowflake(roleId)));
  const gatewaySequence = Number(record.gateway_sequence);
  const occurredAt = safeString(record.occurred_at, 80);

  if (!eventType || !ALLOWED_EVENT_TYPES.has(eventType)) {
    throw new Error("event_type must be guildMemberAdd or guildMemberUpdate.");
  }

  if (guildId !== EXPECTED_DISCORD_GUILD_ID) {
    throw new Error("guild_id does not match the configured Reaper guild.");
  }

  if (!discordUserId) {
    throw new Error("discord_user_id must be a Discord snowflake.");
  }

  return {
    event_type: eventType as MemberSyncPayload["event_type"],
    guild_id: guildId,
    discord_user_id: discordUserId,
    roles,
    gateway_sequence: Number.isFinite(gatewaySequence) ? gatewaySequence : null,
    occurred_at: occurredAt,
  };
}

async function fetchGuildChannels(): Promise<JsonRecord[]> {
  const response = await discordApi(
    `/guilds/${EXPECTED_DISCORD_GUILD_ID}/channels`,
    {
      headers: discordApiHeaders(),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Guild channel fetch failed with Discord API ${response.status}.`,
    );
  }

  return asArray(response.data).map(asRecord).filter((channel) =>
    Boolean(pendingChannelId(channel))
  );
}

async function fetchGuildRoles(): Promise<JsonRecord[]> {
  const response = await discordApi(
    `/guilds/${EXPECTED_DISCORD_GUILD_ID}/roles`,
    {
      headers: discordApiHeaders(),
    },
  );

  if (!response.ok) {
    throw new Error(
      `Guild role fetch failed with Discord API ${response.status}.`,
    );
  }

  return asArray(response.data).map(asRecord).filter((role) =>
    Boolean(snowflake(role.id))
  );
}

async function fetchCurrentMember(
  discordUserId: string,
): Promise<JsonRecord | null> {
  const response = await discordApi(
    `/guilds/${EXPECTED_DISCORD_GUILD_ID}/members/${
      encodeURIComponent(discordUserId)
    }`,
    { headers: discordApiHeaders() },
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(
      `Guild member fetch failed with Discord API ${response.status}.`,
    );
  }

  const member = asRecord(response.data);
  const fetchedUserId = memberUserId(member);
  if (fetchedUserId !== discordUserId) {
    throw new Error("Discord returned an unexpected member payload.");
  }
  return member;
}

function discordApiErrorDetail(data: unknown): string {
  const record = asRecord(data);
  const code = safeString(record.code, 40);
  const message = safeString(record.message, 140);
  const details = [code ? `code ${code}` : "", message].filter(Boolean).join(
    ": ",
  );
  return details ? ` (${details})` : "";
}

async function writePendingDiscordOverwrite(
  change: PendingContainmentChange,
): Promise<void> {
  const auditHeaders = discordApiHeaders(
    change.nextAllow !== 0n || change.nextDeny !== 0n,
  );
  auditHeaders.set(
    "X-Audit-Log-Reason",
    encodeURIComponent(PENDING_VERIFICATION_AUDIT_REASON),
  );

  const removeOverwrite = change.nextAllow === 0n && change.nextDeny === 0n;
  const response = removeOverwrite
    ? await discordApi(
      `/channels/${change.channelId}/permissions/${change.userId}`,
      {
        method: "DELETE",
        headers: auditHeaders,
      },
    )
    : await discordApi(
      `/channels/${change.channelId}/permissions/${change.userId}`,
      {
        method: "PUT",
        headers: auditHeaders,
        body: JSON.stringify({
          allow: change.nextAllow.toString(),
          deny: change.nextDeny.toString(),
          type: DISCORD_MEMBER_OVERWRITE_TYPE,
        }),
      },
    );

  if (!response.ok) {
    throw new Error(
      `Discord overwrite ${change.detail} on ${change.channelName}:${change.channelId} user:${change.userId} failed with API ${response.status}${
        discordApiErrorDetail(response.data)
      }.`,
    );
  }
}

function planSummary(plan: PendingContainmentPlan): JsonRecord {
  return {
    targetCount: plan.targetUserIds.length,
    channelCount: plan.channelsChecked,
    allowedChannelCount: plan.allowedChannelIds.length,
    discordWriteCount:
      plan.changes.filter((change) => change.discordWrite).length,
    registryWriteCount: plan.changes.filter((change) => change.dbWrite).length +
      plan.staleRecords.length,
    conflictCount: plan.conflicts.length,
    staleRecordCount: plan.staleRecords.length,
  };
}

Deno.serve(async (req) => {
  if (!runtimeProfileReady("reaper-discord-member-sync")) {
    return unavailableResponse();
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "Method not allowed." }, 405);
  }

  if (!verifyMemberSyncSecret(req)) {
    return jsonResponse({ ok: false, error: "Unauthorized." }, 401);
  }

  let payload: MemberSyncPayload;
  let adminClient: SupabaseAdminClient | null = null;
  let plan: PendingContainmentPlan | null = null;

  try {
    if (!Deno.env.get("DISCORD_BOT_TOKEN")) {
      throw new Error("Discord bot token is not configured.");
    }

    payload = parsePayload(await req.json());
    adminClient = serviceAdminClient("pending verification member sync");

    const [channels, member, roles] = await Promise.all([
      fetchGuildChannels(),
      fetchCurrentMember(payload.discord_user_id),
      fetchGuildRoles(),
    ]);
    plan = await buildSingleMemberPendingContainmentPlan(
      adminClient,
      channels,
      member,
      payload.discord_user_id,
      roles,
    );
    const discordWriteCount = plan.changes.filter((change) =>
      change.discordWrite
    ).length;

    if (plan.conflicts.length) {
      await logPendingContainmentSync(
        adminClient,
        "apply",
        "warning",
        "Gateway member event blocked by manual VIEW_CHANNEL conflicts.",
        plan,
        {
          source: "gateway_member_event",
          eventType: payload.event_type,
          discordUserId: payload.discord_user_id,
          reportedRoleCount: payload.roles.length,
          gatewaySequence: payload.gateway_sequence,
        },
      );
      return jsonResponse({
        ok: false,
        status: "blocked_conflict",
        ...planSummary(plan),
      }, 409);
    }

    if (discordWriteCount > MAX_PENDING_VERIFICATION_MUTATIONS) {
      await logPendingContainmentSync(
        adminClient,
        "apply",
        "warning",
        "Gateway member event exceeded the pending-verification mutation guard.",
        plan,
        {
          source: "gateway_member_event",
          eventType: payload.event_type,
          discordUserId: payload.discord_user_id,
          maxMutationGuard: MAX_PENDING_VERIFICATION_MUTATIONS,
        },
      );
      return jsonResponse({
        ok: false,
        status: "blocked_mutation_guard",
        ...planSummary(plan),
      }, 409);
    }

    const result = await applyPendingContainmentPlan(
      adminClient,
      plan,
      writePendingDiscordOverwrite,
    );
    await logPendingContainmentSync(
      adminClient,
      "apply",
      "success",
      "Gateway member event pending-verification sync completed.",
      plan,
      {
        source: "gateway_member_event",
        eventType: payload.event_type,
        discordUserId: payload.discord_user_id,
        reportedRoleCount: payload.roles.length,
        gatewaySequence: payload.gateway_sequence,
        ...result,
      },
    );

    return jsonResponse({
      ok: true,
      status: "applied",
      ...planSummary(plan),
      ...result,
    });
  } catch (error) {
    console.error("reaper-discord-member-sync failed", {
      message: error instanceof Error ? error.message : String(error),
    });

    if (adminClient) {
      const partialApply = error instanceof PendingContainmentApplyError
        ? error.result
        : null;
      await logPendingContainmentSync(
        adminClient,
        "apply",
        "failed",
        "Gateway member event pending-verification sync failed.",
        plan,
        {
          source: "gateway_member_event",
          error: error instanceof Error
            ? error.message.slice(0, 160)
            : "Unknown error",
          failedDiscordWriteCount: partialApply?.failedWrites || 0,
          skippedDiscordWriteCount: partialApply?.skippedWrites || 0,
          appliedDiscordWriteCount: partialApply?.discordWrites || 0,
          registryWriteCountBeforeFailure: partialApply?.dbWrites || 0,
        },
      );
    }

    const status = error instanceof SyntaxError ? 400 : 500;
    return jsonResponse({
      ok: false,
      error: "Pending-verification member sync failed.",
    }, status);
  }
});
