# Repository Guidance

- Reaper is the private command/contract helper for Mōchirīī gallery slash-command submissions. Production command handling now runs through the Mochirii repo's Supabase Edge Function `reaper-discord-interactions`.
- Do not deploy the Gateway bot as the primary production runtime unless a later approved plan reintroduces a host/process manager.
- Keep bot tokens, Supabase ingest secrets, Discord IDs, and runtime credentials out of GitHub, docs, logs, screenshots, and PR comments. Use `.env.local` locally and Supabase secrets in production.
- The `/submit` command contract is:
  `/submit image:<file> title:<title> subtitle:<subtitle> share_to_instagram:<true|false>`.
- `share_to_instagram` is optional, defaults to `false`, and maps to the Supabase `instagramOptIn` JSON boolean. Send `true` only when the member explicitly selects true.
- Keep submissions restricted to channel `1508077313965817856`.
- `subtitle` maps to the website gallery `caption` field.
- The Supabase-hosted Discord Interactions webhook calls the Mochirii Supabase Edge Function `submit-discord-gallery-image` with `x-mochirii-reaper-secret`. Do not call Instagram or publish media from Reaper.
- Gallery approval and Instagram publishing remain website moderator workflows; Reaper only creates pending submissions.
- Run validation before completing work: `bun install`, `bun run typecheck`, `bun test`, and `bun run build`.
- Use guild-scoped command registration first. Do not register global commands unless explicitly requested.
