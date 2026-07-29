import { discordFetch } from "./discord-api.ts";
import {
  asRecord,
  deferredMessageUpdateResponse,
  editOriginalInteractionPayload,
  interactionMessage,
  type JsonRecord,
  modalResponse,
  safeString,
  snowflake,
  stringOption,
  updateMessageResponse,
} from "./discord-interaction-helpers.ts";
import {
  buildPhotoDayPollDraft,
  buildPhotoDayPollEditModal,
  buildPhotoDayPollPublicMessage,
  buildPhotoDayPollReviewMessage,
  buildPhotoDayPollStatusInteractionData,
  EXPECTED_DISCORD_PHOTO_DAY_CHANNEL_ID,
  PHOTO_DAY_POLL_APPROVE_CUSTOM_ID,
  PHOTO_DAY_POLL_CANCEL_CUSTOM_ID,
  PHOTO_DAY_POLL_EDIT_CUSTOM_ID,
  PHOTO_DAY_POLL_EDIT_MODAL_CUSTOM_ID,
  type PhotoDayPollDraft,
  photoDayPollDraftFromModalSubmit,
  photoDayPollDraftFromPreviewMessage,
} from "./photo-day-polls.ts";

type PhotoDayPollContext = {
  applicationId: string;
  configuredGuildId: string;
  configuredModeratorRoleIds: string[];
  data: JsonRecord;
  discordApiUserAgent: string;
  discordUserId: string | null;
  expectedGuildId: string;
  expectedModeratorConfigMatches(configuredRoleIds: string[]): boolean;
  guildId: string | null;
  hasModeratorRole(memberRoleIds: string[]): boolean;
  interactionMessage: JsonRecord;
  interactionToken: string | null;
  memberRoleIds: string[];
  waitUntil(promise: Promise<unknown>): void;
};

export function photoDayPollCustomId(value: unknown): string | null {
  const customId = safeString(value, 100);
  return (
      customId === PHOTO_DAY_POLL_APPROVE_CUSTOM_ID ||
      customId === PHOTO_DAY_POLL_EDIT_CUSTOM_ID ||
      customId === PHOTO_DAY_POLL_CANCEL_CUSTOM_ID
    )
    ? customId
    : null;
}

export function photoDayPollOptionValues(
  data: JsonRecord,
): string[] | undefined {
  const options = [1, 2, 3, 4, 5]
    .map((index) => stringOption(data, `option_${index}`, 90))
    .filter((option): option is string => Boolean(option));

  return options.length ? options : undefined;
}

async function postPhotoDayPollReview(
  draft: PhotoDayPollDraft,
  discordApiUserAgent: string,
): Promise<{ ok: boolean; status: number }> {
  const response = await discordFetch(
    `/channels/${EXPECTED_DISCORD_PHOTO_DAY_CHANNEL_ID}/messages`,
    {
      method: "POST",
      headers: {
        "User-Agent": discordApiUserAgent,
      },
      body: buildPhotoDayPollReviewMessage(draft),
    },
  );

  return {
    ok: response.ok,
    status: response.status,
  };
}

async function patchPhotoDayPollReview(
  messageId: string,
  draft: PhotoDayPollDraft,
  discordApiUserAgent: string,
): Promise<{ ok: boolean; status: number }> {
  const response = await discordFetch(
    `/channels/${EXPECTED_DISCORD_PHOTO_DAY_CHANNEL_ID}/messages/${messageId}`,
    {
      method: "PATCH",
      headers: {
        "User-Agent": discordApiUserAgent,
      },
      body: buildPhotoDayPollReviewMessage(draft),
    },
  );

  return {
    ok: response.ok,
    status: response.status,
  };
}

async function addPhotoDayPollReactions(
  messageId: string,
  draft: PhotoDayPollDraft,
  discordApiUserAgent: string,
): Promise<string[]> {
  const failures: string[] = [];

  for (const choice of draft.choices) {
    const reactionResponse = await discordFetch(
      `/channels/${EXPECTED_DISCORD_PHOTO_DAY_CHANNEL_ID}/messages/${messageId}/reactions/${
        encodeURIComponent(choice.emoji)
      }/@me`,
      {
        method: "PUT",
        headers: {
          "User-Agent": discordApiUserAgent,
        },
      },
    );

    if (!reactionResponse.ok) {
      failures.push(`${choice.emoji} (HTTP ${reactionResponse.status})`);
    }
  }

  return failures;
}

async function editPhotoDayPublicSetupWarning(
  messageId: string,
  discordApiUserAgent: string,
): Promise<void> {
  const response = await discordFetch(
    `/channels/${EXPECTED_DISCORD_PHOTO_DAY_CHANNEL_ID}/messages/${messageId}`,
    {
      method: "PATCH",
      headers: {
        "User-Agent": discordApiUserAgent,
      },
      body: {
        content:
          "Setup note: Reaper could not add every starter reaction. Please use the listed emojis manually.",
        allowed_mentions: {
          parse: [],
        },
      },
    },
  );

  if (!response.ok) {
    console.error(
      "reaper-discord-interactions photo day public warning edit failed",
      {
        status: response.status,
      },
    );
  }
}

async function processPhotoDayPollApproval(
  draft: PhotoDayPollDraft,
  messageId: string,
  interactionToken: string,
  applicationId: string,
  discordApiUserAgent: string,
): Promise<void> {
  try {
    if (!Deno.env.get("DISCORD_BOT_TOKEN")) {
      await editOriginalInteractionPayload(
        applicationId,
        interactionToken,
        buildPhotoDayPollStatusInteractionData(
          "Photo day poll was not sent. Reaper is missing the Discord bot token.",
        ),
      );
      return;
    }

    const publishResponse = await discordFetch(
      `/channels/${EXPECTED_DISCORD_PHOTO_DAY_CHANNEL_ID}/messages/${messageId}`,
      {
        method: "PATCH",
        headers: {
          "User-Agent": discordApiUserAgent,
        },
        body: buildPhotoDayPollPublicMessage(draft),
      },
    );

    if (!publishResponse.ok) {
      await editOriginalInteractionPayload(
        applicationId,
        interactionToken,
        buildPhotoDayPollStatusInteractionData(
          `Photo day poll was not sent. Discord API returned HTTP ${publishResponse.status}.`,
        ),
      );
      return;
    }

    const reactionFailures = await addPhotoDayPollReactions(
      messageId,
      draft,
      discordApiUserAgent,
    );
    if (reactionFailures.length) {
      await editPhotoDayPublicSetupWarning(messageId, discordApiUserAgent);
      await editOriginalInteractionPayload(
        applicationId,
        interactionToken,
        buildPhotoDayPollStatusInteractionData(
          `Photo day poll was sent to <#${EXPECTED_DISCORD_PHOTO_DAY_CHANNEL_ID}>, but starter reaction setup failed for ${
            reactionFailures.join(", ")
          }.`,
        ),
      );
      return;
    }

    await editOriginalInteractionPayload(
      applicationId,
      interactionToken,
      buildPhotoDayPollStatusInteractionData(
        `Photo day poll sent to <#${EXPECTED_DISCORD_PHOTO_DAY_CHANNEL_ID}>. Starter reactions added: ${
          draft.choices.map((choice) => choice.emoji).join(" ")
        }.`,
      ),
    );
  } catch (error) {
    console.error(
      "reaper-discord-interactions photo day poll approval failed",
      {
        message: error instanceof Error ? error.message : String(error),
      },
    );
    await editOriginalInteractionPayload(
      applicationId,
      interactionToken,
      buildPhotoDayPollStatusInteractionData(
        "Photo day poll approval could not be completed. No confirmed public send result is available.",
      ),
    );
  }
}

function hasValidPhotoDayConfig(
  context: PhotoDayPollContext,
  workflow: string,
): boolean {
  const configMatches = context.configuredGuildId === context.expectedGuildId;
  const moderatorConfigMatches = context.expectedModeratorConfigMatches(
    context.configuredModeratorRoleIds,
  );

  if (!configMatches || !moderatorConfigMatches) {
    console.error(
      `reaper-discord-interactions missing or mismatched ${workflow} configuration`,
      {
        guildConfigMatches: configMatches,
        moderatorRoleConfigMatches: moderatorConfigMatches,
        configuredModeratorRoleCount: context.configuredModeratorRoleIds.length,
      },
    );
    return false;
  }

  return true;
}

function callerHasPhotoDayModeratorAccess(
  context: PhotoDayPollContext,
): boolean {
  return context.guildId === context.expectedGuildId &&
    Boolean(context.discordUserId) &&
    context.hasModeratorRole(context.memberRoleIds);
}

export function handlePhotoDayPollComponent(
  context: PhotoDayPollContext,
): Response | null {
  const customId = photoDayPollCustomId(context.data.custom_id);
  if (!customId) return null;

  if (!hasValidPhotoDayConfig(context, "photo day poll")) {
    return interactionMessage("Photo day poll approval is not configured yet.");
  }

  if (!callerHasPhotoDayModeratorAccess(context)) {
    return interactionMessage(
      "Photo day poll approval requires the Moderator role.",
    );
  }

  if (customId === PHOTO_DAY_POLL_CANCEL_CUSTOM_ID) {
    return updateMessageResponse(
      buildPhotoDayPollStatusInteractionData(
        "Photo day poll canceled. No Discord message was sent.",
      ),
    );
  }

  let draft: PhotoDayPollDraft;
  try {
    draft = photoDayPollDraftFromPreviewMessage(context.interactionMessage);
  } catch (error) {
    console.error(
      "reaper-discord-interactions photo day poll preview parse failed",
      {
        message: error instanceof Error ? error.message : String(error),
      },
    );
    return updateMessageResponse(
      buildPhotoDayPollStatusInteractionData(
        "Photo day poll preview could not be read. No Discord message was sent.",
      ),
    );
  }

  if (customId === PHOTO_DAY_POLL_EDIT_CUSTOM_ID) {
    return modalResponse(buildPhotoDayPollEditModal(draft));
  }

  if (!context.interactionToken || !context.applicationId) {
    return interactionMessage("Discord interaction could not be identified.");
  }

  const messageId = snowflake(asRecord(context.interactionMessage).id);
  if (!messageId) {
    return updateMessageResponse(
      buildPhotoDayPollStatusInteractionData(
        "Photo day poll review message could not be identified. No Discord message was sent.",
      ),
    );
  }

  context.waitUntil(
    processPhotoDayPollApproval(
      draft,
      messageId,
      context.interactionToken,
      context.applicationId,
      context.discordApiUserAgent,
    ),
  );
  return deferredMessageUpdateResponse();
}

export async function handlePhotoDayPollModalSubmit(
  context: PhotoDayPollContext,
): Promise<Response | null> {
  if (
    safeString(context.data.custom_id, 100) !==
      PHOTO_DAY_POLL_EDIT_MODAL_CUSTOM_ID
  ) {
    return null;
  }

  if (!hasValidPhotoDayConfig(context, "photo day poll")) {
    return interactionMessage("Photo day poll editing is not configured yet.");
  }

  if (!callerHasPhotoDayModeratorAccess(context)) {
    return interactionMessage(
      "Photo day poll editing requires the Moderator role.",
    );
  }

  const messageId = snowflake(asRecord(context.interactionMessage).id);
  if (!messageId) {
    return interactionMessage(
      "Photo day poll review message could not be identified.",
    );
  }

  let draft: PhotoDayPollDraft;
  try {
    draft = photoDayPollDraftFromModalSubmit(context.data);
  } catch (error) {
    console.error(
      "reaper-discord-interactions photo day poll modal parse failed",
      {
        message: error instanceof Error ? error.message : String(error),
      },
    );
    return interactionMessage(
      "Photo day poll edits require one question and 2-5 non-empty answer options.",
    );
  }

  try {
    const patchResponse = await patchPhotoDayPollReview(
      messageId,
      draft,
      context.discordApiUserAgent,
    );
    if (!patchResponse.ok) {
      return interactionMessage(
        `Photo day poll draft could not be updated. Discord API returned HTTP ${patchResponse.status}.`,
      );
    }
  } catch (error) {
    console.error(
      "reaper-discord-interactions photo day poll review update failed",
      {
        message: error instanceof Error ? error.message : String(error),
      },
    );
    return interactionMessage("Photo day poll draft could not be updated.");
  }

  return interactionMessage(
    `Photo day poll draft updated in <#${EXPECTED_DISCORD_PHOTO_DAY_CHANNEL_ID}>.`,
  );
}

export async function handlePhotoDayPollCommand(
  context: PhotoDayPollContext,
): Promise<Response> {
  if (!hasValidPhotoDayConfig(context, "photo day poll")) {
    return interactionMessage("Photo day poll is not configured yet.");
  }

  if (!callerHasPhotoDayModeratorAccess(context)) {
    return interactionMessage("Photo day poll requires the Moderator role.");
  }

  let draft: PhotoDayPollDraft;
  try {
    draft = buildPhotoDayPollDraft({
      question: stringOption(context.data, "question", 220),
      options: photoDayPollOptionValues(context.data),
    });
  } catch (error) {
    console.error("reaper-discord-interactions photo day poll preview failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    return interactionMessage(
      "Photo day poll requires 2-5 non-empty answer options.",
    );
  }

  try {
    const postResponse = await postPhotoDayPollReview(
      draft,
      context.discordApiUserAgent,
    );

    if (!postResponse.ok) {
      return interactionMessage(
        `Photo day poll review could not be posted. Discord API returned HTTP ${postResponse.status}.`,
      );
    }

    return interactionMessage(
      `Photo day poll review posted to <#${EXPECTED_DISCORD_PHOTO_DAY_CHANNEL_ID}> for moderator approval and editing.`,
    );
  } catch (error) {
    console.error(
      "reaper-discord-interactions photo day poll review post failed",
      {
        message: error instanceof Error ? error.message : String(error),
      },
    );
    return interactionMessage(
      "Photo day poll review could not be posted. Check Reaper bot token and channel permissions.",
    );
  }
}
