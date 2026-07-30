# Website Edge Function Contract Consumer

## Status

Reaper is a read-only consumer of six Website-owned Supabase Edge Function
contracts. This repository contains no Supabase project configuration, Edge
Function implementation, shared helper, import map, lockfile, migration,
deployment workflow, provider identifier, or provider credential.

The reviewed producer baseline is Website union commit
`c1dbbfa10eec61375c8d99123552a2b38d57cd07`, tree
`85c0698c2858e16f19a31a734ea8af7f3a53e332`. Website remains the sole source,
configuration, schema, schedule, secret-destination, and deployment owner for
every function declared in its `supabase/config.toml`.

## Contract Boundary

`contracts/reaper-edge-runtime.v1.json` records:

- the six Website-owned bot-facing functions;
- their unchanged `verify_jwt=false` modes;
- the application-layer authentication required for each function;
- the nine Discord commands handled by the interactions function; and
- a fail-closed statement that this repository contains no copied source and
  cannot deploy the functions.

`contracts/website-supabase-consumer.v1.json` records the tables, RPCs,
gallery-ingest producer, authentication headers, guild-schedule document, and
spinner-render route consumed by the Website-owned functions. Migrations,
schema, RLS, schedules, producer routes, and generic project configuration stay
with Website.

## Compatibility Model

Run the local, read-only check against a clean Website worktree:

```sh
MOCHIRII_WEBSITE_ROOT=/absolute/path/to/clean/Website bun run website:compat
```

The check verifies that the recorded baseline commit resolves to the recorded
tree, then compares only the contracted producer files:

- the current and baseline recursive relative-import closure for the six
  functions and the gallery-ingest producer;
- each function-local `deno.json` and `deno.lock`;
- only the seven relevant `supabase/config.toml` function blocks;
- the spinner-render route source and required fail-closed markers; and
- the current guild-schedule document's versioned UTC+8 event shape.

It also rechecks command coverage, JWT parity, dependency pins, Discord
signature-before-JSON ordering, the currently contracted secret comparisons,
table/RPC usage, and gallery HMAC headers. It requires contracted producer files to be committed, performs
no network request, contacts no provider, invokes no function, and makes no
change to the Website worktree.

The current Website HEAD and whole tree are deliberately not required to equal
the baseline. A later Website commit with unrelated changes remains compatible
when every contracted file and semantic boundary is unchanged. Contracted
producer changes require a reviewed contract update and fresh parity evidence.

## Producer Security Findings

The exact reviewed Website baseline reads the Discord Interactions request body
without an explicit byte ceiling before signature verification, and three cron
functions use exact string equality rather than a constant-time comparison.
The contracts describe that current behavior without endorsing it. Because
Website is the sole producer, those hardenings belong in a focused Website
change with its own tests and release review; Reaper must not carry a divergent
copy as a substitute.

## Future Ownership

A future terminal move cannot be inferred from these files. It requires a
successor architecture decision that preserves one deployment writer, shared
Website schema and identity governance, exact artifact identity, provider
readback, rollback, and a bounded compatibility window. Until that separately
approved cutover succeeds, Website remains authoritative and Reaper remains a
contract consumer.
