# Gateway hosted deployment candidate

Status: `SOURCE_ONLY_NOT_DEPLOYED`. No image publication, paid resource,
credential provisioning, Discord connection, welcome send, or forwarding call
is authorized by this document.

## Ownership and order

This repository owns the persistent Gateway. Website remains the production
writer for the hosted interaction/member-sync functions, schema, schedules, and
authorization. The prepared forwarder requires the separately reviewed Website
UUID receipt and shared containment-fence migration/runtime. Do not deploy the
older Edge tree from this repository or cut over function ownership as part of
Gateway hosting.

1. Review both exact source trees, tests, compatible receipt protocol, and
   migration/rollback order.
2. Approve and publish the compatible Website migration/runtime through its
   owning runbook, with live single-writer readback.
3. Approve the exact Gateway commit/tree and narrow dormant-publisher permission
   exception; build, scan, publish, and verify the immutable digest and
   attestations without activation through `GATEWAY-ARTIFACT.md`.
4. Approve that exact digest, host, runtime configuration, credentials, recurring
   cost, and test recipient; provision the approved host; install only the
   reviewed templates and prebuilt digest. Never build source on the Droplet.
5. Prove startup, private readiness, reconnect, bounded recovery, full reboot,
   controlled welcome/forwarding, rollback, and workstation independence.

## Capacity and cost

The candidate is one basic shared-CPU Droplet in the selected region, initially
512 MiB RAM/10 GiB disk at the observed $4/month base price. The account/region
readback and exact paid resource approval remain in the private release packet.
No backup, snapshot, extra volume, reserved IP, monitoring subscription, or paid
add-on is enabled by the source. Recheck current prices and transfer allowances
before provisioning; the next 1 GiB tier was observed at $6/month.

The service template caps the container at 256 MiB RAM with no swap, 0.5 CPU,
64 PIDs, 1 MiB shared memory, and a 16 MiB readiness tmpfs. A local no-network
Linux container probe on Node 22.23.2 retained 10,000 synthetic discord.js member
objects, 256 private queued records, and exercised 10,000 mocked welcome/forwarding
calls. Its provisional peak process RSS was about 101 MiB, with no cgroup OOM or
limit events. This is
process-only evidence, not proof of a real 512 MiB host: it excludes Gateway TLS,
provider latency, actual guild size, host OS/Docker memory, sustained runtime,
reboot, and full image security verification.

Before activation, record host memory/disk headroom with the actual approved
image during an idle and representative live soak. If the OS/daemon/container
cannot retain safe measured headroom, stop before activation and request the
1 GiB tier. Do not silently add swap, increase cost, or weaken limits. Apply and
verify an appropriate host filesystem quota/alert for the private spool; Compose
alone does not supply a host disk quota.

## Host files and supervision

Install reviewed deployment files root-owned under `/opt/mochirii-reaper/deploy`.
Use supported Docker Engine and Compose 2.30 or newer (`env_file.format: raw`).
The non-secret `/etc/mochirii-reaper/gateway-release.env`, mode0600 root-owned,
contains only the approved immutable image reference:

```text
REAPER_GATEWAY_IMAGE=registry.example.test/mochirii/reaper@sha256:<approved-digest>
```

The runtime credential file `/etc/mochirii-reaper/gateway.env` must be root-owned
mode0600, outside source, shell history, cloud-init/user-data, and diagnostics.
Root-only directories must protect its ancestry. Provision values through an
approved protected editor/secret delivery channel; never paste tokens into chat
or command arguments. Only Docker reads the raw file. Docker administrative
access can inspect container environment and is therefore secret-level access.

Runtime names required for this worker are:

```text
DISCORD_BOT_TOKEN
DISCORD_GUILD_ID
WELCOME_DM_ENABLED=true
REAPER_PENDING_VERIFICATION_SYNC_ENABLED=true
REAPER_PENDING_VERIFICATION_SYNC_URL
REAPER_PENDING_VERIFICATION_SYNC_SECRET
```

The approved target and shared secret must match the compatible Website writer.
The source defaults remain forwarding-disabled, welcome-enabled, and Gallery
rollback-disabled. Activation requires explicit runtime `true` values and an
approved test recipient. The image requires neither a Supabase service-role key
nor Discord role-management/Administrator permissions. Keep the Developer
Portal Server Members Intent enabled only for the approved bot/application.

Create `/var/lib/mochirii-reaper/gateway` as an existing real directory owned
65532:65532 with mode0700. Its bind mount supplies
`/var/lib/reaper/member-sync`; it must survive container replacement and reboot.
The queue is bounded to256 private records, each at most32KiB. Logs never contain
spooled bodies. A blocked record holds later work, raises a persistent readiness
fault, and requires reconciliation; no restart or elapsed timeout clears it.
Before admission, the preallocated journal durably invalidates its marker,
writes and syncs the complete held body, then commits and syncs its valid marker.
Writes account for every byte and reject zero or invalid progress. If storage
refuses even the initial marker, software cannot guarantee a persisted hold:
admission is rejected and readiness faults. Reconcile that rejected event before
claiming recovery or delivery; a restart does not prove it was retained.

The boot-enabled lifecycle unit runs the exact digest without pulling or
building and waits for readiness. Docker handles up to three crash restarts.
The private timer checks fresh in-container readiness and exact container/image/
Compose identity before requesting an unhealthy-running restart. At most three
health recoveries occur within15minutes; a root-owned persistent latch then
requires operator review. Missing/foreign/stopped containers fail or stay stopped.
No health port is published. A manual stop survives the running boot session;
use `disable --now` or mask for maintenance that must survive a host reboot.

Local source checks do not prove systemd, Docker boot policy, actual Linux host
metadata, or live recovery. Verify those on the approved target before claiming
hosted completion. Recovery must preserve unresolved spool and remote receipt
state, including across image rollback.

## Credential recovery and missing setup

The initial credential-file and protected-secret name audit found no normal
runtime source. The owner subsequently confirmed an existing bot recovery
credential and prepared a disabled recovery environment with a new shared secret;
cloud sync was observed separately. No secret values were read into this source
packet. These observations do not certify provider secret publication, host
installation, or a successful restore. Runtime provisioning still requires an
approved protected owner delivery flow and coordinated Website secret approval.
Do not read a recovery vault or export existing provider secrets as a shortcut.

The owner's local cloud-synced credential recovery folder is a recovery boundary,
not source or runtime. Verify its protected access, actual cloud sync, encryption,
and recovery metadata without printing values. The Droplet must continue while
the workstation and sync client are offline. Private queue backup and restore
need a separate encrypted, access-controlled policy; no paid backup or successful
restore is claimed here.

## Capability and acceptance record

| Capability | Runtime and authorization |
| --- | --- |
| New-member welcome | Hosted Gateway; private DM only, mentions disabled, no public fallback; controlled recipient approval first. |
| Join/role-change forwarding | Hosted Gateway spool to compatible Website writer; UUID dedupe and shared fence; blocked work requires reconciliation. |
| Slash commands, schedule advancement, scheduled reminders/polls | Existing hosted Website-owned functions/database schedules; Gateway deployment must preserve their source and runtime ownership. |
| Role/rank/moderation apply operations | Hosted execution with existing moderator/owner confirmation; hosting does not authorize automatic privileged decisions. |
| Gallery submissions/publication | Existing hosted owner; Gateway rollback remains disabled; publication approvals remain required. |

The final redacted evidence packet must bind exact source commit/tree, runtime
platform, registry digest/signature/SBOM/provenance, zero unapproved final-image
high/critical findings, exact host identity/region/size/cost, protected runtime
configuration metadata, production function/migration compatibility, permissions,
private state/backup policy, and fresh health/restart/reconnect/reboot proof.
Record a controlled welcome and forward result, including strict receipt, no
duplicate mutation, and blocked/DM-denied behavior. Turn the development
workstation off for the independence observation. Until then this remains a
local release candidate.

If there is no previous deployed Gateway, rollback means stopping/disabling the
candidate while retaining all private spool, receipts, audit evidence, and
credentials. Never replace it with a workstation daemon or delete uncertain
work. The remote shared fence may require a separately approved forward fix;
reverting source does not reverse durable data state.
