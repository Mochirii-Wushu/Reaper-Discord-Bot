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

## Response Boundary

Critical authorization, secret-exposure, or private-data findings block a
release. Dependency exceptions require an accountable owner, reason, expiry,
and recheck trigger. No report authorizes a provider change, credential
rotation, deployment, Discord message, or production test.
