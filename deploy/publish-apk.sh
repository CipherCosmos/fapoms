#!/usr/bin/env bash
#
# Point the stable download link at a build.
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
#
# RUNS ON ANY HOST THE STACK RUNS ON. It used to hardcode the homeserver — `podman`, and paths
# under ~/apps/fapoms — so on a developer machine it failed at the first compose call, after
# having already written the snippet. Everything below is now derived from the script's own
# location and from the SAME env file compose reads, which resolves to the identical paths on the
# homeserver and needs no per-host configuration anywhere.
set -euo pipefail

# --- where everything is, worked out rather than assumed --------------------------------------
HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd -- "$HERE/.." && pwd)
# auto-deploy.sh installs a copy of this script into the ops directory (~/apps/fapoms-ops), where
# "one level up" is ~/apps and not a checkout — that copy died on a download directory it could not
# find. Outside a checkout, resolve the repository the same way auto-deploy.sh does.
[ -f "$REPO/deploy/docker-compose.prod.yml" ] || REPO="${FAPOMS_REPO:-$HOME/apps/fapoms}"
COMPOSE="${COMPOSE:-$REPO/deploy/docker-compose.prod.yml}"
ENVFILE="${ENVFILE:-$REPO/.env.docker}"

# podman on the homeserver, docker on a developer machine. Whichever is present drives the same
# compose file. Guessing wrong is not a loud failure — it is a restart that silently never
# happens, leaving the old redirect live while the log says the publish succeeded.
ENGINE="${CONTAINER_ENGINE:-}"
if [ -z "$ENGINE" ]; then
  for candidate in podman docker; do
    command -v "$candidate" >/dev/null 2>&1 && { ENGINE=$candidate; break; }
  done
fi
[ -n "$ENGINE" ] || { echo "neither podman nor docker is on PATH" >&2; exit 1; }

# The directory compose mounts into caddy. Read from the same env file compose reads when the
# caller has not exported it — this script and compose disagreeing about where downloads live is
# exactly the bug that once wrote the snippet and the APK where caddy was not looking. The literal
# default below must stay in step with docker-compose.prod.yml's default for the same variable.
if [ -z "${APK_DIR:-}" ] && [ -f "$ENVFILE" ]; then
  APK_DIR=$(sed -n 's/^APK_DIR=//p' "$ENVFILE" | tail -1)
fi
APK_DIR="${APK_DIR:-/srv/fapoms-downloads}"
[ -d "$APK_DIR" ] || { echo "download directory does not exist: $APK_DIR" >&2; exit 1; }

SNIPPET="$APK_DIR/apk-redirect.caddy"

# The journal lives in the ops directory on the homeserver, deliberately outside the repo.
# Anywhere else it sits beside the downloads it describes (that directory ignores it, so a
# developer machine does not end up offering to commit its own publish history).
LOG="${PUBLISH_APK_LOG:-}"
if [ -z "$LOG" ]; then
  if [ -d "$HOME/apps/fapoms-ops" ]; then LOG="$HOME/apps/fapoms-ops/publish-apk.log"
  else LOG="$APK_DIR/publish-apk.log"; fi
fi
mkdir -p "$(dirname "$LOG")"

# coreutils on Linux, BSD on macOS. Only ever used to journal which file was published.
checksum() {
  if command -v md5sum >/dev/null 2>&1; then md5sum "$1" | cut -c1-32
  else md5 -q "$1" | cut -c1-32; fi
}

# `date -Is` is GNU-only; BSD date (macOS) rejects it and the journal line loses its timestamp —
# which is the one thing the journal exists to record. This spelling is ISO-8601 on both.
log() { printf '%s  %s\n' "$(date +%Y-%m-%dT%H:%M:%S%z)" "$*" | tee -a "$LOG"; }

[ $# -eq 1 ] || { echo "usage: $0 <EAS artifact URL | local .apk path>" >&2; exit 2; }
TARGET=$1

write_snippet() {
  # WRITTEN IN PLACE, NOT REPLACED. This used to be a write-to-temp plus `mv -f`, for atomicity.
  #
  # That breaks the deployment. Compose bind-mounts this single FILE into the caddy container, and
  # a single-file bind mount is bound to the INODE. `mv` gives the path a new inode, so the
  # container is left holding the old one — or, as actually observed on 2026-09-21, holding
  # nothing at all: `/etc/caddy/apk-redirect.caddy` simply vanished inside a running container
  # while the host file sat there perfectly readable. The Caddyfile `import`s that path, and an
  # import of a missing file is a hard adapt error, so the next config load fails. The publish is
  # refused by the check below (which is the guard working), but the deployment is then one
  # unrelated caddy restart away from the proxy refusing to come up at all.
  #
  # It survived a first `mv` and not a second, so this is not a property to rely on either way.
  # Truncating and rewriting the existing inode keeps the mount intact on every host and engine.
  # The atomicity being given up buys nothing here: nothing reads this file concurrently — the
  # only readers are the `caddy validate` and the container start below, both of which we trigger
  # ourselves, after this returns.
  #
  # 302, not 301: browsers and Android cache a permanent redirect aggressively, and the whole
  # reason this is a redirect is that the target CHANGES with every release.
  # 'temporary' + 'redir' is Caddy's spelling of that.
  #
  # The explicit `*` matcher is load-bearing. Caddy reads a first argument that starts with `/`
  # as a PATH MATCHER, so `redir /download/x.apk temporary` meant "redirect requests for
  # /download/x.apk to the URL 'temporary'" — it never matched /download/app.apk, and the stable
  # link answered an empty 200 on every local-file publish (2026-09-23). A URL target starts with
  # `https://` and happened to parse correctly, which is why EAS publishes never showed it.
  printf 'redir * %s temporary\n' "$1" > "$SNIPPET"
}

restart_caddy() {
  # Validate first: a snippet caddy rejects would take the proxy down, and the proxy is the only
  # way into this deployment. `admin off` in the Caddyfile rules out a live reload, and a
  # container restart is about a second — the same call auto-deploy.sh makes.
  if "$ENGINE" compose -f "$COMPOSE" --env-file "$ENVFILE" exec -T caddy \
       caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
    "$ENGINE" compose -f "$COMPOSE" --env-file "$ENVFILE" up -d --force-recreate caddy >/dev/null 2>&1
  else
    echo "REFUSING: caddy rejected the new config; leaving the running one in place." >&2
    exit 1
  fi
}

case "$TARGET" in
  http://*|https://*)
    # PUBLISH THE STABLE URL, NOT THE ONE A DOWNLOAD RESOLVED TO.
    #
    # `https://expo.dev/artifacts/eas/<hash>.apk` is permanent and mints a fresh presigned S3 link
    # on every request. That presigned link — `https://wf-artifacts.eascdn.net/...?X-Amz-Expires=900`
    # — is what a browser's address bar or download history shows, and it is dead 15 minutes later.
    # Publishing it looks perfectly healthy here (it HEADs fine, the probe below answers 302) and
    # then hands every appraiser a broken download for the rest of the release. Warns rather than
    # refuses: the markers below are a shape, not a rule, and a legitimate target this script
    # cannot foresee — a self-hosted artifact store, say — must not be blocked by a guess.
    case "$TARGET" in
      *X-Amz-Expires=*|*wf-artifacts.eascdn.net*)
        echo "WARNING: that looks like a PRESIGNED artifact link, which expires in minutes." >&2
        echo "         Publish the stable https://expo.dev/artifacts/eas/<hash>.apk URL instead" >&2
        echo "         (eas build:view <id> --json → .artifacts.applicationArchiveUrl)." >&2
        ;;
    esac
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
    log "published local file -> /download/$NAME ($(checksum "$APK_DIR/$NAME"))"
    ;;
  *)
    echo "not a URL or a .apk: $TARGET" >&2; exit 2 ;;
esac

# Prove the stable link answers, from the box's own front door.
PROBE="${PUBLISH_APK_PROBE:-http://127.0.0.1:8080/download/app.apk}"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$PROBE" || true)
case "$STATUS" in
  # A redirect is the only right answer: the handler serves nothing itself, so a 200 means the
  # snippet did not take effect and the link hands out an empty body.
  302|301) log "stable link answers $STATUS — done" ;;
  *) log "WARNING: stable link answered '$STATUS' after publish"; exit 1 ;;
esac
