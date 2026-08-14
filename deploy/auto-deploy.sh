#!/usr/bin/env bash
#
# Pull main and redeploy whatever actually changed.
#
# Not hot reload in the development sense — that would mean bind-mounting source and running
# `nest start --watch` and a vite dev server, which throws away the production build, the nginx
# SPA fallback and the single-origin routing this deployment depends on. Real users are testing
# against this URL, so it stays a production build; what is automated is getting new commits onto
# it without anyone asking.
#
# Rebuilds only the image whose package changed. A backend-only commit does not spend two minutes
# rebuilding the web bundle, and vice versa.
set -euo pipefail

REPO=~/apps/fapoms
COMPOSE="$REPO/deploy/docker-compose.prod.yml"
ENVFILE="$REPO/.env.docker"
LOG=~/apps/fapoms-ops/auto-deploy.log

log() { printf '%s  %s\n' "$(date -Is)" "$*" >> "$LOG"; }

cd "$REPO"
git fetch -q origin main

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)
[ "$LOCAL" = "$REMOTE" ] && exit 0

log "new commits: ${LOCAL:0:8} -> ${REMOTE:0:8}"

# What actually has to happen, decided from the paths that changed.
#
# The first version of this asked one question — "did anything under packages/backend or
# packages/frontend move?" — and rebuilt a whole image if so. The commit that installed it
# changed only `deploy/` and a markdown file, and it spent 43 seconds rebuilding the backend and
# 85 rebuilding the web bundle for changes that touched neither. Rebuilding is the expensive
# option and most changes do not need it.
CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE")

# Files that cannot affect a running container. Tests do not run in production, and documentation
# and the mobile app are not in either image — mobile ships through `eas update` and the APK.
DEPLOYABLE=$(echo "$CHANGED" | grep -vE '(\.md$|^docs/|^packages/mobile/|\.spec\.[jt]sx?$|\.test\.[jt]sx?$)' || true)

NEED_BACKEND=false; NEED_FRONTEND=false; NEED_CADDY_RELOAD=false; NEED_RECREATE=false

# Shared is compiled into both images, so a change there is the one case that rebuilds everything.
echo "$DEPLOYABLE" | grep -qE '^packages/shared/' && { NEED_BACKEND=true; NEED_FRONTEND=true; }
echo "$DEPLOYABLE" | grep -qE '^packages/backend/'  && NEED_BACKEND=true
echo "$DEPLOYABLE" | grep -qE '^packages/frontend/' && NEED_FRONTEND=true

# Dependency changes at the root alter what `npm ci` installs inside both images.
echo "$DEPLOYABLE" | grep -qE '^(package\.json|package-lock\.json)$' && { NEED_BACKEND=true; NEED_FRONTEND=true; }

# The Caddyfile is bind-mounted, not baked into an image, so a config change needs the process
# to re-read it — never a rebuild. `caddy reload` would do that with no dropped connections, but
# it talks to the admin API on :2019 and this Caddyfile sets `admin off`; the reload is refused
# and would fall back every time. Restarting the container is about a second on an image this
# size, and is not worth reopening an admin endpoint that was closed deliberately.
echo "$DEPLOYABLE" | grep -qE '^deploy/Caddyfile$' && NEED_CADDY_RELOAD=true

# Compose changes alter how containers are run, not what is inside them: recreate, do not build.
echo "$DEPLOYABLE" | grep -qE '^deploy/docker-compose' && NEED_RECREATE=true

# Local commits made on this box would be destroyed by a reset. Refuse rather than discard —
# an unpushed commit was found here once already, and it was real work.
if [ -n "$(git log --oneline origin/main..HEAD)" ]; then
  log "REFUSING: this clone has unpushed commits. Push or drop them, then rerun."
  exit 1
fi

# ---------------------------------------------------------------------------------------------
# Do not deploy a commit CI has not passed.
#
# Deciding what to rebuild says nothing about whether the code works. Until this gate existed the
# answer to "has anything verified this commit?" was no — 1058 tests sat in the repository and
# nothing ran them, while this script shipped whatever landed on main within two minutes, to the
# URL assayers are working against.
#
# The verdict is read from the check runs on the exact SHA about to be deployed, so it is that
# commit's own result and not a stale badge from an earlier one.
#
# It must be check-runs and not the older `/commits/{sha}/status` endpoint. GitHub Actions
# publishes check runs; it does not create legacy commit statuses. `/status` on this repository
# returns `{"state":"pending","total_count":0}` for every commit forever — a gate reading that
# would treat "CI passed" and "CI does not exist" as the same answer and quietly stop deploying
# anything, with the log cheerfully reporting that it was waiting.
#
# Deliberately fails closed on every uncertain answer — a rate limit, an unreachable API, a run
# that never appeared. Waiting two minutes for the next timer tick costs nothing; deploying an
# unverified commit to the machine holding the audit record is not the same kind of cheap. Set
# FAPOMS_SKIP_CI_GATE=1 for a genuine emergency where shipping unverified is the lesser risk; it
# is logged loudly.
# ---------------------------------------------------------------------------------------------
if [ "${FAPOMS_SKIP_CI_GATE:-0}" = "1" ]; then
  log "WARNING: CI gate skipped by FAPOMS_SKIP_CI_GATE — deploying ${REMOTE:0:8} unverified"
else
  command -v jq >/dev/null || { log "REFUSING: jq is required for the CI gate."; exit 1; }

  GH_API="https://api.github.com/repos/${FAPOMS_GH_REPO:-CipherCosmos/fapoms}/commits/$REMOTE/check-runs"
  AUTH=()
  [ -n "${FAPOMS_GH_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $FAPOMS_GH_TOKEN")

  CI_JSON=$(curl -fsS --max-time 30 "${AUTH[@]}" \
    -H "Accept: application/vnd.github+json" "$GH_API" 2>>"$LOG") || {
      log "REFUSING: could not reach GitHub for ${REMOTE:0:8}'s CI result. Will retry next tick."
      exit 1
    }

  TOTAL=$(printf '%s' "$CI_JSON"    | jq '.total_count')
  RUNNING=$(printf '%s' "$CI_JSON"  | jq '[.check_runs[] | select(.status != "completed")] | length')
  # `skipped` and `neutral` are passes. Anything else that completed is not.
  BAD=$(printf '%s' "$CI_JSON"      | jq '[.check_runs[] | select(.status == "completed")
                                            | select(.conclusion | IN("success","skipped","neutral") | not)] | length')

  if [ "$TOTAL" -eq 0 ]; then
    # No run has appeared. Early on that just means it has not started; past a few minutes it
    # means something is wrong — Actions disabled, the workflow file invalid, a billing stop —
    # and staying quiet about that would freeze deploys with no explanation.
    AGE_MIN=$(( ( $(date +%s) - $(git show -s --format=%ct "$REMOTE") ) / 60 ))
    if [ "$AGE_MIN" -ge 15 ]; then
      log "REFUSING: no CI run for ${REMOTE:0:8} after ${AGE_MIN}m — is the workflow enabled?"
      exit 1
    fi
    log "waiting: no CI run yet for ${REMOTE:0:8} (${AGE_MIN}m old). Will retry next tick."
    exit 0
  elif [ "$BAD" -gt 0 ]; then
    log "REFUSING: $BAD failing check(s) on ${REMOTE:0:8}. Not deploying."
    exit 1
  elif [ "$RUNNING" -gt 0 ]; then
    log "waiting: $RUNNING check(s) still running for ${REMOTE:0:8}. Will retry next tick."
    exit 0
  fi
  log "CI green for ${REMOTE:0:8} ($TOTAL checks)"
fi

git reset --hard -q origin/main

# ---------------------------------------------------------------------------------------------
# Keep the operations scripts in step with the repository.
#
# These run from ~/apps/fapoms-ops, which is a copy taken by hand at install time. So the one
# thing this deployment could not deploy was its own tooling: an edit to this script, or to the
# backup job, sat in main looking applied while the host went on running whatever was copied
# weeks ago. That gap is invisible precisely because the log keeps reporting healthy deploys.
#
# Written via a temp file and renamed, never overwritten in place. Bash reads a script
# incrementally as it executes, so writing over the file this process is running from would feed
# it the tail of a different file mid-run. `mv` is atomic and leaves the running process on its
# original inode; the new version takes effect at the next tick, two minutes later.
# ---------------------------------------------------------------------------------------------
for f in auto-deploy.sh backup.sh restore.sh; do
  SRC="$REPO/deploy/$f"; DST=~/apps/fapoms-ops/"$f"
  if [ -f "$SRC" ] && ! cmp -s "$SRC" "$DST"; then
    install -m 755 "$SRC" "$DST.new" && mv -f "$DST.new" "$DST"
    log "ops script updated: $f (in effect next run)"
  fi
done

if $NEED_BACKEND; then
  log "rebuilding backend"
  podman compose -f "$COMPOSE" --env-file "$ENVFILE" build backend >> "$LOG" 2>&1
  podman compose -f "$COMPOSE" --env-file "$ENVFILE" up -d backend >> "$LOG" 2>&1
fi
if $NEED_FRONTEND; then
  log "rebuilding frontend"
  podman compose -f "$COMPOSE" --env-file "$ENVFILE" build frontend >> "$LOG" 2>&1
  podman compose -f "$COMPOSE" --env-file "$ENVFILE" up -d frontend >> "$LOG" 2>&1
fi
if $NEED_CADDY_RELOAD; then
  # Validate before restarting: a Caddyfile the process rejects would leave the proxy down, and
  # the proxy is the only way into this deployment.
  if podman exec deploy-caddy-1 caddy validate --config /etc/caddy/Caddyfile >> "$LOG" 2>&1; then
    log "caddy config valid — restarting caddy only (no image rebuild)"
    podman compose -f "$COMPOSE" --env-file "$ENVFILE" up -d --force-recreate caddy >> "$LOG" 2>&1
  else
    log "REFUSING: the new Caddyfile is invalid. Leaving the running config in place."
    exit 1
  fi
fi
if $NEED_RECREATE; then
  log "compose changed — recreating containers without rebuilding"
  podman compose -f "$COMPOSE" --env-file "$ENVFILE" up -d >> "$LOG" 2>&1
fi
if ! $NEED_BACKEND && ! $NEED_FRONTEND && ! $NEED_CADDY_RELOAD && ! $NEED_RECREATE; then
  log "no change affects a running container — nothing rebuilt or restarted"
  exit 0
fi

# Prove it came back, rather than assuming the restart worked.
for i in $(seq 1 30); do
  if curl -fsS -m 5 http://127.0.0.1:8080/api/v1/health >/dev/null 2>&1; then
    log "healthy at ${REMOTE:0:8}"; exit 0
  fi
  sleep 4
done
log "WARNING: unhealthy 2 minutes after deploying ${REMOTE:0:8}"
exit 1
