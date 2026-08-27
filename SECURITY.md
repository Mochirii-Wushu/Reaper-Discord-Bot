# Security Policy

## Reporting

Report suspected vulnerabilities through repository Security Advisories when
that feature is enabled. Otherwise contact an accountable repository owner
through the organization's established private security channel. Do not open
a public issue for a suspected secret, authorization weakness, private member
data exposure, or live runtime defect.

Do not include secrets, credentials, private payloads, signed media URLs,
production identifiers, or member data in a report. Provide the smallest
sanitized reproduction and identify the affected commit when possible.

## Supported Source

Only the current protected default branch and an exact reviewed release
candidate are supported. This repository is source-only until a separately
approved runtime release is bound to an immutable artifact digest.

## Dependency audit gate

Every pull request and push to `main` validates both the production and complete
Bun dependency graphs and all six frozen Deno lock graphs. High or critical
findings fail closed. The bounded exception schema in
`security/dependency-audit-exceptions.v1.json` binds an exact package, advisory
URL, vulnerable range, scope, reason, reachability analysis, compensating
controls, accountable owner and approver, canonical UTC approval/expiry, and a
credential-free tracking record. The maximum lifetime is 30 days. Expired,
future-dated, duplicate, malformed, unknown-field, stale, wrong-package, or
wrong-range exceptions fail validation.

Review dependencies at least monthly and after any manifest, lock, override,
runtime, or security-advisory change. Triage every critical advisory within one business day and every high advisory within two. An exception never authorizes
image publication or deployment.

## Runtime image gate

The Gateway artifact uses digest-pinned distroless build and Node runtime
images, numeric nonroot execution, no shell or package manager in the runtime,
and no public listener. Before publication, verify the selected upstream image
signature, generate restricted SBOM and provenance evidence, and scan the final
image. A critical or high runtime finding blocks publication unless a separate
explicit release-security decision records a bounded exception.

## Response Boundary

Critical authorization, secret-exposure, or private-data findings block a
release. Dependency exceptions require an accountable owner, reason, expiry,
and recheck trigger. No report authorizes a provider change, credential
rotation, deployment, Discord message, or production test.
