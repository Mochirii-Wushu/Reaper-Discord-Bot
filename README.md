# Reaper

Private Discord bot runtime for Mōchirīī gallery submissions.

## Current Contract

Reaper owns the Discord slash-command entrypoint for member gallery submissions:

```text
/submit image:<file> title:<title> subtitle:<subtitle> share_to_instagram:<true|false>
```

`share_to_instagram` is optional and defaults to `false`. Reaper sends `instagramOptIn: true` only when the member explicitly selects true. It does not publish to Instagram. The Mochirii website moderator workflow creates and publishes Instagram queue items after approval.

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

4. Run the bot:

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

## Deployment Guardrails

- Register guild commands before runtime deployment checks.
- Keep submissions restricted to channel `1508077313965817856`.
- Do not log tokens, ingest secrets, attachment signed URLs, or private payload bodies.
- If a token or secret is exposed, rotate it before restarting production.
- No real Instagram post is created by this bot.
