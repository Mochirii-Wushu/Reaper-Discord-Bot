export type JsonRecord = Record<string, unknown>;

export type SupabaseAdminClient = {
  from(table: string): any;
};

export type PendingContainmentMode = "preview" | "apply";
export type PendingContainmentAction = "allow" | "deny" | "clear";

export type PendingManagedOverwrite = {
  id: string;
  channelId: string;
  userId: string;
  ownedAllow: bigint;
  ownedDeny: bigint;
};

export type PendingContainmentChange = {
  action: PendingContainmentAction;
  channelId: string;
  channelName: string;
  userId: string;
  currentAllow: bigint;
  currentDeny: bigint;
  nextAllow: bigint;
  nextDeny: bigint;
  nextOwnedAllow: bigint;
  nextOwnedDeny: bigint;
  managedRecord: PendingManagedOverwrite | null;
  discordWrite: boolean;
  dbWrite: boolean;
  detail: string;
};

export type PendingContainmentConflict = {
  channelId: string;
  channelName: string;
  userId: string;
  detail: string;
};

export type PendingContainmentPlan = {
  targetUserIds: string[];
  allowedChannelIds: string[];
  channelsChecked: number;
  changes: PendingContainmentChange[];
  staleRecords: PendingManagedOverwrite[];
  conflicts: PendingContainmentConflict[];
  highOverwriteChannels: string[];
};

export type PendingContainmentApplyResult = {
  discordWrites: number;
  dbWrites: number;
  staleRecordsCleared: number;
  failedWrites: number;
  skippedWrites: number;
};

export type PendingContainmentConfig = {
  guildId: string;
  pendingBaseRoleId: string;
  verifiedRoleId: string;
  moderatorRoleIds: string[];
  allowedChannelIds: string[];
  managedBy: string;
  maxMutationCount: number;
  discordWriteBatchSize: number;
  discordWriteBatchPauseMs: number;
};

export type WritePendingDiscordOverwrite = (
  change: PendingContainmentChange,
) => Promise<void>;

export class PendingContainmentApplyError extends Error {
  result: PendingContainmentApplyResult;

  constructor(message: string, result: PendingContainmentApplyResult) {
    super(message);
    this.name = "PendingContainmentApplyError";
    this.result = result;
  }
}

export const PENDING_BASE_ROLE_ID = CONFIGURED_PENDING_BASE_ROLE_ID;
export const VERIFIED_ROLE_ID = CONFIGURED_VERIFIED_ROLE_ID;
export const PENDING_ALLOWED_CHANNEL_IDS =
  CONFIGURED_PENDING_ALLOWED_CHANNEL_IDS;
export const ADMINISTRATOR_PERMISSION = 1n << 3n;
export const VIEW_CHANNEL_PERMISSION = 1n << 10n;
export const SEND_MESSAGES_PERMISSION = 1n << 11n;
export const READ_MESSAGE_HISTORY_PERMISSION = 1n << 16n;
export const PENDING_ALLOWED_CHANNEL_ALLOW_PERMISSIONS =
  VIEW_CHANNEL_PERMISSION | SEND_MESSAGES_PERMISSION |
  READ_MESSAGE_HISTORY_PERMISSION;
export const DISCORD_MEMBER_OVERWRITE_TYPE = 1;
export const MAX_PENDING_VERIFICATION_MUTATIONS = 500;
export const DISCORD_WRITE_BATCH_SIZE = 10;
export const DISCORD_WRITE_BATCH_PAUSE_MS = 250;
export const PENDING_VERIFICATION_MANAGED_BY = "reaper-pending-verification";
export const DEFAULT_PENDING_CONTAINMENT_CONFIG: PendingContainmentConfig = {
  guildId: DISCORD_GUILD_ID,
  pendingBaseRoleId: PENDING_BASE_ROLE_ID,
  verifiedRoleId: VERIFIED_ROLE_ID,
  moderatorRoleIds: DISCORD_MODERATOR_ROLE_IDS,
  allowedChannelIds: PENDING_ALLOWED_CHANNEL_IDS,
  managedBy: PENDING_VERIFICATION_MANAGED_BY,
  maxMutationCount: MAX_PENDING_VERIFICATION_MUTATIONS,
  discordWriteBatchSize: DISCORD_WRITE_BATCH_SIZE,
  discordWriteBatchPauseMs: DISCORD_WRITE_BATCH_PAUSE_MS,
};

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item)).filter(Boolean)
    : [];
}

export function safeString(value: unknown, maxLength: number): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.slice(0, maxLength);
}

export function snowflake(value: unknown): string | null {
  const id = safeString(value, 24);
  return id && /^\d{16,22}$/.test(id) ? id : null;
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function permissionBits(value: unknown): bigint {
  try {
    return BigInt(String(value || "0"));
  } catch {
    return 0n;
  }
}

export function hasPermissionBit(value: unknown, bit: bigint): boolean {
  return (permissionBits(value) & bit) === bit;
}

export function withPermissionBit(value: bigint, bit: bigint): bigint {
  return value | bit;
}

export function withoutPermissionBit(value: bigint, bit: bigint): bigint {
  return value & ~bit;
}

export function pendingOverwriteKey(channelId: string, userId: string): string {
  return `${channelId}:${userId}`;
}

export function pendingChannelId(channel: JsonRecord): string | null {
  return snowflake(channel.id);
}

export function pendingChannelName(channel: JsonRecord): string {
  return safeString(channel.name, 80) || "unnamed-channel";
}

export function memberUserId(member: JsonRecord): string | null {
  return snowflake(asRecord(member.user).id);
}

export function isPendingVerificationTarget(
  member: JsonRecord,
  config: PendingContainmentConfig = DEFAULT_PENDING_CONTAINMENT_CONFIG,
): boolean {
  const user = asRecord(member.user);
  if (user.bot === true) return false;

  const roles = asStringArray(member.roles);
  if (roles.includes(config.verifiedRoleId)) return false;
  if (roles.some((roleId) => config.moderatorRoleIds.includes(roleId))) {
    return false;
  }
  return roles.length === 1 && roles[0] === config.pendingBaseRoleId;
}

export function memberOverwrite(
  channel: JsonRecord,
  userId: string,
): JsonRecord {
  return asRecord(
    asArray(channel.permission_overwrites).find((overwrite) => {
      const record = asRecord(overwrite);
      return safeString(record.id, 24) === userId &&
        Number(record.type) === DISCORD_MEMBER_OVERWRITE_TYPE;
    }),
  );
}

function roleOverwriteApplies(
  overwrite: JsonRecord,
  roleIds: Set<string>,
): boolean {
  return Number(overwrite.type) === 0 &&
    roleIds.has(String(overwrite.id || ""));
}

function rolePermissionMap(
  roles: JsonRecord[],
): Map<string, bigint> {
  const permissionsByRoleId = new Map<string, bigint>();
  for (const role of roles) {
    const roleId = snowflake(role.id);
    if (!roleId) continue;
    permissionsByRoleId.set(roleId, permissionBits(role.permissions));
  }
  return permissionsByRoleId;
}

export function memberEffectivePermissions(
  channel: JsonRecord,
  member: JsonRecord,
  roles: JsonRecord[],
  config: PendingContainmentConfig = DEFAULT_PENDING_CONTAINMENT_CONFIG,
): bigint {
  const permissionsByRoleId = rolePermissionMap(roles);
  const memberRoles = new Set(
    asStringArray(member.roles).filter((roleId) => Boolean(snowflake(roleId))),
  );
  let permissions = permissionsByRoleId.get(config.guildId) || 0n;

  for (const roleId of memberRoles) {
    permissions |= permissionsByRoleId.get(roleId) || 0n;
  }

  if ((permissions & ADMINISTRATOR_PERMISSION) === ADMINISTRATOR_PERMISSION) {
    return permissions;
  }

  const overwrites = asArray(channel.permission_overwrites).map(asRecord);
  const everyoneOverwrite = overwrites.find((overwrite) =>
    safeString(overwrite.id, 24) === config.guildId
  );
  if (everyoneOverwrite) {
    permissions = withoutPermissionBit(
      permissions,
      permissionBits(everyoneOverwrite.deny),
    );
    permissions |= permissionBits(everyoneOverwrite.allow);
  }

  let roleDeny = 0n;
  let roleAllow = 0n;
  for (const overwrite of overwrites) {
    if (!roleOverwriteApplies(overwrite, memberRoles)) continue;
    roleDeny |= permissionBits(overwrite.deny);
    roleAllow |= permissionBits(overwrite.allow);
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;

  const userId = memberUserId(member);
  if (userId) {
    const overwrite = memberOverwrite(channel, userId);
    permissions &= ~permissionBits(overwrite.deny);
    permissions |= permissionBits(overwrite.allow);
  }

  return permissions;
}

export function memberCanViewChannel(
  channel: JsonRecord,
  member: JsonRecord,
  roles: JsonRecord[],
  config: PendingContainmentConfig = DEFAULT_PENDING_CONTAINMENT_CONFIG,
): boolean {
  const permissions = memberEffectivePermissions(
    channel,
    member,
    roles,
    config,
  );
  return hasPermissionBit(permissions, ADMINISTRATOR_PERMISSION) ||
    hasPermissionBit(permissions, VIEW_CHANNEL_PERMISSION);
}

export function activeManagedOwned(
  record: PendingManagedOverwrite | null,
  side: "allow" | "deny",
  mask = VIEW_CHANNEL_PERMISSION,
): boolean {
  if (!record) return false;
  const value = side === "allow" ? record.ownedAllow : record.ownedDeny;
  return (value & mask) !== 0n;
}

export function desiredPendingChange(
  action: PendingContainmentAction,
  channel: JsonRecord,
  userId: string,
  managedRecord: PendingManagedOverwrite | null,
): {
  change: PendingContainmentChange | null;
  conflict: PendingContainmentConflict | null;
} {
  const channelId = pendingChannelId(channel);
  if (!channelId) return { change: null, conflict: null };

  const overwrite = memberOverwrite(channel, userId);
  const currentAllow = permissionBits(overwrite.allow);
  const currentDeny = permissionBits(overwrite.deny);
  const ownedAllowBits = managedRecord ? managedRecord.ownedAllow : 0n;
  const ownedDenyBits = managedRecord ? managedRecord.ownedDeny : 0n;
  const ownedAllowedBits = ownedAllowBits &
    PENDING_ALLOWED_CHANNEL_ALLOW_PERMISSIONS;
  const ownedViewDeny = ownedDenyBits & VIEW_CHANNEL_PERMISSION;
  const manualAllow = hasPermissionBit(currentAllow, VIEW_CHANNEL_PERMISSION) &&
    (ownedAllowedBits & VIEW_CHANNEL_PERMISSION) === 0n;
  const allowedManualDeny =
    (currentDeny & PENDING_ALLOWED_CHANNEL_ALLOW_PERMISSIONS) & ~ownedDenyBits;
  const channelName = pendingChannelName(channel);

  if (action === "allow" && allowedManualDeny !== 0n) {
    return {
      change: null,
      conflict: {
        channelId,
        channelName,
        userId,
        detail: "manual member deny inside allowed channels",
      },
    };
  }

  if (action === "deny" && manualAllow) {
    return {
      change: null,
      conflict: {
        channelId,
        channelName,
        userId,
        detail: "manual member allow outside allowed channels",
      },
    };
  }

  let nextAllow = currentAllow;
  let nextDeny = currentDeny;
  let nextOwnedAllow = 0n;
  let nextOwnedDeny = 0n;

  if (action === "allow") {
    nextAllow |= PENDING_ALLOWED_CHANNEL_ALLOW_PERMISSIONS;
    nextOwnedAllow = PENDING_ALLOWED_CHANNEL_ALLOW_PERMISSIONS;
    if (ownedViewDeny) {
      nextDeny = withoutPermissionBit(nextDeny, VIEW_CHANNEL_PERMISSION);
    }
  } else if (action === "deny") {
    if (!hasPermissionBit(currentDeny, VIEW_CHANNEL_PERMISSION)) {
      nextDeny = withPermissionBit(nextDeny, VIEW_CHANNEL_PERMISSION);
      nextOwnedDeny = VIEW_CHANNEL_PERMISSION;
    } else if (ownedViewDeny) {
      nextOwnedDeny = VIEW_CHANNEL_PERMISSION;
    }
    if (ownedAllowedBits) nextAllow &= ~ownedAllowedBits;
  } else {
    if (ownedAllowBits) nextAllow &= ~ownedAllowBits;
    if (ownedDenyBits) nextDeny &= ~ownedDenyBits;
  }

  const discordWrite = currentAllow !== nextAllow || currentDeny !== nextDeny;
  const dbWrite = Boolean(
    managedRecord
      ? managedRecord.ownedAllow !== nextOwnedAllow ||
        managedRecord.ownedDeny !== nextOwnedDeny ||
        (nextOwnedAllow === 0n && nextOwnedDeny === 0n)
      : nextOwnedAllow !== 0n || nextOwnedDeny !== 0n,
  );

  if (!discordWrite && !dbWrite) return { change: null, conflict: null };

  return {
    change: {
      action,
      channelId,
      channelName,
      userId,
      currentAllow,
      currentDeny,
      nextAllow,
      nextDeny,
      nextOwnedAllow,
      nextOwnedDeny,
      managedRecord,
      discordWrite,
      dbWrite,
      detail: action === "clear"
        ? "cleanup tracked overwrite"
        : `${action} view channel`,
    },
    conflict: null,
  };
}

export function pendingAllowedChannelIds(
  channels: JsonRecord[],
  config: PendingContainmentConfig = DEFAULT_PENDING_CONTAINMENT_CONFIG,
): Set<string> {
  const availableChannelIds = new Set(
    channels.map(pendingChannelId).filter((id): id is string => Boolean(id)),
  );
  const allowed = new Set(
    config.allowedChannelIds.filter((channelId) =>
      Boolean(snowflake(channelId))
    ),
  );
  const missing = [...allowed].filter((channelId) =>
    !availableChannelIds.has(channelId)
  );

  if (!allowed.size) {
    throw new Error("No allowed pending-verification channels are configured.");
  }

  if (missing.length) {
    throw new Error(
      `${missing.length} configured pending-verification channel(s) were unavailable.`,
    );
  }

  return allowed;
}

export async function loadManagedPendingOverwrites(
  adminClient: SupabaseAdminClient,
  config: PendingContainmentConfig = DEFAULT_PENDING_CONTAINMENT_CONFIG,
  discordUserId: string | null = null,
): Promise<Map<string, PendingManagedOverwrite>> {
  let query = adminClient
    .from("discord_managed_permission_overwrites")
    .select("id,channel_id,discord_user_id,owned_allow,owned_deny")
    .eq("guild_id", config.guildId)
    .eq("managed_by", config.managedBy)
    .eq("active", true);

  if (discordUserId) query = query.eq("discord_user_id", discordUserId);

  const { data, error } = await query;
  if (error) throw error;

  const records = new Map<string, PendingManagedOverwrite>();
  for (const row of asArray(data).map(asRecord)) {
    const id = safeString(row.id, 80);
    const channelId = snowflake(row.channel_id);
    const userId = snowflake(row.discord_user_id);
    if (!id || !channelId || !userId) continue;
    records.set(pendingOverwriteKey(channelId, userId), {
      id,
      channelId,
      userId,
      ownedAllow: permissionBits(row.owned_allow),
      ownedDeny: permissionBits(row.owned_deny),
    });
  }
  return records;
}

export function highOverwriteChannelNames(channels: JsonRecord[]): string[] {
  return channels
    .filter((channel) => asArray(channel.permission_overwrites).length >= 90)
    .map((channel) =>
      `${pendingChannelName(channel)}:${pendingChannelId(channel) || "unknown"}`
    )
    .slice(0, 10);
}

function buildPlanFromRecords(
  channels: JsonRecord[],
  members: JsonRecord[],
  roles: JsonRecord[],
  managedRecords: Map<string, PendingManagedOverwrite>,
  config: PendingContainmentConfig,
): PendingContainmentPlan {
  const allowedChannelIds = pendingAllowedChannelIds(channels, config);
  const targetMembers = members.filter((member) =>
    isPendingVerificationTarget(member, config)
  );
  const targetUserIds = targetMembers.map(memberUserId).filter((
    id,
  ): id is string => Boolean(id));
  const targetUserIdSet = new Set(targetUserIds);
  const channelById = new Map(
    channels.map((channel) => [pendingChannelId(channel) || "", channel]),
  );
  const changes = new Map<string, PendingContainmentChange>();
  const conflicts: PendingContainmentConflict[] = [];

  for (const member of targetMembers) {
    const userId = memberUserId(member);
    if (!userId) continue;

    for (const channel of channels) {
      const channelId = pendingChannelId(channel);
      if (!channelId) continue;
      const action: PendingContainmentAction = allowedChannelIds.has(channelId)
        ? "allow"
        : "deny";
      const key = pendingOverwriteKey(channelId, userId);
      const managedRecord = managedRecords.get(key) || null;
      const result = desiredPendingChange(
        action,
        channel,
        userId,
        managedRecord,
      );
      if (result.conflict) conflicts.push(result.conflict);
      const currentlyVisible = memberCanViewChannel(
        channel,
        member,
        roles,
        config,
      );
      const visibilityNeedsChange = action === "allow"
        ? !currentlyVisible
        : currentlyVisible;
      const hasManagedViewBit = activeManagedOwned(
        managedRecord,
        "allow",
        PENDING_ALLOWED_CHANNEL_ALLOW_PERMISSIONS,
      ) ||
        activeManagedOwned(managedRecord, "deny");
      if (result.change && (visibilityNeedsChange || hasManagedViewBit)) {
        changes.set(key, result.change);
      }
    }
  }

  const staleRecords: PendingManagedOverwrite[] = [];
  for (const [key, record] of managedRecords.entries()) {
    if (
      targetUserIdSet.has(record.userId) && channelById.has(record.channelId)
    ) continue;

    const channel = channelById.get(record.channelId);
    if (!channel) {
      staleRecords.push(record);
      continue;
    }

    const result = desiredPendingChange(
      "clear",
      channel,
      record.userId,
      record,
    );
    if (result.conflict) conflicts.push(result.conflict);
    if (result.change) changes.set(key, result.change);
  }

  return {
    targetUserIds,
    allowedChannelIds: [...allowedChannelIds],
    channelsChecked: channels.length,
    changes: [...changes.values()],
    staleRecords,
    conflicts,
    highOverwriteChannels: highOverwriteChannelNames(channels),
  };
}

export async function buildPendingContainmentPlan(
  adminClient: SupabaseAdminClient,
  channels: JsonRecord[],
  members: JsonRecord[],
  roles: JsonRecord[],
  config: PendingContainmentConfig = DEFAULT_PENDING_CONTAINMENT_CONFIG,
): Promise<PendingContainmentPlan> {
  const managedRecords = await loadManagedPendingOverwrites(
    adminClient,
    config,
  );
  return buildPlanFromRecords(channels, members, roles, managedRecords, config);
}

export async function buildSingleMemberPendingContainmentPlan(
  adminClient: SupabaseAdminClient,
  channels: JsonRecord[],
  member: JsonRecord | null,
  discordUserId: string,
  roles: JsonRecord[],
  config: PendingContainmentConfig = DEFAULT_PENDING_CONTAINMENT_CONFIG,
): Promise<PendingContainmentPlan> {
  const managedRecords = await loadManagedPendingOverwrites(
    adminClient,
    config,
    discordUserId,
  );
  const members = member ? [member] : [];
  return buildPlanFromRecords(channels, members, roles, managedRecords, config);
}

async function savePendingOverwriteRecord(
  adminClient: SupabaseAdminClient,
  change: PendingContainmentChange,
  config: PendingContainmentConfig,
): Promise<void> {
  const active = change.nextOwnedAllow !== 0n || change.nextOwnedDeny !== 0n;
  const now = new Date().toISOString();

  if (active) {
    const { error } = await adminClient
      .from("discord_managed_permission_overwrites")
      .upsert(
        {
          guild_id: config.guildId,
          channel_id: change.channelId,
          discord_user_id: change.userId,
          managed_by: config.managedBy,
          owned_allow: change.nextOwnedAllow.toString(),
          owned_deny: change.nextOwnedDeny.toString(),
          active: true,
          applied_at: now,
          cleared_at: null,
        },
        { onConflict: "guild_id,channel_id,discord_user_id,managed_by" },
      );
    if (error) throw error;
    return;
  }

  if (!change.managedRecord) return;

  const { error } = await adminClient
    .from("discord_managed_permission_overwrites")
    .update({
      owned_allow: "0",
      owned_deny: "0",
      active: false,
      cleared_at: now,
    })
    .eq("id", change.managedRecord.id);

  if (error) throw error;
}

async function clearStalePendingRecord(
  adminClient: SupabaseAdminClient,
  record: PendingManagedOverwrite,
): Promise<void> {
  const { error } = await adminClient
    .from("discord_managed_permission_overwrites")
    .update({
      owned_allow: "0",
      owned_deny: "0",
      active: false,
      cleared_at: new Date().toISOString(),
    })
    .eq("id", record.id);

  if (error) throw error;
}

export async function applyPendingContainmentPlan(
  adminClient: SupabaseAdminClient,
  plan: PendingContainmentPlan,
  writePendingDiscordOverwrite: WritePendingDiscordOverwrite,
  config: PendingContainmentConfig = DEFAULT_PENDING_CONTAINMENT_CONFIG,
): Promise<PendingContainmentApplyResult> {
  const plannedDiscordWrites =
    plan.changes.filter((change) => change.discordWrite).length;
  let discordWrites = 0;
  let dbWrites = 0;

  for (const change of plan.changes) {
    const ownsPermissionsAfterChange = change.nextOwnedAllow !== 0n ||
      change.nextOwnedDeny !== 0n;

    // Persist newly acquired ownership first so a failed Discord write remains safely retryable.
    if (change.dbWrite && ownsPermissionsAfterChange) {
      await savePendingOverwriteRecord(adminClient, change, config);
      dbWrites += 1;
    }

    if (change.discordWrite) {
      try {
        await writePendingDiscordOverwrite(change);
      } catch {
        const failedWrites = 1;
        const skippedWrites = Math.max(
          plannedDiscordWrites - discordWrites - failedWrites,
          0,
        );
        throw new PendingContainmentApplyError(
          "Discord overwrite write failed.",
          {
            discordWrites,
            dbWrites,
            staleRecordsCleared: 0,
            failedWrites,
            skippedWrites,
          },
        );
      }
      discordWrites += 1;
      if (discordWrites % config.discordWriteBatchSize === 0) {
        await wait(config.discordWriteBatchPauseMs);
      }
    }

    // Release ownership only after Discord no longer has the Reaper-managed bits.
    if (change.dbWrite && !ownsPermissionsAfterChange) {
      await savePendingOverwriteRecord(adminClient, change, config);
      dbWrites += 1;
    }
  }

  for (const record of plan.staleRecords) {
    await clearStalePendingRecord(adminClient, record);
  }

  return {
    discordWrites,
    dbWrites,
    staleRecordsCleared: plan.staleRecords.length,
    failedWrites: 0,
    skippedWrites: 0,
  };
}

function pendingConflictLine(conflict: PendingContainmentConflict): string {
  return `${conflict.channelName}:${conflict.channelId} user:${conflict.userId} (${conflict.detail})`;
}

function pendingChangeLine(change: PendingContainmentChange): string {
  const prefix = change.discordWrite ? "Would write" : "Already satisfied";
  return `${prefix}: ${change.action} ${change.channelName}:${change.channelId} user:${change.userId}`;
}

export function pendingPlanMessage(
  mode: PendingContainmentMode,
  plan: PendingContainmentPlan,
  applyResult?: PendingContainmentApplyResult,
): string {
  const discordWriteCount =
    plan.changes.filter((change) => change.discordWrite).length;
  const dbWriteCount = plan.changes.filter((change) => change.dbWrite).length +
    plan.staleRecords.length;
  const lines = [
    mode === "apply"
      ? "Pending verification containment finished."
      : "Pending verification containment preview. No Discord permissions were changed.",
    `Targets: ${plan.targetUserIds.length}. Channels checked: ${plan.channelsChecked}. Allowed channels: ${plan.allowedChannelIds.length}.`,
    `Planned Discord writes: ${discordWriteCount}. Planned registry writes: ${dbWriteCount}.`,
  ];

  if (applyResult) {
    lines.push(
      `Applied Discord writes: ${applyResult.discordWrites}. Failed writes: ${applyResult.failedWrites}. Skipped writes: ${applyResult.skippedWrites}. Registry writes: ${applyResult.dbWrites}. Stale registry rows cleared: ${applyResult.staleRecordsCleared}.`,
    );
  }

  if (plan.highOverwriteChannels.length) {
    lines.push(
      `High-overwrite channels to review: ${
        plan.highOverwriteChannels.join(", ")
      }`,
    );
  }

  if (plan.conflicts.length) {
    lines.push("Blocked by manual VIEW_CHANNEL conflicts:");
    lines.push(...plan.conflicts.slice(0, 8).map(pendingConflictLine));
  } else if (plan.changes.length) {
    lines.push(...plan.changes.slice(0, 10).map(pendingChangeLine));
  } else {
    lines.push("No containment changes are needed.");
  }

  if (plan.conflicts.length > 8 || plan.changes.length > 10) {
    lines.push(
      "Additional entries were omitted from this Discord response; check discord_sync_log for counts.",
    );
  }

  return lines.join("\n").slice(0, 1900);
}

export async function logPendingContainmentSync(
  adminClient: SupabaseAdminClient,
  mode: PendingContainmentMode,
  status: "success" | "warning" | "failed" | "skipped",
  message: string,
  plan: PendingContainmentPlan | null,
  extra: JsonRecord = {},
): Promise<void> {
  try {
    const { error } = await adminClient
      .from("discord_sync_log")
      .insert({
        sync_type: "role_check",
        status,
        message,
        details: {
          managedBy: PENDING_VERIFICATION_MANAGED_BY,
          mode,
          targetCount: plan?.targetUserIds.length || 0,
          channelCount: plan?.channelsChecked || 0,
          allowedChannelCount: plan?.allowedChannelIds.length || 0,
          discordWriteCount: plan?.changes.filter((change) =>
            change.discordWrite
          ).length || 0,
          registryWriteCount: plan
            ? plan.changes.filter((change) => change.dbWrite).length +
              plan.staleRecords.length
            : 0,
          conflictCount: plan?.conflicts.length || 0,
          highOverwriteChannelCount: plan?.highOverwriteChannels.length || 0,
          sampleTargetUserIds: plan?.targetUserIds.slice(0, 10) || [],
          sampleConflictChannelIds:
            plan?.conflicts.slice(0, 10).map((conflict) =>
              conflict.channelId
            ) || [],
          ...extra,
        },
        finished_at: new Date().toISOString(),
      });

    if (error) {
      console.error("reaper pending containment log failed", {
        code: error.code,
        errorType: "database_write_failed",
      });
    }
  } catch {
    console.error("reaper pending containment log failed", {
      errorType: "unexpected_failure",
    });
  }
}

import {
  DISCORD_GUILD_ID,
  DISCORD_MODERATOR_ROLE_IDS,
  PENDING_ALLOWED_CHANNEL_IDS as CONFIGURED_PENDING_ALLOWED_CHANNEL_IDS,
  PENDING_BASE_ROLE_ID as CONFIGURED_PENDING_BASE_ROLE_ID,
  VERIFIED_ROLE_ID as CONFIGURED_VERIFIED_ROLE_ID,
} from "./runtime-config.ts";
