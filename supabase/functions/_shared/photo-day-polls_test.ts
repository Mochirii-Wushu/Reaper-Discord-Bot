import {
  buildPhotoDayPollDraft,
  buildPhotoDayPollEditModal,
  buildPhotoDayPollPublicMessage,
  buildPhotoDayPollReviewMessage,
  DEFAULT_PHOTO_DAY_POLL_OPTIONS,
  DEFAULT_PHOTO_DAY_POLL_QUESTION,
  EXPECTED_DISCORD_PHOTO_DAY_CHANNEL_ID,
  PHOTO_DAY_POLL_APPROVE_CUSTOM_ID,
  PHOTO_DAY_POLL_CANCEL_CUSTOM_ID,
  PHOTO_DAY_POLL_EDIT_CUSTOM_ID,
  PHOTO_DAY_POLL_MODAL_OPTIONS_ID,
  PHOTO_DAY_POLL_MODAL_QUESTION_ID,
  PHOTO_DAY_POLL_PUBLIC_TITLE,
  PHOTO_DAY_POLL_REACTION_EMOJIS,
  photoDayPollDraftFromModalSubmit,
  photoDayPollDraftFromPreviewMessage,
  sanitizePhotoDayPollText,
} from "./photo-day-polls.ts";

Deno.test("photo day poll defaults render the approved gathering-hour draft exactly", () => {
  const draft = buildPhotoDayPollDraft();

  assertEquals(draft.question, DEFAULT_PHOTO_DAY_POLL_QUESTION);
  assertEquals(draft.choices.map((choice) => choice.text), [
    ...DEFAULT_PHOTO_DAY_POLL_OPTIONS,
  ]);
  assertEquals(draft.choices.map((choice) => choice.emoji), [
    ...PHOTO_DAY_POLL_REACTION_EMOJIS,
  ]);
  assertEquals(draft.choices.map((choice) => choice.label), [
    "\u{1F30C} Saturday, 12:00 AM - 2:00 AM",
    "\u{1F989} Saturday, 2:00 AM - 4:00 AM",
    "\u{1F305} Saturday, 4:00 AM - 6:00 AM",
    "\u{2600}\u{FE0F} Saturday, 6:00 AM - 8:00 AM",
    "\u{1F324}\u{FE0F} Saturday, 8:00 AM - 10:00 AM",
  ]);
});

Deno.test("photo day poll public message mirrors the concise official structure", () => {
  const message = buildPhotoDayPollPublicMessage(buildPhotoDayPollDraft());
  const embed = asRecord(asArray(message.embeds)[0]);

  assertEquals(embed.title, PHOTO_DAY_POLL_PUBLIC_TITLE);
  assertEquals(
    embed.description,
    [
      "When can you join Guild Photo Day?",
      "",
      "Times are UTC+8. React to every answer that works for you.",
      "",
      "\u{1F30C} Saturday, 12:00 AM - 2:00 AM",
      "\u{1F989} Saturday, 2:00 AM - 4:00 AM",
      "\u{1F305} Saturday, 4:00 AM - 6:00 AM",
      "\u{2600}\u{FE0F} Saturday, 6:00 AM - 8:00 AM",
      "\u{1F324}\u{FE0F} Saturday, 8:00 AM - 10:00 AM",
      "",
      "Let's take pretty things in pretty places!",
    ].join("\n"),
  );
  assertEquals(asRecord(message.allowed_mentions).parse, []);
  assert(!String(embed.description).includes("??"), "emoji must not degrade");
});

Deno.test("photo day poll accepts sanitized question and option overrides", () => {
  const draft = buildPhotoDayPollDraft({
    question: "  @everyone choose the robe hour?  ",
    options: ["Friday dusk", "Saturday noon", "Sunday lantern hour"],
  });

  assertEquals(draft.question, "everyone choose the robe hour?");
  assertEquals(draft.choices.map((choice) => choice.label), [
    "\u{1F30C} Friday dusk",
    "\u{1F989} Saturday noon",
    "\u{1F305} Sunday lantern hour",
  ]);
});

Deno.test("photo day poll rejects invalid answer counts", () => {
  assertThrows(
    () => buildPhotoDayPollDraft({ options: ["Only one"] }),
    "one option should be rejected",
  );
  assertThrows(
    () =>
      buildPhotoDayPollDraft({
        options: ["One", "Two", "Three", "Four", "Five", "Six"],
      }),
    "six options should be rejected",
  );
});

Deno.test("photo day poll strips Discord mention formatting hazards", () => {
  const sanitized = sanitizePhotoDayPollText(
    "Gather <@123456789012345678>, <@&223456789012345678>, <#323456789012345678>, @here, and `robe` makers.",
    220,
  );

  assert(!sanitized.includes("<"), "angle brackets should be stripped");
  assert(!sanitized.includes(">"), "angle brackets should be stripped");
  assert(!sanitized.includes("@"), "at signs should be stripped");
  assert(!sanitized.includes("`"), "backticks should be stripped");
  assertEquals(
    sanitized,
    "Gather member, role, channel, here, and robe makers.",
  );
});

Deno.test("photo day poll review message round-trips approved question and answer options", () => {
  const draft = buildPhotoDayPollDraft({
    question: "When do the lanterns rise?",
    options: ["First bell", "Second bell"],
  });
  const preview = buildPhotoDayPollReviewMessage(draft);
  const rebuilt = photoDayPollDraftFromPreviewMessage({
    embeds: preview.embeds,
  });

  assertEquals(rebuilt.question, draft.question);
  assertEquals(
    rebuilt.choices.map((choice) => choice.label),
    draft.choices.map((choice) => choice.label),
  );
  assertEquals(String(preview.content).includes("Moderator review"), true);
  assertEquals(asRecord(preview.allowed_mentions).parse, []);
  assertEquals(asArray(preview.components).length, 1);
  assert(
    JSON.stringify(preview).includes(PHOTO_DAY_POLL_APPROVE_CUSTOM_ID),
    "preview should include approve button",
  );
  assert(
    JSON.stringify(preview).includes(PHOTO_DAY_POLL_CANCEL_CUSTOM_ID),
    "preview should include cancel button",
  );
  assert(
    JSON.stringify(preview).includes(PHOTO_DAY_POLL_EDIT_CUSTOM_ID),
    "preview should include edit button",
  );
  assert(
    JSON.stringify(preview).includes(EXPECTED_DISCORD_PHOTO_DAY_CHANNEL_ID),
    "preview should show target channel",
  );
});

Deno.test("photo day poll edit modal rebuilds a revised draft", () => {
  const draft = buildPhotoDayPollDraft({
    question: "Original question?",
    options: ["First bell", "Second bell"],
  });
  const modal = buildPhotoDayPollEditModal(draft);
  assertEquals(modal.custom_id, "photo_day_poll:edit_modal");
  assert(
    JSON.stringify(modal).includes(PHOTO_DAY_POLL_MODAL_QUESTION_ID),
    "modal should include question input",
  );
  assert(
    JSON.stringify(modal).includes(PHOTO_DAY_POLL_MODAL_OPTIONS_ID),
    "modal should include options input",
  );

  const revised = photoDayPollDraftFromModalSubmit({
    components: [
      {
        type: 18,
        component: {
          type: 4,
          custom_id: PHOTO_DAY_POLL_MODAL_QUESTION_ID,
          value: "Revised lantern question?",
        },
      },
      {
        type: 18,
        component: {
          type: 4,
          custom_id: PHOTO_DAY_POLL_MODAL_OPTIONS_ID,
          value: "Friday dusk\nSaturday noon",
        },
      },
    ],
  });

  assertEquals(revised.question, "Revised lantern question?");
  assertEquals(revised.choices.map((choice) => choice.label), [
    "\u{1F30C} Friday dusk",
    "\u{1F989} Saturday noon",
  ]);
});

Deno.test("photo day poll public message stays under Discord embed limits and suppresses pings", () => {
  const draft = buildPhotoDayPollDraft({
    question: "Q".repeat(500),
    options: [
      "A".repeat(200),
      "B".repeat(200),
      "C".repeat(200),
      "D".repeat(200),
      "E".repeat(200),
    ],
  });
  const message = buildPhotoDayPollPublicMessage(draft);
  const embed = asRecord(asArray(message.embeds)[0]);
  const textLength = [
    embed.title,
    embed.description,
    asRecord(embed.footer).text,
  ].join("").length;

  assert(
    textLength < 6000,
    "embed text should stay under the Discord combined text limit",
  );
  assertEquals(asRecord(message.allowed_mentions).parse, []);
});

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }.`,
    );
  }
}

function assertThrows(fn: () => unknown, message: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(message);
}
