# Documentation index

Every doc in this repo, what it is for, and who reads it. Start with the root
[README.md](../README.md) (repo layout, running it locally) and [DEPLOYMENT.md](../DEPLOYMENT.md)
(putting it on a machine) — both stay at the repo root because that is where GitHub, and anyone
cloning the repo, looks first.

## architecture/ — the system and the domain

| Doc | For |
|---|---|
| [business-spec.md](architecture/business-spec.md) | Learning the domain: the audit process end to end, entity by entity. Anyone building a feature who needs the vocabulary (branch, contract, assayer, coverage, …) before touching code. |
| [appraiser-recruitment-spec.md](architecture/appraiser-recruitment-spec.md) | The recruitment requirements the hiring pipeline was built from. Read before changing onboarding, BGV, or the hiring pipeline. |

## operations/ — running, deploying, and recovering the system

| Doc | For |
|---|---|
| [environments.md](operations/environments.md) | Which branch runs on which host, which compose file, how migrations run there, and how to deploy/check/back up/restore each one. Read this before touching anything deploy-related. |
| [go-live-checklist.md](operations/go-live-checklist.md) | Certifying a deployment before real use. `scripts/acceptance/verify-deployment.mjs` runs its §3 against a live deployment. |
| [load-test-and-scale.md](operations/load-test-and-scale.md) | Proving the capacity ceiling and where to add capacity past one instance. |
| [outbox-recovery-runbook.md](operations/outbox-recovery-runbook.md) | Completed work stopped turning into payables/billing lines — on-call runbook for the outbox. |
| [service-logs.md](operations/service-logs.md) | Reading live/historical container logs from `/admin/logs` or over HTTP, without shell access to a host. |
| [reference-nginx-fapoms.conf](operations/reference-nginx-fapoms.conf) | A worked example for fronting the stack with host nginx instead of the Caddy this deployment actually runs. Nothing in this repo deploys this file automatically. |

## reference/ — tables to look up, not narratives to read start to end

| Doc | For |
|---|---|
| [env-vars.md](reference/env-vars.md) | Every environment variable read anywhere in this repo — backend, scripts, frontend, mobile, and the compose/`.env*` files. |
| [database-roles.md](reference/database-roles.md) | Who FAPOMS is when it talks to PostgreSQL: the `fapoms_migrator` / `fapoms_audit_owner` / `fapoms_runtime` split, the transition procedure, and its rollback. |
| [SECURITY-CONTROLS.md](reference/SECURITY-CONTROLS.md) | `security-controls.spec.ts` failed, or you are adding/touching a security control. |

## reports/ — dated, point-in-time records

Kept as-is; each is a record of what was true when it was written, not a living doc.

| Doc | For |
|---|---|
| [2026-09-09-incident-audit-truncate.md](reports/2026-09-09-incident-audit-truncate.md) | Why certification/acceptance probes never touch the audit tables — the guards in `scripts/acceptance/` cite it by name. |

## reorganization/ — this reorganization itself

| Doc | For |
|---|---|
| [PLAN.md](reorganization/PLAN.md) | The reorganization plan, its progress tracker, and the log of what each phase did. |
| `snapshots/` | The G1/G3/G4/G5 "nothing changed" snapshots each phase diffs against. |

## Elsewhere in the repo

Not moved here because they are read in place, next to the code or config they describe, or
because a script depends on their exact path:

| Doc | For |
|---|---|
| [../CLAUDE.md](../CLAUDE.md) | Conventions for AI coding agents working in this repo. |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Branch rule, commit style, how to run the checks before opening a PR. |
| [../SECURITY.md](../SECURITY.md) | How to report a vulnerability. |
| [../deploy/aws/README.md](../deploy/aws/README.md) | Deploying the whole platform to a fresh AWS account. |
| [../scripts/acceptance/README.md](../scripts/acceptance/README.md) | Checking a running deployment end to end with the acceptance probes. |
| [../packages/mobile/BUILD-APK.md](../packages/mobile/BUILD-APK.md) | Building and publishing the field app APK. |
| [../packages/mobile/IOS-SETUP.md](../packages/mobile/IOS-SETUP.md) | iOS build setup for the mobile app. |
| [../packages/backend/templates/emails/email_templates_ai_prompts.md](../packages/backend/templates/emails/email_templates_ai_prompts.md) | Prompts used to draft the email templates; read alongside the templates themselves. |

## What is not here

No architecture decision records (ADRs) exist in this repo yet. `docs/reorganization/PLAN.md`
refers to an eventual `docs/adr/` with entries for prior decisions plus one for this
reorganization; that folder has not been created because there is nothing to move into it yet.
