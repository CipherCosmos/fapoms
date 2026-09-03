#!/usr/bin/env bash
# =============================================================================
# FAPOMS - install (or re-install) the auto-deploy timer on the HOMESERVER.
#
# The homeserver follows `main`. The AWS box follows `test` and has its own installer at
# deploy/aws/install-auto-deploy.sh — same script underneath, different branch and runtime.
#
# Rootless podman, so this runs as the ordinary user and installs USER units. It needs no sudo
# and must not be given any: units placed in /etc/systemd/system would run as root and could not
# reach this user's podman socket.
#
#   bash ~/apps/fapoms/deploy/install-auto-deploy.sh
#
# Options (environment):
#   BRANCH=main              branch to follow                 (default: main)
#   APP_DIR=~/apps/fapoms    the checkout                     (default: ~/apps/fapoms)
#   OPS_DIR=~/apps/fapoms-ops  where the scripts run from     (default: ~/apps/fapoms-ops)
#   FAPOMS_GH_TOKEN=...      optional; only raises the GitHub API rate limit
#   FORCE=1                  proceed even though tracked files are locally modified
#
# Re-runnable, and safe on a box where this is already running: an existing token is preserved,
# and re-installing the units does not interrupt an in-flight deploy.
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/apps/fapoms}"
OPS_DIR="${OPS_DIR:-$HOME/apps/fapoms-ops}"
BRANCH="${BRANCH:-main}"
CONF="$HOME/.config/fapoms/deploy.env"
UNIT_DIR="$HOME/.config/systemd/user"

[ "$(id -u)" -ne 0 ] || { echo "Do NOT run this as root — rootless podman lives in the user session."; exit 1; }
[ -d "$APP_DIR/.git" ] || { echo "No git checkout at $APP_DIR."; exit 1; }

echo "==> installing auto-deploy  [branch=$BRANCH, repo=$APP_DIR]"

# --- 1. Dependencies ------------------------------------------------------
# jq is what the CI gate parses check runs with; without it the gate refuses on every tick, and
# the only trace is a log line nobody is watching two minutes later.
MISSING=()
for c in git curl jq podman; do command -v "$c" >/dev/null || MISSING+=("$c"); done
if [ "${#MISSING[@]}" -gt 0 ]; then
  echo "!! Missing: ${MISSING[*]}"
  echo "   Installing needs root, which this script deliberately does not take. Run:"
  echo "     sudo dnf install -y ${MISSING[*]}"
  exit 1
fi

# --- 2. Point the checkout at the branch ----------------------------------
cd "$APP_DIR"
git fetch -q origin "$BRANCH"

# Every deploy begins with `git reset --hard`, so anything locally modified here is on a countdown
# whether this script mentions it or not. Say what will be lost while it can still be saved.
DIRTY="$(git status --porcelain --untracked-files=no)"
if [ -n "$DIRTY" ] && [ "${FORCE:-0}" != "1" ]; then
  echo ""
  echo "!! Tracked files are locally modified in $APP_DIR:"
  echo "$DIRTY" | sed 's/^/     /'
  echo ""
  echo "   Auto-deploy resets hard onto origin/$BRANCH, so the next deploy discards these."
  echo "   Save anything real, then re-run with FORCE=1."
  exit 1
fi

git checkout -B "$BRANCH" "origin/$BRANCH"
echo "==> $APP_DIR now on $BRANCH at $(git rev-parse --short HEAD)"
# No safe.directory registration needed here, unlike the AWS installer: this runs as the user that
# owns the checkout and installs USER units, so the service and the repository share an owner.

# --- 3. The scripts, outside the checkout ---------------------------------
# They cannot run from inside $APP_DIR: `git reset --hard` rewrites files there while bash is
# still reading the script it is executing, and it would resume in the middle of a different file.
mkdir -p "$OPS_DIR"
for f in auto-deploy.sh backup.sh restore.sh publish-apk.sh; do
  [ -f "$APP_DIR/deploy/$f" ] && install -m 755 "$APP_DIR/deploy/$f" "$OPS_DIR/$f"
done
echo "==> scripts installed in $OPS_DIR"

# --- 4. Configuration (optional on this host) -----------------------------
# Unlike the AWS box, every value here is already the script's default. The file is written
# anyway so that "what does this box deploy?" has a written answer rather than an implied one.
TOKEN="${FAPOMS_GH_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$CONF" ]; then
  TOKEN="$(sed -n 's/^FAPOMS_GH_TOKEN=//p' "$CONF" | tr -d '"' | head -1)"
fi
mkdir -p "$(dirname "$CONF")"
umask 077
cat > "$CONF" <<EOF
# Written by deploy/install-auto-deploy.sh. May contain a token — not in git.
FAPOMS_BRANCH=$BRANCH
FAPOMS_REPO=$APP_DIR
FAPOMS_OPS_DIR=$OPS_DIR
FAPOMS_GH_REPO=${FAPOMS_GH_REPO:-CipherCosmos/fapoms}
FAPOMS_GH_TOKEN=$TOKEN
EOF
chmod 600 "$CONF"
umask 022
echo "==> wrote $CONF (0600)"
[ -n "$TOKEN" ] || echo "    (no token: the CI gate queries GitHub anonymously, 60 req/hr per IP — fine while the repo is public)"

# --- 5. Prove the gate can reach GitHub before enabling the timer ---------
# Every failure in the gate fails closed, which is correct and also completely silent from
# outside: the timer ticks, the log says REFUSING, and the box serves the old build indefinitely.
SHA="$(git rev-parse HEAD)"
GH_AUTH=(); [ -n "$TOKEN" ] && GH_AUTH=(-H "Authorization: Bearer $TOKEN")
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "${GH_AUTH[@]}" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/${FAPOMS_GH_REPO:-CipherCosmos/fapoms}/commits/$SHA/check-runs" || echo 000)
case "$HTTP" in
  200) echo "==> CI gate endpoint reachable${TOKEN:+ (token accepted)}" ;;
  404) echo "!! GitHub returned 404 for ${FAPOMS_GH_REPO:-CipherCosmos/fapoms} at $SHA."
       echo "   Wrong repo name, or it is private and needs FAPOMS_GH_TOKEN."; exit 1 ;;
  401|403) echo "!! GitHub returned $HTTP — token invalid/expired, or the anonymous rate limit is"
           echo "   exhausted. Set FAPOMS_GH_TOKEN and re-run."; exit 1 ;;
  *)   echo "!! GitHub returned HTTP $HTTP. Not enabling the timer against an unverified gate."; exit 1 ;;
esac

# --- 6. Units -------------------------------------------------------------
mkdir -p "$UNIT_DIR"
install -m 644 "$APP_DIR/deploy/fapoms-deploy.service" "$UNIT_DIR/fapoms-deploy.service"
install -m 644 "$APP_DIR/deploy/fapoms-deploy.timer"   "$UNIT_DIR/fapoms-deploy.timer"
systemctl --user daemon-reload
systemctl --user enable --now fapoms-deploy.timer

# The user session must survive logout or the timer stops with it. Already set on this host for
# the app itself; asserted here because a timer that only runs while someone is logged in is
# worse than no timer — it works whenever it is checked and stops whenever it is not.
if ! loginctl show-user "$USER" -p Linger --value 2>/dev/null | grep -qi yes; then
  echo "!! Lingering is OFF for $USER: the timer stops at logout."
  echo "   Fix with: loginctl enable-linger $USER"
fi
echo "==> timer enabled"

echo ""
echo "Auto-deploy is live: $BRANCH -> this box, checked every 2 minutes, CI-gated."
echo ""
echo "  watch:    tail -f $OPS_DIR/auto-deploy.log"
echo "  next run: systemctl --user list-timers fapoms-deploy.timer"
echo "  run now:  systemctl --user start fapoms-deploy.service"
echo "  stop:     systemctl --user disable --now fapoms-deploy.timer"
