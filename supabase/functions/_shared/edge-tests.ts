const syntheticEnvironment: Record<string, string> = {
  MOCHIRII_SITE_ORIGIN: "https://guild.example",
  MOCHIRII_CORS_ORIGINS: "https://guild.example",
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
  DISCORD_GALLERY_INGEST_SECRET: "synthetic-gallery-ingest-secret-value-01",
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

const { runtimeProfileReady } = await import("./runtime-config.ts");
const { MAX_SHARED_SECRET_BYTES, MIN_SHARED_SECRET_BYTES } = await import(
  "./secret-auth.ts"
);
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
    ["reaper-discord-interactions", "DISCORD_GALLERY_INGEST_SECRET"],
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
        ["a".repeat(MAX_SHARED_SECRET_BYTES), true, "512 bytes"],
        ["a".repeat(MAX_SHARED_SECRET_BYTES + 1), false, "513 bytes"],
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
