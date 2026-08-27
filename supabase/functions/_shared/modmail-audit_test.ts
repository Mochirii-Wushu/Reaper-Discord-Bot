import {
  buildModmailAudit,
  EMBED_LINKS_PERMISSION,
  type JsonRecord,
  MENTION_EVERYONE_PERMISSION,
  MODMAIL_BOT_USER_ID,
  MODMAIL_LOG_CHANNEL_ID,
  MODMAIL_MODERATOR_ROLE_ID,
  READ_MESSAGE_HISTORY_PERMISSION,
  SEND_MESSAGES_PERMISSION,
  VIEW_CHANNEL_PERMISSION,
} from "./modmail-audit.ts";

const GUILD_ID = "900000000000000004";
const BOT_ROLE_ID = "900000000000000015";

function bits(...permissions: bigint[]): string {
  return permissions.reduce((value, permission) => value | permission, 0n)
    .toString();
}

function baseFixture(overrides: Partial<{
  roles: JsonRecord[];
  channels: JsonRecord[];
  members: JsonRecord[];
  modmailMember: JsonRecord | null;
}> = {}) {
  const roles: JsonRecord[] = [
    {
      id: GUILD_ID,
      name: "@everyone",
      permissions: VIEW_CHANNEL_PERMISSION.toString(),
      mentionable: false,
    },
    {
      id: MODMAIL_MODERATOR_ROLE_ID,
      name: "Moderator",
      permissions: "0",
      mentionable: false,
    },
    {
      id: BOT_ROLE_ID,
      name: "ModMail",
      permissions: bits(
        VIEW_CHANNEL_PERMISSION,
        SEND_MESSAGES_PERMISSION,
        EMBED_LINKS_PERMISSION,
        READ_MESSAGE_HISTORY_PERMISSION,
        MENTION_EVERYONE_PERMISSION,
      ),
      mentionable: false,
    },
  ];
  const channels: JsonRecord[] = [
    {
      id: MODMAIL_LOG_CHANNEL_ID,
      name: "modmail-logs",
      type: 0,
      permission_overwrites: [
        {
          id: GUILD_ID,
          type: 0,
          allow: "0",
          deny: VIEW_CHANNEL_PERMISSION.toString(),
        },
        {
          id: MODMAIL_MODERATOR_ROLE_ID,
          type: 0,
          allow: bits(VIEW_CHANNEL_PERMISSION, READ_MESSAGE_HISTORY_PERMISSION),
          deny: "0",
        },
        {
          id: BOT_ROLE_ID,
          type: 0,
          allow: bits(
            VIEW_CHANNEL_PERMISSION,
            SEND_MESSAGES_PERMISSION,
            EMBED_LINKS_PERMISSION,
            READ_MESSAGE_HISTORY_PERMISSION,
            MENTION_EVERYONE_PERMISSION,
          ),
          deny: "0",
        },
      ],
    },
  ];
  const modmailMember = {
    user: { id: MODMAIL_BOT_USER_ID },
    roles: [BOT_ROLE_ID],
  };
  const members: JsonRecord[] = [
    modmailMember,
    { user: { id: "900000000000000016" }, roles: [MODMAIL_MODERATOR_ROLE_ID] },
  ];

  return {
    guildId: GUILD_ID,
    roles: overrides.roles ?? roles,
    channels: overrides.channels ?? channels,
    members: overrides.members ?? members,
    modmailMember: overrides.modmailMember === undefined
      ? modmailMember
      : overrides.modmailMember,
  };
}

function check(result: ReturnType<typeof buildModmailAudit>, key: string) {
  const found = result.checks.find((item) => item.key === key);
  if (!found) throw new Error(`Missing check ${key}`);
  return found;
}

Deno.test("ModMail audit passes when bot, Moderator role, private log channel, and permissions are ready", () => {
  const result = buildModmailAudit(baseFixture());
  if (!result.ok) {
    throw new Error(
      `Expected audit pass: ${JSON.stringify(result.checks, null, 2)}`,
    );
  }
});

Deno.test("ModMail audit reports missing bot", () => {
  const fixture = baseFixture({
    modmailMember: null,
    members: [{
      user: { id: "900000000000000016" },
      roles: [MODMAIL_MODERATOR_ROLE_ID],
    }],
  });
  const result = buildModmailAudit(fixture);
  if (check(result, "modmail-bot-present").ok) {
    throw new Error("Expected missing bot to fail.");
  }
});

Deno.test("ModMail audit reports missing Moderator role", () => {
  const fixture = baseFixture({
    roles: baseFixture().roles.filter((role) =>
      role.id !== MODMAIL_MODERATOR_ROLE_ID
    ),
  });
  const result = buildModmailAudit(fixture);
  if (check(result, "moderator-role-present").ok) {
    throw new Error("Expected missing Moderator role to fail.");
  }
});

Deno.test("ModMail audit reports missing log channel", () => {
  const result = buildModmailAudit(baseFixture({ channels: [] }));
  if (check(result, "log-channel-present").ok) {
    throw new Error("Expected missing log channel to fail.");
  }
});

Deno.test("ModMail audit reports public log channel", () => {
  const fixture = baseFixture();
  const publicChannel = {
    ...fixture.channels[0],
    permission_overwrites: [
      {
        id: MODMAIL_MODERATOR_ROLE_ID,
        type: 0,
        allow: bits(VIEW_CHANNEL_PERMISSION, READ_MESSAGE_HISTORY_PERMISSION),
        deny: "0",
      },
      {
        id: BOT_ROLE_ID,
        type: 0,
        allow: bits(
          VIEW_CHANNEL_PERMISSION,
          SEND_MESSAGES_PERMISSION,
          EMBED_LINKS_PERMISSION,
          READ_MESSAGE_HISTORY_PERMISSION,
          MENTION_EVERYONE_PERMISSION,
        ),
        deny: "0",
      },
    ],
  };
  const result = buildModmailAudit(baseFixture({ channels: [publicChannel] }));
  if (check(result, "log-channel-private").ok) {
    throw new Error("Expected public log channel to fail.");
  }
});

Deno.test("ModMail audit reports Moderator role lacking read permissions", () => {
  const fixture = baseFixture();
  const channel = {
    ...fixture.channels[0],
    permission_overwrites: [
      {
        id: GUILD_ID,
        type: 0,
        allow: "0",
        deny: VIEW_CHANNEL_PERMISSION.toString(),
      },
      {
        id: MODMAIL_MODERATOR_ROLE_ID,
        type: 0,
        allow: VIEW_CHANNEL_PERMISSION.toString(),
        deny: READ_MESSAGE_HISTORY_PERMISSION.toString(),
      },
    ],
  };
  const result = buildModmailAudit(baseFixture({ channels: [channel] }));
  if (check(result, "moderator-can-read-log").ok) {
    throw new Error("Expected Moderator read check to fail.");
  }
});

Deno.test("ModMail audit reports ModMail bot lacking write permissions", () => {
  const fixture = baseFixture();
  const channel = {
    ...fixture.channels[0],
    permission_overwrites: [
      {
        id: GUILD_ID,
        type: 0,
        allow: "0",
        deny: VIEW_CHANNEL_PERMISSION.toString(),
      },
      {
        id: MODMAIL_MODERATOR_ROLE_ID,
        type: 0,
        allow: bits(VIEW_CHANNEL_PERMISSION, READ_MESSAGE_HISTORY_PERMISSION),
        deny: "0",
      },
      {
        id: BOT_ROLE_ID,
        type: 0,
        allow: bits(
          VIEW_CHANNEL_PERMISSION,
          READ_MESSAGE_HISTORY_PERMISSION,
          MENTION_EVERYONE_PERMISSION,
        ),
        deny: bits(SEND_MESSAGES_PERMISSION, EMBED_LINKS_PERMISSION),
      },
    ],
  };
  const result = buildModmailAudit(baseFixture({ channels: [channel] }));
  if (check(result, "modmail-can-write-log").ok) {
    throw new Error("Expected ModMail write check to fail.");
  }
});

Deno.test("ModMail audit requires non-mentionable Moderator role and scoped bot mention permission", () => {
  const fixture = baseFixture();
  const mentionableRoles = fixture.roles.map((role) =>
    role.id === MODMAIL_MODERATOR_ROLE_ID
      ? { ...role, mentionable: true }
      : role
  );
  const mentionableResult = buildModmailAudit(
    baseFixture({ roles: mentionableRoles }),
  );
  if (check(mentionableResult, "moderator-role-not-globally-mentionable").ok) {
    throw new Error("Expected globally mentionable Moderator role to fail.");
  }

  const missingMentionChannel = {
    ...fixture.channels[0],
    permission_overwrites: [
      {
        id: GUILD_ID,
        type: 0,
        allow: "0",
        deny: VIEW_CHANNEL_PERMISSION.toString(),
      },
      {
        id: MODMAIL_MODERATOR_ROLE_ID,
        type: 0,
        allow: bits(VIEW_CHANNEL_PERMISSION, READ_MESSAGE_HISTORY_PERMISSION),
        deny: "0",
      },
      {
        id: BOT_ROLE_ID,
        type: 0,
        allow: bits(
          VIEW_CHANNEL_PERMISSION,
          SEND_MESSAGES_PERMISSION,
          EMBED_LINKS_PERMISSION,
          READ_MESSAGE_HISTORY_PERMISSION,
        ),
        deny: MENTION_EVERYONE_PERMISSION.toString(),
      },
    ],
  };
  const missingMentionResult = buildModmailAudit(
    baseFixture({ channels: [missingMentionChannel] }),
  );
  if (check(missingMentionResult, "modmail-can-mention-moderators").ok) {
    throw new Error("Expected missing scoped mention permission to fail.");
  }
});
