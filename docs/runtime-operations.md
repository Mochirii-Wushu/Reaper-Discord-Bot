# Gateway Runtime Operations

Status: `SOURCE_ONLY_NOT_DEPLOYED`.

This runbook defines the source contract and locally prepared hosting template.
It does not create infrastructure, configure a provider, publish an image,
register a command, or send a message. See
[`operations/GATEWAY-DEPLOYMENT.md`](operations/GATEWAY-DEPLOYMENT.md) for the
DigitalOcean candidate, measured limits, and remaining release gates.

## Runtime contract

- Build with the exact toolchain in `contracts/gateway-release.v1.json`.
- Bind the reviewed source commit to an immutable artifact digest, dependency
  SBOM, and provenance attestation before promotion.
- Supply credentials only from the approved runtime secret boundary. The
  prepared host flow uses a root-owned mode-0600 runtime file outside the
  checkout, read only by Docker Compose. Never bake values into an image,
  template, user-data, log, or evidence packet.
- Run as a non-privileged identity with a read-only application filesystem and
  a host-owned writable readiness directory.
- Configure `REAPER_HEALTH_STATE_PATH` as an absolute path in that directory.
  The process atomically writes a mode-0600 JSON snapshot and refreshes it at
  `REAPER_HEALTH_HEARTBEAT_MS`.
- A private host probe runs `bun run health:check -- <absolute-path>` with
  `REAPER_HEALTH_MAX_AGE_MS`. No public health endpoint is required.

The process reports starting, ready, reconnecting, disconnected, error,
session-resume, and shutdown transitions without account names, guild IDs,
tokens, payloads, or member data. A readiness-write failure closes the client
and returns a failing process exit code.

## Supervisor and monitoring

The approved host must provide automatic restart with bounded backoff. Monitor
process state, fresh ready snapshots, reconnect frequency, invalidated
sessions, redacted error categories, and restart loops. Alert destinations,
retention, egress, and cost require a separate provider packet.

The prepared `mochirii-reaper-gateway-operations.timer` is independent of the
Gateway lifecycle and starts from `timers.target`. Its root-only, outbound
Python 3.12+ observer runs every 60 seconds. It verifies the exact local
image/container/Compose identity and invokes the private readiness command;
it never restarts a container, reads Docker environment or logs, pulls an
image, or forwards a member record. A persistent recovery latch reports
unhealthy. Missing heartbeats become unhealthy after 180 seconds at the
Website-owned status endpoint, whose only public responses are `ok` and
`unavailable`. External alert delivery must be tested before welcome activation.

The observer also checks filesystem capacity through no-follow private directory
handles for both existing spools, with their expected owners and unchanged
directory identity. It reads metadata only, never lists or hashes private files.
Available space must be greater than 1 GiB and available inodes greater than
1,024 on each filesystem; unknown, inconsistent, read-only or insufficient
capacity reports unhealthy through the existing heartbeat. These are operational
reserves, not native quotas or admission guarantees. Normal known application
file slots have conservative logical ceilings of 25,243,736 bytes/264 inodes for
the Gateway and 16,780,323 bytes/five inodes for operations, excluding filesystem
metadata, block rounding and unrelated host storage. The reserves allow over
25 times their combined logical bytes and over three times their inode slots.
Backup/receipt reconciliation still runs when capacity is unhealthy so retained
work is preserved. Abrupt termination can leave UUID-named atomic temporaries;
repeated crashes have no finite lifetime disk bound. Alert response and operator
reconciliation must cover that risk; this observer never deletes orphan state.

Discord.js owns protocol heartbeats and session resumption. Acceptance still
requires a controlled disconnect/reconnect observation, a host restart, and a
full reboot with no workstation online. Source tests alone do not prove those
runtime properties.

## Data and recovery

The Gateway worker has no canonical application database. Its private host spool
does retain member IDs, roles, timestamps, and immutable request bodies until
the Website-owned durable receipt reports completion. Preserve that state on
restart and rollback. Never reset UUIDs, remove unresolved work, or replace a
blocked receipt to clear uncertainty. Queue exhaustion and corrupt state require
operator reconciliation. Database migrations and shared fences remain
Website-owned.

Recovery inputs are reviewed source, an immutable artifact, provider
configuration, protected runtime credentials, and the private spool. The
selected source policy exports a consistent checkpoint at startup, on a new
held/blocked state, and at most five minutes between due checks. Capture shares
the queue's serialization barrier; encryption and network operations run
outside it. A validated unchanged queue retains the same checkpoint ID and
bytes while refreshing a separately bound check timestamp. An incomplete
snapshot/status replacement fails closed; it never changes queue holds.

The host observer uses the signature-verified, hash-pinned age 1.3.2 binary
and only a public X25519 recipient. It durably stores one ciphertext and UUID
before upload. Lost acknowledgements use authenticated receipt lookup;
pending, blocked or retired receipts never authorize a replacement write.
The Website-owned receiver has a separate HMAC key and accepts only bounded,
create-only ciphertext. The worker holds no Storage or service-role key.
Private Storage retention is the union of the latest eight checkpoints and
the newest checkpoint for each of seven UTC+8 calendar days, with at most
15 objects/240 MiB including uncertain reservations. Unknown or uncertain
provider state stops cleanup/admission for reconciliation. The recovery goal
is 15 minutes; fresh validated state must bind to an accepted receipt.

The private age identity stays in the approved cloud-synced credential recovery
boundary, never on the worker. This is a locally implemented policy, not proof
of a hosted backup. Storage, secrets, hosted cron, monitoring and activation
need separate approval and readback. A credential recovery copy never becomes
a runtime dependency or a location for unapproved copied member payloads.

After owner-approved download/decryption in an isolated private directory,
`node dist/restore-checkpoint.js <absolute-checkpoint>` validates only, without
loading bot configuration or contacting any provider. Explicit
`--apply <fresh-offline-directory>` refuses existing targets, preserves original
record UUIDs/order/backoff/blocked state and holds admission during staging.
Never adopt a failed staging directory. Prove a complete validation/restore,
reconcile original permanent remote receipts, and obtain activation approval
before using a recovered queue. No timeout or restore clears uncertainty.

## Promotion and rollback

Promotion requires a separate exact approval naming the source commit,
artifact digest, target, secret/configuration contract, cost, observation
window, verification, and previous known-good digest. Keep forwarding disabled
unless its own compatibility checks pass.

For rollback, stop new promotion, restore the previous immutable digest and
its matching configuration, restart through the supervisor, then require a
fresh ready snapshot and a non-mutating command/readiness check. Do not replay
member events or send a public fallback message. A failed rollback blocks the
release.

The final acceptance record must prove automatic restart, session resume or a
clean reconnect, rollback, redacted logs, monitored health, and operation with
the development workstation offline.
