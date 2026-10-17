# Reaper

Mōchirīī’s Discord companion for gallery submissions, community reminders,
moderator tools, live raffle announcements, and private new-member welcomes.

## What’s included

- Slash-command and button handling for image submissions, vote reminders,
  event and rank synchronization, photo-day polls, and moderation checks.
- Member-event forwarding for the reviewed pending-verification workflow.
- Live raffle message delivery with optional replay media.
- A persistent welcome worker that sends private DMs without a public fallback.
- Command registration, tests, deployment contracts, and recovery tools.

The source also retains legacy spotlight-poll functions and an inactive
gallery Gateway fallback. Their presence does not make them active features.

## Current status

This repository owns the six functions listed in
[the deployment contract](contracts/reaper-edge-deployment.v1.json), plus the
welcome worker. Website remains the production writer until a separately
approved single-writer cutover. Source checks do not establish that this
revision is deployed.

The Website repository continues to own shared identity, database migrations,
permissions, schedules, and gallery ingestion. See
[source ownership](docs/reaper-edge-source-ownership.md).

## Development

Use Bun 1.3.14 and Node.js 22.23.3. Edge checks also require the pinned Deno
toolchain described by the repository’s checks and workflow.

~~~sh
bun install --frozen-lockfile --ignore-scripts
bun run check
git diff --check
~~~

The aggregate check covers types, tests, builds, dependency audits, and Edge
Function contracts. Use [.env.example](.env.example) for configuration names;
never commit real credentials or member data.

Starting the worker, registering commands, publishing an image, or deploying
functions can affect Discord or live services. Follow the relevant release
guide before running those commands.

## Important behavior

- `/submit image:<file> [title:<title>] [subtitle:<subtitle>] [share_to_instagram:<true|false>]`
  defaults Instagram consent to false. Gallery submissions still require
  moderator approval; Reaper never publishes to Instagram.
- Voting features provide links and record manual confirmations. They never
  automate third-party votes.
- The welcome worker uses only Guilds and GuildMembers intents. It does not
  need Administrator, Message Content, Presences, or role-management permission.
- Pending-verification forwarding is disabled by default. It requires the
  compatible backend release and never directly changes roles.
- Ambiguous deliveries retain their original identity for reconciliation;
  retries must not create a second live writer.
- Functions without gateway JWT verification must enforce their documented
  signature, HMAC, or shared-secret checks.

## Guides and help

- [Welcome-worker release](docs/operations/GATEWAY-DEPLOYMENT.md)
- [Build artifact contract](docs/operations/GATEWAY-ARTIFACT.md)
- [Service health and recovery](docs/runtime-operations.md)
- [Dependency security](docs/dependency-security.md)
- [Security reporting](SECURITY.md)
- [Repository guidance](AGENTS.md)
