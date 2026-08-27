# Reaper Edge Function Source Ownership

## Status

Reaper is the terminal source, test, scoped-deployment, and operations owner of
exactly six bot execution functions. Source publication does not package,
deploy, activate, or change a provider. Website remains the current production
writer until a separately approved single-writer cutover.

The predecessor is the immutable Website commit
`f587409adef29d4735b5e6ce8512c794579d8bef`. The reviewed 31-file runtime,
seven-file packaging, and six-function configuration seals are captured in
`contracts/reaper-source-relocation.v1.json`. The manifest records an exact
source and target for every predecessor file; no broad Website tree was taken.
`contracts/website-source-reconciliation.v1.json` separately binds protected
Website main `7ca34ed96ef70f828ed542a052da90c4aa82ae4d` and classifies all 31
inputs: 13 identical inputs are accepted, while 13 changed and five absent
inputs block activation pending a reviewed semantic merge.

## Repository Boundary

Reaper owns the implementations, tests, and scoped operational contract for:

- `reaper-discord-interactions`
- `reaper-discord-member-sync`
- `reaper-spinner-dispatch`
- `send-vote-reminder`
- `send-member-spotlight-poll`
- `publish-member-spotlight-winner`

Website retains migrations, tables, RLS, grants, shared schema, schedules,
generic Supabase configuration, `submit-discord-gallery-image`, shared
identity/authorization, and the current production writer. Reaper contains
`supabase/functions`, but never `supabase/config.toml`, migrations, or
schedules. The two repositories do not become independent schema owners.

Eighteen Reaper-specific predecessor files have safe whole-file provenance. The
remaining thirteen shared modules are explicit versioned interfaces or adapters;
they are not asserted to become cross-repository shared source. Singapore and
Last Blossom are not immutable inputs in either reviewed commit. They are
explicit activation blockers until versioned contracts, coherent fixtures, and
two-sided source review exist.

## Authentication Boundary

All six functions preserve `verify_jwt=false` and enforce application-layer
authentication before parsing or acting on the request body:

- Discord Ed25519 signatures for interactions;
- strong fixed-digest shared-secret checks for internal and cron calls;
- scoped spinner media capabilities; and
- the versioned gallery-ingest HMAC signer contract.

Reaper owns gallery key selection and signing. Website independently owns
verification and the one-use nonce store. The contract preserves the exact raw
body-byte digest, HMAC algorithm, method/runtime-normalized WHATWG
pathname/timestamp/nonce canonical message, four headers, clock skew, body
ceiling, key-length range, and replay behavior. The verifier fixture
intentionally does not import the signer canonicalizer.

Reaper signs the reviewed constant pathname. Website requires its
runtime-normalized URL pathname to equal that value and requires an empty
search, hash, and userinfo plus an allowed runtime origin and port. An Edge
Function cannot recover or bind the raw HTTP request-target, so gateway
normalization is a private activation-manifest and provider-readback gate.
Website digests the exact bounded request bytes before decoding or
normalization; after HMAC verification and one-use nonce consumption, it rejects
U+FEFF anywhere in the decoded JSON, including an initial BOM.

The producer requires a canonical declared JPEG, PNG, or WebP MIME matching the
attachment filename extension before it constructs or signs the payload.
Missing, null, mismatched, or extension-only inferred MIME fails closed.

The Website consumer contract also pins an exact fourteen-key JSON payload.
Reaper requires canonical positive uint64 decimal identifiers, an exact
normalized allowlisted Discord attachment URL whose path IDs match the signed
channel and attachment, a safe-integer size from 1 through 8 MiB, an exact
trim-stable filename of at most 255 characters, and explicit-null-or-exact
title/caption fields bounded to 80/300 characters. Signed metadata is never
coerced or silently truncated, and Reaper rejects U+FEFF anywhere in the JSON
body before HMAC signing.

The signed JSON body also carries `discord-gallery-authorization-context.v1`:
its version plus the lowercase SHA-256 of canonical UTF-8 rows binding the
configured guild, gallery channel, exactly two unique required roles, and the
`all` role predicate. Identifiers must be untrimmed canonical positive uint64
decimal strings; required roles are validated for uniqueness and then
ASCII-sorted. Secrets, HMAC key IDs, and Discord member IDs are excluded.

Website verifies the exact-body HMAC and atomically consumes its one-use nonce
before parsing and comparing the context. That nonce ledger is the sole allowed
pre-context mutation and fails closed with 503 when unavailable. A context
mismatch rejects before profile lookup, external media fetch, storage upload, or
application-row mutation. The digest detects one-sided runtime drift; a
coordinated matching change still requires the reviewed private activation
manifest and provider readback. This does not change the HMAC v1 wire contract.

Every untrusted JSON boundary is byte-bounded and rejects duplicate property
names, including decoded escape aliases. Provider origins and identifiers are
validated runtime configuration only; tests use synthetic values.

All non-PING Discord interactions additionally require the dormant
`discord-interaction-replay.v1` adapter before any mutation or deferred effect.
The schema-independent interface requires an atomic durable claim, opaque
fencing lease, durable completion, and fail-closed duplicate/retry/crash
semantics. No Website migration or database object is invented here. The
production adapter remains unbound, so mutating interaction activation is
impossible until Website accepts and supplies the durable schema implementation
and its provider readback. Scheduling work with `waitUntil` is not replay
completion: activation additionally requires a provider-backed durable enqueue,
durable effect completion, and crash-boundary proof showing that every retry is
classified without repeating an effect.

## Validation and Activation

Local validation is source-only. It may format, type-check, and run synthetic
tests, but must not invoke functions or contact providers. The compatibility
checker reads both immutable Website Git objects, reproduces the predecessor
seals, and verifies the exact 31-row protected-main reconciliation without
depending on either worktree's mutable files.

Green local or CI checks do not activate the source. A future cutover requires
separate approval naming exact commits/artifacts, configuration and secret
destinations, merge/deploy order, a compatibility window, rollback, and live
single-writer readback. Until that packet succeeds, Website keeps serving the
production functions.
