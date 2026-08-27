const syntheticEnvironment: Record<string, string> = {
  MOCHIRII_SITE_ORIGIN: "https://guild.example",
  MOCHIRII_CORS_ORIGINS: "https://guild.example",
  DISCORD_API_ORIGIN: "https://discord-api.example",
  DISCORD_WEB_ORIGIN: "https://discord-web.example",
  SUPABASE_URL: "https://database.example",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-service-role-value",
  DISCORD_GUILD_ID: "900000000000000004",
  DISCORD_APPLICATION_ID: "900000000000000013",
  DISCORD_GALLERY_CHANNEL_ID: "900000000000000005",
  DISCORD_VOTE_CHANNEL_ID: "900000000000000008",
  DISCORD_PHOTO_DAY_CHANNEL_ID: "900000000000000011",
  DISCORD_SPOTLIGHT_POLL_CHANNEL_ID: "900000000000000014",
  DISCORD_RAFFLE_CHANNEL_ID: "900000000000000011",
  DISCORD_REQUIRED_ROLE_IDS: "900000000000000006,900000000000000007",
  DISCORD_MODERATOR_ROLE_IDS: "900000000000000002",
  DISCORD_PENDING_BASE_ROLE_ID: "900000000000000006",
  DISCORD_VERIFIED_ROLE_ID: "900000000000000007",
  DISCORD_PENDING_ALLOWED_CHANNEL_IDS: "900000000000000009,900000000000000010",
  DISCORD_MODMAIL_BOT_USER_ID: "900000000000000001",
  DISCORD_MODMAIL_LOG_CHANNEL_ID: "900000000000000003",
  DISCORD_MODMAIL_MODERATOR_ROLE_ID: "900000000000000002",
  DISCORD_SPOTLIGHT_EXCLUDED_MEMBER_IDS: "900000000000000012",
  SPOTLIGHT_EXCLUDED_MEMBER_PROFILE_IDS: "00000000-0000-4000-8000-999999999999",
  DISCORD_PUBLIC_KEY:
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  DISCORD_BOT_TOKEN: "synthetic-discord-token",
  DISCORD_GALLERY_INGEST_HMAC_KEYS_JSON:
    '{"primary":"synthetic-gallery-ingest-hmac-secret-0001"}',
  DISCORD_GALLERY_INGEST_HMAC_ACTIVE_KEY_ID: "primary",
  REAPER_PENDING_VERIFICATION_SYNC_SECRET:
    "synthetic-member-sync-secret-value-01",
  REAPER_SPINNER_DISPATCH_SECRET: "synthetic-spinner-dispatch-secret-value",
  DISCORD_VOTE_LINKS_JSON: '[{"label":"Vote","url":"https://vote.example"}]',
  VOTE_REMINDER_CRON_SECRET: "synthetic-vote-cron-secret-value-01",
  VOTE_REMINDER_TIME_ZONE: "UTC",
  SPOTLIGHT_POLL_CRON_SECRET: "synthetic-spotlight-cron-secret-value-01",
};

for (const [name, value] of Object.entries(syntheticEnvironment)) {
  Deno.env.set(name, value);
}

await import("./bounded-request-body_test.ts");
await import("./discord-gallery-ingest-signer_test.ts");
await import("./discord-gallery-ingest-contract_test.ts");
await import("./discord-interaction-helpers_test.ts");
await import("./discord-signature_test.ts");
await import("./modmail-audit_test.ts");
await import("./pending-verification-containment_test.ts");
await import("./photo-day-polls_test.ts");
await import("./reaper-discord-events_test.ts");
await import("./secret-auth_test.ts");
await import("./spinner-consumer-contract_test.ts");
await import("./spinner-media_test.ts");
await import("./spotlight-polls_test.ts");
await import("./supabase-service-role_test.ts");
await import("./vote-reminders_test.ts");
await import("./strict-json_test.ts");

const {
  canonicalDiscordGalleryAuthorizationContextBytes,
  createDiscordGalleryAuthorizationContext,
  DISCORD_GALLERY_AUTHORIZATION_CONTEXT_VERSION,
  runtimeProfileReady,
} = await import("./runtime-config.ts");
const { MAX_SHARED_SECRET_BYTES, MIN_SHARED_SECRET_BYTES } = await import(
  "./secret-auth.ts"
);

Deno.test("gallery authorization context matches the shared synthetic vector", async () => {
  const input = {
    guildId: "9000000000000001",
    galleryChannelId: "9000000000000002",
    requiredRoleMatch: "all",
    requiredRoleIds: ["9000000000000004", "9000000000000003"],
  };
  const bytes = canonicalDiscordGalleryAuthorizationContextBytes(input);
  if (!bytes) throw new Error("The shared synthetic context should be valid.");
  const expected = "version\u0000discord-gallery-authorization-context.v1\n" +
    "guild\u00009000000000000001\n" +
    "gallery-channel\u00009000000000000002\n" +
    "required-role-count\u00002\n" +
    "required-role-match\u0000all\n" +
    "required-role\u00009000000000000003\n" +
    "required-role\u00009000000000000004\n";
  if (
    bytes.byteLength !== 213 || new TextDecoder().decode(bytes) !== expected
  ) {
    throw new Error("Gallery authorization context canonical bytes drifted.");
  }

  const context = await createDiscordGalleryAuthorizationContext(input);
  if (
    context?.authorizationContextVersion !==
      DISCORD_GALLERY_AUTHORIZATION_CONTEXT_VERSION ||
    context.authorizationContextSha256 !==
      "af0e2e6f1bcc2f15633ed33fc8947684c0f86abf50fa82d51c7f849bd72450d2"
  ) {
    throw new Error("Gallery authorization context synthetic hash drifted.");
  }
});

Deno.test("gallery authorization context sorts roles by ASCII, not numeric value", async () => {
  const input = {
    guildId: "9000000000000001",
    galleryChannelId: "9000000000000002",
    requiredRoleMatch: "all",
    requiredRoleIds: ["9000000000000000", "10000000000000000"],
  };
  const bytes = canonicalDiscordGalleryAuthorizationContextBytes(input);
  const context = await createDiscordGalleryAuthorizationContext(input);
  if (
    !bytes || bytes.byteLength !== 214 ||
    !new TextDecoder().decode(bytes).endsWith(
      "required-role\u000010000000000000000\n" +
        "required-role\u00009000000000000000\n",
    ) ||
    context?.authorizationContextSha256 !==
      "70e0d0f32e819025ab8b35831e2ccd53fc2d6a95599141d4fd7761a6d79fdbab"
  ) {
    throw new Error("Gallery authorization context role ordering drifted.");
  }
});

Deno.test("gallery authorization context rejects every hostile contract vector", () => {
  const valid = {
    guildId: "9000000000000001",
    galleryChannelId: "9000000000000002",
    requiredRoleMatch: "all",
    requiredRoleIds: ["9000000000000000", "10000000000000000"],
  };
  for (
    const input of [
      {
        ...valid,
        requiredRoleIds: ["9000000000000000", "9000000000000000"],
      },
      {
        ...valid,
        requiredRoleIds: ["9000000000000001", "09000000000000001"],
      },
      { ...valid, guildId: "0000000000000000" },
      { ...valid, galleryChannelId: "18446744073709551616" },
      { ...valid, requiredRoleIds: ["9000000000000000"] },
      {
        ...valid,
        requiredRoleIds: [
          "9000000000000000",
          "10000000000000000",
          "10000000000000001",
        ],
      },
      { ...valid, guildId: " 9000000000000001" },
      { ...valid, galleryChannelId: "9000000000000002 " },
      {
        ...valid,
        requiredRoleIds: ["+9000000000000000", "10000000000000000"],
      },
      {
        ...valid,
        requiredRoleIds: ["-9000000000000000", "10000000000000000"],
      },
      {
        ...valid,
        requiredRoleIds: ["9000000000000000\u0000", "10000000000000000"],
      },
      {
        ...valid,
        requiredRoleIds: ["9000000000000000\n", "10000000000000000"],
      },
      { ...valid, requiredRoleMatch: "any" },
    ]
  ) {
    if (canonicalDiscordGalleryAuthorizationContextBytes(input) !== null) {
      throw new Error("Invalid gallery authorization context was accepted.");
    }
  }
});

Deno.test("gallery runtime requires exactly two unique required roles", () => {
  const original = Deno.env.get("DISCORD_REQUIRED_ROLE_IDS");
  try {
    for (
      const [value, expectedReady] of [
        ["900000000000000006,900000000000000007", true],
        ["900000000000000006", false],
        ["900000000000000006,900000000000000006", false],
        [
          "900000000000000006,900000000000000007,900000000000000008",
          false,
        ],
        ["900000000000000006,,900000000000000007", false],
        ["900000000000000006, 900000000000000007", false],
        ["09000000000000001,9000000000000001", false],
        ["18446744073709551616,9000000000000001", false],
        ["+9000000000000001,9000000000000002", false],
        ["-9000000000000001,9000000000000002", false],
      ] as const
    ) {
      Deno.env.set("DISCORD_REQUIRED_ROLE_IDS", value);
      if (
        runtimeProfileReady("reaper-discord-interactions") !== expectedReady
      ) {
        throw new Error(
          `Required-role configuration was misclassified: ${value}`,
        );
      }
    }
  } finally {
    if (original === undefined) Deno.env.delete("DISCORD_REQUIRED_ROLE_IDS");
    else Deno.env.set("DISCORD_REQUIRED_ROLE_IDS", original);
  }
});

Deno.test("gallery runtime rejects non-canonical guild and channel environment values", () => {
  const originalGuild = Deno.env.get("DISCORD_GUILD_ID");
  const originalChannel = Deno.env.get("DISCORD_GALLERY_CHANNEL_ID");
  try {
    for (
      const [name, value] of [
        ["DISCORD_GUILD_ID", " 9000000000000001"],
        ["DISCORD_GUILD_ID", "0000000000000000"],
        ["DISCORD_GUILD_ID", "+9000000000000001"],
        ["DISCORD_GALLERY_CHANNEL_ID", "9000000000000002 "],
        ["DISCORD_GALLERY_CHANNEL_ID", "18446744073709551616"],
      ] as const
    ) {
      if (originalGuild !== undefined) {
        Deno.env.set("DISCORD_GUILD_ID", originalGuild);
      }
      if (originalChannel !== undefined) {
        Deno.env.set("DISCORD_GALLERY_CHANNEL_ID", originalChannel);
      }
      Deno.env.set(name, value);
      if (runtimeProfileReady("reaper-discord-interactions")) {
        throw new Error(`Non-canonical ${name} was accepted: ${value}`);
      }
    }
  } finally {
    if (originalGuild === undefined) Deno.env.delete("DISCORD_GUILD_ID");
    else Deno.env.set("DISCORD_GUILD_ID", originalGuild);
    if (originalChannel === undefined) {
      Deno.env.delete("DISCORD_GALLERY_CHANNEL_ID");
    } else {
      Deno.env.set("DISCORD_GALLERY_CHANNEL_ID", originalChannel);
    }
  }
});

for (
  const profile of [
    "reaper-discord-interactions",
    "reaper-discord-member-sync",
    "reaper-spinner-dispatch",
    "send-vote-reminder",
    "send-member-spotlight-poll",
    "publish-member-spotlight-winner",
  ] as const
) {
  Deno.test(`${profile} synthetic runtime contract is complete`, () => {
    if (!runtimeProfileReady(profile)) {
      throw new Error(
        `${profile} should accept the complete synthetic contract.`,
      );
    }
  });
}

Deno.test("runtime profiles reject a Supabase URL with a path", () => {
  const original = Deno.env.get("SUPABASE_URL");
  try {
    Deno.env.set("SUPABASE_URL", "https://database.example/not-an-origin");
    if (runtimeProfileReady("send-vote-reminder")) {
      throw new Error("A path-bearing Supabase URL must fail closed.");
    }
  } finally {
    if (original === undefined) Deno.env.delete("SUPABASE_URL");
    else Deno.env.set("SUPABASE_URL", original);
  }
});

for (
  const [profile, secretName] of [
    [
      "reaper-discord-member-sync",
      "REAPER_PENDING_VERIFICATION_SYNC_SECRET",
    ],
    ["reaper-spinner-dispatch", "REAPER_SPINNER_DISPATCH_SECRET"],
    ["send-vote-reminder", "VOTE_REMINDER_CRON_SECRET"],
    ["send-member-spotlight-poll", "SPOTLIGHT_POLL_CRON_SECRET"],
    ["publish-member-spotlight-winner", "SPOTLIGHT_POLL_CRON_SECRET"],
  ] as const
) {
  Deno.test(`${profile} enforces the shared-secret byte contract`, () => {
    const original = Deno.env.get(secretName);
    try {
      const cases: Array<readonly [string, boolean, string]> = [
        ["a".repeat(MIN_SHARED_SECRET_BYTES - 1), false, "31 bytes"],
        ["a".repeat(MIN_SHARED_SECRET_BYTES), true, "32 bytes"],
        [
          "a".repeat(MAX_SHARED_SECRET_BYTES),
          true,
          `${MAX_SHARED_SECRET_BYTES} bytes`,
        ],
        [
          "a".repeat(MAX_SHARED_SECRET_BYTES + 1),
          false,
          `${MAX_SHARED_SECRET_BYTES + 1} bytes`,
        ],
        [` ${"a".repeat(MIN_SHARED_SECRET_BYTES)}`, false, "leading space"],
        [`${"a".repeat(MIN_SHARED_SECRET_BYTES)} `, false, "trailing space"],
        [`${"a".repeat(16)} ${"b".repeat(16)}`, false, "internal space"],
        [`${"a".repeat(MIN_SHARED_SECRET_BYTES)}\t`, false, "tab"],
        [`${"a".repeat(MIN_SHARED_SECRET_BYTES)}\n`, false, "newline"],
        [`${"a".repeat(MIN_SHARED_SECRET_BYTES)}\u0000`, false, "NUL"],
        [`${"a".repeat(MIN_SHARED_SECRET_BYTES)}\u007f`, false, "DEL"],
        ["é".repeat(MIN_SHARED_SECRET_BYTES), false, "non-ASCII"],
      ];

      for (const [value, expectedReady, description] of cases) {
        try {
          Deno.env.set(secretName, value);
        } catch {
          if (!expectedReady) continue;
          throw new Error(
            `${profile} could not configure the accepted ${description} case.`,
          );
        }
        if (runtimeProfileReady(profile) !== expectedReady) {
          throw new Error(
            `${profile} should ${
              expectedReady ? "accept" : "reject"
            } ${description}.`,
          );
        }
      }
    } finally {
      if (original === undefined) Deno.env.delete(secretName);
      else Deno.env.set(secretName, original);
    }
  });
}

Deno.test("Discord gallery interaction runtime requires one valid active HMAC key", () => {
  const originalKeys = Deno.env.get("DISCORD_GALLERY_INGEST_HMAC_KEYS_JSON");
  const originalActiveKey = Deno.env.get(
    "DISCORD_GALLERY_INGEST_HMAC_ACTIVE_KEY_ID",
  );
  try {
    const cases: Array<readonly [string, string, boolean]> = [
      ['{"primary":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', "primary", true],
      ['{"primary":"short"}', "primary", false],
      ['{"primary":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', "missing", false],
      ["not-json", "primary", false],
      ["{}", "primary", false],
    ];
    for (const [keys, activeKey, expectedReady] of cases) {
      Deno.env.set("DISCORD_GALLERY_INGEST_HMAC_KEYS_JSON", keys);
      Deno.env.set("DISCORD_GALLERY_INGEST_HMAC_ACTIVE_KEY_ID", activeKey);
      if (
        runtimeProfileReady("reaper-discord-interactions") !== expectedReady
      ) {
        throw new Error(
          `reaper-discord-interactions should ${
            expectedReady ? "accept" : "reject"
          } the HMAC fixture.`,
        );
      }
    }
  } finally {
    if (originalKeys === undefined) {
      Deno.env.delete("DISCORD_GALLERY_INGEST_HMAC_KEYS_JSON");
    } else {
      Deno.env.set("DISCORD_GALLERY_INGEST_HMAC_KEYS_JSON", originalKeys);
    }
    if (originalActiveKey === undefined) {
      Deno.env.delete("DISCORD_GALLERY_INGEST_HMAC_ACTIVE_KEY_ID");
    } else {
      Deno.env.set(
        "DISCORD_GALLERY_INGEST_HMAC_ACTIVE_KEY_ID",
        originalActiveKey,
      );
    }
  }
});

Deno.test("runtime profiles accept opaque provider-issued credentials", () => {
  const originals = {
    botToken: Deno.env.get("DISCORD_BOT_TOKEN"),
    serviceRole: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),
  };
  try {
    Deno.env.set("DISCORD_BOT_TOKEN", "x");
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "y");
    for (
      const profile of [
        "reaper-discord-interactions",
        "reaper-discord-member-sync",
        "reaper-spinner-dispatch",
        "send-vote-reminder",
        "send-member-spotlight-poll",
        "publish-member-spotlight-winner",
      ] as const
    ) {
      if (!runtimeProfileReady(profile)) {
        throw new Error(
          `${profile} must treat nonempty provider credentials as opaque.`,
        );
      }
    }
  } finally {
    if (originals.botToken === undefined) Deno.env.delete("DISCORD_BOT_TOKEN");
    else Deno.env.set("DISCORD_BOT_TOKEN", originals.botToken);
    if (originals.serviceRole === undefined) {
      Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    } else {
      Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", originals.serviceRole);
    }
  }
});
