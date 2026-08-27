import { DISCORD_PHOTO_DAY_CHANNEL_ID } from "./runtime-config.ts";

export type JsonRecord = Record<string, unknown>;

export type PhotoDayPollDraftInput = {
  question?: unknown;
  options?: unknown[];
};

export type PhotoDayPollChoice = {
  emoji: string;
  text: string;
  label: string;
};

export type PhotoDayPollDraft = {
  question: string;
  choices: PhotoDayPollChoice[];
};

export const EXPECTED_DISCORD_PHOTO_DAY_CHANNEL_ID =
  DISCORD_PHOTO_DAY_CHANNEL_ID;
export const PHOTO_DAY_POLL_APPROVE_CUSTOM_ID = "photo_day_poll:approve";
export const PHOTO_DAY_POLL_EDIT_CUSTOM_ID = "photo_day_poll:edit";
export const PHOTO_DAY_POLL_EDIT_MODAL_CUSTOM_ID = "photo_day_poll:edit_modal";
export const PHOTO_DAY_POLL_CANCEL_CUSTOM_ID = "photo_day_poll:cancel";
export const PHOTO_DAY_POLL_PUBLIC_TITLE =
  "Guild Photo Day: Choose Your Gathering Hour";
export const PHOTO_DAY_POLL_PREVIEW_TITLE =
  "Moderator Review: Guild Photo Day Poll";
export const PHOTO_DAY_POLL_REACTION_EMOJIS = [
  "\u{1F30C}",
  "\u{1F989}",
  "\u{1F305}",
  "\u{2600}\u{FE0F}",
  "\u{1F324}\u{FE0F}",
];
export const PHOTO_DAY_POLL_MODAL_QUESTION_ID = "photo_day_poll_question";
export const PHOTO_DAY_POLL_MODAL_OPTIONS_ID = "photo_day_poll_options";

export const DEFAULT_PHOTO_DAY_POLL_QUESTION =
  "When can you join Guild Photo Day?";
export const DEFAULT_PHOTO_DAY_POLL_OPTIONS = [
  "Saturday, 12:00 AM - 2:00 AM",
  "Saturday, 2:00 AM - 4:00 AM",
  "Saturday, 4:00 AM - 6:00 AM",
  "Saturday, 6:00 AM - 8:00 AM",
  "Saturday, 8:00 AM - 10:00 AM",
];

const PHOTO_DAY_POLL_PUBLIC_DESCRIPTION =
  "Times are UTC+8. React to every answer that works for you.";
const PHOTO_DAY_POLL_CLOSING_LINE =
  "Let's take pretty things in pretty places!";
const PHOTO_DAY_POLL_COLOR = 0xf2c75c;
const EPHEMERAL_FLAG = 1 << 6;
const MIN_PHOTO_DAY_POLL_OPTIONS = 2;
const MAX_PHOTO_DAY_POLL_OPTIONS = 5;
const MAX_QUESTION_LENGTH = 220;
const MAX_OPTION_LENGTH = 90;
const DISCORD_EMBED_TOTAL_TEXT_LIMIT = 6000;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textField(value: unknown): string {
  return String(value ?? "");
}

function truncate(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

export function sanitizePhotoDayPollText(
  value: unknown,
  maxLength: number,
): string {
  const text = truncate(textField(value), maxLength * 2)
    .replace(/<@&\d{16,22}>/g, "role")
    .replace(/<@!?\d{16,22}>/g, "member")
    .replace(/<#\d{16,22}>/g, "channel")
    .replace(/@everyone/gi, "everyone")
    .replace(/@here/gi, "here")
    .replace(/@/g, "at ")
    .replace(/[<>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return truncate(text, maxLength).trim();
}

function stripLeadingReactionEmoji(value: string): string {
  const text = value.trim();
  for (const emoji of PHOTO_DAY_POLL_REACTION_EMOJIS) {
    if (text.startsWith(emoji)) return text.slice(emoji.length).trim();
  }
  return text;
}

function normalizeOptions(options: unknown[] | undefined): string[] {
  const source = options ? options : DEFAULT_PHOTO_DAY_POLL_OPTIONS;
  return source
    .map((option) =>
      stripLeadingReactionEmoji(
        sanitizePhotoDayPollText(option, MAX_OPTION_LENGTH),
      )
    )
    .filter(Boolean);
}

export function buildPhotoDayPollDraft(
  input: PhotoDayPollDraftInput = {},
): PhotoDayPollDraft {
  const question =
    sanitizePhotoDayPollText(input.question, MAX_QUESTION_LENGTH) ||
    DEFAULT_PHOTO_DAY_POLL_QUESTION;
  const options = normalizeOptions(input.options);

  if (
    options.length < MIN_PHOTO_DAY_POLL_OPTIONS ||
    options.length > MAX_PHOTO_DAY_POLL_OPTIONS
  ) {
    throw new Error("Photo day poll requires 2-5 non-empty answer options.");
  }

  return {
    question,
    choices: options.map((text, index) => {
      const emoji = PHOTO_DAY_POLL_REACTION_EMOJIS[index];
      return {
        emoji,
        text,
        label: `${emoji} ${text}`,
      };
    }),
  };
}

function choiceLines(draft: PhotoDayPollDraft): string[] {
  return draft.choices.map((choice) => choice.label);
}

function numberedChoiceLines(draft: PhotoDayPollDraft): string[] {
  return draft.choices.map((choice, index) => `${index + 1}. ${choice.label}`);
}

function allowedMentions(): JsonRecord {
  return {
    parse: [],
  };
}

function embedTextLength(embed: JsonRecord): number {
  const footer = asRecord(embed.footer);
  const fields = asArray(embed.fields).map(asRecord);
  return [
    textField(embed.title),
    textField(embed.description),
    textField(footer.text),
    ...fields.flatMap((
      field,
    ) => [textField(field.name), textField(field.value)]),
  ].reduce((total, value) => total + value.length, 0);
}

function assertEmbedLimit(embed: JsonRecord): void {
  if (embedTextLength(embed) > DISCORD_EMBED_TOTAL_TEXT_LIMIT) {
    throw new Error("Photo day poll embed exceeds Discord text limits.");
  }
}

export function buildPhotoDayPollPublicEmbed(
  draft: PhotoDayPollDraft,
): JsonRecord {
  const embed = {
    title: PHOTO_DAY_POLL_PUBLIC_TITLE,
    description: [
      draft.question,
      "",
      PHOTO_DAY_POLL_PUBLIC_DESCRIPTION,
      "",
      ...choiceLines(draft),
      "",
      PHOTO_DAY_POLL_CLOSING_LINE,
    ].join("\n"),
    color: PHOTO_DAY_POLL_COLOR,
  };

  assertEmbedLimit(embed);
  return embed;
}

export function buildPhotoDayPollPublicMessage(
  draft: PhotoDayPollDraft,
): JsonRecord {
  return {
    content: "",
    embeds: [buildPhotoDayPollPublicEmbed(draft)],
    components: [],
    allowed_mentions: allowedMentions(),
  };
}

export function buildPhotoDayPollPreviewEmbed(
  draft: PhotoDayPollDraft,
): JsonRecord {
  const embed = {
    title: PHOTO_DAY_POLL_PREVIEW_TITLE,
    description:
      "Review the exact question and answer options. Nothing is sent until Approve & Send is clicked.",
    color: PHOTO_DAY_POLL_COLOR,
    fields: [
      {
        name: "Target Channel",
        value: `<#${EXPECTED_DISCORD_PHOTO_DAY_CHANNEL_ID}>`,
        inline: false,
      },
      {
        name: "Question",
        value: draft.question,
        inline: false,
      },
      {
        name: "Answer Options",
        value: numberedChoiceLines(draft).join("\n"),
        inline: false,
      },
      {
        name: "Starter Reactions",
        value: draft.choices.map((choice) => choice.emoji).join(" "),
        inline: false,
      },
    ],
    footer: {
      text: "Only moderators can approve this Reaper poll preview.",
    },
  };

  assertEmbedLimit(embed);
  return embed;
}

export function buildPhotoDayPollPreviewInteractionData(
  draft: PhotoDayPollDraft,
): JsonRecord {
  const review = buildPhotoDayPollReviewMessage(draft);
  return {
    content:
      "Guild Photo Day poll preview. Please approve the exact wording before Reaper sends it.",
    flags: EPHEMERAL_FLAG,
    embeds: review.embeds,
    components: review.components,
    allowed_mentions: allowedMentions(),
  };
}

export function buildPhotoDayPollReviewMessage(
  draft: PhotoDayPollDraft,
): JsonRecord {
  return {
    content:
      "Moderator review for Guild Photo Day. Edit the draft if needed, then approve it when the wording is ready.",
    embeds: [buildPhotoDayPollPreviewEmbed(draft)],
    components: [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 3,
            label: "Approve & Send",
            custom_id: PHOTO_DAY_POLL_APPROVE_CUSTOM_ID,
          },
          {
            type: 2,
            style: 1,
            label: "Edit Draft",
            custom_id: PHOTO_DAY_POLL_EDIT_CUSTOM_ID,
          },
          {
            type: 2,
            style: 4,
            label: "Cancel",
            custom_id: PHOTO_DAY_POLL_CANCEL_CUSTOM_ID,
          },
        ],
      },
    ],
    allowed_mentions: allowedMentions(),
  };
}

export function buildPhotoDayPollStatusInteractionData(
  content: string,
): JsonRecord {
  return {
    content: truncate(content, 1900),
    embeds: [],
    components: [],
    allowed_mentions: allowedMentions(),
  };
}

function modalInput(
  customId: string,
  label: string,
  value: string,
  maxLength: number,
  style = 1,
): JsonRecord {
  return {
    type: 18,
    label,
    component: {
      type: 4,
      custom_id: customId,
      style,
      min_length: 1,
      max_length: maxLength,
      required: true,
      value,
    },
  };
}

export function buildPhotoDayPollEditModal(
  draft: PhotoDayPollDraft,
): JsonRecord {
  return {
    custom_id: PHOTO_DAY_POLL_EDIT_MODAL_CUSTOM_ID,
    title: "Edit Guild Photo Day Poll",
    components: [
      modalInput(
        PHOTO_DAY_POLL_MODAL_QUESTION_ID,
        "Question",
        draft.question,
        MAX_QUESTION_LENGTH,
        2,
      ),
      modalInput(
        PHOTO_DAY_POLL_MODAL_OPTIONS_ID,
        "Options, one per line",
        draft.choices.map((choice) => choice.label).join("\n"),
        MAX_OPTION_LENGTH * MAX_PHOTO_DAY_POLL_OPTIONS,
        2,
      ),
    ],
  };
}

function previewField(embed: JsonRecord, name: string): string {
  const field = asArray(embed.fields)
    .map(asRecord)
    .find((candidate) => textField(candidate.name) === name);
  return textField(field?.value).trim();
}

function parsePreviewOptions(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+\.\s*/, "").trim())
    .filter(Boolean);
}

export function photoDayPollDraftFromPreviewMessage(
  message: JsonRecord,
): PhotoDayPollDraft {
  const embed = asArray(message.embeds)
    .map(asRecord)
    .find((candidate) =>
      textField(candidate.title) === PHOTO_DAY_POLL_PREVIEW_TITLE
    );

  if (!embed) {
    throw new Error("Photo day poll preview could not be read.");
  }

  const question = previewField(embed, "Question");
  const options = parsePreviewOptions(previewField(embed, "Answer Options"));
  return buildPhotoDayPollDraft({ question, options });
}

function modalInputValue(data: JsonRecord, customId: string): string {
  for (const row of asArray(data.components).map(asRecord)) {
    const component = asRecord(row.component);
    if (textField(component.custom_id) === customId) {
      return textField(component.value);
    }

    for (const nested of asArray(row.components).map(asRecord)) {
      if (textField(nested.custom_id) === customId) {
        return textField(nested.value);
      }
    }
  }

  return "";
}

export function photoDayPollDraftFromModalSubmit(
  data: JsonRecord,
): PhotoDayPollDraft {
  const question = modalInputValue(data, PHOTO_DAY_POLL_MODAL_QUESTION_ID);
  const options = modalInputValue(data, PHOTO_DAY_POLL_MODAL_OPTIONS_ID)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return buildPhotoDayPollDraft({ question, options });
}
