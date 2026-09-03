#!/usr/bin/env bash
# =============================================================================
# FAPOMS - install the auto-deploy timer on the EC2 box.
#
# Turns the running deployment into one that follows a branch: every two minutes it checks
# whether the branch moved, refuses anything CI has not marked green, rebuilds only the image
# whose package changed, and proves the stack came back before calling it done.
#
# Run on the box, after bootstrap.sh, as root:
#
#   sudo -i
#   bash /opt/fapoms/deploy/aws/install-auto-deploy.sh
#
# Options (environment):
#   BRANCH=test          branch to follow                       (default: test)
#   APP_DIR=...          the checkout        (default: auto-detected, see LAYOUTS below)
#   OPS_DIR=/opt/fapoms-ops  where the scripts run from         (default: /opt/fapoms-ops)
#   MODE=saving|full     bootstrap layout only; ignored otherwise    (default: saving)
#
# LAYOUTS. Two different stacks answer to "the AWS box", and they need opposite deploy actions:
#
#   bootstrap  - deploy/docker-compose.aws.yml, production images, source baked in.
#                A source change means rebuild the image whose package moved.
#   mounted    - the root docker-compose.yml, dev images, packages/*/src bind-mounted,
#                `nest start --watch` and `vite --host` inside. The git reset IS the deploy;
#                only dependency manifests and Dockerfiles still need a rebuild.
#
# Detected from which compose file is present, and printed before anything is written.
#   FORCE=1              proceed even though tracked files are locally modified
#   FAPOMS_GH_TOKEN=...  optional; only raises the GitHub API rate limit (see below)
#
# Re-runnable. An existing token in /etc/default/fapoms-deploy is preserved.
# =============================================================================
set -euo pipefail

OPS_DIR="${OPS_DIR:-/opt/fapoms-ops}"
BRANCH="${BRANCH:-test}"
MODE="${MODE:-saving}"
CONF=/etc/default/fapoms-deploy
UNIT_DIR=/etc/systemd/system

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo -i)."; exit 1; }
case "$MODE" in saving|full) ;; *) echo "MODE must be 'saving' or 'full'"; exit 2 ;; esac

# --- 0. Find the checkout -------------------------------------------------
# Not hardcoded to /opt/fapoms: the box this was first pointed at keeps the app under
# /var/www/html/fapoms, and a wrong guess here silently produces a config for a directory that
# does not exist rather than an error anyone would notice.
if [ -z "${APP_DIR:-}" ]; then
  for d in /opt/fapoms /var/www/html/fapoms /srv/fapoms /home/ubuntu/fapoms; do
    [ -d "$d/.git" ] && { APP_DIR="$d"; break; }
  done
fi
[ -n "${APP_DIR:-}" ] && [ -d "$APP_DIR/.git" ] || {
  echo "!! No git checkout found. Set APP_DIR explicitly:  APP_DIR=/path/to/fapoms bash $0"; exit 1; }

# --- 0b. Which stack is this? ---------------------------------------------
if [ -f "$APP_DIR/deploy/docker-compose.aws.yml" ]; then
  LAYOUT=bootstrap
  SOURCE_MOUNTED=false
  COMPOSE_FILES="$APP_DIR/deploy/docker-compose.aws.yml"
  [ "$MODE" = "full" ] && COMPOSE_FILES="$COMPOSE_FILES $APP_DIR/deploy/aws/docker-compose.aws-full.yml"
  HOOK="$OPS_DIR/render-aws-compose.sh"
  HEALTH_URL="http://127.0.0.1:8080/api/v1/health"   # caddy on loopback
elif [ -f "$APP_DIR/docker-compose.yml" ]; then
  LAYOUT=mounted
  SOURCE_MOUNTED=true
  COMPOSE_FILES="$APP_DIR/docker-compose.yml"
  HOOK=""                                            # nothing is generated in this layout
  HEALTH_URL="http://127.0.0.1:3000/api/v1/health"   # backend published directly
else
  echo "!! No compose file found under $APP_DIR."; exit 1
fi
ENV_FILE="${FAPOMS_ENV_FILE:-$APP_DIR/.env.docker}"
[ -f "$ENV_FILE" ] || { echo "!! No env file at $ENV_FILE. Set FAPOMS_ENV_FILE if it lives elsewhere."; exit 1; }

echo "==> installing auto-deploy"
echo "      branch : $BRANCH"
echo "      repo   : $APP_DIR"
echo "      layout : $LAYOUT$([ "$LAYOUT" = bootstrap ] && echo " (mode=$MODE)")"
echo "      compose: $COMPOSE_FILES"
echo "      health : $HEALTH_URL"
echo "      deploys: $($SOURCE_MOUNTED && echo "reset only; rebuild on dependency/Dockerfile changes" || echo "rebuild the image whose package changed")"

# --- 1. Dependencies ------------------------------------------------------
# jq is what the CI gate parses check runs with; without it the gate refuses every tick. Install
# it now rather than discovering it from a log line two minutes after enabling the timer.
MISSING=()
for c in git curl jq python3 docker; do command -v "$c" >/dev/null || MISSING+=("$c"); done
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "==> installing: ${MISSING[*]}"
  apt-get update -qq && apt-get install -y -qq "${MISSING[@]}"
fi
python3 -c 'import yaml' 2>/dev/null || { echo "==> installing python3-yaml"; apt-get install -y -qq python3-yaml; }

# --- 2. Point the checkout at the branch ----------------------------------
cd "$APP_DIR"
git fetch -q origin "$BRANCH" || { echo "!! Cannot fetch origin/$BRANCH. Does the clone's remote carry a token?"; exit 1; }

# Every deploy begins with `git reset --hard`, so anything locally modified here is on a countdown
# whether this script mentions it or not. Say what will be lost while it can still be saved.
DIRTY="$(git status --porcelain --untracked-files=no)"
if [ -n "$DIRTY" ] && [ "${FORCE:-0}" != "1" ]; then
  echo ""
  echo "!! Tracked files are locally modified in $APP_DIR:"
  echo "$DIRTY" | sed 's/^/     /'
  echo ""
  echo "   The first deploy will discard these — auto-deploy resets hard onto origin/$BRANCH."
  echo "   infrastructure/livekit/livekit.yaml is expected here: bootstrap.sh rewrites it, and"
  echo "   no compose service reads it (neither the prod nor the AWS stack defines livekit)."
  echo "   Anything else in that list is a real local change. Save it, then re-run with FORCE=1."
  exit 1
fi

git checkout -B "$BRANCH" "origin/$BRANCH"
echo "==> $APP_DIR now on $BRANCH at $(git rev-parse --short HEAD)"

# The timer runs as root; this checkout is usually owned by the login user. Git refuses a
# repository owned by someone else, EXCEPT under sudo, where it consults SUDO_UID — which is why
# every interactive check passes and only the service fails, with a refusal that looks nothing
# like a permissions problem. Registered in the SYSTEM config on purpose: a --global written from
# a sudo shell lands in the calling user's home, which the service never reads.
OWNER="$(stat -c %U "$APP_DIR" 2>/dev/null || echo root)"
if [ "$OWNER" != "root" ]; then
  git config --system --add safe.directory "$APP_DIR" 2>/dev/null || true
  echo "==> registered $APP_DIR as a safe.directory for root (it is owned by $OWNER)"
fi

# --- 3. The scripts, outside the checkout ---------------------------------
# They cannot run from inside $APP_DIR: `git reset --hard` rewrites files there while bash is
# still reading the script it is executing, and it would resume in the middle of a different file.
mkdir -p "$OPS_DIR"
OPS_SCRIPTS="auto-deploy.sh backup.sh restore.sh publish-apk.sh"
[ "$LAYOUT" = bootstrap ] && OPS_SCRIPTS="$OPS_SCRIPTS aws/render-aws-compose.sh"
for f in $OPS_SCRIPTS; do
  [ -f "$APP_DIR/deploy/$f" ] && install -m 755 "$APP_DIR/deploy/$f" "$OPS_DIR/$(basename "$f")"
done
echo "==> scripts installed in $OPS_DIR"

# --- 4. Configuration -----------------------------------------------------
# A token already on the box wins over an empty environment, so re-running this to change the
# branch or the mode does not silently blank the credential and stop deploys.
TOKEN="${FAPOMS_GH_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$CONF" ]; then
  TOKEN="$(sed -n 's/^FAPOMS_GH_TOKEN=//p' "$CONF" | tr -d '"' | head -1)"
fi
# Optional, despite what the CI gate's failure modes suggest. CipherCosmos/fapoms is public, so
# the check-runs call works unauthenticated; a token only lifts the API rate limit from 60
# requests an hour to 5000. That ceiling is worth knowing about because the gate re-checks on
# every tick for as long as the branch head does not move — a commit left failing costs 30
# requests an hour from this box, and the anonymous limit counts per source IP, not per repo.
if [ -z "$TOKEN" ]; then
  echo "==> no FAPOMS_GH_TOKEN: the CI gate will query GitHub anonymously (60 req/hr per IP)."
  echo "    Fine while the repo is public. Set one if it is ever made private, or if the log"
  echo "    starts reporting HTTP 403."
fi

umask 077
cat > "$CONF" <<EOF
# Written by deploy/aws/install-auto-deploy.sh. Contains a token — not in git.
FAPOMS_BRANCH=$BRANCH
FAPOMS_REPO=$APP_DIR
FAPOMS_OPS_DIR=$OPS_DIR
FAPOMS_ENV_FILE=$ENV_FILE
FAPOMS_CONTAINER_CLI=docker
FAPOMS_COMPOSE_FILES="$COMPOSE_FILES"
FAPOMS_SOURCE_MOUNTED=$SOURCE_MOUNTED
FAPOMS_POST_RESET_HOOK=$HOOK
FAPOMS_HEALTH_URL=$HEALTH_URL
FAPOMS_GH_REPO=${FAPOMS_GH_REPO:-CipherCosmos/fapoms}
FAPOMS_GH_TOKEN=$TOKEN
EOF
chmod 600 "$CONF"
umask 022
echo "==> wrote $CONF (0600)"

# --- 5. Prove the gate can reach GitHub before enabling the timer ---------
# Every failure in the gate fails closed, which is correct and also completely silent from
# outside: the timer ticks, the log says REFUSING, and the box goes on serving the old build
# indefinitely. Two seconds of checking here turns that into an error someone is present to read.
SHA="$(git rev-parse HEAD)"
GH_AUTH=(); [ -n "$TOKEN" ] && GH_AUTH=(-H "Authorization: Bearer $TOKEN")
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "${GH_AUTH[@]}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${FAPOMS_GH_REPO:-CipherCosmos/fapoms}/commits/$SHA/check-runs" || echo 000)
case "$HTTP" in
  200) echo "==> CI gate endpoint reachable${TOKEN:+ (token accepted)}" ;;
  404) echo "!! GitHub returned 404 for ${FAPOMS_GH_REPO:-CipherCosmos/fapoms} at $SHA."
       echo "   Either the repo name is wrong, or it is private and needs FAPOMS_GH_TOKEN with"
       echo "   Contents: read + Actions: read. Fix, then re-run."; exit 1 ;;
  401|403) echo "!! GitHub returned $HTTP — token invalid/expired, or the anonymous rate limit is"
           echo "   exhausted. Set FAPOMS_GH_TOKEN and re-run."; exit 1 ;;
  *)   echo "!! GitHub returned HTTP $HTTP. Not enabling the timer against an unverified gate."; exit 1 ;;
esac

# --- 6. Units -------------------------------------------------------------
install -m 644 "$APP_DIR/deploy/aws/fapoms-deploy.service" "$UNIT_DIR/fapoms-deploy.service"
install -m 644 "$APP_DIR/deploy/aws/fapoms-deploy.timer"   "$UNIT_DIR/fapoms-deploy.timer"
systemctl daemon-reload
systemctl enable --now fapoms-deploy.timer
echo "==> timer enabled"

echo ""
echo "Auto-deploy is live: $BRANCH -> this box, checked every 2 minutes, CI-gated."
echo ""
echo "  watch:    tail -f $OPS_DIR/auto-deploy.log"
echo "  next run: systemctl list-timers fapoms-deploy.timer"
echo "  run now:  systemctl start fapoms-deploy.service"
echo "  stop:     systemctl disable --now fapoms-deploy.timer"
echo ""
echo "Emergency ship-without-CI (logged loudly, use once and stop):"
echo "  FAPOMS_SKIP_CI_GATE=1 $OPS_DIR/auto-deploy.sh"
