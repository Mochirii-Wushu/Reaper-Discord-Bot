import { withProtectedCors } from "../_shared/cors.ts";
import "@supabase/functions-js/edge-runtime.d.ts";
import { discordFetch } from "../_shared/discord-api.ts";
import {
  runtimeProfileReady,
  unavailableResponse,
} from "../_shared/runtime-config.ts";
import { constantTimeSecretEqual } from "../_shared/secret-auth.ts";
import {
  addHours,
  bearerOrHeaderSecret,
  buildCandidateSnapshots,
  buildDiscordPollPayload,
  createAdminClient,
  cycleMonthFor,
  jsonResponse,
  loadEligibleProfiles,
  pollAnswerIds,
  readJson,
  SPOTLIGHT_POLL_DURATION_HOURS,
  SPOTLIGHT_POLL_MANAGED_BY,
  SPOTLIGHT_POLL_QUESTION,
  SPOTLIGHT_POLL_TIME_ZONE,
  type SpotlightCandidate,
  spotlightPollConfig,
} from "../_shared/spotlight-polls.ts";
import {
  asRecord,
  EXPECTED_DISCORD_GUILD_ID,
  safeString,
  snowflake,
} from "../_shared/vote-reminders.ts";

type JsonRecord = Record<string, unknown>;

export type SendMemberSpotlightPollHandlerDependencies = {
  runtimeReady(): boolean;
  unavailable(): Response;
  withCors(req: Request, response: Promise<Response>): Promise<Response>;
  config(): ReturnType<typeof spotlightPollConfig>;
  authenticate(provided: string, expected: string): Promise<boolean>;
  parseBody(req: Request): Promise<JsonRecord>;
  authorizedEffect?: (
    req: Request,
    body: JsonRecord,
  ) => Response | Promise<Response>;
};

function requestedCycleMonth(body: JsonRecord): string {
  const value = safeString(body.cycleMonth, 20);
  return value && /^\d{4}-\d{2}-01$/.test(value)
    ? value
    : cycleMonthFor(new Date(), SPOTLIGHT_POLL_TIME_ZONE);
}

async function existingCycle(
  adminClient: ReturnType<typeof createAdminClient>,
  cycleMonth: string,
) {
  if (!adminClient) return null;
  const { data, error } = await adminClient
    .from("spotlight_poll_cycles")
    .select(
      "id,status,discord_channel_id,discord_message_id,winner_display_name",
    )
    .eq("cycle_month", cycleMonth)
    .maybeSingle();

  if (error) throw error;
  return data ? asRecord(data) : null;
}

async function insertCycle(
  adminClient: NonNullable<ReturnType<typeof createAdminClient>>,
  cycleMonth: string,
  channelId: string,
  openAt: Date,
  closeAt: Date,
) {
  const { data, error } = await adminClient
    .from("spotlight_poll_cycles")
    .insert({
      cycle_month: cycleMonth,
      poll_date: cycleMonth,
      vote_open_at: openAt.toISOString(),
      vote_close_at: closeAt.toISOString(),
      status: "pending",
      discord_guild_id: EXPECTED_DISCORD_GUILD_ID,
      discord_channel_id: channelId,
      poll_question: SPOTLIGHT_POLL_QUESTION,
      metadata: {
        managedBy: SPOTLIGHT_POLL_MANAGED_BY,
        timeZone: SPOTLIGHT_POLL_TIME_ZONE,
      },
    })
    .select("id")
    .single();

  if (error) throw error;
  return safeString(asRecord(data).id, 80) || "";
}

async function insertCandidates(
  adminClient: NonNullable<ReturnType<typeof createAdminClient>>,
  cycleId: string,
  candidates: SpotlightCandidate[],
) {
  const { error } = await adminClient
    .from("spotlight_poll_candidates")
    .insert(candidates.map((candidate) => ({
      cycle_id: cycleId,
      member_profile_id: candidate.memberProfileId,
      discord_user_id: candidate.discordUserId,
      display_name: candidate.displayName,
      answer_label: candidate.answerLabel,
      candidate_order: candidate.candidateOrder,
      metadata: {
        managedBy: SPOTLIGHT_POLL_MANAGED_BY,
        discordUsername: candidate.discordUsername || null,
      },
    })));

  if (error) throw error;
}

async function updateCycleFailure(
  adminClient: NonNullable<ReturnType<typeof createAdminClient>>,
  cycleId: string,
  message: string,
) {
  if (!cycleId) return;
  await adminClient
    .from("spotlight_poll_cycles")
    .update({
      status: "failed",
      error_message: message.slice(0, 500),
      updated_at: new Date().toISOString(),
    })
    .eq("id", cycleId);
}

const defaultHandlerDependencies: SendMemberSpotlightPollHandlerDependencies = {
  runtimeReady: () => runtimeProfileReady("send-member-spotlight-poll"),
  unavailable: unavailableResponse,
  withCors: (req, response) => withProtectedCors(req, response),
  config: spotlightPollConfig,
  authenticate: constantTimeSecretEqual,
  parseBody: readJson,
};

export function createSendMemberSpotlightPollHandler(
  overrides: Partial<SendMemberSpotlightPollHandlerDependencies> = {},
): (req: Request) => Promise<Response> {
  const dependencies = { ...defaultHandlerDependencies, ...overrides };
  return (req) =>
    dependencies.runtimeReady()
      ? dependencies.withCors(req, handleRequest(req, dependencies))
      : Promise.resolve(dependencies.unavailable());
}

export const sendMemberSpotlightPollHandler =
  createSendMemberSpotlightPollHandler();

if (import.meta.main) Deno.serve(sendMemberSpotlightPollHandler);

async function handleRequest(
  req: Request,
  dependencies: SendMemberSpotlightPollHandlerDependencies,
): Promise<Response> {
  if (req.method === "OPTIONS") return jsonResponse({ ok: true });
  if (!["GET", "POST"].includes(req.method)) {
    return jsonResponse({ ok: false, message: "Method not allowed." }, 405);
  }

  const config = dependencies.config();
  if (!config.secret) {
    return jsonResponse({
      ok: false,
      message: "Spotlight poll cron secret is not configured.",
    }, 500);
  }
  if (
    !await dependencies.authenticate(bearerOrHeaderSecret(req), config.secret)
  ) {
    return jsonResponse({ ok: false, message: "Unauthorized." }, 401);
  }
  if (!config.ready) {
    return jsonResponse({
      ok: false,
      message: "Spotlight poll Discord configuration is not ready.",
    }, 500);
  }

  let body: JsonRecord;
  try {
    body = await dependencies.parseBody(req);
  } catch {
    return jsonResponse({
      ok: false,
      message: "Invalid request body.",
    }, 400);
  }

  if (dependencies.authorizedEffect) {
    return dependencies.authorizedEffect(req, body);
  }

  const adminClient = createAdminClient();
  if (!adminClient) {
    return jsonResponse({
      ok: false,
      message: "Supabase service credentials are not configured.",
    }, 500);
  }

  const preview = body.preview === true ||
    new URL(req.url).searchParams.get("preview") === "1";
  const cycleMonth = requestedCycleMonth(body);

  try {
    const existing = await existingCycle(adminClient, cycleMonth);
    if (existing && !preview) {
      return jsonResponse({
        ok: true,
        duplicate: true,
        cycleMonth,
        status: existing.status,
        channelId: existing.discord_channel_id,
        messageId: existing.discord_message_id,
        message: "A spotlight poll cycle already exists for this month.",
      });
    }

    const profiles = await loadEligibleProfiles(adminClient);
    const candidates = buildCandidateSnapshots(profiles);
    if (!candidates.length) {
      return jsonResponse({
        ok: false,
        cycleMonth,
        message: "No eligible verified Discord-linked members found.",
      }, 422);
    }

    const payload = buildDiscordPollPayload(candidates);
    if (preview) {
      return jsonResponse({
        ok: true,
        preview: true,
        cycleMonth,
        channelId: config.channelId,
        candidateCount: candidates.length,
        answerLabels: candidates.map((candidate) => candidate.answerLabel),
        payload,
      });
    }

    const now = new Date();
    const voteCloseAt = addHours(now, SPOTLIGHT_POLL_DURATION_HOURS);
    const cycleId = await insertCycle(
      adminClient,
      cycleMonth,
      config.channelId,
      now,
      voteCloseAt,
    );
    await insertCandidates(adminClient, cycleId, candidates);

    const response = await discordFetch(
      `/channels/${config.channelId}/messages`,
      {
        method: "POST",
        body: payload,
      },
    );
    const message = asRecord(response.data);
    const messageId = snowflake(message.id);

    if (!response.ok || !messageId) {
      await updateCycleFailure(
        adminClient,
        cycleId,
        `Discord poll send failed with HTTP ${response.status}.`,
      );
      return jsonResponse({
        ok: false,
        cycleMonth,
        message: "Discord poll send failed.",
      }, 502);
    }

    const answerIds = pollAnswerIds(message);
    await Promise.all(candidates.map((candidate, index) =>
      adminClient
        .from("spotlight_poll_candidates")
        .update({
          answer_id: answerIds[index] || null,
        })
        .eq("cycle_id", cycleId)
        .eq("candidate_order", candidate.candidateOrder)
    ));

    await adminClient
      .from("spotlight_poll_cycles")
      .update({
        status: "open",
        discord_message_id: messageId,
        sent_at: now.toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {
          managedBy: SPOTLIGHT_POLL_MANAGED_BY,
          timeZone: SPOTLIGHT_POLL_TIME_ZONE,
          durationHours: SPOTLIGHT_POLL_DURATION_HOURS,
          answerCount: candidates.length,
        },
      })
      .eq("id", cycleId);

    return jsonResponse({
      ok: true,
      cycleMonth,
      channelId: config.channelId,
      messageId,
      candidateCount: candidates.length,
      voteCloseAt: voteCloseAt.toISOString(),
    });
  } catch {
    console.error("send-member-spotlight-poll failed", {
      errorType: "spotlight_poll_failed",
      cycleMonth,
    });
    return jsonResponse({
      ok: false,
      cycleMonth,
      message: "Spotlight poll could not be sent.",
    }, 500);
  }
}
