#!/usr/bin/env bash
#
# Point the stable download link at a build. Run ON the homeserver.
#
#   publish-apk.sh <EAS artifact URL | local .apk path>
#
# The stable link (https://<host>/download/app.apk) is a Caddy redirect, not a file served from
# this box — see the Caddyfile for the measurements behind that. This script is how the target
# of that redirect changes, and it deliberately makes the fast path the easy path:
#
#   URL   → writes the redirect and restarts caddy. Takes a second. Nothing is transferred:
#           EAS already hosts the finished APK on a CDN, and the whole point is that the file
#           never has to cross this machine's ~9 KB/s upload line to be handed out.
#   FILE  → copies the file into the download directory, points the redirect at the local
#           /download/<name> path, restarts caddy. The fallback for a build not on EAS.
#
# Every publish is journalled to publish-apk.log so "which build did people actually install
# on <date>" always has an answer.
set -euo pipefail

APK_DIR="${APK_DIR:-/home/shivam/fapoms-downloads}"
COMPOSE=~/apps/fapoms/deploy/docker-compose.prod.yml
ENVFILE=~/apps/fapoms/.env.docker
LOG=~/apps/fapoms-ops/publish-apk.log
SNIPPET="$APK_DIR/apk-redirect.caddy"

log() { printf '%s  %s\n' "$(date -Is)" "$*" | tee -a "$LOG"; }

[ $# -eq 1 ] || { echo "usage: $0 <EAS artifact URL | local .apk path>" >&2; exit 2; }
TARGET=$1

write_snippet() {
  # 302, not 301: browsers and Android cache a permanent redirect aggressively, and the whole
  # reason this is a redirect is that the target CHANGES with every release.
  # 'temporary' + 'redir' is Caddy's spelling of that.
  local tmp="$SNIPPET.tmp"
  printf 'redir %s temporary\n' "$1" > "$tmp"
  mv -f "$tmp" "$SNIPPET"   # atomic: caddy never sees a half-written file
}

restart_caddy() {
  # Validate first: a snippet caddy rejects would take the proxy down, and the proxy is the only
  # way into this deployment. `admin off` in the Caddyfile rules out a live reload, and a
  # container restart is about a second — the same call auto-deploy.sh makes.
  if podman compose -f "$COMPOSE" --env-file "$ENVFILE" exec -T caddy \
       caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    podman compose -f "$COMPOSE" --env-file "$ENVFILE" up -d --force-recreate caddy >/dev/null 2>&1
  else
    echo "REFUSING: caddy rejected the new config; leaving the running one in place." >&2
    exit 1
  fi
}

case "$TARGET" in
  http://*|https://*)
    # A quick, cheap sanity check on the URL — HEAD only, follows redirects, no download.
    # Catches a typo before it is published to every phone; does not try to be a full validator.
    if ! curl -fsSIL --max-time 20 "$TARGET" -o /dev/null; then
      echo "REFUSING: $TARGET did not answer a HEAD request. Not publishing." >&2
      exit 1
    fi
    write_snippet "$TARGET"
    restart_caddy
    log "published redirect -> $TARGET"
    ;;
  *.apk)
    [ -f "$TARGET" ] || { echo "no such file: $TARGET" >&2; exit 1; }
    NAME=$(basename "$TARGET")
    [ "$(realpath "$TARGET")" = "$(realpath "$APK_DIR/$NAME" 2>/dev/null)" ] || cp -f "$TARGET" "$APK_DIR/$NAME"
    write_snippet "/download/$NAME"
    restart_caddy
    log "published local file -> /download/$NAME ($(md5sum "$APK_DIR/$NAME" | cut -c1-32))"
    ;;
  *)
    echo "not a URL or a .apk: $TARGET" >&2; exit 2 ;;
esac

# Prove the stable link answers, from the box's own front door.
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:8080/download/app.apk || true)
case "$STATUS" in
  302|301|200) log "stable link answers $STATUS — done" ;;
  *) log "WARNING: stable link answered '$STATUS' after publish"; exit 1 ;;
esac
