import { withProtectedCors } from "../_shared/cors.ts";
import "@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "@supabase/supabase-js";
import { discordFetch } from "../_shared/discord-api.ts";
import { getServiceRoleKey } from "../_shared/supabase-service-role.ts";
import { constantTimeSecretEqual } from "../_shared/secret-auth.ts";
import {
  runtimeProfileReady,
  unavailableResponse,
} from "../_shared/runtime-config.ts";
import {
  asRecord,
  buildVoteReminderPayload,
  dateInTimeZone,
  DEFAULT_VOTE_TIME_ZONE,
  EXPECTED_DISCORD_GUILD_ID,
  EXPECTED_DISCORD_VOTE_CHANNEL_ID,
  isVoteDate,
  loadVoteLinks,
  safeString,
  snowflake,
} from "../_shared/vote-reminders.ts";

type JsonRecord = Record<string, unknown>;
type SupabaseAdminClient = {
  from(table: string): any;
};

function jsonResponse(body: JsonRecord, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function bearerOrHeaderSecret(req: Request): string {
  const header = req.headers.get("x-mochirii-vote-reminder-secret") || "";
  if (header) return header;

  const authorization = req.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

async function readJson(req: Request): Promise<JsonRecord> {
  if (req.method === "GET") return {};
  const raw = await req.text();
  if (!raw.trim()) return {};

  try {
    return asRecord(JSON.parse(raw));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function requestedVoteDate(body: JsonRecord, timeZone: string): string {
  const value = safeString(body.voteDate, 20);
  return value && isVoteDate(value)
    ? value
    : dateInTimeZone(new Date(), timeZone);
}

async function insertPendingSend(
  adminClient: SupabaseAdminClient,
  voteDate: string,
  channelId: string,
) {
  const { data, error } = await adminClient
    .from("vote_reminder_sends")
    .insert({
      vote_date: voteDate,
      discord_guild_id: EXPECTED_DISCORD_GUILD_ID,
      discord_channel_id: channelId,
      status: "pending",
      message: "Vote reminder send started.",
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "23505") return { duplicate: true, id: "" };
    throw error;
  }

  return { duplicate: false, id: safeString(asRecord(data).id, 64) || "" };
}

async function updateSend(
  adminClient: SupabaseAdminClient,
  id: string,
  status: "sent" | "skipped" | "failed",
  fields: JsonRecord,
): Promise<void> {
  if (!id) return;

  const { error } = await adminClient
    .from("vote_reminder_sends")
    .update({
      ...fields,
      status,
      finished_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (error) {
    console.error("send-vote-reminder log update failed", {
      code: error.code,
      message: error.message,
      status,
    });
  }
}

Deno.serve((req: Request) =>
  runtimeProfileReady("send-vote-reminder")
    ? withProtectedCors(req, handleRequest(req))
    : unavailableResponse()
);

async function handleRequest(req: Request): Promise<Response> {
  if (!["GET", "POST"].includes(req.method)) {
    return jsonResponse({ ok: false, message: "Method not allowed." }, 405);
  }

  const cronSecret = Deno.env.get("VOTE_REMINDER_CRON_SECRET") || "";
  if (!cronSecret) {
    return jsonResponse({
      ok: false,
      message: "Vote reminder cron secret is not configured.",
    }, 500);
  }

  if (!constantTimeSecretEqual(bearerOrHeaderSecret(req), cronSecret)) {
    return jsonResponse({ ok: false, message: "Unauthorized." }, 401);
  }

  let body: JsonRecord;
  try {
    body = await readJson(req);
  } catch (error) {
    return jsonResponse({
      ok: false,
      message: error instanceof Error ? error.message : "Invalid request.",
    }, 400);
  }

  const configuredGuildId = Deno.env.get("DISCORD_GUILD_ID") || "";
  const channelId = Deno.env.get("DISCORD_VOTE_CHANNEL_ID") || "";
  if (
    configuredGuildId !== EXPECTED_DISCORD_GUILD_ID ||
    channelId !== EXPECTED_DISCORD_VOTE_CHANNEL_ID
  ) {
    console.error(
      "send-vote-reminder missing or mismatched Discord configuration",
      {
        guildConfigMatches: configuredGuildId === EXPECTED_DISCORD_GUILD_ID,
        channelConfigMatches: channelId === EXPECTED_DISCORD_VOTE_CHANNEL_ID,
      },
    );
    return jsonResponse({
      ok: false,
      message: "Vote reminder Discord configuration is not ready.",
    }, 500);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceRoleKey = getServiceRoleKey();
  if (!supabaseUrl || !serviceRoleKey) {
    return jsonResponse({
      ok: false,
      message: "Supabase service credentials are not configured.",
    }, 500);
  }

  const timeZone = Deno.env.get("VOTE_REMINDER_TIME_ZONE") ||
    DEFAULT_VOTE_TIME_ZONE;
  const voteDate = requestedVoteDate(body, timeZone);
  const preview = body.preview === true ||
    new URL(req.url).searchParams.get("preview") === "1";
  const adminClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  let sendId = "";

  try {
    const links = await loadVoteLinks({
      channelId,
      discordFetch: (path, init) => discordFetch(path, init),
      linksJson: Deno.env.get("DISCORD_VOTE_LINKS_JSON") || "",
    });

    if (!links.length) {
      if (preview) {
        return jsonResponse({
          ok: false,
          preview: true,
          skipped: true,
          voteDate,
          message: "No vote links found.",
        }, 422);
      }

      const pending = await insertPendingSend(adminClient, voteDate, channelId);
      if (!pending.duplicate) {
        await updateSend(adminClient, pending.id, "skipped", {
          link_count: 0,
          message: "No configured or pinned vote links were found.",
        });
      }
      return jsonResponse({
        ok: false,
        skipped: true,
        voteDate,
        message: "No vote links found.",
      }, 422);
    }

    const payload = buildVoteReminderPayload(links, voteDate);
    if (preview) {
      return jsonResponse({
        ok: true,
        preview: true,
        voteDate,
        channelId,
        linkCount: links.length,
        payload,
      });
    }

    const pending = await insertPendingSend(adminClient, voteDate, channelId);
    if (pending.duplicate) {
      return jsonResponse({
        ok: true,
        duplicate: true,
        voteDate,
        channelId,
        message:
          "A vote reminder has already been sent or is currently sending for this date.",
      });
    }
    sendId = pending.id;

    const response = await discordFetch(`/channels/${channelId}/messages`, {
      method: "POST",
      body: payload,
    });
    const messageId = snowflake(asRecord(response.data).id);

    if (!response.ok || !messageId) {
      await updateSend(adminClient, sendId, "failed", {
        link_count: links.length,
        message: `Discord API send failed with HTTP ${response.status}.`,
      });
      return jsonResponse({
        ok: false,
        voteDate,
        message: "Discord reminder send failed.",
      }, 502);
    }

    await updateSend(adminClient, sendId, "sent", {
      discord_message_id: messageId,
      link_count: links.length,
      message: "Vote reminder sent.",
      details: {
        managedBy: "manual-vote-reminder",
      },
      sent_at: new Date().toISOString(),
    });

    return jsonResponse({
      ok: true,
      voteDate,
      channelId,
      messageId,
      linkCount: links.length,
    });
  } catch (error) {
    await updateSend(adminClient, sendId, "failed", {
      message: error instanceof Error ? error.message : "Vote reminder failed.",
    });
    console.error("send-vote-reminder failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse({
      ok: false,
      voteDate,
      message: "Vote reminder failed.",
    }, 500);
  }
}
