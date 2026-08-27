import { withProtectedCors } from "../_shared/cors.ts";
import "@supabase/functions-js/edge-runtime.d.ts";
import { discordFetch } from "../_shared/discord-api.ts";
import {
  runtimeProfileReady,
  unavailableResponse,
} from "../_shared/runtime-config.ts";
import { constantTimeSecretEqual } from "../_shared/secret-auth.ts";
import {
  bearerOrHeaderSecret,
  createAdminClient,
  fetchPollAnswerVoterCount,
  jsonResponse,
  pollResults,
  readJson,
  SPOTLIGHT_POLL_MANAGED_BY,
  type SpotlightCycle,
  spotlightPollConfig,
} from "../_shared/spotlight-polls.ts";
import { asArray, asRecord, safeString } from "../_shared/vote-reminders.ts";

type JsonRecord = Record<string, unknown>;

export type PublishMemberSpotlightWinnerHandlerDependencies = {
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

function requestedCycleMonth(body: JsonRecord): string | null {
  const value = safeString(body.cycleMonth, 20);
  return value && /^\d{4}-\d{2}-01$/.test(value) ? value : null;
}

async function loadCycle(
  adminClient: NonNullable<ReturnType<typeof createAdminClient>>,
  cycleMonth: string | null,
): Promise<SpotlightCycle | null> {
  let query = adminClient
    .from("spotlight_poll_cycles")
    .select(
      "id,cycle_month,discord_guild_id,discord_channel_id,discord_message_id,status,vote_close_at",
    )
    .eq("status", "open")
    .not("discord_message_id", "is", null)
    .order("vote_close_at", { ascending: true })
    .limit(1);

  if (cycleMonth) {
    query = query.eq("cycle_month", cycleMonth);
  } else {
    query = query.lte("vote_close_at", new Date().toISOString());
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const record = asRecord(data);
  return {
    id: safeString(record.id, 80) || "",
    cycleMonth: safeString(record.cycle_month, 20) || "",
    discordGuildId: safeString(record.discord_guild_id, 24) || "",
    discordChannelId: safeString(record.discord_channel_id, 24) || "",
    discordMessageId: safeString(record.discord_message_id, 24) || "",
    status: safeString(record.status, 20) || "",
    voteCloseAt: safeString(record.vote_close_at, 40) || "",
  };
}

async function loadCandidates(
  adminClient: NonNullable<ReturnType<typeof createAdminClient>>,
  cycleId: string,
) {
  const { data, error } = await adminClient
    .from("spotlight_poll_candidates")
    .select(
      "member_profile_id,discord_user_id,display_name,answer_id,candidate_order,answer_label",
    )
    .eq("cycle_id", cycleId)
    .order("candidate_order", { ascending: true });

  if (error) throw error;
  return asArray(data).map(asRecord).map((candidate) => ({
    memberProfileId: safeString(candidate.member_profile_id, 80) || "",
    discordUserId: safeString(candidate.discord_user_id, 24) || "",
    displayName: safeString(candidate.display_name, 120) || "",
    answerId: Number(candidate.answer_id),
    candidateOrder: Number(candidate.candidate_order),
    answerLabel: safeString(candidate.answer_label, 55) || "",
  })).filter((candidate) =>
    candidate.memberProfileId && candidate.discordUserId &&
    Number.isInteger(candidate.answerId)
  );
}

async function upsertResult(
  adminClient: NonNullable<ReturnType<typeof createAdminClient>>,
  cycleId: string,
  candidate: Awaited<ReturnType<typeof loadCandidates>>[number],
  voteCount: number,
  voterCountVerified: number | null,
) {
  const { error } = await adminClient
    .from("spotlight_poll_results")
    .upsert({
      cycle_id: cycleId,
      answer_id: candidate.answerId,
      member_profile_id: candidate.memberProfileId,
      discord_user_id: candidate.discordUserId,
      vote_count: voteCount,
      voter_count_verified: voterCountVerified,
      metadata: {
        managedBy: SPOTLIGHT_POLL_MANAGED_BY,
        answerLabel: candidate.answerLabel,
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: "cycle_id,answer_id" });

  if (error) throw error;
}

const defaultHandlerDependencies:
  PublishMemberSpotlightWinnerHandlerDependencies = {
    runtimeReady: () => runtimeProfileReady("publish-member-spotlight-winner"),
    unavailable: unavailableResponse,
    withCors: (req, response) => withProtectedCors(req, response),
    config: spotlightPollConfig,
    authenticate: constantTimeSecretEqual,
    parseBody: readJson,
  };

export function createPublishMemberSpotlightWinnerHandler(
  overrides: Partial<PublishMemberSpotlightWinnerHandlerDependencies> = {},
): (req: Request) => Promise<Response> {
  const dependencies = { ...defaultHandlerDependencies, ...overrides };
  return (req) =>
    dependencies.runtimeReady()
      ? dependencies.withCors(req, handleRequest(req, dependencies))
      : Promise.resolve(dependencies.unavailable());
}

export const publishMemberSpotlightWinnerHandler =
  createPublishMemberSpotlightWinnerHandler();

if (import.meta.main) Deno.serve(publishMemberSpotlightWinnerHandler);

async function handleRequest(
  req: Request,
  dependencies: PublishMemberSpotlightWinnerHandlerDependencies,
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
    const cycle = await loadCycle(adminClient, cycleMonth);
    if (!cycle) {
      return jsonResponse({
        ok: true,
        skipped: true,
        message: "No due open spotlight poll cycle found.",
      });
    }

    const response = await discordFetch(
      `/channels/${cycle.discordChannelId}/messages/${cycle.discordMessageId}`,
      {
        method: "GET",
      },
    );

    if (!response.ok) {
      return jsonResponse({
        ok: false,
        cycleMonth: cycle.cycleMonth,
        message: "Discord poll message could not be loaded.",
      }, 502);
    }

    const message = asRecord(response.data);
    const results = pollResults(message);
    if (!results.finalized) {
      return jsonResponse({
        ok: false,
        retry: true,
        cycleMonth: cycle.cycleMonth,
        message: "Discord poll results are not finalized yet.",
      }, 409);
    }

    const candidates = await loadCandidates(adminClient, cycle.id);
    if (!candidates.length) {
      await adminClient
        .from("spotlight_poll_cycles")
        .update({
          status: "failed",
          error_message:
            "No candidates were found for this spotlight poll cycle.",
          finalized_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", cycle.id);
      return jsonResponse({
        ok: false,
        cycleMonth: cycle.cycleMonth,
        message: "No spotlight candidates found.",
      }, 500);
    }

    const scored = [];
    for (const candidate of candidates) {
      const voteCount = results.counts.get(candidate.answerId) || 0;
      const voterCountVerified = await fetchPollAnswerVoterCount(
        (path, init) => discordFetch(path, init),
        cycle.discordChannelId,
        cycle.discordMessageId,
        candidate.answerId,
      );
      scored.push({ ...candidate, voteCount, voterCountVerified });
    }

    if (preview) {
      return jsonResponse({
        ok: true,
        preview: true,
        cycleMonth: cycle.cycleMonth,
        finalized: true,
        results: scored.map((candidate) => ({
          answerLabel: candidate.answerLabel,
          voteCount: candidate.voteCount,
          voterCountVerified: candidate.voterCountVerified,
        })),
      });
    }

    for (const candidate of scored) {
      await upsertResult(
        adminClient,
        cycle.id,
        candidate,
        candidate.voteCount,
        candidate.voterCountVerified,
      );
    }

    const totalVotes = scored.reduce(
      (total, candidate) => total + candidate.voteCount,
      0,
    );
    const now = new Date().toISOString();

    if (totalVotes <= 0) {
      await adminClient
        .from("spotlight_poll_cycles")
        .update({
          status: "closed",
          finalized_at: now,
          updated_at: now,
          metadata: {
            managedBy: SPOTLIGHT_POLL_MANAGED_BY,
            noVotes: true,
          },
        })
        .eq("id", cycle.id);

      return jsonResponse({
        ok: true,
        cycleMonth: cycle.cycleMonth,
        skipped: true,
        message:
          "Poll finalized with no votes; current spotlight remains unchanged.",
      });
    }

    const winner = scored
      .sort((left, right) =>
        right.voteCount - left.voteCount ||
        left.candidateOrder - right.candidateOrder
      )[0];
    const tiedCount = scored.filter((candidate) =>
      candidate.voteCount === winner.voteCount
    ).length;

    const { error } = await adminClient
      .from("spotlight_poll_cycles")
      .update({
        status: "published",
        winner_profile_id: winner.memberProfileId,
        winner_discord_user_id: winner.discordUserId,
        winner_answer_id: winner.answerId,
        winner_display_name: winner.displayName,
        tie_breaker: tiedCount > 1 ? "candidate_order" : null,
        finalized_at: now,
        published_at: now,
        updated_at: now,
        metadata: {
          managedBy: SPOTLIGHT_POLL_MANAGED_BY,
          totalVotes,
          tiedCandidateCount: tiedCount,
        },
      })
      .eq("id", cycle.id);

    if (error) throw error;

    return jsonResponse({
      ok: true,
      cycleMonth: cycle.cycleMonth,
      winnerName: winner.displayName,
      voteCount: winner.voteCount,
      totalVotes,
      tieBreaker: tiedCount > 1 ? "candidate_order" : "",
    });
  } catch {
    console.error("publish-member-spotlight-winner failed", {
      errorType: "spotlight_winner_publish_failed",
      cycleMonth,
    });
    return jsonResponse({
      ok: false,
      message: "Spotlight poll winner could not be published.",
    }, 500);
  }
}
