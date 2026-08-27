import {
  allowedImageFilename,
  asArray,
  asRecord,
  attachmentOption,
  booleanOption,
  canonicalDeclaredImageMime,
  canonicalDiscordGalleryAttachmentUrl,
  canonicalGalleryAttachmentSize,
  DISCORD_GALLERY_ATTACHMENT_MAX_BYTES,
  DISCORD_GALLERY_SUBMISSION_PAYLOAD_KEYS,
  discordGallerySubmissionPayload,
  editOriginalInteractionPayload,
  exactBoundedString,
  exactOptionalBooleanOption,
  exactOptionalStringOption,
  imageFilenameMatchesMime,
  interactionMessage,
  normalizedMime,
  safeString,
  snowflake,
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
          id: "223456789012345678",
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
    attachmentOption(data, "image").filename === "screen.webp" &&
      attachmentOption(data, "image").id === "123456789012345678",
    "attachment should resolve and stay bound to its option snowflake",
  );
});

Deno.test("Discord interaction helpers bound gallery upload inputs", () => {
  const channelId = "9000000000000001";
  const attachmentId = "9000000000000002";
  const attachmentUrl =
    `https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/photo.PNG?ex=abc`;
  assert(
    snowflake(channelId) === channelId &&
      snowflake("09000000000000001") === null &&
      snowflake("18446744073709551616") === null && snowflake(9e15) === null,
    "gallery IDs must be canonical positive uint64 decimal strings",
  );
  assert(
    canonicalDiscordGalleryAttachmentUrl(
      attachmentUrl,
      channelId,
      attachmentId,
    ) === attachmentUrl,
    "the exact canonical Discord attachment URL should pass",
  );
  assert(
    canonicalDiscordGalleryAttachmentUrl(
          attachmentUrl,
          "9000000000000003",
          attachmentId,
        ) === null &&
      canonicalDiscordGalleryAttachmentUrl(
          attachmentUrl,
          channelId,
          "9000000000000003",
        ) === null,
    "attachment URL path IDs must match the signed payload IDs",
  );
  assert(
    canonicalDiscordGalleryAttachmentUrl(
          ` https://cdn.discordapp.com/attachments/${channelId}/${attachmentId}/photo.png`,
          channelId,
          attachmentId,
        ) === null &&
      canonicalDiscordGalleryAttachmentUrl(
          `https://other.synthetic.test/attachments/${channelId}/${attachmentId}/photo.png`,
          channelId,
          attachmentId,
        ) === null,
    "non-canonical or non-Discord attachment URLs must fail closed",
  );
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
  for (const missingMime of [undefined, null]) {
    assert(
      canonicalDeclaredImageMime(missingMime) === null &&
        !imageFilenameMatchesMime("photo.png", missingMime),
      "a missing or null declared MIME must fail closed",
    );
  }
  assert(
    imageFilenameMatchesMime("photo.JPG", "image/jpeg") &&
      imageFilenameMatchesMime("photo.jpeg", "image/jpeg"),
    "JPEG filename aliases should match the canonical JPEG MIME",
  );
  assert(
    canonicalDeclaredImageMime("image/jpg") === null &&
      canonicalDeclaredImageMime("image/jpeg; charset=utf-8") === null &&
      canonicalDeclaredImageMime(" IMAGE/JPEG ") === null &&
      !imageFilenameMatchesMime("photo.jpg", "image/jpg"),
    "a non-canonical declared MIME alias, parameter, case, or space must fail closed",
  );
  assert(
    !imageFilenameMatchesMime("photo.png", "image/webp"),
    "a filename/MIME mismatch must fail closed",
  );
  assert(
    canonicalGalleryAttachmentSize(1) === 1 &&
      canonicalGalleryAttachmentSize(DISCORD_GALLERY_ATTACHMENT_MAX_BYTES) ===
        DISCORD_GALLERY_ATTACHMENT_MAX_BYTES,
    "gallery size boundaries should be accepted exactly",
  );
  for (
    const invalidSize of [
      undefined,
      null,
      "1",
      0,
      -1,
      1.5,
      Number.NaN,
      Number.MAX_SAFE_INTEGER + 1,
      DISCORD_GALLERY_ATTACHMENT_MAX_BYTES + 1,
    ]
  ) {
    assert(
      canonicalGalleryAttachmentSize(invalidSize) === null,
      "invalid gallery sizes must fail closed without coercion",
    );
  }
  assert(
    exactBoundedString("photo.PNG", 255) === "photo.PNG" &&
      exactBoundedString(" photo.PNG", 255) === null &&
      exactBoundedString("photo\uFEFF.PNG", 255) === null &&
      exactBoundedString("x".repeat(256), 255) === null,
    "signed filenames must be exact, trim-stable, U+FEFF-free, and bounded",
  );
  const exactOptions = {
    options: [
      { name: "title", type: 3, value: "Lantern" },
      { name: "subtitle", type: 3, value: "Quiet evening" },
    ],
  };
  assert(
    exactOptionalStringOption(exactOptions, "title", 80).value === "Lantern" &&
      exactOptionalStringOption(exactOptions, "missing", 80).value === null,
    "optional signed text should preserve exact values and explicit null",
  );
  for (const invalidText of ["", " padded", "a\uFEFFb", "x".repeat(81)]) {
    assert(
      !exactOptionalStringOption(
        { options: [{ name: "title", type: 3, value: invalidText }] },
        "title",
        80,
      ).ok,
      "empty, non-trim-stable, or oversized signed text must fail closed",
    );
  }
  assert(
    exactOptionalBooleanOption(exactOptions, "share_to_instagram").value ===
        false &&
      exactOptionalBooleanOption(
          {
            options: [
              { name: "share_to_instagram", type: 5, value: true },
            ],
          },
          "share_to_instagram",
        ).value === true &&
      exactOptionalBooleanOption(
        {
          options: [
            { name: "share_to_instagram", type: 5, value: false },
          ],
        },
        "share_to_instagram",
      ).ok,
    "optional Instagram consent should default only when absent and preserve exact booleans",
  );
  for (const invalidConsent of ["false", 0, null]) {
    assert(
      !exactOptionalBooleanOption(
        {
          options: [
            { name: "share_to_instagram", type: 5, value: invalidConsent },
          ],
        },
        "share_to_instagram",
      ).ok,
      "a malformed present Instagram consent option must fail closed",
    );
  }
  assert(
    safeString("  hello  ", 3) === "hel",
    "safeString should trim and bound text",
  );
  const payload = discordGallerySubmissionPayload({
    guildId: channelId,
    channelId,
    messageId: "9000000000000003",
    attachmentId,
    discordUserId: "9000000000000004",
    attachmentUrl,
    mimeType: "image/png",
    sizeBytes: 1,
    originalFilename: "photo.PNG",
    title: null,
    caption: null,
    instagramOptIn: false,
    authorizationContextVersion: "discord-gallery-authorization-context.v1",
    authorizationContextSha256: "a".repeat(64),
  });
  assert(
    JSON.stringify(Object.keys(payload)) ===
        JSON.stringify(DISCORD_GALLERY_SUBMISSION_PAYLOAD_KEYS) &&
      payload.title === null && payload.caption === null,
    "signed gallery payloads must emit exactly 14 keys with explicit null optionals",
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
