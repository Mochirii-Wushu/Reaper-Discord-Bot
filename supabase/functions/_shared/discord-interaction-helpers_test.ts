import {
  allowedImageFilename,
  asArray,
  asRecord,
  attachmentOption,
  booleanOption,
  editOriginalInteractionPayload,
  interactionMessage,
  normalizedMime,
  safeString,
  stringOption,
  successMessage,
} from "./discord-interaction-helpers.ts";

Deno.test("Discord interaction helpers build ephemeral messages", async () => {
  const response = interactionMessage("Queued.");
  const body = await response.json();

  assert(response.status === 200, "interaction response should default to 200");
  assert(body.type === 4, "interaction response should be a channel message");
  assert(
    body.data.content === "Queued.",
    "message content should be preserved",
  );
  assert(body.data.flags === 64, "message should be ephemeral");
  assert(
    Array.isArray(body.data.allowed_mentions.parse),
    "allowed mentions parse list should exist",
  );
  assert(
    body.data.allowed_mentions.parse.length === 0,
    "allowed mentions should be disabled",
  );
});

Deno.test("Discord interaction helpers parse command options", () => {
  const data = {
    options: [
      { name: "title", type: 3, value: "A".repeat(120) },
      { name: "share_to_instagram", type: 5, value: true },
      { name: "image", type: 11, value: "123456789012345678" },
    ],
    resolved: {
      attachments: {
        "123456789012345678": {
          filename: "screen.webp",
          content_type: "image/webp",
          url: "https://cdn.example.invalid/screen.webp",
        },
      },
    },
  };

  assert(
    stringOption(data, "title", 20) === "A".repeat(20),
    "string options should be trimmed to max length",
  );
  assert(
    booleanOption(data, "share_to_instagram") === true,
    "boolean option should parse true",
  );
  assert(
    attachmentOption(data, "image").filename === "screen.webp",
    "attachment should resolve by snowflake id",
  );
});

Deno.test("Discord interaction helpers bound gallery upload inputs", () => {
  assert(
    normalizedMime("image/jpg; charset=utf-8") === "image/jpeg",
    "image/jpg should normalize to jpeg",
  );
  assert(normalizedMime("image/svg+xml") === null, "svg should not be allowed");
  assert(
    allowedImageFilename("photo.PNG") === true,
    "png filename should be allowed",
  );
  assert(
    allowedImageFilename("payload.zip") === false,
    "archive filename should be rejected",
  );
  assert(
    safeString("  hello  ", 3) === "hel",
    "safeString should trim and bound text",
  );
});

Deno.test("Discord interaction helpers normalize safe records and messages", () => {
  assert(
    Object.keys(asRecord(null)).length === 0,
    "null should normalize to empty record",
  );
  assert(
    asArray("not-list").length === 0,
    "non-array should normalize to empty array",
  );
  assert(
    successMessage(true, false).includes("Instagram sharing is enabled"),
    "success message should mention enabled Instagram review",
  );
  assert(
    successMessage(false, true).includes("already in the moderation queue"),
    "duplicate message should mention existing queue item",
  );
});

Deno.test("Discord interaction transport failures redact webhook credentials", async () => {
  const interactionToken = "synthetic-interaction-token-that-must-not-leak";
  const rawTransportMessage = "synthetic transport detail that must not leak";
  const rejectingFetch = ((input: RequestInfo | URL) =>
    Promise.reject(
      new Error(`${rawTransportMessage}: ${String(input)}`),
    )) as typeof fetch;

  let thrown: unknown;
  try {
    await editOriginalInteractionPayload(
      "900000000000000013",
      interactionToken,
      { content: "Synthetic response" },
      rejectingFetch,
    );
  } catch (error) {
    thrown = error;
  }

  assert(thrown instanceof Error, "transport rejection should remain an error");
  assert(
    thrown.message === "Discord interaction response transport failed.",
    "transport rejection should expose only the fixed safe message",
  );
  assert(
    !thrown.message.includes(interactionToken) &&
      !thrown.message.includes(rawTransportMessage),
    "transport rejection must not expose the webhook token or raw error",
  );
  assert(
    !("cause" in thrown) || thrown.cause === undefined,
    "transport rejection must not retain a credential-bearing cause",
  );
});

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
