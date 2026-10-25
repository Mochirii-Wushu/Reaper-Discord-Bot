# Repository Guidance

## Ownership

- Reaper is the terminal source, test, scoped-deployment, and operations owner
  for exactly these six Supabase Edge Functions: `reaper-discord-interactions`,
  `reaper-discord-member-sync`, `reaper-spinner-dispatch`, `send-vote-reminder`,
  `send-member-spotlight-poll`, and `publish-member-spotlight-winner`.
- Reaper also owns the persistent Gateway welcome/member-sync worker, Discord
  command registration contract, tests, and rollback reference.
- Reaper is Mōchirīī's Discord automation runtime. Website owns monthly member
  selection, its public snapshot reader, shared data and authoritative UTC+8
  schedules; Twitch work owns streaming content and artwork. Reaper consumes
  those approved contracts without taking over their source or selection.
- Website retains migrations, tables, RLS, grants, shared schema, schedules,
  generic Supabase configuration, `submit-discord-gallery-image`, shared
  identity/authorization, and the current production writer until a separately
  approved single-writer cutover.
- Keep the Reaper Edge Function tree under `supabase/functions`. Never add
  `supabase/config.toml`, migrations, schedules, copied Website routes, or a
  second schema owner here.
- The exact immutable predecessor closure and every source-to-target decision
  are recorded in `contracts/reaper-source-relocation.v1.json`. Safe
  Reaper-specific implementations may be retained whole; Website-shared modules
  must remain explicit versioned adapters/contracts.

## Security contracts

- All six functions intentionally use `verify_jwt=false`; each entry point must
  enforce its documented application-layer Discord signature, HMAC, or strong
  shared-secret authentication before parsing or acting on a body.
- Within `supabase/functions`, JSON at an untrusted boundary must be
  size-bounded and parsed with the shared duplicate-key rejecting parser. Do not
  use direct `Request.json()`, `Response.json()`, or unguarded `JSON.parse()` in
  Edge runtime code. Gateway hardening outside this exact six-function lane
  remains separately scoped.
- The gallery-ingest HMAC signer contract is owned here; Website owns the
  independent verifier and one-use nonce store. Preserve exact-body-byte
  SHA-256, HMAC-SHA-256, method/runtime-normalized WHATWG
  pathname/timestamp/nonce canonicalization, the exact four headers, skew, size,
  key-length, and replay semantics documented in
  `contracts/discord-gallery-ingest-hmac.v1.json`. The Edge verifier cannot bind
  the raw HTTP request-target; gateway normalization is an activation gate.
- Gallery submissions require a canonical declared JPEG, PNG, or WebP MIME that
  matches the attachment filename extension before HMAC signing. Missing, null,
  mismatched, or extension-only inferred MIME fails closed.
- The signed gallery payload has exactly fourteen reviewed keys. IDs are
  canonical positive uint64 decimal strings; the exact normalized Discord CDN
  URL is bound to its channel and attachment IDs; size is a safe integer from 1
  through 8 MiB; filename and optional title/caption are exact, trim-stable,
  bounded strings with explicit null optionals. Reject rather than coerce or
  truncate signed metadata, and reject U+FEFF anywhere before signing.
- Keep provider identifiers, provider origins, secrets, and live URLs out of
  source, contracts, docs, test fixtures, logs, screenshots, and PR comments.
  Runtime origins and IDs must be validated configuration; tests use only
  synthetic `.test` origins and synthetic identifiers.
- Keep bot tokens, service-role keys, HMAC keys, shared secrets, member data,
  media bytes, signed URLs, and private payloads out of Git and diagnostics.
- Reaper never publishes to Instagram. `share_to_instagram` remains an explicit
  opt-in field defaulting to `false`; Website moderator workflows remain the
  publication owner.

## Gateway invariants

- Use only the `Guilds` and `GuildMembers` intents. Do not request
  Administrator, Message Content, Presences, or role-management permission for
  the welcome worker.
- The legacy welcome route is private DM-only and has no public fallback. The
  separately approved community route may welcome new members and post goodbyes only in its
  explicitly configured and verified guild text channel, with DMs disabled.
  Both new community routes default to disabled; route failure never selects
  another channel or delivery mode. Preserve durable notice receipts and hold
  uncertain sends rather than replaying them.
- Monthly Gateway announcements consume only Website's current-month public
  winner DTO. Never select, redraw, read candidate records, revive legacy polls,
  or change the selector schedule as part of announcement delivery.
- Pending-verification forwarding remains disabled by default, bounded, and
  fail-closed. It does not authorize direct Discord role mutation.
- Use guild-scoped command registration first. Global command registration
  requires separate explicit approval.

## Change and activation boundary

- Read every applicable workspace/repository `AGENTS.md`, inspect status, and
  preserve all user changes before editing. Never edit `main` directly.
- Keep changes within the six-function source boundary and its explicit
  adapters, contracts, tests, CI, and local checkers. Do not broadly copy a
  Website tree or import uncommitted Website overrides.
- No source change authorizes a commit, push, PR, package/image publication,
  deployment, Supabase/Discord/provider mutation, production restart, command
  registration, message send, or production-data access.
- Website remains the current production writer until an approved cutover packet
  names the exact source closure, merge/deploy order, rollback, and live
  single-writer readback.

## Local validation

Run the narrowest relevant checks plus the repository baseline:

```sh
git diff --check
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
bun run check
```

For Edge Function source, also run the manifest/checker, Deno formatting,
type-check, and synthetic tests exposed by `package.json`. Do not run Reaper
`dev`, `start`, `register:guild`, deployment tooling, or provider-connected
commands as ordinary validation.
