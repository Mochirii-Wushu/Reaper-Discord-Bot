# Reaper

Private Reaper runtime repository for Mōchirīī Discord automation and the
Gateway-only member welcome worker.

Website remains the current production writer while this repository establishes
the terminal source boundary for six Edge Functions. No cutover, provider
change, or deployment is implied by this local source candidate.

```text
${SUPABASE_FUNCTIONS_URL}/reaper-discord-interactions
```

Reaper also retains guild command registration, contract tests, a rollback
Gallery Gateway reference, and the separate welcome-DM Gateway worker.

## Edge Function Source Ownership

Reaper is the terminal implementation, test, scoped-deployment, and operations
owner for exactly these functions:

- `reaper-discord-interactions`
- `reaper-discord-member-sync`
- `reaper-spinner-dispatch`
- `send-vote-reminder`
- `send-member-spotlight-poll`
- `publish-member-spotlight-winner`

Website retains migrations, tables, RLS, grants, shared schema, schedules,
generic Supabase configuration, `submit-discord-gallery-image`, shared
identity/authorization, and the current production writer until an explicitly
approved single-writer cutover. Reaper therefore contains only
`supabase/functions`; it must not contain `supabase/config.toml`, migrations, or
schedules.

The immutable Website predecessor is commit
`f587409adef29d4735b5e6ce8512c794579d8bef`. Its exact 31-file runtime,
seven-file packaging, and six-function configuration seals are recorded in
[`contracts/reaper-source-relocation.v1.json`](contracts/reaper-source-relocation.v1.json).
That manifest distinguishes the 18 safe Reaper-specific source files from the 13
Website-shared interfaces/adapters and records uncommitted Website overrides as
deferred inputs rather than importing them. See
[`docs/reaper-edge-source-ownership.md`](docs/reaper-edge-source-ownership.md).

## Welcome DM Gateway Worker

New-member welcome DMs require a persistent Discord Gateway connection because
Discord member-join notifications are Gateway events, not Interactions webhooks.
Supabase Edge Functions and Vercel Functions are not the right runtime for that
long-running connection.

Enable Discord Developer Portal > Reaper > Bot > Privileged Gateway Intents >
Server Members Intent before deploying this worker.

The worker listens for `guildMemberAdd`, ignores bots and other guilds, then
sends this exact DM with mentions disabled:

```text
Welcome to Mōchirīī pretty guildies!

For more guild info, flutter over to https://mochirii.com & make sure to sync your Discord account so all the hidden guild doors unlock properly.

To view & interact with the WWM guild channels, you’ll need the Mōchirīī guild role. If you want to submit gallery images to the guild website & enjoy other guild-exclusive features, you’ll also need the Verified role.

Introduce yourself with your in-game guild title so we can add it to your role list & sync it with our guild site ranking system.

Mōchirīī is constantly evolving, if you have any questions, get stuck, or feel a tiny bit lost in the clouds, please DM a Moderator anytime. We’re so excited to have you here!
```

If a member blocks DMs, Reaper records a redacted warning and does not post a
public fallback message.

## Pending Verification Forwarder

Pending-verification forwarding is a second release and is disabled by default
with:

```text
REAPER_PENDING_VERIFICATION_SYNC_ENABLED=false
```

When approved and enabled, the Gateway worker posts `guildMemberAdd` and
role-changing `guildMemberUpdate` events to the Mochirii Supabase Edge Function:

```text
${REAPER_PENDING_VERIFICATION_SYNC_URL}
```

The worker uses only `Guilds` and `GuildMembers` intents. It does not mutate
Discord roles or channel permission overwrites directly and does not store
Supabase service-role keys. The Edge Function owns the current-member fetch,
conflict checks, max-mutation guard, tracked `VIEW_CHANNEL` overwrite writes,
and fixed-schema aggregate-only `discord_sync_log` entries. Before any request,
the worker stores a UUID and byte-identical payload in a private host spool.
The compatible Website release permanently binds that UUID to its payload and
holds a durable fence shared by all containment writers. Forwarding activation
requires that release; the older endpoint is incompatible.

## Current Contract

The public Discord command contract is:

```text
/submit image:<file> title:<title> subtitle:<subtitle> share_to_instagram:<true|false>
```

`share_to_instagram` is optional and defaults to `false`. The Supabase-hosted
interaction sends `instagramOptIn: true` only when the member explicitly selects
true. Reaper does not publish to Instagram. The Mochirii website moderator
workflow creates and publishes Instagram queue items after approval.

The Gateway rollback client is compiled but inert by default. Only the exact
value `REAPER_GALLERY_GATEWAY_ROLLBACK_ENABLED=true` permits guild-command
registration or `/submit` handling, and the gate is checked before Gallery
configuration, serialization, HMAC creation, or network access. It uses the
same four-header, body-bound HMAC-SHA256 v1 wire contract as the Reaper-owned
Edge signer and validates the exact fourteen-field payload before signing.
This flag is necessary but never sufficient for production activation. Website
remains the sole writer until a separately approved exact source/artifact,
provider-normalization, compatibility, rollback, and single-writer readback
packet succeeds. No source check or local flag changes provider state.

## Setup

1. Install dependencies:

   ```sh
   bun install --frozen-lockfile --ignore-scripts
   ```

2. Create `.env.local` from `.env.example` and fill secret values locally or in
   the bot host secret manager. Never commit real values.

3. Register the guild command:

   ```sh
   bun run register:guild
   ```

4. Run the Gateway worker when an approved persistent host is available:

   ```sh
   bun run dev
   ```

## Required Secrets

- `DISCORD_BOT_TOKEN`
- `DISCORD_APPLICATION_ID`
- `DISCORD_GUILD_ID`
- `WELCOME_DM_ENABLED`
- `REAPER_PENDING_VERIFICATION_SYNC_ENABLED`
- `REAPER_PENDING_VERIFICATION_SYNC_URL`
- `REAPER_PENDING_VERIFICATION_SYNC_SECRET`
- `REAPER_PENDING_VERIFICATION_SYNC_TIMEOUT_MS` (optional, defaults to `5000`)
- `REAPER_PENDING_VERIFICATION_SYNC_MAX_ATTEMPTS` (optional, defaults to `2`)
- `REAPER_GALLERY_GATEWAY_ROLLBACK_ENABLED` (optional, exact `true` only;
  defaults to `false`)
- `DISCORD_GALLERY_CHANNEL_ID`
- `DISCORD_GALLERY_ATTACHMENT_ORIGINS`
- `DISCORD_REQUIRED_ROLE_IDS` (exactly two canonical role IDs)
- `SUPABASE_FUNCTIONS_URL`
- `DISCORD_GALLERY_INGEST_HMAC_KEYS_JSON`
- `DISCORD_GALLERY_INGEST_HMAC_ACTIVE_KEY_ID`

The welcome DM worker only needs `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, and
optional `WELCOME_DM_ENABLED`. Gallery command registration and the inactive
rollback `/submit` Gateway reference require the explicit rollback gate, exact
Discord authorization context, attachment-origin allowlist, and bounded HMAC
key set. The
Reaper-owned Edge signer selects the same versioned key contract at runtime;
real values belong only in an approved server-side secret destination.

## Validation

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
bun run typecheck
bun test
bun run build
bun run contracts:check
MOCHIRII_WEBSITE_ROOT=/absolute/path/to/clean/Website bun run website:compat
bun run audit:all
```

`audit:all` requires both the Bun advisory audit and pinned Deno advisory audits
for all six tracked function lock graphs. The latter is CI/validation network
access only; deployed Reaper runtime has no advisory-registry dependency.

`bun run check` includes the complete dependency advisory inventory, source-only
release contract, approved welcome-message hash, Gateway lifecycle contract, and
Edge Function checks. See [`SECURITY.md`](SECURITY.md) and
[`docs/dependency-security.md`](docs/dependency-security.md).

The provider-neutral immutable OCI source contract is documented in
[`docs/operations/GATEWAY-ARTIFACT.md`](docs/operations/GATEWAY-ARTIFACT.md).
Source validation builds and inspects an image without authenticating to a
registry; publication, host selection, deployment, and provider changes remain
false release gates.

## Private runtime readiness

An approved persistent host may configure `REAPER_HEALTH_STATE_PATH` to an
absolute host-owned file. The worker atomically records a provider-neutral
readiness snapshot without account, guild, member, or credential values. A
private supervisor probe uses `bun run health:check -- <absolute-path>`.

The immutable-artifact, SBOM, provenance, restart, session-resume, rollback, and
workstation-off gates are defined in
[`contracts/gateway-release.v1.json`](contracts/gateway-release.v1.json) and
[`docs/runtime-operations.md`](docs/runtime-operations.md). This repository
still contains no deployment workflow and no runtime has been activated.

## Production Runtime

- Primary slash-command runtime: Supabase Edge Function
  `reaper-discord-interactions`.
- Welcome DM runtime: persistent Gateway worker from this repo.
- Discord Developer Portal Interactions Endpoint URL remains provider-managed
  and is not recorded in this repository.
- Register guild commands before endpoint verification checks.
- Keep Discord, Supabase, and Instagram secrets in Supabase secrets or local
  ignored files only.
- Pending-verification forwarding uses a private persistent host spool and one
  sequential drainer. It retains at most 256 records of at most 32 KiB each.
  Admission, corruption, or storage failure raises a readiness fault; no event
  is reported as delivered. Logs contain only fixed labels and counts.
- The configured target must be the canonical credential-free HTTPS
  `/functions/v1/reaper-discord-member-sync` endpoint, without a query or
  fragment. Requests reject redirects.
- Each delivery pass starts with an authenticated UUID status lookup. Only a
  durable `missing` receipt admits a POST using the original UUID and exact
  spooled body. Network errors, timeouts, malformed acknowledgements, `408`,
  `429`, and `5xx` responses never trigger a blind POST replay.
- Only an exact completed receipt removes work. Pending work retains its UUID
  and bounded backoff across restarts. Blocked/rejected work remains quarantined
  and holds later queued events for operator reconciliation; there is no timed
  takeover or restart reset. Welcome DMs remain independently enabled.

The concrete local hosting candidate and remaining publication/activation gates
are in [`docs/operations/GATEWAY-DEPLOYMENT.md`](docs/operations/GATEWAY-DEPLOYMENT.md).

## Release Boundary

- This source change does not enable pending-verification forwarding, deploy
  Reaper, change Discord or Supabase configuration, or send a Discord message.
- Local and pull-request validation uses synthetic fixtures with no provider
  network calls. Green source tests do not prove that a production Gateway
  worker is running this revision.
- Enabling the forwarder, publishing a runtime image, or changing a live worker
  requires a separately reviewed deployment packet with exact source,
  configuration, rollback, and live readback evidence.
- Reaper is the terminal source owner but is not yet the production writer.
  Moving the live writer requires an exact single-writer provider packet, a
  compatibility window, and rollback/readback evidence.

## Deployment Guardrails

- Keep submissions restricted to the channel configured by
  `DISCORD_GALLERY_CHANNEL_ID`; never commit its production value.
- Do not log tokens, ingest secrets, attachment signed URLs, or private payload
  bodies.
- Do not grant Reaper Administrator, Message Content, Presences, or
  role-management permissions for the welcome DM worker.
- If a token or secret is exposed, rotate it before restarting production.
- No real Instagram post is created by this repo or by Discord submission alone.
