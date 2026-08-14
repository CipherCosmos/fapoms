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
  log "nothing deployable changed (docs, tests or mobile only) — no work done"
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
