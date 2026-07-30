# Dependency Security

The repository pins Bun `1.3.14`, Node.js `22.23.1`, and Deno `2.9.4`.
Function-local import maps and frozen lockfiles remain authoritative for the six
Edge Function candidates.

`bun run audit:runtime` is a required check and fails on a high or critical
advisory. `bun run audit:all` records the complete current advisory inventory.
An audit failure is not bypassed through an override, ignored advisory, or
weaker threshold merely to make CI green.

An exception is allowed only after an exact review records:

- affected package and runtime reachability;
- owner and rationale;
- compensating control;
- expiry;
- review trigger;
- remediation or upstream tracking reference.

Raw audit output belongs in restricted CI evidence or the ignored operations
artifact boundary. It must not contain credentials or private runtime values.
Release evidence records the exact source commit, lockfile hash, tool versions,
result, and reviewer.
