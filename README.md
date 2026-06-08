# Reaper

Private Reaper command and contract helper for Mōchirīī gallery submissions.

Production gallery submissions now use the Supabase-hosted Discord Interactions webhook in the Mochirii website repo:

```text
https://deyvmtncimmcinldjyqe.supabase.co/functions/v1/reaper-discord-interactions
```

This repository remains useful for guild command registration, contract tests, and a rollback Gateway runtime reference. Do not deploy the Gateway bot as the primary production runtime unless a later approved plan reintroduces a host/process manager.

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

4. Run the rollback Gateway runtime only when explicitly needed for local contract testing:

   ```sh
   bun run dev
   ```

## Required Secrets

- `DISCORD_BOT_TOKEN`
- `DISCORD_APPLICATION_ID`
- `DISCORD_GUILD_ID`
- `DISCORD_GALLERY_CHANNEL_ID`
- `SUPABASE_FUNCTIONS_URL`
- `DISCORD_GALLERY_INGEST_SECRET`

## Validation

```sh
bun run typecheck
bun test
bun run build
```

## Production Runtime

- Primary runtime: Supabase Edge Function `reaper-discord-interactions`.
- Discord Developer Portal Interactions Endpoint URL: `https://deyvmtncimmcinldjyqe.supabase.co/functions/v1/reaper-discord-interactions`.
- Register guild commands before endpoint verification checks.
- Keep Discord, Supabase, and Instagram secrets in Supabase secrets or local ignored files only.

## Deployment Guardrails

- Keep submissions restricted to channel `1508077313965817856`.
- Do not log tokens, ingest secrets, attachment signed URLs, or private payload bodies.
- If a token or secret is exposed, rotate it before restarting production.
- No real Instagram post is created by this repo or by Discord submission alone.
