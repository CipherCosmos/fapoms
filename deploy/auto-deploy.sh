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

# Which packages moved? Decided before the working tree is updated.
CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE")
NEED_BACKEND=false; NEED_FRONTEND=false
echo "$CHANGED" | grep -qE '^packages/(backend|shared)/' && NEED_BACKEND=true
echo "$CHANGED" | grep -qE '^packages/(frontend|shared)/' && NEED_FRONTEND=true
echo "$CHANGED" | grep -qE '^deploy/' && { NEED_BACKEND=true; NEED_FRONTEND=true; }

# Local commits made on this box would be destroyed by a reset. Refuse rather than discard —
# an unpushed commit was found here once already, and it was real work.
if [ -n "$(git log --oneline origin/main..HEAD)" ]; then
  log "REFUSING: this clone has unpushed commits. Push or drop them, then rerun."
  exit 1
fi
git reset --hard -q origin/main

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
if ! $NEED_BACKEND && ! $NEED_FRONTEND; then
  log "no deployable package changed (docs/mobile only) — nothing rebuilt"
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
