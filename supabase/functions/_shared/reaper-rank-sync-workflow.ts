import {
  asArray,
  asRecord,
  type JsonRecord,
  safeString,
} from "./discord-interaction-helpers.ts";

type SupabaseAdminClient = {
  from(table: string): any;
};

type DiscordApiResult = {
  ok: boolean;
  status: number;
  data: unknown;
};

type RankSyncDeps = {
  baseGuildRoleId: string;
  discordApi(path: string, init?: RequestInit): Promise<DiscordApiResult>;
  discordApiHeaders(contentType?: boolean): Headers;
  editOriginalInteractionResponse(
    applicationId: string,
    interactionToken: string,
    content: string,
  ): Promise<void>;
  expectedGuildId: string;
  serviceAdminClient(purpose: string): SupabaseAdminClient;
};

const RANK_ROLES = [
  { name: "Guild Leader", tier: "senior", order: 1 },
  { name: "Vice Leader", tier: "senior", order: 2 },
  { name: "Hall Leader", tier: "senior", order: 3 },
  { name: "Dharmapala", tier: "middle", order: 4 },
  { name: "Lotus Warden", tier: "middle", order: 5 },
  { name: "Petal Keeper", tier: "middle", order: 6 },
  { name: "Mochi Blossom", tier: "members", order: 7 },
  { name: "Young Bamboo", tier: "members", order: 8 },
  { name: "Softwind", tier: "members", order: 9 },
  { name: "Rice Sprout", tier: "members", order: 10 },
];

function roleNameKey(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function hasChannelOverwrite(channels: JsonRecord[], roleId: string): boolean {
  return channels.some((channel) =>
    asArray(channel.permission_overwrites).some((overwrite) => {
      const record = asRecord(overwrite);
      if (safeString(record.id, 24) !== roleId) return false;
      const allow = String(record.allow || "0");
      const deny = String(record.deny || "0");
      return allow !== "0" || deny !== "0";
    })
  );
}

function roleSafetyProblems(
  role: JsonRecord,
  channels: JsonRecord[],
): string[] {
  const problems: string[] = [];
  const roleId = safeString(role.id, 24) || "";
  if (String(role.permissions || "0") !== "0") {
    problems.push("nonzero permissions");
  }
  if (role.hoist === true) problems.push("displayed separately");
  if (role.mentionable === true) problems.push("mentionable");
  if (hasChannelOverwrite(channels, roleId)) {
    problems.push("channel overwrites");
  }
  return problems;
}

function rankSummaryLine(
  action: string,
  rankName: string,
  detail = "",
): string {
  return detail
    ? `${action}: ${rankName} (${detail})`
    : `${action}: ${rankName}`;
}

async function upsertDiscordResource(
  role: JsonRecord,
  rank: typeof RANK_ROLES[number],
  deps: RankSyncDeps,
): Promise<void> {
  const roleId = safeString(role.id, 24);

  if (!roleId) {
    throw new Error(
      "Supabase service credentials are not configured for rank registry updates.",
    );
  }

  const adminClient = deps.serviceAdminClient("rank registry updates");
  const { error } = await adminClient
    .from("discord_resources")
    .upsert(
      {
        kind: "role",
        label: rank.name,
        discord_id: roleId,
        discord_parent_id: deps.expectedGuildId,
        enabled: true,
        description: `Vanity guild rank role for ${rank.name}.`,
        metadata: {
          managedBy: "reaper-rank-sync",
          vanityOnly: true,
          rankTier: rank.tier,
          rankOrder: rank.order,
          source: "data/ranks.json",
          baseAccessRoleId: deps.baseGuildRoleId,
        },
      },
      { onConflict: "kind,discord_id" },
    );

  if (error) {
    console.error("reaper-discord-interactions rank registry upsert failed", {
      code: error.code,
      errorType: "database_upsert_failed",
    });
    throw new Error(
      "Rank role was created but could not be recorded in the website registry.",
    );
  }
}

export async function processRankSync(
  mode: string,
  interactionToken: string,
  applicationId: string,
  deps: RankSyncDeps,
): Promise<void> {
  const apply = mode === "apply";
  const lines: string[] = [];

  try {
    if (!Deno.env.get("DISCORD_BOT_TOKEN")) {
      await deps.editOriginalInteractionResponse(
        applicationId,
        interactionToken,
        "Reaper rank sync is missing the Discord bot token.",
      );
      return;
    }

    const rolesResponse = await deps.discordApi(
      `/guilds/${deps.expectedGuildId}/roles`,
      {
        headers: deps.discordApiHeaders(),
      },
    );
    const channelsResponse = await deps.discordApi(
      `/guilds/${deps.expectedGuildId}/channels`,
      {
        headers: deps.discordApiHeaders(),
      },
    );

    if (!rolesResponse.ok || !channelsResponse.ok) {
      await deps.editOriginalInteractionResponse(
        applicationId,
        interactionToken,
        "Reaper could not read guild roles and channels. Check bot role hierarchy and permissions.",
      );
      return;
    }

    const roles = asArray(rolesResponse.data).map(asRecord);
    const channels = asArray(channelsResponse.data).map(asRecord);
    const roleByName = new Map(
      roles.map((role) => [roleNameKey(role.name), role]),
    );

    for (const rank of RANK_ROLES) {
      const existing = roleByName.get(roleNameKey(rank.name));
      if (existing) {
        const problems = roleSafetyProblems(existing, channels);
        if (problems.length) {
          lines.push(
            rankSummaryLine("Blocked", rank.name, problems.join(", ")),
          );
          continue;
        }

        lines.push(
          rankSummaryLine(
            "Adopted",
            rank.name,
            `role ${safeString(existing.id, 24) || "unknown"}`,
          ),
        );
        if (apply) await upsertDiscordResource(existing, rank, deps);
        continue;
      }

      if (!apply) {
        lines.push(
          rankSummaryLine(
            "Would create",
            rank.name,
            "zero-permission vanity role",
          ),
        );
        continue;
      }

      const createResponse = await deps.discordApi(
        `/guilds/${deps.expectedGuildId}/roles`,
        {
          method: "POST",
          headers: deps.discordApiHeaders(true),
          body: JSON.stringify({
            name: rank.name,
            permissions: "0",
            color: 0,
            hoist: false,
            mentionable: false,
          }),
        },
      );

      if (!createResponse.ok) {
        lines.push(
          rankSummaryLine(
            "Blocked",
            rank.name,
            `Discord API ${createResponse.status}`,
          ),
        );
        continue;
      }

      const createdRole = asRecord(createResponse.data);
      lines.push(
        rankSummaryLine(
          "Created",
          rank.name,
          `role ${safeString(createdRole.id, 24) || "unknown"}`,
        ),
      );
      await upsertDiscordResource(createdRole, rank, deps);
    }

    const intro = apply
      ? "Rank sync finished. Rank roles are vanity-only; assign them manually in Discord."
      : "Rank sync preview. No Discord roles were changed.";
    await deps.editOriginalInteractionResponse(
      applicationId,
      interactionToken,
      `${intro}\n${lines.slice(0, 20).join("\n")}`,
    );
  } catch {
    console.error("reaper-discord-interactions rank sync failed", {
      errorType: "rank_sync_failed",
    });
    await deps.editOriginalInteractionResponse(
      applicationId,
      interactionToken,
      "Reaper rank sync could not be completed. Check configuration and try preview again.",
    );
  }
}
