import {
  ADMINISTRATOR_PERMISSION,
  applyPendingContainmentPlan,
  buildPendingContainmentPlan,
  DEFAULT_PENDING_CONTAINMENT_CONFIG,
  desiredPendingChange,
  isPendingVerificationTarget,
  type JsonRecord,
  memberCanViewChannel,
  memberEffectivePermissions,
  PENDING_ALLOWED_CHANNEL_ALLOW_PERMISSIONS,
  PendingContainmentApplyError,
  type PendingContainmentChange,
  type PendingContainmentPlan,
  type PendingManagedOverwrite,
  READ_MESSAGE_HISTORY_PERMISSION,
  SEND_MESSAGES_PERMISSION,
  type SupabaseAdminClient,
  VIEW_CHANNEL_PERMISSION,
} from "./pending-verification-containment.ts";

const config = {
  ...DEFAULT_PENDING_CONTAINMENT_CONFIG,
  discordWriteBatchPauseMs: 0,
};
const pendingUserId = "11111111111111111";
const unrelatedPermission = 1n << 15n;

Deno.test("pending targets require only the base role and exclude verified, moderator, and bot members", () => {
  assert(isPendingVerificationTarget(member([config.pendingBaseRoleId])));
  assert(
    !isPendingVerificationTarget(
      member([config.pendingBaseRoleId, config.verifiedRoleId]),
    ),
  );
  assert(
    !isPendingVerificationTarget(
      member([config.pendingBaseRoleId, config.moderatorRoleIds[0]]),
    ),
  );
  assert(
    !isPendingVerificationTarget(
      member([config.pendingBaseRoleId, "22222222222222222"]),
    ),
  );
  assert(
    !isPendingVerificationTarget(member([config.pendingBaseRoleId], true)),
  );
});

Deno.test("effective permissions follow Discord role and overwrite precedence", () => {
  const roles = [
    role(config.guildId, VIEW_CHANNEL_PERMISSION | SEND_MESSAGES_PERMISSION),
    role(config.pendingBaseRoleId, 0n),
  ];
  const target = member([config.pendingBaseRoleId]);
  const restrictedChannel = channel("33333333333333333", [
    overwrite(config.guildId, 0, 0n, SEND_MESSAGES_PERMISSION),
    overwrite(config.pendingBaseRoleId, 0, READ_MESSAGE_HISTORY_PERMISSION, 0n),
    overwrite(pendingUserId, 1, 0n, VIEW_CHANNEL_PERMISSION),
  ]);

  const permissions = memberEffectivePermissions(
    restrictedChannel,
    target,
    roles,
    config,
  );
  assert(
    !has(permissions, VIEW_CHANNEL_PERMISSION),
    "member overwrite should deny view",
  );
  assert(
    !has(permissions, SEND_MESSAGES_PERMISSION),
    "everyone overwrite should deny send",
  );
  assert(
    has(permissions, READ_MESSAGE_HISTORY_PERMISSION),
    "role overwrite should allow history",
  );
  assert(!memberCanViewChannel(restrictedChannel, target, roles, config));

  const administratorRoles = [
    role(config.guildId, 0n),
    role(config.pendingBaseRoleId, ADMINISTRATOR_PERMISSION),
  ];
  assert(
    memberCanViewChannel(restrictedChannel, target, administratorRoles, config),
  );
});

Deno.test("desired changes preserve manual bits and block manual view conflicts", () => {
  const outside = channel("44444444444444444", [
    overwrite(pendingUserId, 1, unrelatedPermission, unrelatedPermission),
  ]);
  const deny = desiredPendingChange("deny", outside, pendingUserId, null);
  assert(deny.change && !deny.conflict);
  assert(
    has(deny.change.nextAllow, unrelatedPermission),
    "manual allow bits should be preserved",
  );
  assert(
    has(deny.change.nextDeny, unrelatedPermission),
    "manual deny bits should be preserved",
  );
  assert(
    has(deny.change.nextDeny, VIEW_CHANNEL_PERMISSION),
    "outside channels should deny view",
  );

  const manualOutsideAllow = channel("55555555555555555", [
    overwrite(pendingUserId, 1, VIEW_CHANNEL_PERMISSION, 0n),
  ]);
  assert(
    desiredPendingChange("deny", manualOutsideAllow, pendingUserId, null)
      .conflict?.detail ===
      "manual member allow outside allowed channels",
  );

  const manualInsideDeny = channel(config.allowedChannelIds[0], [
    overwrite(pendingUserId, 1, 0n, VIEW_CHANNEL_PERMISSION),
  ]);
  assert(
    desiredPendingChange("allow", manualInsideDeny, pendingUserId, null)
      .conflict?.detail ===
      "manual member deny inside allowed channels",
  );
});

Deno.test("cleanup removes only Reaper-owned bits", () => {
  const managed = managedOverwrite({ ownedAllow: VIEW_CHANNEL_PERMISSION });
  const existing = channel("66666666666666666", [
    overwrite(
      pendingUserId,
      1,
      VIEW_CHANNEL_PERMISSION | unrelatedPermission,
      unrelatedPermission,
    ),
  ]);
  const result = desiredPendingChange(
    "clear",
    existing,
    pendingUserId,
    managed,
  );

  assert(result.change && !result.conflict);
  assert(!has(result.change.nextAllow, VIEW_CHANNEL_PERMISSION));
  assert(has(result.change.nextAllow, unrelatedPermission));
  assert(has(result.change.nextDeny, unrelatedPermission));
  assert(result.change.nextAllow !== 0n || result.change.nextDeny !== 0n);

  const fullyManaged = desiredPendingChange(
    "clear",
    channel("67777777777777777", [
      overwrite(
        pendingUserId,
        1,
        PENDING_ALLOWED_CHANNEL_ALLOW_PERMISSIONS,
        0n,
      ),
    ]),
    pendingUserId,
    managedOverwrite({ ownedAllow: PENDING_ALLOWED_CHANNEL_ALLOW_PERMISSIONS }),
  );
  assert(
    fullyManaged.change?.nextAllow === 0n &&
      fullyManaged.change.nextDeny === 0n,
  );
});

Deno.test("planner writes only channels whose effective visibility needs containment", async () => {
  const allowedVisible = channel(config.allowedChannelIds[0]);
  const allowedHidden = channel(config.allowedChannelIds[1], [
    overwrite(config.guildId, 0, 0n, VIEW_CHANNEL_PERMISSION),
  ]);
  const allowedCategoryChildVisible = {
    ...channel("76666666666666666"),
    parent_id: config.allowedChannelIds[0],
  };
  const outsideVisible = channel("77777777777777777");
  const outsideHidden = channel("88888888888888888", [
    overwrite(config.guildId, 0, 0n, VIEW_CHANNEL_PERMISSION),
  ]);
  const roles = [
    role(config.guildId, 0n),
    role(config.pendingBaseRoleId, VIEW_CHANNEL_PERMISSION),
  ];

  const plan = await buildPendingContainmentPlan(
    readAdmin([]),
    [
      allowedVisible,
      allowedHidden,
      allowedCategoryChildVisible,
      outsideVisible,
      outsideHidden,
    ],
    [member([config.pendingBaseRoleId])],
    roles,
    config,
  );

  assertEquals(plan.targetUserIds, [pendingUserId]);
  assertEquals(
    plan.changes.map((change) => [change.channelId, change.action]),
    [
      [config.allowedChannelIds[1], "allow"],
      ["76666666666666666", "deny"],
      ["77777777777777777", "deny"],
    ],
  );
  const allowedChange = plan.changes.find((change) =>
    change.action === "allow"
  );
  assert(
    allowedChange?.nextAllow === PENDING_ALLOWED_CHANNEL_ALLOW_PERMISSIONS,
    "allowed channels should grant view, send, and read-history permissions",
  );
  assert(plan.conflicts.length === 0);
});

Deno.test("ownership acquisition is durable before Discord writes and failures remain retryable", async () => {
  const events: string[] = [];
  const changes = [
    activeChange("91111111111111111"),
    activeChange("92222222222222222"),
    activeChange("93333333333333333"),
  ];
  const plan = containmentPlan(changes);
  let calls = 0;

  try {
    await applyPendingContainmentPlan(
      writeAdmin(events),
      plan,
      async () => {
        calls += 1;
        events.push(`discord:${calls}`);
        if (calls === 2) throw new Error("Discord write failed");
      },
      config,
    );
    throw new Error("Expected apply to fail");
  } catch (error) {
    assert(error instanceof PendingContainmentApplyError);
    assertEquals(error.result, {
      discordWrites: 1,
      dbWrites: 2,
      staleRecordsCleared: 0,
      failedWrites: 1,
      skippedWrites: 1,
    });
  }

  assertEquals(events, ["db:upsert", "discord:1", "db:upsert", "discord:2"]);
});

Deno.test("ownership release happens only after Discord cleanup succeeds", async () => {
  const events: string[] = [];
  const change = clearChange("94444444444444444");
  const result = await applyPendingContainmentPlan(
    writeAdmin(events),
    containmentPlan([change]),
    async () => {
      events.push("discord:clear");
    },
    config,
  );

  assertEquals(events, ["discord:clear", "db:update"]);
  assertEquals(result, {
    discordWrites: 1,
    dbWrites: 1,
    staleRecordsCleared: 0,
    failedWrites: 0,
    skippedWrites: 0,
  });
});

function member(roles: string[], bot = false): JsonRecord {
  return { roles, user: { id: pendingUserId, bot } };
}

function role(id: string, permissions: bigint): JsonRecord {
  return { id, permissions: permissions.toString() };
}

function overwrite(
  id: string,
  type: number,
  allow: bigint,
  deny: bigint,
): JsonRecord {
  return { id, type, allow: allow.toString(), deny: deny.toString() };
}

function channel(
  id: string,
  permissionOverwrites: JsonRecord[] = [],
): JsonRecord {
  return {
    id,
    name: `channel-${id.slice(-4)}`,
    permission_overwrites: permissionOverwrites,
  };
}

function managedOverwrite(
  overrides: Partial<PendingManagedOverwrite> = {},
): PendingManagedOverwrite {
  return {
    id: "managed-row",
    channelId: "66666666666666666",
    userId: pendingUserId,
    ownedAllow: 0n,
    ownedDeny: 0n,
    ...overrides,
  };
}

function activeChange(channelId: string): PendingContainmentChange {
  return {
    action: "deny",
    channelId,
    channelName: `channel-${channelId.slice(-4)}`,
    userId: pendingUserId,
    currentAllow: 0n,
    currentDeny: 0n,
    nextAllow: 0n,
    nextDeny: VIEW_CHANNEL_PERMISSION,
    nextOwnedAllow: 0n,
    nextOwnedDeny: VIEW_CHANNEL_PERMISSION,
    managedRecord: null,
    discordWrite: true,
    dbWrite: true,
    detail: "deny view channel",
  };
}

function clearChange(channelId: string): PendingContainmentChange {
  return {
    action: "clear",
    channelId,
    channelName: `channel-${channelId.slice(-4)}`,
    userId: pendingUserId,
    currentAllow: 0n,
    currentDeny: VIEW_CHANNEL_PERMISSION,
    nextAllow: 0n,
    nextDeny: 0n,
    nextOwnedAllow: 0n,
    nextOwnedDeny: 0n,
    managedRecord: managedOverwrite({
      channelId,
      ownedDeny: VIEW_CHANNEL_PERMISSION,
    }),
    discordWrite: true,
    dbWrite: true,
    detail: "cleanup tracked overwrite",
  };
}

function containmentPlan(
  changes: PendingContainmentChange[],
): PendingContainmentPlan {
  return {
    targetUserIds: [pendingUserId],
    allowedChannelIds: [...config.allowedChannelIds],
    channelsChecked: changes.length,
    changes,
    staleRecords: [],
    conflicts: [],
    highOverwriteChannels: [],
  };
}

function readAdmin(rows: JsonRecord[]): SupabaseAdminClient {
  return {
    from(table: string) {
      assert(table === "discord_managed_permission_overwrites");
      const query: Record<string, unknown> = {
        select: () => query,
        eq: () => query,
        then: (
          resolve: (value: unknown) => unknown,
          reject: (reason: unknown) => unknown,
        ) => Promise.resolve({ data: rows, error: null }).then(resolve, reject),
      };
      return query;
    },
  };
}

function writeAdmin(events: string[]): SupabaseAdminClient {
  return {
    from(table: string) {
      assert(table === "discord_managed_permission_overwrites");
      return {
        upsert() {
          events.push("db:upsert");
          return Promise.resolve({ error: null });
        },
        update() {
          return {
            eq() {
              events.push("db:update");
              return Promise.resolve({ error: null });
            },
          };
        },
      };
    },
  };
}

function has(value: bigint, permission: bigint): boolean {
  return (value & permission) === permission;
}

function assert(
  condition: unknown,
  message = "Assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEquals(actual: unknown, expected: unknown): void {
  const normalized = (value: unknown) =>
    JSON.stringify(
      value,
      (_, item) => typeof item === "bigint" ? item.toString() : item,
    );
  if (normalized(actual) !== normalized(expected)) {
    throw new Error(
      `Expected ${normalized(expected)}, received ${normalized(actual)}`,
    );
  }
}
