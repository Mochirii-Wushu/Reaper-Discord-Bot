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
configuration, protected runtime credentials, and the private spool. Encrypted,
access-controlled backup/recovery for credentials and spool state must be
approved and verified separately; no backup or restore currently follows from
the templates. A local cloud-synced credential recovery copy must never become a
runtime dependency or contain copied member payloads without its own approval.

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
