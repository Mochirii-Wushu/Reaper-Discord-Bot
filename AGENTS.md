# Repository Guidance

- Reaper is the private command/contract helper for Mōchirīī gallery slash-command submissions and the Gateway-only new-member welcome DM worker. Production slash-command handling still runs from the Website repository's Supabase Edge Functions.
- `supabase/` is an additive, local-only ownership candidate for exactly the six functions in `contracts/reaper-edge-runtime.v1.json`. It is not deployed. Keep migrations, schema, RLS, schedules, Website producers, and generic project config in Website until an exact ownership-migration approval says otherwise.
- Do not deploy the Gateway bot as the primary slash-command production runtime unless a later approved plan changes that architecture. The welcome DM worker is the approved Gateway use because Discord member joins are Gateway events.
- Keep bot tokens, Supabase ingest secrets, production Discord IDs, and runtime credentials out of GitHub, docs, logs, screenshots, and PR comments. Synthetic Discord fixtures are allowed only in tests. Use `.env.local` locally and Supabase secrets in production.
- Welcome DM work requires Discord Developer Portal Server Members Intent / `GUILD_MEMBERS`, but not Administrator, Message Content, Presences, or role mutation.
- The welcome DM is private DM-only. If DMs fail, record a redacted warning and do not post a public fallback.
- The `/submit` command contract is:
  `/submit image:<file> title:<title> subtitle:<subtitle> share_to_instagram:<true|false>`.
- `share_to_instagram` is optional, defaults to `false`, and maps to the Supabase `instagramOptIn` JSON boolean. Send `true` only when the member explicitly selects true.
- Keep submissions restricted to the channel configured by `DISCORD_GALLERY_CHANNEL_ID`; never commit its production value.
- `subtitle` maps to the website gallery `caption` field.
- The Supabase-hosted Discord Interactions webhook calls the Mochirii Supabase Edge Function `submit-discord-gallery-image` with `x-mochirii-reaper-secret`. Do not call Instagram or publish media from Reaper.
- Gallery approval and Instagram publishing remain website moderator workflows; Reaper only creates pending submissions.
- Run validation before completing work: `bun install`, `bun run check`, and `git diff --check`.
- Keep Edge Function manifests and locks function-local, pin Deno to 2.9.4 in CI, and preserve application-layer signature/shared-secret checks because all six functions intentionally use `verify_jwt=false`.
- Do not add deployment workflows, provider IDs, production endpoints, secret values, or live configuration to the additive candidate.
- Use guild-scoped command registration first. Do not register global commands unless explicitly requested.
