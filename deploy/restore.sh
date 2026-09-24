#!/usr/bin/env bash
#
# Restore a database dump, or prove one can be restored.
#
# The drill mode exists because an untested backup is not a backup, it is a belief about a file.
# The failure modes that matter — a dump truncated at 4GB, an extension the target cannot create,
# a role that does not exist on the restoring side — all produce a file that looks completely fine
# until the day someone needs it. Drill mode restores into a scratch database and throws it away,
# so the question gets answered on an ordinary Tuesday instead of during an outage.
#
# Usage:
#   ./restore.sh --drill                    # restore the newest dump to a scratch DB, verify, drop
#   ./restore.sh --drill <dump>             # same, for a specific dump
#   ./restore.sh --to-production <dump>     # the real thing. Asks first.
#
# Objects are not handled here. They are mirrored as plain files, so restoring them is
# `mc mirror` in the other direction — see DEPLOYMENT.md, which spells out the command rather
# than hiding it in a script nobody reads before running.
set -euo pipefail

REPO="${FAPOMS_REPO:-$HOME/apps/fapoms}"
ENVFILE="$REPO/.env.docker"
BACKUP_DIR="${FAPOMS_BACKUP_DIR:-$HOME/backups/fapoms}"

# Same resolution backup.sh and auto-deploy.sh use: an explicit FAPOMS_CONTAINER_CLI always wins,
# otherwise prefer podman when it is present. On the homeserver this still resolves to "podman",
# so that host's behaviour is unchanged; only a box with no podman (EC2) falls through to docker.
if [ -n "${FAPOMS_CONTAINER_CLI:-}" ]; then
  CLI="$FAPOMS_CONTAINER_CLI"
elif command -v podman >/dev/null 2>&1; then
  CLI=podman
else
  CLI=docker
fi

# resolve_container <default> <fixed-docker-name> <compose-service> — an explicit env override
# (passed in $1's name, see callers) always wins. Otherwise podman keeps the old hardcoded default
# unchanged, and docker asks the root compose file which container it made for that service,
# falling back to the fixed container_name it pins if compose cannot be asked.
resolve_container() {
  local override="$1" podman_default="$2" docker_fixed="$3" service="$4"
  if [ -n "$override" ]; then
    printf '%s' "$override"
    return
  fi
  case "$CLI" in
    podman) printf '%s' "$podman_default" ;;
    *)
      local cid name compose_file="$REPO/docker-compose.yml"
      if [ -r "$compose_file" ]; then
        cid=$(docker compose -f "$compose_file" ps -q "$service" 2>/dev/null || true)
        if [ -n "$cid" ]; then
          name=$(docker inspect -f '{{.Name}}' "$cid" 2>/dev/null | sed 's#^/##')
          [ -n "$name" ] && { printf '%s' "$name"; return; }
        fi
      fi
      printf '%s' "$docker_fixed"
      ;;
  esac
}
PG_CONTAINER="$(resolve_container "${FAPOMS_PG_CONTAINER:-}" deploy-postgres-1 fapoms-postgres postgres)"
BACKEND_CONTAINER="$(resolve_container "${FAPOMS_BACKEND_CONTAINER:-}" deploy-backend-1 fapoms-backend backend)"

[ -r "$ENVFILE" ] || { echo "no env file at $ENVFILE" >&2; exit 1; }
# shellcheck disable=SC1090
set -a; . "$ENVFILE"; set +a
: "${DB_USERNAME:?}"; : "${DB_DATABASE:?}"

MODE="${1:---drill}"
DUMP="${2:-$(ls -t "$BACKUP_DIR"/daily/db-*.dump 2>/dev/null | head -1)}"
[ -n "$DUMP" ] && [ -r "$DUMP" ] || { echo "no dump found — looked in $BACKUP_DIR/daily" >&2; exit 1; }

psql_q() { $CLI exec -i "$PG_CONTAINER" psql -U "$DB_USERNAME" -tAc "$1"; }

case "$MODE" in
  --drill)
    SCRATCH="fapoms_restore_drill_$$"
    echo "Restoring $(basename "$DUMP") ($(du -h "$DUMP" | cut -f1)) into $SCRATCH…"

    # Always dropped, including when the restore dies partway. A drill that leaves debris behind
    # gets run once and then avoided.
    trap '$CLI exec -i "$PG_CONTAINER" psql -U "$DB_USERNAME" -d postgres \
            -c "DROP DATABASE IF EXISTS $SCRATCH" >/dev/null 2>&1 || true' EXIT

    $CLI exec -i "$PG_CONTAINER" psql -U "$DB_USERNAME" -d postgres \
      -c "CREATE DATABASE $SCRATCH" >/dev/null

    # PostGIS, uuid-ossp and pg_trgm have to exist before the schema that depends on them. A fresh
    # database does not inherit them, and this is exactly the class of thing a drill catches.
    for ext in "uuid-ossp" postgis pg_trgm; do
      $CLI exec -i "$PG_CONTAINER" psql -U "$DB_USERNAME" -d "$SCRATCH" \
        -c "CREATE EXTENSION IF NOT EXISTS \"$ext\"" >/dev/null 2>&1 || true
    done

    # Warnings are expected and fine (extension objects already present); a nonzero exit is not.
    if ! $CLI exec -i "$PG_CONTAINER" \
        pg_restore -U "$DB_USERNAME" -d "$SCRATCH" --no-owner --no-acl --exit-on-error \
        < "$DUMP" 2>/tmp/restore-drill.err; then
      echo "RESTORE FAILED — this dump is not usable:" >&2
      tail -20 /tmp/restore-drill.err >&2
      exit 1
    fi

    TABLES=$($CLI exec -i "$PG_CONTAINER" psql -U "$DB_USERNAME" -d "$SCRATCH" -tAc \
      "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
    USERS=$($CLI exec -i "$PG_CONTAINER" psql -U "$DB_USERNAME" -d "$SCRATCH" -tAc \
      "SELECT count(*) FROM users" 2>/dev/null || echo '?')
    ASSIGNMENTS=$($CLI exec -i "$PG_CONTAINER" psql -U "$DB_USERNAME" -d "$SCRATCH" -tAc \
      "SELECT count(*) FROM assignments" 2>/dev/null || echo '?')

    echo "  tables:      $TABLES"
    echo "  users:       $USERS"
    echo "  assignments: $ASSIGNMENTS"
    # A dump that restores into an empty schema is a successful restore of nothing.
    [ "$TABLES" -ge 60 ] || { echo "DRILL FAILED — only $TABLES tables restored" >&2; exit 1; }
    echo "DRILL PASSED — $(basename "$DUMP") is restorable."
    ;;

  --to-production)
    echo "This REPLACES the live database '$DB_DATABASE' with $(basename "$DUMP")."
    echo "Everything written since that dump will be gone."
    read -r -p "Type the database name to confirm: " confirm
    [ "$confirm" = "$DB_DATABASE" ] || { echo "Aborted."; exit 1; }

    # Take a dump of what is about to be destroyed. Restores get run under pressure and the
    # decision to restore is sometimes the wrong one; this is the way back.
    SAFETY="$BACKUP_DIR/daily/pre-restore-$(date +%Y%m%d-%H%M%S).dump"
    echo "Saving current state to $(basename "$SAFETY")…"
    $CLI exec "$PG_CONTAINER" pg_dump -U "$DB_USERNAME" -d "$DB_DATABASE" -Fc --no-owner --no-acl > "$SAFETY"

    echo "Stopping backend so nothing writes mid-restore…"
    $CLI stop "$BACKEND_CONTAINER" >/dev/null 2>&1 || true

    $CLI exec -i "$PG_CONTAINER" psql -U "$DB_USERNAME" -d postgres \
      -c "DROP DATABASE IF EXISTS ${DB_DATABASE}_old" >/dev/null
    $CLI exec -i "$PG_CONTAINER" psql -U "$DB_USERNAME" -d postgres \
      -c "ALTER DATABASE $DB_DATABASE RENAME TO ${DB_DATABASE}_old" >/dev/null
    $CLI exec -i "$PG_CONTAINER" psql -U "$DB_USERNAME" -d postgres \
      -c "CREATE DATABASE $DB_DATABASE" >/dev/null

    for ext in "uuid-ossp" postgis pg_trgm; do
      $CLI exec -i "$PG_CONTAINER" psql -U "$DB_USERNAME" -d "$DB_DATABASE" \
        -c "CREATE EXTENSION IF NOT EXISTS \"$ext\"" >/dev/null 2>&1 || true
    done

    $CLI exec -i "$PG_CONTAINER" \
      pg_restore -U "$DB_USERNAME" -d "$DB_DATABASE" --no-owner --no-acl < "$DUMP"

    $CLI start "$BACKEND_CONTAINER" >/dev/null
    echo "Restored. The previous database is kept as ${DB_DATABASE}_old — drop it once you are satisfied."
    ;;

  *)
    echo "usage: $0 [--drill [dump] | --to-production <dump>]" >&2
    exit 1
    ;;
esac
