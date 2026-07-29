import {
  MODMAIL_BOT_USER_ID as CONFIGURED_MODMAIL_BOT_USER_ID,
  MODMAIL_LOG_CHANNEL_ID as CONFIGURED_MODMAIL_LOG_CHANNEL_ID,
  MODMAIL_MODERATOR_ROLE_ID as CONFIGURED_MODMAIL_MODERATOR_ROLE_ID,
} from "./runtime-config.ts";

export type JsonRecord = Record<string, unknown>;

export const MODMAIL_BOT_USER_ID = CONFIGURED_MODMAIL_BOT_USER_ID;
export const MODMAIL_LOG_CHANNEL_ID = CONFIGURED_MODMAIL_LOG_CHANNEL_ID;
export const MODMAIL_MODERATOR_ROLE_ID = CONFIGURED_MODMAIL_MODERATOR_ROLE_ID;
export const GUILD_TEXT_CHANNEL_TYPE = 0;
export const ROLE_OVERWRITE_TYPE = 0;
export const MEMBER_OVERWRITE_TYPE = 1;
export const VIEW_CHANNEL_PERMISSION = 1n << 10n;
export const SEND_MESSAGES_PERMISSION = 1n << 11n;
export const EMBED_LINKS_PERMISSION = 1n << 14n;
export const READ_MESSAGE_HISTORY_PERMISSION = 1n << 16n;
export const MENTION_EVERYONE_PERMISSION = 1n << 17n;
const ADMINISTRATOR_PERMISSION = 1n << 3n;
const ALL_AUDITED_PERMISSIONS = VIEW_CHANNEL_PERMISSION |
  SEND_MESSAGES_PERMISSION |
  EMBED_LINKS_PERMISSION |
  READ_MESSAGE_HISTORY_PERMISSION |
  MENTION_EVERYONE_PERMISSION;

export type ModmailAuditCheck = {
  key: string;
  label: string;
  ok: boolean;
  detail: string;
  fix: string;
};

export type ModmailAuditResult = {
  ok: boolean;
  checks: ModmailAuditCheck[];
  note: string;
};

export type ModmailAuditInput = {
  guildId: string;
  botUserId?: string;
  logChannelId?: string;
  moderatorRoleId?: string;
  roles: JsonRecord[];
  channels: JsonRecord[];
  members: JsonRecord[];
  modmailMember: JsonRecord | null;
};

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function snowflake(value: unknown): string {
  const text = String(value || "").trim();
  return /^\d{16,22}$/.test(text) ? text : "";
}

function permissionBits(value: unknown): bigint {
  try {
    return BigInt(String(value || "0"));
  } catch {
    return 0n;
  }
}

function hasPermission(permissionValue: bigint, permission: bigint): boolean {
  return (permissionValue & permission) === permission;
}

function roleIds(member: JsonRecord): string[] {
  return asArray(member.roles).map(snowflake).filter(Boolean);
}

function memberUserId(member: JsonRecord): string {
  return snowflake(asRecord(member.user).id);
}

function findRole(roles: JsonRecord[], roleId: string): JsonRecord | null {
  return roles.find((role) => snowflake(role.id) === roleId) || null;
}

function findChannel(
  channels: JsonRecord[],
  channelId: string,
): JsonRecord | null {
  return channels.find((channel) => snowflake(channel.id) === channelId) ||
    null;
}

function overwriteFor(
  channel: JsonRecord,
  id: string,
  type: number,
): JsonRecord | null {
  return asArray(channel.permission_overwrites)
    .map(asRecord)
    .find((overwrite) =>
      snowflake(overwrite.id) === id && Number(overwrite.type) === type
    ) || null;
}

function applyOverwrite(base: bigint, overwrite: JsonRecord | null): bigint {
  if (!overwrite) return base;
  const deny = permissionBits(overwrite.deny);
  const allow = permissionBits(overwrite.allow);
  return (base & ~deny) | allow;
}

function roleBasePermissions(
  guildId: string,
  roles: JsonRecord[],
  roleId: string,
): bigint {
  const everyone = findRole(roles, guildId);
  const role = roleId === guildId ? everyone : findRole(roles, roleId);
  return permissionBits(everyone?.permissions) |
    permissionBits(role?.permissions);
}

function effectiveRolePermissions(
  guildId: string,
  roles: JsonRecord[],
  channel: JsonRecord,
  roleId: string,
): bigint {
  const base = roleBasePermissions(guildId, roles, roleId);
  if (hasPermission(base, ADMINISTRATOR_PERMISSION)) {
    return ALL_AUDITED_PERMISSIONS;
  }
  let effective = applyOverwrite(
    base,
    overwriteFor(channel, guildId, ROLE_OVERWRITE_TYPE),
  );
  if (roleId !== guildId) {
    effective = applyOverwrite(
      effective,
      overwriteFor(channel, roleId, ROLE_OVERWRITE_TYPE),
    );
  }
  return effective;
}

function effectiveMemberPermissions(
  guildId: string,
  roles: JsonRecord[],
  channel: JsonRecord,
  member: JsonRecord,
): bigint {
  const ids = roleIds(member);
  let base = roleBasePermissions(guildId, roles, guildId);
  for (const roleId of ids) {
    base |= permissionBits(findRole(roles, roleId)?.permissions);
  }
  if (hasPermission(base, ADMINISTRATOR_PERMISSION)) {
    return ALL_AUDITED_PERMISSIONS;
  }

  let effective = applyOverwrite(
    base,
    overwriteFor(channel, guildId, ROLE_OVERWRITE_TYPE),
  );

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const roleId of ids) {
    const overwrite = overwriteFor(channel, roleId, ROLE_OVERWRITE_TYPE);
    if (!overwrite) continue;
    roleAllow |= permissionBits(overwrite.allow);
    roleDeny |= permissionBits(overwrite.deny);
  }
  effective = (effective & ~roleDeny) | roleAllow;

  return applyOverwrite(
    effective,
    overwriteFor(channel, memberUserId(member), MEMBER_OVERWRITE_TYPE),
  );
}

function check(
  key: string,
  label: string,
  ok: boolean,
  detail: string,
  fix: string,
): ModmailAuditCheck {
  return { key, label, ok, detail, fix };
}

export function buildModmailAudit(
  input: ModmailAuditInput,
): ModmailAuditResult {
  const guildId = input.guildId;
  const botUserId = input.botUserId || MODMAIL_BOT_USER_ID;
  const logChannelId = input.logChannelId || MODMAIL_LOG_CHANNEL_ID;
  const moderatorRoleId = input.moderatorRoleId || MODMAIL_MODERATOR_ROLE_ID;
  const moderatorRole = findRole(input.roles, moderatorRoleId);
  const logChannel = findChannel(input.channels, logChannelId);
  const modmailMember = input.modmailMember ||
    input.members.find((member) => memberUserId(member) === botUserId) || null;
  const moderatorMemberCount =
    input.members.filter((member) => roleIds(member).includes(moderatorRoleId))
      .length;
  const checks: ModmailAuditCheck[] = [];

  checks.push(check(
    "modmail-bot-present",
    "ModMail bot present",
    Boolean(modmailMember),
    modmailMember
      ? `Bot user ${botUserId} is in the guild.`
      : `Bot user ${botUserId} was not found in the guild.`,
    "Invite the ModMail bot or check that Reaper is auditing the correct guild and bot user ID.",
  ));

  checks.push(check(
    "moderator-role-present",
    "Moderator role present",
    Boolean(moderatorRole),
    moderatorRole
      ? `Role ${moderatorRoleId} exists as ${
        String(moderatorRole.name || "unnamed role")
      }.`
      : `Role ${moderatorRoleId} was not found.`,
    "Restore the Moderator role or update the approved role ID before configuring ModMail.",
  ));

  checks.push(check(
    "moderator-role-has-members",
    "Moderator role has members",
    moderatorMemberCount > 0,
    `${moderatorMemberCount} guild member(s) currently have role ${moderatorRoleId}.`,
    "Assign the Moderator role to at least one active staff member before relying on ModMail pings.",
  ));

  checks.push(check(
    "log-channel-present",
    "ModMail log channel present",
    Boolean(logChannel),
    logChannel
      ? `Channel ${logChannelId} exists as ${
        String(logChannel.name || "unnamed channel")
      }.`
      : `Channel ${logChannelId} was not found.`,
    `Create or restore the log channel, then run =logging <#${logChannelId}>.`,
  ));

  const textChannel = Boolean(
    logChannel && Number(logChannel.type) === GUILD_TEXT_CHANNEL_TYPE,
  );
  checks.push(check(
    "log-channel-text",
    "Log channel is a text channel",
    textChannel,
    logChannel
      ? `Channel type is ${Number(logChannel.type)}.`
      : "Channel could not be checked because it was not found.",
    `Point ModMail logging at a normal guild text channel with =logging <#${logChannelId}>.`,
  ));

  const everyonePermissions = logChannel
    ? effectiveRolePermissions(guildId, input.roles, logChannel, guildId)
    : 0n;
  checks.push(check(
    "log-channel-private",
    "Log channel private from @everyone",
    Boolean(
      logChannel &&
        !hasPermission(everyonePermissions, VIEW_CHANNEL_PERMISSION),
    ),
    logChannel && !hasPermission(everyonePermissions, VIEW_CHANNEL_PERMISSION)
      ? "@everyone cannot view the ModMail log channel."
      : "@everyone can view the ModMail log channel or privacy could not be checked.",
    "Deny View Channel for @everyone on the ModMail log channel or its parent category.",
  ));

  const moderatorPermissions = logChannel
    ? effectiveRolePermissions(
      guildId,
      input.roles,
      logChannel,
      moderatorRoleId,
    )
    : 0n;
  const moderatorCanRead =
    hasPermission(moderatorPermissions, VIEW_CHANNEL_PERMISSION) &&
    hasPermission(moderatorPermissions, READ_MESSAGE_HISTORY_PERMISSION);
  checks.push(check(
    "moderator-can-read-log",
    "Moderator role can read logs",
    Boolean(logChannel && moderatorRole && moderatorCanRead),
    moderatorCanRead
      ? "Moderator role can view the channel and read message history."
      : "Moderator role is missing View Channel or Read Message History for the log channel.",
    "Allow View Channel and Read Message History for the Moderator role on the log channel or parent category.",
  ));

  const botPermissions = logChannel && modmailMember
    ? effectiveMemberPermissions(
      guildId,
      input.roles,
      logChannel,
      modmailMember,
    )
    : 0n;
  const botCanLog = hasPermission(botPermissions, VIEW_CHANNEL_PERMISSION) &&
    hasPermission(botPermissions, SEND_MESSAGES_PERMISSION) &&
    hasPermission(botPermissions, EMBED_LINKS_PERMISSION) &&
    hasPermission(botPermissions, READ_MESSAGE_HISTORY_PERMISSION);
  checks.push(check(
    "modmail-can-write-log",
    "ModMail bot can write logs",
    Boolean(logChannel && modmailMember && botCanLog),
    botCanLog
      ? "ModMail bot can view, send, embed links, and read message history in the log channel."
      : "ModMail bot is missing View Channel, Send Messages, Embed Links, or Read Message History in the log channel.",
    "Allow View Channel, Send Messages, Embed Links, and Read Message History for ModMail on the log channel or parent category.",
  ));

  const moderatorMentionable = moderatorRole?.mentionable === true;
  checks.push(check(
    "moderator-role-not-globally-mentionable",
    "Moderator role is not globally mentionable",
    Boolean(moderatorRole && !moderatorMentionable),
    moderatorMentionable
      ? "Moderator role is globally mentionable, which is not the preferred ModMail setup."
      : "Moderator role is not globally mentionable.",
    "Turn off global role mentionability; if ticket pings fail, grant ModMail scoped Mention Everyone permission instead.",
  ));

  const botCanMention = hasPermission(
    botPermissions,
    MENTION_EVERYONE_PERMISSION,
  );
  checks.push(check(
    "modmail-can-mention-moderators",
    "ModMail can mention Moderator role",
    Boolean(
      logChannel && modmailMember && moderatorRole && !moderatorMentionable &&
        botCanMention,
    ),
    botCanMention
      ? "ModMail has scoped Mention Everyone permission in the audited log channel."
      : "ModMail may be unable to ping a non-mentionable Moderator role in the audited channel.",
    `Use =pingrole <@&${moderatorRoleId}>; if live ticket pings fail, grant ModMail scoped Mention Everyone permission without making the role globally mentionable.`,
  ));

  return {
    ok: checks.every((item) => item.ok),
    checks,
    note:
      "Reaper cannot read third-party ModMail internal config through Discord's public API. Run =viewconfig in Discord to confirm accessrole, pingrole, logging channel, and commandonly mode.",
  };
}

export function formatModmailAuditMessage(
  result: ModmailAuditResult,
  moderatorRoleId = MODMAIL_MODERATOR_ROLE_ID,
  logChannelId = MODMAIL_LOG_CHANNEL_ID,
): string {
  const header = result.ok
    ? "ModMail audit passed."
    : "ModMail audit found issues.";
  const lines = result.checks.map((item) => {
    const prefix = item.ok ? "PASS" : "FAIL";
    return `${prefix} ${item.label}: ${item.detail}${
      item.ok ? "" : ` Fix: ${item.fix}`
    }`;
  });

  return [
    header,
    ...lines,
    "",
    result.note,
    `Native ModMail commands: =viewconfig, =accessrole <@&${moderatorRoleId}>, =pingrole <@&${moderatorRoleId}>, =logging <#${logChannelId}>, =commandonly.`,
    "Do not enable =loggingplus unless separately approved, because it can include message content or AI summaries.",
  ].join("\n").slice(0, 1900);
}
