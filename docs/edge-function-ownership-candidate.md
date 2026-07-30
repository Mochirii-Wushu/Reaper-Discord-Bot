# Reaper Edge Function Ownership Candidate

## Status

This is an additive, source-only candidate. It has not been deployed, has not changed any provider, and is not the production owner. The current Website source at the baseline recorded in `contracts/reaper-edge-runtime.v1.json` remains authoritative.

The recorded Website baseline is union commit
`f31834c2ce451ca4d4631690c7ea2628e7ee8821`, tree
`590cb5b67b83c9414f0c515fe6e7b3125b388b17`. Both Reaper contracts bind to
the same commit and tree so a later Website rebase cannot silently widen the
consumer boundary.

## Candidate Boundary

Reaper contains exactly six bot execution functions and the bot-owned helpers/tests they require. The canonical manifest also records all nine Discord commands routed by `reaper-discord-interactions`.

Website retains:

- migrations and database schema;
- row-level security and grants;
- schedules and provider integration settings;
- Website routes and producer functions;
- generic Supabase project configuration.

Mixed spinner logic is represented as a versioned consumer contract. Reaper copies only the roster/media validation needed by its dispatcher; draw creation and authority remain Website-owned. Database tables, RPCs, the gallery-ingest producer, and the two Website routes consumed for the guild schedule and spinner media rendering are listed in `contracts/website-supabase-consumer.v1.json` so changes cannot silently widen the dependency boundary.

## Security Boundary

All six functions use `verify_jwt=false` because they are Discord webhooks, cron consumers, or server-only dispatchers. They therefore require their reviewed application-layer authentication:

- Discord Ed25519 request signatures;
- bounded, constant-time shared-secret comparison;
- scoped spinner media capabilities;
- body-bound HMAC-SHA256 gallery ingest requests with a key ID, timestamp,
  random nonce, exact request path, and exact body digest;
- fail-closed runtime identity/origin validation;
- no provider IDs, production endpoints, or secret values in candidate source.

Runtime configuration is environment-only. Missing or malformed identities return an empty, non-cacheable 503 before the function can reach Discord or Website-owned data.

The candidate intentionally removes the inherited `GUILD_SCHEDULE_URL` override. Event sync can read only the Website-owned `data/guild-schedule.json` route derived from the validated Website origin, matching the versioned consumer contract. This is a fail-closed hardening difference from the recorded Website baseline and must be included in any future behavior-parity review.

The candidate also replaces the inherited unbounded pre-authentication Discord body read with a streaming 64 KiB ceiling. Invalid lengths, oversized bodies, stream failures, and invalid UTF-8 fail closed before signature verification or JSON routing. Signature verification operates on the exact bounded bytes. This is a second intentional hardening difference for future parity review.

The current Website baseline replaces the former gallery static-secret header
with a versioned HMAC-SHA256 request. Reaper's signer accepts a bounded set of
one to three independent keys, selects one explicit active key, signs the exact
JSON body, and emits only the four reviewed protocol headers. Unknown, weak,
duplicate, or inactive key configuration fails closed. This source-only replay
does not provision keys or activate the candidate.

## Validation

```sh
bun install --frozen-lockfile
bun run check
MOCHIRII_WEBSITE_ROOT=/absolute/path/to/clean/Website bun run website:compat
git diff --check
```

`website:compat` is read-only. It requires the exact clean Website baseline,
checks both commit and tree identities, confirms the six function/JWT and
dependency contracts, and proves that every declared table, RPC, route, and
gallery-ingest authentication header still exists. It does not contact a
provider or invoke a function.

CI pins Bun and Deno 2.9.4, verifies the Deno binary checksum, uses function-local import maps and lockfiles, and runs contract, formatting, type, behavior, path, and provider-boundary checks. The workflow has no deployment job.

## Future Activation Gate

Production ownership must not move from Website based on green source checks alone. A later approval must identify exact commits, compare behavior against the then-current Website source, configure secrets and provider identities without exposing values, preserve a compatibility window, prove rollback, and verify live request authentication and schedules. Until then, this directory is reference source only.
