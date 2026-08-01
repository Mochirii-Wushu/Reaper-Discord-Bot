# Reaper Gateway OCI artifact

## Scope

This packet makes the persistent Gateway worker buildable as one immutable OCI
image without choosing a host, registry, supervisor, secret store, or paid
service. It does not publish or deploy an image, register Discord commands,
change Discord configuration, or send a Discord message.

The Website repository remains the production owner of slash-command Edge
Functions. This image contains only the Reaper Gateway process already owned by
this repository: welcome DMs and the default-disabled pending-verification
forwarder.

## Reproducible build contract

`Dockerfile` uses exact digests for its Dockerfile frontend and the
multi-architecture Bun 1.3.14 and Node.js 22.23.1 images. The build installs the
committed lockfile twice: once with
development dependencies for TypeScript compilation and once with production
dependencies only for the runtime. Lifecycle scripts are disabled. The final
image contains only `dist`, production `node_modules`, and `package.json`.

An operator may build locally without publishing:

```sh
docker build \
  --build-arg BUILD_DATE="$(git show -s --format=%cI HEAD)" \
  --build-arg VERSION="$(node -p \"require('./package.json').version\")" \
  --build-arg VCS_REF="$(git rev-parse HEAD)" \
  --tag mochirii-reaper-gateway:local \
  .
```

The three OCI metadata arguments are mandatory. `VCS_REF` must be a full
40-character commit SHA. Revalidate both base-image tags, digests, supported
architectures, and current security advisories before any publication; a digest
prevents silent drift but does not make an old base permanently safe.

Pull-request CI checks out and verifies the exact reviewed head before building;
it never labels a synthetic merge commit as the reviewed source.

## Runtime contract

- Run as the image's `node` user; never override it with root.
- Use a read-only root filesystem, drop every Linux capability, and enable
  `no-new-privileges`.
- Provide a small writable, memory-backed `/tmp` for the readiness file.
- Do not publish a port. Reaper initiates an outbound Discord Gateway
  connection and has no inbound HTTP service.
- Use `node dist/healthcheck.js` as an exec health/readiness probe.
- Send `SIGTERM` for shutdown. The worker removes readiness state and closes
  the Gateway client before exiting.
- Inject runtime secrets from the later approved host secret manager. Do not
  bake secrets into image layers, environment files, command arguments, labels,
  logs, or deployment manifests.
- Preserve only Discord `Guilds` and `GuildMembers` intents. Keep pending
  verification forwarding disabled unless its separate release packet is
  approved.

A provider-neutral supervisor configuration must implement the equivalent of:

```text
read_only_root_filesystem = true
tmpfs /tmp = rw,noexec,nosuid,nodev,size=16m
capabilities = []
no_new_privileges = true
restart = on-failure with bounded backoff
healthcheck = node dist/healthcheck.js
stop_signal = SIGTERM
```

## Publication gate

No publication is authorized by this source packet. A later exact approval must
name the reviewed source commit and tree, target registry/repository, target
platforms, build arguments, immutable output digest, SBOM, provenance
attestation, retention policy, and signer/identity. BuildKit publication should
use its SBOM and provenance attestations. The published digest must be read back
from the registry before deployment is considered.

## Deployment and cost gate

No runtime host has been selected. Before deployment, record and approve:

1. host and region, recurring cost, quota, and ownership;
2. exact immutable image digest and verified attestations;
3. least-privilege secret source and rotation/revocation procedure;
4. exact Discord application, guild, Server Members Intent readback, and bot
   permissions without Administrator, Message Content, Presences, or role
   mutation;
5. supervisor definition, resource limits, outbound network policy, monitoring,
   alert ownership, restart/backoff limits, and log retention/redaction;
6. backup needs (the worker is stateless), recovery steps, and an offline
   workstation-independence test;
7. previous immutable digest and the rollback decision owner.

Deployment must not register commands or change the Interactions endpoint.
Start with pending-verification forwarding disabled. Verify a healthy Gateway
session without sending a synthetic member event or Discord message.

## Rollback

Rollback is an image-digest change, not a rebuild. Stop the candidate, restore
the recorded previous digest and its exact secret/config version, wait for the
exec readiness probe, and confirm one active Gateway session. If no prior worker
exists, rollback means stop the candidate and leave the service absent; do not
improvise another host or use a workstation as production runtime.

Never delete image evidence, provider audit records, or redacted incident logs
needed to explain the attempted release.

## Workstation independence

Production may depend only on the approved host, immutable image, provider
secret store, Discord, and the explicitly enabled HTTPS forwarder. It must not
read this checkout, `.env.local`, a local scheduler, editor process, LAN service,
or workstation filesystem. Turning off the development workstation must not
interrupt the Gateway worker.
