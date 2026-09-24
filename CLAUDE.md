# AWS Guidance

- Prefer the AWS MCP Server for AWS interactions — it provides sandboxed
  execution, observability, and audit logging. If unavailable, use the
  AWS CLI directly.
- Before starting a task, check whether a relevant AWS skill is available.
  Load the skill with `retrieve_skill` and prefer its guidance over
  general knowledge.
- When uncertain about specific AWS details (API parameters, permissions,
  limits, error codes), verify against documentation rather than guessing.
  State uncertainty explicitly if you cannot confirm.
- When creating infrastructure, prefer infrastructure-as-code (AWS CDK or
  CloudFormation) over direct CLI commands.
- When working with infrastructure, follow AWS Well-Architected Framework
  principles.
- Do not use em dashes in AWS resource names or descriptions. Use
  hyphens instead.

## Secret Safety

- MUST load the `aws-secrets-manager` skill first for any secret,
  credential, API key, token, or password task. MUST NOT call
  `secretsmanager get-secret-value` or `batch-get-secret-value`, and MUST
  NOT hit the Secrets Manager Agent daemon directly. MUST use
  `{{resolve:secretsmanager:secret-id:SecretString:json-key}}` with
  `asm-exec` so the secret resolves at runtime without entering context.

## This project

FAPOMS: field audit planning & operations software, an API plus a web app and an Android field
app. Four npm workspaces:

| Package | What it is |
|---|---|
| `packages/shared` | Enums, interfaces, state machines, display labels, Indian geography. Consumed from its **compiled** `dist/` — run `npm run build:shared` after editing `src/`. |
| `packages/backend` | NestJS + TypeORM + Postgres/PostGIS, Redis, S3-compatible object storage. |
| `packages/frontend` | React + Vite + Leaflet — the operations desk. |
| `packages/mobile` | Expo / React Native — the field appraiser's app. Ships through EAS, not Docker. |

### Branch rules

- Work on `test`. `main` is the production deploy trigger: the homeserver follows it with no
  review step in front, so a commit reaching `main` reaches real users within minutes of CI going
  green.
- This repository's own reorganization (folder layout, dead-code removal, splitting oversized
  files — see `docs/reorganization/PLAN.md`) lives on `refactor/reorganization`, in a separate
  checkout with its own `node_modules`. Do not do reorganization work on `test` or `main`, and do
  not merge `refactor/reorganization` in except at the end of a completed, proven phase.

### Where docs live

Start at [docs/README.md](docs/README.md) — it indexes every doc in the repo and who reads it.
[docs/operations/environments.md](docs/operations/environments.md) covers which branch deploys
where and how.

### How to verify a change before calling it done

```bash
npm run typecheck      # tsc --noEmit across backend, frontend, mobile, shared
npm run lint
npm test                # every workspace
npm run reorg:verify    # the reorganization's "nothing changed" snapshots (G1/G3/G4/G5); should
                         # print "unchanged" for all four outside the reorganization branch
```
