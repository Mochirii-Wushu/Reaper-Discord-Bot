# Minimal community notices

Status: local source candidate; neither new route is activated.

This Gateway addition has two routes: public welcomes and goodbyes in one
verified guild text channel, and a monthly announcement of the member already
chosen by Website.
The later approved public welcome goal explicitly replaces the old DM-only
requirement for this route. The legacy DM function remains available unchanged;
public welcome requires it to be disabled and never uses it as a fallback.

## Data and routing

Website owns selection, eligibility, schema, grants and its daily 00:05 UTC+8
selection schedule. Reaper reads only the existing anonymous
`get-current-spotlight-winner` response: `{ok:true,data:{winnerName,monthKey}}`.
It neither draws a winner nor invokes the legacy poll publisher. No Website
source, schema, schedule, secret, additional service or service-role credential
is required. The reader's current-month result is the existing public name
contract, not a Discord account mapping.

The bot checks that reader when ready and at most once per 60 seconds through
its existing health heartbeat. This reconciles consumption without changing the
selection schedule. On first activation a current-month result is eligible for
one announcement; this initial backfill must be included in the release approval.
No previous month is announced. Name text is escaped and mentions are disabled.

`REAPER_MEMBER_NOTICES_ENABLED` and `REAPER_SPOTLIGHT_ANNOUNCEMENT_ENABLED`
both default to false. The member route uses `REAPER_MEMBER_NOTICE_CHANNEL_ID`;
the monthly route uses `REAPER_SPOTLIGHT_CHANNEL_ID`. Enabled routes require exact configured guild
and destination identifiers, the canonical HTTPS reader URL, configured HTTPS
API origin and a private absolute `REAPER_NOTICE_STATE_PATH` below the existing
persistent host volume. The resolver requires the same guild/channel, a normal
guild text or announcement channel, and effective View Channel and Send Messages.
It never changes permissions, creates a channel or chooses an alternative.

Public welcome identifies the member with a non-pinging mention followed by the
existing approved welcome body unchanged, including its Gallery guidance. Its
suitability for public posting remains explicit in the concrete release review.
Goodbye copy identifies the departed account, says it has left the guild and
wishes it well. Neither route pings mentions or sends for bots/other guilds.

## Durable send boundary

Both consumers use one bounded private receipt journal: at most 4,096 receipts,
each at most 1,024 bytes. A welcome key binds the guild, member and exact join
timestamp so duplicate Gateway deliveries are suppressed while a genuine rejoin
remains eligible. Goodbyes consume raw Gateway dispatches, including uncached
departures that the SDK's ordinary cached-member event omits. Their key binds a
hash of the current shard session, the guild/member and dispatch sequence. A
resumed replay of the same dispatch has the same key; a later distinct departure
is eligible. The notice reader never logs or persists raw session IDs; it keeps
only bounded in-memory hashes. The SDK retains its ordinary resume state.
Missing context fails closed. No additional intent or roster is needed.
Missed events during a full outage are not backfilled, and semantically repeated
provider events carrying a new dispatch identity cannot be proven duplicates.
A spotlight key binds the exact Singapore month. The receipt
also binds destination and content digest; configuration/copy drift cannot
silently send a replacement. No member names, tokens or message bodies are logged
or stored in the journal. Treat the hashes and message identifiers as private
operational metadata.

A dispatching intent is synced before the single Discord POST. The transport
does not use SDK POST retries. A validated acknowledgement is synced as sent;
later calls and restarts suppress the same notice. Stable nonce enforcement is
additional short-term protection only. A timeout, unexpected acknowledgement,
crash during dispatch, storage failure, orphan admission fence or corrupt state
holds the route for operator reconciliation. It never blindly resends, clears
an intent or prunes receipts. Capacity exhaustion fails closed.

A known month change before admission skips the obsolete announcement without
an intent. If the month changes while intent durability is being established,
the journal records a cancelled receipt before any POST. This is a known no-send
outcome and never clears uncertain delivery state. Shutdown rejects new work and
drains already admitted notices before destroying the Gateway client.

This prevents automatic duplicate delivery; it cannot guarantee delivery across
every network/crash boundary. A held intent may correspond to zero or one actual
message. Reconcile the destination before authorizing any repair. Preserve the
entire journal across normal restart, container replacement, rollback and reboot.
Only one approved live instance may own it. Do not clear it to restart the bot.

The existing member-forwarding checkpoint does not include this journal. Its
off-host restore test is not notice-recovery proof. A restored older host backup
may lack later receipts: keep both new routes disabled until those messages and
receipts are reconciled. No new backup or recovery service is added here.

## Release and acceptance

Source tests use synthetic guilds, channels, names and HTTP responses. They do
not log in, invoke live bot handlers, register commands or send messages.
Run `bun run check` and `git diff --check`, with the exact pinned toolchain and
unchanged frozen dependencies. Preserve all prior action receipts and consumed
publication/host allowances. This source does not renew any old execution plan.

Before live use, separately approve source publication, immutable artifact
delivery, any required host configuration, exact verified destinations and
bounded test sends. Verify the current host image, health, feature flags and
existing service state without exporting credentials. No source status or
powered-on Droplet proves that the bot is operating.

Acceptance covers only correct welcome/goodbye/spotlight routing, duplicate suppression,
necessary reconnect/restart/reboot recovery and workstation independence. Preserve
all unrelated functions and services. Rollback disables/stops the candidate,
retains its private journal and restores only an explicitly reviewed prior
artifact/configuration. No automatic rollback may repeat an uncertain send.
