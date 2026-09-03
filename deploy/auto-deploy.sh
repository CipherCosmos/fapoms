#!/usr/bin/env bash
#
# Pull the deploy branch and redeploy whatever actually changed.
#
# Not hot reload in the development sense — that would mean bind-mounting source and running
# `nest start --watch` and a vite dev server, which throws away the production build, the nginx
# SPA fallback and the single-origin routing this deployment depends on. Real users are testing
# against this URL, so it stays a production build; what is automated is getting new commits onto
# it without anyone asking.
#
# Rebuilds only the image whose package changed. A backend-only commit does not spend two minutes
# rebuilding the web bundle, and vice versa.
#
# ---------------------------------------------------------------------------------------------
# One script, two hosts.
#
# The homeserver runs it under rootless podman, out of ~/apps/fapoms, on `main`. The AWS box runs
# it under docker, out of /opt/fapoms, on `test`. Everything that differs is a variable whose
# default is the homeserver's value, so that host keeps behaving exactly as before; the AWS box
# overrides them in /etc/default/fapoms-deploy.
#
# A second copy of this script for AWS was the obvious alternative and the wrong one: the two
# would have started identical and drifted, and the half that drifts is always the one nobody is
# watching. The differences here are five paths and a binary name — not a different deployment.
# ---------------------------------------------------------------------------------------------
set -euo pipefail

# Sourced before anything else so a manual run and a timer run see the same configuration. Absent
# on the homeserver, which is what the defaults below are for.
CONF="${FAPOMS_DEPLOY_CONF:-/etc/default/fapoms-deploy}"
# shellcheck disable=SC1090
[ -r "$CONF" ] && . "$CONF"

REPO="${FAPOMS_REPO:-$HOME/apps/fapoms}"
BRANCH="${FAPOMS_BRANCH:-main}"
OPS_DIR="${FAPOMS_OPS_DIR:-$HOME/apps/fapoms-ops}"
ENVFILE="${FAPOMS_ENV_FILE:-$REPO/.env.docker}"
CLI="${FAPOMS_CONTAINER_CLI:-podman}"
HEALTH_URL="${FAPOMS_HEALTH_URL:-http://127.0.0.1:8080/api/v1/health}"
LOG="${FAPOMS_LOG:-$OPS_DIR/auto-deploy.log}"

# Space-separated, in `-f` order. One file on the homeserver; the AWS box passes its generated
# compose file, plus the OSM/ClamAV overlay when it was bootstrapped in `full` mode.
COMPOSE_LIST="${FAPOMS_COMPOSE_FILES:-$REPO/deploy/docker-compose.prod.yml}"

# Runs after the reset and before anything is built, with the repo as its working directory. The
# AWS box uses it to re-derive the compose file bootstrap generates from docker-compose.prod.yml;
# without it a service added upstream would never reach the box while the log went on reporting
# healthy deploys.
HOOK="${FAPOMS_POST_RESET_HOOK:-}"

# Whether this host bind-mounts source into its containers instead of baking it into images.
#
# The AWS box does: it runs the root docker-compose.yml, whose backend is `nest start --watch` and
# whose frontend is `vite --host`, both with packages/*/src mounted from the checkout. There, the
# reset IS the deploy — the watchers see the new files and reload. Rebuilding would spend minutes
# producing an image whose only job is to hold node_modules, and would drop the dev servers'
# state to achieve nothing. Only the things a mount cannot carry — dependency manifests, which
# are installed into an anonymous node_modules volume at image build time, and the Dockerfiles
# themselves — still require a rebuild.
SOURCE_MOUNTED="${FAPOMS_SOURCE_MOUNTED:-false}"

mkdir -p "$(dirname "$LOG")"
log() { printf '%s  %s\n' "$(date -Is)" "$*" >> "$LOG"; }

# Build the compose invocation once. Word splitting on COMPOSE_LIST is the point, so the array is
# read explicitly rather than left to an unquoted expansion.
read -r -a COMPOSE_FILES <<< "$COMPOSE_LIST"
COMPOSE=("$CLI" compose)
for f in "${COMPOSE_FILES[@]}"; do COMPOSE+=(-f "$f"); done
COMPOSE+=(--env-file "$ENVFILE")

# A cheap content hash of the compiled shared package inside one container, used to tell a
# no-op recompile from one that actually replaced the build. Empty when the service or the
# directory is not there, which compares unequal to any real hash and so errs towards restarting.
dist_fingerprint() {
  "${COMPOSE[@]}" exec -T "$1" sh -c \
    'find /app/packages/shared/dist -type f -exec md5sum {} + 2>/dev/null | sort | md5sum' \
    2>/dev/null | awk '{print $1}'
}

# Running from inside the checkout would hand this process the tail of a different file: `git
# reset --hard` rewrites the script while bash is still reading it. The ops-directory copy below
# exists precisely to avoid that, so refuse rather than corrupt the run.
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$SELF/" in
  "$REPO"/*) log "REFUSING: running from inside $REPO. Install to $OPS_DIR and run it from there."
             exit 1 ;;
esac

cd "$REPO"

# ---------------------------------------------------------------------------------------------
# Which branch is checked out — and, separately, whether git can answer that question at all.
#
# These were one line, and collapsing them cost an afternoon. `$(git symbolic-ref … || echo
# '(detached HEAD)')` reports detachment for EVERY failure, so a git that refused to read the
# repository at all produced a confident, precise, wrong diagnosis — and the suggested fix ran
# clean by hand, because by hand it was never broken.
#
# The failure it was hiding: git refuses a repository owned by another user ("detected dubious
# ownership"). Under sudo it does not, because git special-cases SUDO_UID and this checkout is
# owned by the login user. systemd sets no SUDO_UID, so the timer's root hits the refusal that
# every interactive test skipped past.
#
# So stderr is captured and the exit status is read. Detachment is now only claimed when git
# actually said so.
# ---------------------------------------------------------------------------------------------
HEAD_ERR="$(mktemp)"; trap 'rm -f "$HEAD_ERR"' EXIT
if CURRENT="$(git symbolic-ref --quiet --short HEAD 2>"$HEAD_ERR")"; then
  :
elif [ -s "$HEAD_ERR" ]; then
  # git had something to say, so this is not a detached HEAD — it is git declining to work here.
  log "REFUSING: git cannot read $REPO: $(tr '\n' ' ' < "$HEAD_ERR")"
  if grep -qi 'dubious ownership' "$HEAD_ERR"; then
    log "         This is the timer running as $(id -un) against a checkout owned by $(stat -c %U "$REPO" 2>/dev/null || echo 'another user')."
    log "         fix: git config --system --add safe.directory $REPO"
    log "         (--system, not --global: a --global written under sudo lands in the calling"
    log "          user's home, which this service never reads.)"
  fi
  exit 1
else
  # Exited non-zero and said nothing, which is exactly what --quiet does on a detached HEAD.
  CURRENT='(detached HEAD)'
fi

# A clone left on the wrong branch would be reset onto this one, quietly moving whatever branch is
# checked out to another branch's commit. Say so instead, with the command that fixes it.
if [ "$CURRENT" != "$BRANCH" ]; then
  log "REFUSING: clone is on '$CURRENT' but this host deploys '$BRANCH'."
  log "         fix: git -C $REPO fetch origin $BRANCH && git -C $REPO checkout -B $BRANCH origin/$BRANCH"
  exit 1
fi

git fetch -q origin "$BRANCH"

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")
[ "$LOCAL" = "$REMOTE" ] && exit 0

log "new commits on $BRANCH: ${LOCAL:0:8} -> ${REMOTE:0:8}"

# What actually has to happen, decided from the paths that changed.
#
# The first version of this asked one question — "did anything under packages/backend or
# packages/frontend move?" — and rebuilt a whole image if so. The commit that installed it
# changed only `deploy/` and a markdown file, and it spent 43 seconds rebuilding the backend and
# 85 rebuilding the web bundle for changes that touched neither. Rebuilding is the expensive
# option and most changes do not need it.
CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE")

# Files that cannot affect a running container. Tests do not run in production, and documentation
# is in neither image. The mobile app is excluded too where images are built — it ships through
# `eas update` and the APK, not through this stack — but on a bind-mounted host its Metro bundler
# is one of the running containers, so there it stays in scope.
IGNORE='(\.md$|^docs/|\.spec\.[jt]sx?$|\.test\.[jt]sx?$)'
$SOURCE_MOUNTED || IGNORE='(\.md$|^docs/|^packages/mobile/|\.spec\.[jt]sx?$|\.test\.[jt]sx?$)'
DEPLOYABLE=$(echo "$CHANGED" | grep -vE "$IGNORE" || true)

NEED_BACKEND=false; NEED_FRONTEND=false; NEED_MOBILE=false
NEED_SHARED_BUILD=false; NEED_CADDY_RELOAD=false; NEED_RECREATE=false

if $SOURCE_MOUNTED; then
  # Only what a bind mount cannot deliver. node_modules lives in an anonymous volume created when
  # the image is built, so a new dependency never appears merely because package.json changed on
  # disk — that is the one edit here that genuinely needs a rebuild, along with the Dockerfile.
  # Everything else under packages/*/src is already inside the container the moment git writes it.
  echo "$DEPLOYABLE" | grep -qE '^packages/backend/(package\.json|Dockerfile)'  && NEED_BACKEND=true
  echo "$DEPLOYABLE" | grep -qE '^packages/frontend/(package\.json|Dockerfile)' && NEED_FRONTEND=true
  echo "$DEPLOYABLE" | grep -qE '^packages/mobile/(package\.json|Dockerfile)'   && NEED_MOBILE=true
  # Shared is the exception that looks like the rule and is not.
  #
  # `packages/shared/src` IS mounted, so a change to it lands inside the container like any other
  # source edit — and has no effect whatsoever. Nothing imports that source: package.json points
  # at `dist/cjs/index.js`, which each dev image compiles once at BUILD time and which is
  # deliberately not mounted (mounting it over the image's copy breaks every fresh clone, and the
  # compose file carries the scar).
  #
  # Checked on EVERY deploy rather than only when shared/src appears in this diff, because the
  # thing that invalidates dist is usually not this deploy at all. dist lives in the container's
  # own filesystem, so `compose up -d` recreating a container throws away whatever was compiled
  # into it and restores the image's copy — which may be weeks old. A deploy that changes only
  # the frontend then leaves a backend whose source imports twenty exports its `@fapoms/shared`
  # has never heard of, and the container reports Up throughout.
  #
  # That is exactly how this failed: a frontend-only deploy landed onto a backend recreated after
  # the last shared build, and the API came back with 46 TS2305 errors for symbols that were
  # sitting in shared/src the whole time.
  #
  # The build is idempotent and takes seconds, so running it always costs far less than the class
  # of failure it removes. The restart below is still conditional — see there.
  #
  # "Always" means every deploy that touches anything a container runs. A commit of documentation
  # alone still short-circuits below without opening a shell into a container, which keeps the
  # common no-op tick free and keeps its log line honest about having done nothing.
  [ -n "$(echo "$DEPLOYABLE" | tr -d '[:space:]')" ] && NEED_SHARED_BUILD=true
  # The manifest is a different matter: dependencies are installed into an anonymous volume at
  # image build time, so a change there does need the image rebuilt.
  echo "$DEPLOYABLE" | grep -qE '^packages/shared/package\.json' && { NEED_BACKEND=true; NEED_FRONTEND=true; NEED_MOBILE=true; }
  echo "$DEPLOYABLE" | grep -qE '^(package\.json|package-lock\.json)$' && { NEED_BACKEND=true; NEED_FRONTEND=true; NEED_MOBILE=true; }
else
  # Shared is compiled into both images, so a change there is the one case that rebuilds everything.
  echo "$DEPLOYABLE" | grep -qE '^packages/shared/' && { NEED_BACKEND=true; NEED_FRONTEND=true; }
  echo "$DEPLOYABLE" | grep -qE '^packages/backend/'  && NEED_BACKEND=true
  echo "$DEPLOYABLE" | grep -qE '^packages/frontend/' && NEED_FRONTEND=true

  # Dependency changes at the root alter what `npm ci` installs inside both images.
  echo "$DEPLOYABLE" | grep -qE '^(package\.json|package-lock\.json)$' && { NEED_BACKEND=true; NEED_FRONTEND=true; }
fi

# The Caddyfile is bind-mounted, not baked into an image, so a config change needs the process
# to re-read it — never a rebuild. `caddy reload` would do that with no dropped connections, but
# it talks to the admin API on :2019 and this Caddyfile sets `admin off`; the reload is refused
# and would fall back every time. Restarting the container is about a second on an image this
# size, and is not worth reopening an admin endpoint that was closed deliberately.
echo "$DEPLOYABLE" | grep -qE '^deploy/Caddyfile$' && NEED_CADDY_RELOAD=true

# Compose changes alter how containers are run, not what is inside them: recreate, do not build.
# Matched anywhere under deploy/ — the AWS overlay lives at deploy/aws/docker-compose.aws-full.yml
# and an anchored `^deploy/docker-compose` missed it, so a change to the OSM/ClamAV stack would
# have been classified as affecting nothing at all.
echo "$DEPLOYABLE" | grep -qE '^deploy/.*docker-compose' && NEED_RECREATE=true

# Local commits made on this box would be destroyed by a reset. Refuse rather than discard —
# an unpushed commit was found here once already, and it was real work.
if [ -n "$(git log --oneline "origin/$BRANCH..HEAD")" ]; then
  log "REFUSING: this clone has unpushed commits. Push or drop them, then rerun."
  exit 1
fi

# ---------------------------------------------------------------------------------------------
# Do not deploy a commit CI has not passed.
#
# Deciding what to rebuild says nothing about whether the code works. Until this gate existed the
# answer to "has anything verified this commit?" was no — 1058 tests sat in the repository and
# nothing ran them, while this script shipped whatever landed on the branch within two minutes, to
# the URL assayers are working against.
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
AGE_MIN=$(( ( $(date +%s) - $(git show -s --format=%ct "$REMOTE") ) / 60 ))

if [ "${FAPOMS_SKIP_CI_GATE:-0}" = "1" ]; then
  log "WARNING: CI gate skipped by FAPOMS_SKIP_CI_GATE — deploying ${REMOTE:0:8} unverified"
else
  command -v jq >/dev/null || { log "REFUSING: jq is required for the CI gate."; exit 1; }

  GH_API="https://api.github.com/repos/${FAPOMS_GH_REPO:-CipherCosmos/fapoms}/commits/$REMOTE/check-runs"
  AUTH=()
  [ -n "${FAPOMS_GH_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $FAPOMS_GH_TOKEN")

  # The status code is read rather than relying on `curl -f`, because the two failures that matter
  # are not the same problem and were previously indistinguishable. This repository is private:
  # without a token GitHub answers 404, not 401, and "the repo does not exist" and "the network is
  # down" both surfaced as one vague line while deploys silently stopped forever.
  CI_JSON="$(mktemp)"; trap 'rm -f "$CI_JSON"' EXIT
  HTTP=$(curl -sS -o "$CI_JSON" -w '%{http_code}' --max-time 30 "${AUTH[@]}" \
    -H "Accept: application/vnd.github+json" "$GH_API" 2>>"$LOG") || {
      log "REFUSING: could not reach GitHub for ${REMOTE:0:8}'s CI result. Will retry next tick."
      exit 1
    }

  case "$HTTP" in
    200) ;;
    404) log "REFUSING: GitHub returned 404 for ${REMOTE:0:8}. This repository is private, so the"
         log "         gate needs FAPOMS_GH_TOKEN set to a token with 'repo' (or Actions: read) scope."
         exit 1 ;;
    401|403) log "REFUSING: GitHub returned $HTTP — FAPOMS_GH_TOKEN is invalid, expired, or rate limited."
             exit 1 ;;
    *)   log "REFUSING: GitHub returned HTTP $HTTP for ${REMOTE:0:8}. Will retry next tick."
         exit 1 ;;
  esac

  TOTAL=$(jq '.total_count' "$CI_JSON")
  RUNNING=$(jq '[.check_runs[] | select(.status != "completed")] | length' "$CI_JSON")
  # `skipped` and `neutral` are passes. `cancelled` is handled separately below. Anything else
  # that completed is not a pass.
  CANCELLED=$(jq '[.check_runs[] | select(.status == "completed")
                    | select(.conclusion == "cancelled")] | length' "$CI_JSON")
  BAD=$(jq '[.check_runs[] | select(.status == "completed")
              | select(.conclusion | IN("success","skipped","neutral","cancelled") | not)] | length' "$CI_JSON")

  if [ "$TOTAL" -eq 0 ]; then
    # No run has appeared. Early on that just means it has not started; past a few minutes it
    # means something is wrong — Actions disabled, the workflow file invalid, a billing stop —
    # and staying quiet about that would freeze deploys with no explanation.
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
  elif [ "$CANCELLED" -gt 0 ]; then
    # ci.yml sets `cancel-in-progress` on every branch except main, so a second push while the
    # first is still building leaves the first commit's run `cancelled` forever. That is not a
    # failure — it means this SHA was superseded, and the branch has already moved to one that
    # will get its own verdict. Treating it as a failure would print REFUSING for the ordinary
    # act of pushing twice in five minutes, which is the normal rhythm on `test`.
    #
    # Unless it stays. A cancelled run on a SHA that is still the branch head a quarter of an hour
    # later was cancelled by a person, and nothing is coming to replace it.
    if [ "$AGE_MIN" -ge 15 ]; then
      log "REFUSING: CI on ${REMOTE:0:8} was cancelled and it is still branch head after ${AGE_MIN}m."
      exit 1
    fi
    log "waiting: CI on ${REMOTE:0:8} was cancelled by a newer push. Will retry next tick."
    exit 0
  fi
  log "CI green for ${REMOTE:0:8} ($TOTAL checks)"
fi

git reset --hard -q "origin/$BRANCH"

# ---------------------------------------------------------------------------------------------
# Keep the operations scripts in step with the repository.
#
# These run from the ops directory, which is a copy taken by hand at install time. So the one
# thing this deployment could not deploy was its own tooling: an edit to this script, or to the
# backup job, sat in the branch looking applied while the host went on running whatever was copied
# weeks ago. That gap is invisible precisely because the log keeps reporting healthy deploys.
#
# Written via a temp file and renamed, never overwritten in place. Bash reads a script
# incrementally as it executes, so writing over the file this process is running from would feed
# it the tail of a different file mid-run. `mv` is atomic and leaves the running process on its
# original inode; the new version takes effect at the next tick, two minutes later.
# ---------------------------------------------------------------------------------------------
for f in auto-deploy.sh backup.sh restore.sh publish-apk.sh aws/render-aws-compose.sh; do
  SRC="$REPO/deploy/$f"; DST="$OPS_DIR/$(basename "$f")"
  if [ -f "$SRC" ] && ! cmp -s "$SRC" "$DST"; then
    install -m 755 "$SRC" "$DST.new" && mv -f "$DST.new" "$DST"
    log "ops script updated: $(basename "$f") (in effect next run)"
  fi
done

# Regenerate whatever this host derives from files in the repository. Runs on every deploy rather
# than only when its inputs changed: it is idempotent and costs milliseconds, and the alternative
# is a list of trigger paths that silently stops covering a new one.
if [ -n "$HOOK" ]; then
  if [ -x "$HOOK" ]; then
    log "post-reset hook: $HOOK"
    "$HOOK" >> "$LOG" 2>&1 || { log "REFUSING: post-reset hook failed. Nothing rebuilt."; exit 1; }
  else
    log "REFUSING: FAPOMS_POST_RESET_HOOK is set to $HOOK, which is not executable."
    exit 1
  fi
fi

if $NEED_BACKEND; then
  log "rebuilding backend"
  "${COMPOSE[@]}" build backend >> "$LOG" 2>&1
  "${COMPOSE[@]}" up -d backend >> "$LOG" 2>&1
fi
if $NEED_FRONTEND; then
  log "rebuilding frontend"
  "${COMPOSE[@]}" build frontend >> "$LOG" 2>&1
  "${COMPOSE[@]}" up -d frontend >> "$LOG" 2>&1
fi
if $NEED_SHARED_BUILD && ! $NEED_BACKEND && ! $NEED_FRONTEND; then
  # Skipped when an image rebuild is already happening — that recompiles shared anyway.
  for svc in backend frontend mobile; do
    "${COMPOSE[@]}" ps --services 2>/dev/null | grep -qx "$svc" || continue

    # Fingerprint dist before and after, so the restart is paid for only when the compile actually
    # produced something different. Without this, building on every deploy would also restart both
    # dev servers on every deploy — throwing away the "the reset IS the deploy" property that
    # makes a bind-mounted stack worth having.
    before="$(dist_fingerprint "$svc")"
    if ! "${COMPOSE[@]}" exec -T -w /app "$svc" npm run build:shared >> "$LOG" 2>&1; then
      # `-w /app`: build:shared is a ROOT workspace script, and every dev image sets WORKDIR to
      # its own package (/app/packages/backend). Without it npm resolves the nearest package and
      # exits with "Missing script: build:shared".
      log "REFUSING: 'npm run build:shared' failed in $svc — leaving the previous build running."
      exit 1
    fi
    after="$(dist_fingerprint "$svc")"

    if [ "$before" != "$after" ]; then
      log "@fapoms/shared recompiled in $svc (dist changed) — restarting it"
      "${COMPOSE[@]}" restart "$svc" >> "$LOG" 2>&1
    fi
  done
fi
if $NEED_MOBILE; then
  log "rebuilding mobile (Metro bundler)"
  "${COMPOSE[@]}" build mobile >> "$LOG" 2>&1
  "${COMPOSE[@]}" up -d mobile >> "$LOG" 2>&1
fi
# Only meaningful where the stack actually terminates traffic in Caddy. The AWS box fronts its
# containers with host nginx and defines no caddy service, so a Caddyfile edit there changes
# nothing running — and refusing the deploy over a container that was never supposed to exist
# would strand every later commit behind it.
if $NEED_CADDY_RELOAD && ! "${COMPOSE[@]}" config --services 2>/dev/null | grep -qx caddy; then
  log "note: deploy/Caddyfile changed but this stack defines no caddy service — ignoring"
  NEED_CADDY_RELOAD=false
fi
if $NEED_CADDY_RELOAD; then
  # Validate before restarting: a Caddyfile the process rejects would leave the proxy down, and
  # the proxy is the only way into this deployment.
  #
  # The container is resolved through compose rather than named literally. `deploy-caddy-1` is
  # what the project name happens to produce today, and it is produced from a directory name —
  # it would change under a different checkout path or a COMPOSE_PROJECT_NAME, and the failure
  # mode is a validation step that silently never runs.
  CADDY_ID="$("${COMPOSE[@]}" ps -q caddy 2>/dev/null || true)"
  if [ -z "$CADDY_ID" ]; then
    log "REFUSING: the Caddyfile changed but no caddy container is running to validate it."
    exit 1
  fi
  if "$CLI" exec "$CADDY_ID" caddy validate --config /etc/caddy/Caddyfile >> "$LOG" 2>&1; then
    log "caddy config valid — restarting caddy only (no image rebuild)"
    "${COMPOSE[@]}" up -d --force-recreate caddy >> "$LOG" 2>&1
  else
    log "REFUSING: the new Caddyfile is invalid. Leaving the running config in place."
    exit 1
  fi
fi
if $NEED_RECREATE; then
  log "compose changed — recreating containers without rebuilding"
  "${COMPOSE[@]}" up -d >> "$LOG" 2>&1
fi
# NEED_SHARED_BUILD is deliberately absent from this test. It is true on every deploy that
# touches a container now, so including it would silence the one line that says what an ordinary
# source-only deploy actually did — leaving the log with a "new commits" entry and then nothing.
if ! $NEED_BACKEND && ! $NEED_FRONTEND && ! $NEED_MOBILE \
   && ! $NEED_CADDY_RELOAD && ! $NEED_RECREATE; then
  if $SOURCE_MOUNTED && [ -n "$(echo "$DEPLOYABLE" | tr -d '[:space:]')" ]; then
    # The deploy already happened: the reset wrote the new files straight into the containers
    # through their bind mounts. Saying "nothing to do" here would be false — better to name what
    # occurred and still prove the watchers came back on the other side of it.
    log "source updated in place via bind mounts — nest/vite watchers reload, no rebuild needed"
  else
    log "no change affects a running container — nothing rebuilt or restarted"
    exit 0
  fi
fi

# Prove it came back, rather than assuming the restart worked.
for i in $(seq 1 30); do
  if curl -fsS -m 5 "$HEALTH_URL" >/dev/null 2>&1; then
    log "healthy at ${REMOTE:0:8}"; exit 0
  fi
  sleep 4
done
log "WARNING: unhealthy 2 minutes after deploying ${REMOTE:0:8}"
exit 1
