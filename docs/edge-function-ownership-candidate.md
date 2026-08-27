# Reaper Edge Function Ownership Candidate

## Status

This is a source-only terminal ownership candidate. Source publication does not
package, deploy, activate, or change a provider. Website remains the current
production writer until a separately approved single-writer cutover.

The immutable Website predecessor is `f587409adef29d4735b5e6ce8512c794579d8bef`.
Its exact runtime, packaging, and configuration seals are recorded in
`contracts/reaper-source-relocation.v1.json`. The separately bound
protected-main reconciliation remains activation-blocked for every changed or
absent source input.

## Candidate Boundary

Reaper contains exactly six bot execution functions and their explicit
Reaper-specific helpers, versioned Website-boundary adapters, tests, and local
checkers. The runtime contract records all nine Discord commands routed by
`reaper-discord-interactions`.

Website retains:

- migrations and database schema;
- row-level security and grants;
- schedules and provider integration settings;
- Website routes and producer functions;
- generic Supabase project configuration.

Mixed spinner logic is represented as a versioned consumer adapter. Reaper owns
only dispatcher-side roster/media validation; draw creation and authority remain
Website-owned. Database tables, RPCs, the gallery-ingest producer, and the two
Website routes consumed for schedule and media rendering remain listed in
`contracts/website-supabase-consumer.v1.json`.

## Security Boundary

All six functions use `verify_jwt=false` because they are Discord webhooks, cron
consumers, or server-only dispatchers. They therefore require their reviewed
application-layer authentication:

- Discord Ed25519 request signatures;
- bounded, constant-time shared-secret comparison;
- scoped spinner media capabilities;
- body-bound HMAC-SHA256 gallery ingest requests with a key ID, timestamp,
  random nonce, the runtime-normalized WHATWG pathname, and an exact bounded
  request-body-byte digest;
- a versioned authorization-context digest binding the configured guild, gallery
  channel, and exact required-role set inside that signed body;
- fail-closed runtime identity/origin validation;
- no provider IDs, production endpoints, or secret values in candidate source.

Runtime configuration is environment-only. Missing or malformed identities
return an empty, non-cacheable 503 before the function can reach Discord or
Website-owned data.

Event sync can read only the Website-owned `data/guild-schedule.json` route
derived from the validated Website origin. It does not accept an arbitrary
schedule URL override.

The Discord interaction body uses a streaming 64 KiB ceiling. Invalid lengths,
oversized bodies, stream failures, invalid UTF-8, or duplicate JSON keys fail
closed. Signature verification operates on the exact bounded bytes before JSON
routing.

Every non-PING interaction then requires a durable replay claim before any
mutation or deferred effect. The checked-in schema-independent adapter is
dormant and unbound; therefore mutating interaction routes fail closed until a
Website-owned durable schema and provider binding are separately approved.
`waitUntil` scheduling cannot satisfy claim completion because a scheduled
callback can be lost across process or host failure. Activation requires
provider-backed durable enqueue, fenced effect completion, and duplicate, retry,
and crash evidence accepted against the bound Website-owned provider.

The predecessor replaces the former gallery static-secret header with a
versioned HMAC-SHA256 request. Reaper's signer accepts a bounded set of one to
three independent keys, selects one explicit active key, signs the exact JSON
body, and emits only the four reviewed protocol headers. Unknown, weak,
duplicate, or inactive key configuration fails closed. This source-only replay
does not provision keys or activate the candidate.

The signer uses the reviewed constant pathname. Website can verify only the
runtime-normalized WHATWG URL pathname exposed to its Edge Function, together
with an empty search, hash, and userinfo and an allowed runtime origin and port.
The raw HTTP request-target is not visible to the verifier and is not
HMAC-bound; gateway normalization remains an explicit private activation
manifest and provider-readback gate. Website hashes the exact bounded request
body bytes without decoding or normalization; after HMAC verification and
one-use nonce consumption, it rejects U+FEFF anywhere in the decoded JSON,
including an initial BOM. Before signing, Reaper also requires Discord to
declare a canonical JPEG, PNG, or WebP MIME that agrees with the filename
extension. Missing, null, or mismatched MIME fails closed; the producer does not
infer MIME from an extension alone.

The producer emits exactly the fourteen fields recorded in the Website consumer
contract. Its five Discord identifiers are canonical positive uint64 decimal
strings. The exact normalized allowlisted Discord attachment URL is bound to the
same channel and attachment IDs, and the declared size must be a safe integer
from 1 through 8 MiB. The original filename is exact, trim-stable, nonempty, and
at most 255 characters. Title and caption are explicit nulls when absent or
exact trim-stable nonempty strings of at most 80 and 300 characters. No signed
payload field is coerced or silently truncated, and Reaper rejects U+FEFF
anywhere in the JSON body before HMAC signing.

The independently implemented `discord-gallery-authorization-context.v1`
contract hashes canonical UTF-8 guild, gallery-channel, required-role-count,
`all` role-match, and ASCII-sorted unique required-role rows. Identifiers are
exact positive uint64 decimal strings with no trimming or coercion. Its digest
and version are included in the JSON before HMAC signing, and it contains no
secret, HMAC key ID, or member identity.

Website consumes the one-use nonce after exact-body HMAC verification as the
sole permitted pre-context mutation, then duplicate-safely parses and compares
the context before profile lookup, media fetch, storage upload, or application
mutation. The digest detects one-sided configuration drift only; coordinated
changes remain governed by a reviewed private activation manifest and provider
readback.

## Validation

```sh
bun install --frozen-lockfile
bun run check
MOCHIRII_WEBSITE_ROOT=/absolute/path/to/clean/Website bun run website:compat
git diff --check
```

`website:compat` is read-only. It reads the exact predecessor and protected-main
Git objects, reproduces the three predecessor seals, verifies all 31 two-sided
reconciliation rows, and does not contact a provider or invoke a function.

CI pins Bun and Deno 2.9.4, verifies the Deno binary checksum, uses
function-local import maps and lockfiles, and runs contract, formatting, type,
behavior, path, and provider-boundary checks. The workflow has no deployment
job.

## Future Activation Gate

Production writing must not move from Website based on green source checks
alone. A later approval must identify exact commits/artifacts, compare behavior
against the then-current Website source, configure secrets and runtime
identities without exposing values, preserve a compatibility window, prove
rollback, and verify a single live writer. Until then, this directory is an
inactive source candidate.
