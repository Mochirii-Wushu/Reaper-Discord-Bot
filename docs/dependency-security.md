# Dependency Security

The repository pins Bun `1.3.14` and Node.js `22.23.2`. Reaper owns the source,
tests, Deno toolchain, function-local import maps, and frozen lockfiles for the
six contracted Edge Functions. Website remains the database/schema owner and
current production writer until an approved single-writer cutover.

`bun run check` enforces `bun run audit:all` on every pull request and push to
main. That aggregate gate validates the fail-closed exception policy, audits
both the production and complete Bun dependency graphs at high severity, and
runs a distinct `bun run audit:deno` advisory query for each of the six exact
Deno lock graphs. The Deno gate first binds the complete tracked lock inventory,
lock format, byte digest, and size, then invokes pinned Deno `2.9.4` against its
advisory registry without ignore flags. This validation-time Deno audit registry
access is not part of Reaper runtime and no runtime process contacts it.

`bun run audit:runtime` is an alias for the production-graph gate, not the
complete CI acceptance gate. Maintainers perform a monthly dependency review and
immediately rerun both advisory gates after a lockfile, manifest, override,
runtime, or security-advisory change. An audit failure is not bypassed through
an override, ignored advisory, registry-error bypass, or weaker threshold merely
to make CI green.

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
