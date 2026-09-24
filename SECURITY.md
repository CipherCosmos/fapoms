# Security

FAPOMS handles PII (PAN, Aadhaar, bank details) and an append-only audit trail for physical bank
branch audits. If you find a vulnerability, please report it privately rather than opening a
public issue or PR.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository: open the **Security** tab →
**Report a vulnerability**, or go directly to
`https://github.com/CipherCosmos/fapoms/security/advisories/new`. This opens a private draft
advisory visible only to maintainers until it is resolved.

Please include:
- What you found and where (file/endpoint/screen).
- Steps to reproduce, or a proof of concept.
- What you think the impact is (data exposure, privilege escalation, audit-trail bypass, etc).

Do not include real PII or production credentials in a report, even as evidence — describe the
class of data at risk instead.

## What counts

In scope: anything that defeats the controls documented in
[docs/reference/SECURITY-CONTROLS.md](docs/reference/SECURITY-CONTROLS.md) or
[docs/reference/database-roles.md](docs/reference/database-roles.md) (audit trail tampering,
authentication/authorization bypass, PII encryption bypass, upload validation bypass), or that
exposes another organization's or another user's data.

Out of scope: findings against a local dev stack's deliberately-weak defaults (e.g. the dev-only
`fapoms_dev` / `fapoms_minio_secret` credentials, which are already refused by name in
production — see `README.md` "Configuration").

## Response

Reports are triaged by the maintainer(s) listed in `.github/CODEOWNERS`. There is no formal SLA
yet; a confirmed, in-scope report will get an acknowledgement and a fix or mitigation plan.
