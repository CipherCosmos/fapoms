# Environments: what runs where

Two servers track two branches, both updated by the same script
(`deploy/auto-deploy.sh`, run via `deploy/aws/install-auto-deploy.sh` on EC2 and
`deploy/install-auto-deploy.sh` on the homeserver) on a systemd timer that checks every two
minutes and only deploys a commit CI (`.github/workflows/ci.yml`) has marked green for that exact
SHA. There is no third environment; `refactor/reorganization` (this branch) deploys nowhere — CI
runs on it (`push: branches: [main, test, 'refactor/**']`) but no host follows it
(`.github/workflows/ci.yml:20-24`).

| | AWS EC2 | Homeserver |
|---|---|---|
| Branch followed | `test` | `main` |
| OS / container runtime | Ubuntu, Docker | AlmaLinux, rootless Podman |
| Checkout | auto-detected: `/opt/fapoms`, `/var/www/html/fapoms`, `/srv/fapoms` or `/home/ubuntu/fapoms` (first with a `.git`) | `~/apps/fapoms` |
| Compose file(s) actually running | root `docker-compose.yml` — the **"mounted"** layout | `deploy/docker-compose.prod.yml` |
| Image mode | dev images (`Dockerfile.dev`), `packages/*/src` bind-mounted, `nest start --watch` / `vite --host` inside the containers | production images built from the package `Dockerfile`s, source baked in, no bind mounts |
| How migrations run | `backend` runs `DB_MIGRATIONS_RUN=true` on its own boot (no `db-migrate` service in the root compose file) | a one-shot `db-migrate` service creates the roles, applies migrations as `fapoms_migrator`, hardens, and verifies from a `fapoms_runtime` connection; `backend` and `backend-worker` wait on it with `condition: service_completed_successfully` |
| What a source-only deploy does | nothing to rebuild — `git reset --hard` is the deploy; the watchers in the running containers pick up the new files. Only a dependency-manifest or Dockerfile change triggers a rebuild | rebuilds only the image whose package changed (`packages/backend/**`, `packages/frontend/**`, `packages/shared/**` rebuilds both, root `package-lock.json` rebuilds both) |
| Health check the deploy gate polls | `http://127.0.0.1:3000/api/v1/health` (backend published directly) | `http://127.0.0.1:8080/api/v1/health` (through Caddy) |
| Installer | `BRANCH=test MODE=saving bash deploy/aws/install-auto-deploy.sh` (root, system systemd units) | `bash deploy/install-auto-deploy.sh` (ordinary user, user systemd units — must **not** be run as root) |
| Deploy now / status | `systemctl start fapoms-deploy.service` / `systemctl list-timers fapoms-deploy.timer` / `tail -f /opt/fapoms-ops/auto-deploy.log` | `systemctl --user start fapoms-deploy.service` / `systemctl --user status fapoms-deploy.timer` / `tail -f ~/apps/fapoms-ops/auto-deploy.log` |
| Backup | not currently run — `deploy/backup.sh` requires `podman` on `PATH` and refuses otherwise (`deploy/backup.sh:154`); nothing in this repo makes it run under Docker as of this writing | nightly systemd user timer (`fapoms-backup.timer`) at 02:30 — `deploy/backup.sh` dumps Postgres with `pg_dump -Fc` and mirrors the MinIO object store append-only into `~/backups/fapoms/daily` and `~/backups/fapoms/objects`; verified on every run, retention 14 nightlies + 1/month for a year |
| Restore | not applicable while backup is not run | `~/apps/fapoms-ops/restore.sh --drill` (restore into a scratch DB and verify) or `restore.sh --to-production <dump>` (dumps current state first, then restores; objects go back with `mc mirror`) |
| CI gate before deploy | reads GitHub check runs for the exact commit SHA via `deploy/auto-deploy.sh`'s `check-runs` call; a failing or absent-after-15-minutes check refuses, a still-running one waits for the next tick | same script, same logic |

## Source of the facts above

- Branch/OS/checkout/compose-file/install-script table: `deploy/aws/install-auto-deploy.sh:1-60`
  (the `LAYOUTS` comment block and the `APP_DIR`/compose-file detection) and
  `deploy/install-auto-deploy.sh:1-30`.
- `deploy/auto-deploy.sh:34-61` — the shared script's defaults (homeserver values) and the
  `FAPOMS_SOURCE_MOUNTED` / `FAPOMS_COMPOSE_FILES` / `FAPOMS_HEALTH_URL` variables the AWS
  installer overrides.
- Root `docker-compose.yml:265-330` — the `backend` service's `build: dockerfile:
  packages/backend/Dockerfile.dev` and its bind-mounted `volumes:` (source, `nest-cli.json`,
  `tsconfig.json`, `scripts`, shared `src`).
- `deploy/docker-compose.prod.yml:374-401,469,536` — the `db-migrate` one-shot service and the
  `backend`/`backend-worker` services' `depends_on: db-migrate: {condition:
  service_completed_successfully}`.
- `deploy/aws/install-auto-deploy.sh` LAYOUTS comment for the "only what changed is rebuilt" /
  "the reset IS the deploy" distinction, mirrored in `deploy/auto-deploy.sh`'s own header comment.
- Backup/restore behaviour and the podman requirement: `deploy/backup.sh:154` (`command -v podman
  ... || die`), and `DEPLOYMENT.md`'s "Backups" section for the retention/verification model,
  itself written from `deploy/backup.sh` and `deploy/restore.sh`.
- CI triggers and job names: `.github/workflows/ci.yml:20-24` (`push`/`pull_request` branches) and
  `:35,142` (`verify` and `database` jobs).

## What this means in practice

- **`test` has no review step in front of it.** Whatever is pushed reaches the EC2 box about two
  minutes after CI goes green on `test`. `main` and the homeserver are kept separate so real users
  are never on the branch people are actively testing against (`deploy/aws/README.md:186-188`).
- **The two hosts run genuinely different stacks**, not the same stack on two branches: EC2 runs
  the same bind-mounted dev containers a local `docker compose up` would, while the homeserver runs
  the hardened production compose with the migrator/runtime role split. Do not assume a fix
  verified on EC2 behaves identically on the homeserver, or vice versa — the migration path in
  particular is different (in-process on EC2, a separate `db-migrate` service on the homeserver).
- **EC2 has no documented backup.** If that box starts holding data anyone depends on, `deploy/backup.sh`
  needs a Docker code path before it can be relied on there (tracked as Phase 1.4 in
  `docs/reorganization/PLAN.md`, out of scope for this documentation pass).
