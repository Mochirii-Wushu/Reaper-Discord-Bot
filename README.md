# Reaper

Private Reaper command and contract helper for Mōchirīī gallery submissions and Gateway-only member welcome DMs.

Production gallery submissions now use the Supabase-hosted Discord Interactions webhook in the Mochirii website repo:

```text
https://deyvmtncimmcinldjyqe.supabase.co/functions/v1/reaper-discord-interactions
```

This repository remains useful for guild command registration, contract tests, a rollback Gallery Gateway runtime reference, and the separate welcome-DM Gateway worker. Do not move slash-command production handling away from Supabase unless a later approved plan changes that architecture.

## Welcome DM Gateway Worker

New-member welcome DMs require a persistent Discord Gateway connection because Discord member-join notifications are Gateway events, not Interactions webhooks. Supabase Edge Functions and Vercel Functions are not the right runtime for that long-running connection.

Enable Discord Developer Portal > Reaper > Bot > Privileged Gateway Intents > Server Members Intent before deploying this worker.

The worker listens for `guildMemberAdd`, ignores bots and other guilds, then sends this exact DM with mentions disabled:

```text
Welcome to Mōchirīī pretty guildies!

For more guild info, flutter over to https://mochirii.com & make sure to sync your Discord account so all the hidden guild doors unlock properly.

To view & interact with the WWM guild channels, you’ll need the Mōchirīī guild role. If you want to submit gallery images to the guild website & enjoy other guild-exclusive features, you’ll also need the Verified role.

Introduce yourself with your in-game guild title so we can add it to your role list & sync it with our guild site ranking system.

Mōchirīī is constantly evolving, if you have any questions, get stuck, or feel a tiny bit lost in the clouds, please DM a Moderator anytime. We’re so excited to have you here!
```

If a member blocks DMs, Reaper records a redacted warning and does not post a public fallback message.

## Pending Verification Forwarder

Pending-verification forwarding is a second release and is disabled by default with:

```text
REAPER_PENDING_VERIFICATION_SYNC_ENABLED=false
```

When approved and enabled, the Gateway worker posts `guildMemberAdd` and role-changing `guildMemberUpdate` events to the Mochirii Supabase Edge Function:

```text
https://deyvmtncimmcinldjyqe.supabase.co/functions/v1/reaper-discord-member-sync
```

The worker uses only `Guilds` and `GuildMembers` intents. It does not mutate Discord roles or channel permission overwrites directly and does not store Supabase service-role keys. The Edge Function owns the current-member fetch, conflict checks, max-mutation guard, tracked `VIEW_CHANNEL` overwrite writes, and redacted `discord_sync_log` entries. Retries reuse one byte-identical desired-state payload; the Edge Function re-fetches current member state before calculating changes, so a repeated delivery converges without duplicating an already-applied overwrite.

## Current Contract

The public Discord command contract is:

```text
/submit image:<file> title:<title> subtitle:<subtitle> share_to_instagram:<true|false>
```

`share_to_instagram` is optional and defaults to `false`. The Supabase-hosted interaction sends `instagramOptIn: true` only when the member explicitly selects true. Reaper does not publish to Instagram. The Mochirii website moderator workflow creates and publishes Instagram queue items after approval.

## Setup

1. Install dependencies:

   ```sh
   bun install
   ```

2. Create `.env.local` from `.env.example` and fill secret values locally or in the bot host secret manager. Never commit real values.

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
- `DISCORD_GALLERY_CHANNEL_ID`
- `SUPABASE_FUNCTIONS_URL`
- `DISCORD_GALLERY_INGEST_SECRET`

The welcome DM worker only needs `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, and optional `WELCOME_DM_ENABLED`. Gallery command registration and the rollback `/submit` Gateway fallback still require the other values.

## Validation

```sh
bun run typecheck
bun test
bun run build
```

## Production Runtime

- Primary slash-command runtime: Supabase Edge Function `reaper-discord-interactions`.
- Welcome DM runtime: persistent Gateway worker from this repo.
- Discord Developer Portal Interactions Endpoint URL: `https://deyvmtncimmcinldjyqe.supabase.co/functions/v1/reaper-discord-interactions`.
- Register guild commands before endpoint verification checks.
- Keep Discord, Supabase, and Instagram secrets in Supabase secrets or local ignored files only.
- Pending-verification forwarding uses bounded Edge Function attempts and per-attempt timeouts. Logs stay redacted and record only status labels, short snowflake suffixes, counts, and attempt numbers.
- Retryable `408`, `429`, and `5xx` responses use bounded backoff. A valid `Retry-After` is honored only within the five-second retry-delay budget; a larger delay fails closed for a later Gateway event or operator retry.

## Release Boundary

- This source change does not enable pending-verification forwarding, deploy Reaper, change Discord or Supabase configuration, or send a Discord message.
- Local and pull-request validation uses synthetic fixtures with no provider network calls. Green source tests do not prove that a production Gateway worker is running this revision.
- Enabling the forwarder, publishing a runtime image, or changing a live worker requires a separately reviewed deployment packet with exact source, configuration, rollback, and live readback evidence.

## Deployment Guardrails

- Keep submissions restricted to the channel configured by `DISCORD_GALLERY_CHANNEL_ID`; never commit its production value.
- Do not log tokens, ingest secrets, attachment signed URLs, or private payload bodies.
- Do not grant Reaper Administrator, Message Content, Presences, or role-management permissions for the welcome DM worker.
- If a token or secret is exposed, rotate it before restarting production.
- No real Instagram post is created by this repo or by Discord submission alone.
