# Contributing

## Branch rule

Work on `test`. `main` is the production deploy trigger — the homeserver follows it with no review
step in front (`deploy/aws/README.md`, `docs/operations/environments.md`), so anything that lands
on `main` reaches real users within minutes of CI going green. Open PRs against `test`; `test` is
promoted to `main` deliberately, not by accident of which branch you pushed to.

The one exception is a repository reorganization in progress on `refactor/reorganization`
(`docs/reorganization/PLAN.md`) — a separate checkout, its own `node_modules`, and its own rules.
Don't do reorganization-shaped work (moving files, splitting oversized modules) on `test` or
`main`; it belongs there instead.

## Commit style

This repo writes commits as `type(scope): what changed, and why if it isn't obvious`, following
[Conventional Commits](https://www.conventionalcommits.org/) loosely — scope is the area touched,
not a package name, and the description is a sentence, not a fragment:

```
fix(deploy): migrations were randomly skipped on the homeserver
feat(bgv): a clear background check needs its address, CIBIL and court checks
chore(reorg): the gate that proves a reorganization changed nothing
docs(reorg): log the sync with test, and write the NUL-byte note as an escape
test(reorg): specs find the source tree by name, not by counting '..'
```

Common types in this history: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `merge`. Prefer
one commit that explains itself over several that only make sense read together.

## Before opening a PR

```bash
npm run typecheck      # tsc --noEmit across backend, frontend, mobile, shared
npm run lint
npm test                # every workspace
```

If your change touches `packages/backend/**` and might affect a migration, schema, or a guard
spec, also run the backend's own test suite directly and check `packages/backend/src/security-controls.spec.ts`
passes — see [docs/reference/SECURITY-CONTROLS.md](docs/reference/SECURITY-CONTROLS.md) if it
fails and you don't immediately see why.

If you are working on `refactor/reorganization`, also run `npm run reorg:verify` — every phase's
exit criteria depends on it showing no unintended diff.

CI (`.github/workflows/ci.yml`) runs the same checks, plus a `database` job against a real
Postgres/Redis, on every push to `main`, `test` and `refactor/**`, and on every PR into `main` or
`test`. `deploy/auto-deploy.sh` refuses to deploy a commit CI has not marked green.

## Files that should not move without a reason

`docs/reorganization/PLAN.md`'s ground rules list files that are load-bearing by their exact path
and must never simply be relocated: `docker-compose.yml`, `deploy/docker-compose.prod.yml` (Docker
derives the database volume names from their folder — moving one starts the database empty),
`deploy/*.sh` and `deploy/aws/*.sh` (auto-deploy copies these by name), the package `Dockerfile`s,
`packages/backend/templates/`, `packages/frontend/nginx.conf`, `deploy/Caddyfile`, `.env.docker`
and its two symlinks (`.env`, `deploy/.env`), and the `scripts/*.mjs` files CI calls. If one of
these genuinely needs to move, update every script and compose file that names it, in the same
commit.

## Docs

[docs/README.md](docs/README.md) indexes every doc and who reads it. Add new docs there rather
than leaving them undiscoverable.
