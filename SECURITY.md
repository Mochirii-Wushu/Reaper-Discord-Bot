# Security policy

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue, discussion, log,
or pull-request comment. Use the repository's private GitHub security advisory
flow or another maintainer-approved private channel. Do not include real bot
tokens, guild or member data, signed attachment URLs, or production payloads.

Include the affected revision, a minimal synthetic reproduction, impact, and
whether the issue is reachable in the Discord Interactions endpoint, Gateway
worker, build pipeline, or runtime image. Maintainers must revoke exposed
credentials before reproducing or restarting an affected runtime.

## Supported source

Only the current protected `main` revision and an explicitly named immutable
rollback revision are supported. A local branch, green test run, or built image
is not evidence that production runs that revision.

## Dependency audit gate

The repository pins Bun in `package.json` and the lockfile. Every pull request
and push to `main` must run both audits after a frozen complete install:

```sh
bun run audit:production
bun run audit:complete
```

Both commands fail at `high` or `critical`. The production command excludes
development-only dependencies; the complete command audits the entire lockfile
graph. A failure blocks merge and release. Registry packages outside Bun's
default audit source remain separately reviewable and cannot be treated as
covered by this gate.

Exceptions are fail-closed in
`security/dependency-audit-exceptions.v1.json`. Each exception must bind one
exact registry advisory URL, exact affected package and vulnerable-version
range, production/development/both scope, reason,
reachability analysis, compensating controls, owner, approver, canonical UTC
approval and expiry instants, and a credential-free HTTPS tracking record. The
maximum lifetime is 30 days. Expired, future-dated, duplicate, malformed,
unknown-field, overlong, stale, wrong-package, or wrong-range exceptions fail
validation. The wrapper parses Bun's bounded raw JSON and applies exceptions
locally; it never forwards CVE-wide `--ignore` flags. Empty exceptions are the
normal state. An exception does not authorize image publication or deployment.

Review direct and transitive dependencies at least weekly and on every security
release. Triage a critical advisory within one business day and a high advisory
within two. Prefer the smallest compatible update, preserve the lockfile, and
rerun typecheck, tests, build, both audit scopes, and the OCI contract.

## Runtime image gate

The Gateway image uses an exact digest for a supported distroless Node 22 LTS
runtime, runs as numeric nonroot, and contains no shell or package manager.
Before publication, revalidate the upstream tag and digest, verify the
distroless keyless signature, generate restricted SBOM and provenance evidence,
and scan the final image. Any critical or high runtime finding blocks
publication unless a later, explicit release-security decision documents a
separate bounded exception. Source dependency exceptions do not suppress image
findings.

Publishing, deploying, changing Discord configuration, rotating credentials,
or selecting a paid host always requires a separate target-specific approval.
