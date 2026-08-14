#!/usr/bin/env bash
#
# Nightly backup of everything that cannot be rebuilt from the repository.
#
# Two things here are irreplaceable, and they are irreplaceable in different ways. The database
# holds the audit record — who was assigned what, who checked in where, what was billed. The
# object store holds the scanned returns themselves, which are the evidence a bank collateral
# audit exists to produce. Losing either one loses the audit; losing them together loses the
# business. Everything else on this host — images, node_modules, the containers — is reproducible
# from a git clone and is deliberately not backed up.
#
# The database is captured as a point-in-time dump. `pg_dump -Fc` runs in a single transaction, so
# the dump is internally consistent even though the app is live while it runs.
#
# Objects are mirrored rather than snapshotted, and the mirror is append-only: `--remove` is
# deliberately not passed. Audit evidence is not supposed to be deleted, so a bucket that loses an
# object should not cause the backup to lose it too. The cost is that the mirror accumulates
# objects that were legitimately removed, which is the right way round for this data.
#
# WHAT THIS DOES NOT PROTECT AGAINST. By default the copies land on the same machine, on /home.
# That covers a bad migration, a dropped table, an accidental delete, a corrupted volume — the
# things that actually happen most weeks. It does NOT cover loss of the machine or its disk. For
# that the copies have to leave the building; set FAPOMS_OFFSITE_REMOTE (see below) and they will.
#
# Usage:
#   ./backup.sh                 # run a backup now
#   FAPOMS_BACKUP_DIR=/srv/fapoms-backups ./backup.sh
#
# Environment:
#   FAPOMS_BACKUP_DIR       where backups live (default ~/backups/fapoms)
#   FAPOMS_OFFSITE_REMOTE   an rclone remote, e.g. "b2:fapoms-backups". When set and rclone is
#                           installed, every run syncs there afterwards. Unset = local only, and
#                           the log says so on every run rather than letting it be forgotten.
set -euo pipefail

REPO="${FAPOMS_REPO:-$HOME/apps/fapoms}"
ENVFILE="$REPO/.env.docker"
BACKUP_DIR="${FAPOMS_BACKUP_DIR:-$HOME/backups/fapoms}"
LOG="${FAPOMS_BACKUP_LOG:-$HOME/apps/fapoms-ops/backup.log}"

PG_CONTAINER="${FAPOMS_PG_CONTAINER:-deploy-postgres-1}"
NETWORK="${FAPOMS_NETWORK:-deploy_default}"
MC_IMAGE="docker.io/minio/mc:latest"

# Keep two weeks of nightlies, and one dump per month for a year. A fault noticed late — a
# migration that quietly corrupted a column three weeks ago — needs something older than the
# nightly window to compare against.
DAILY_KEEP_DAYS=14
MONTHLY_KEEP_DAYS=365

mkdir -p "$(dirname "$LOG")" "$BACKUP_DIR"/{daily,monthly,objects}
log() { printf '%s  %s\n' "$(date -Is)" "$*" >> "$LOG"; }
die() { log "FAILED: $*"; exit 1; }

[ -r "$ENVFILE" ] || die "no env file at $ENVFILE"
# shellcheck disable=SC1090
set -a; . "$ENVFILE"; set +a

: "${DB_USERNAME:?DB_USERNAME missing from $ENVFILE}"
: "${DB_DATABASE:?DB_DATABASE missing from $ENVFILE}"

STAMP=$(date +%Y%m%d-%H%M%S)
DUMP="$BACKUP_DIR/daily/db-$STAMP.dump"

log "=== backup start ==="

# ---------------------------------------------------------------------------------------------
# 1. Database
# ---------------------------------------------------------------------------------------------
podman exec "$PG_CONTAINER" \
  pg_dump -U "$DB_USERNAME" -d "$DB_DATABASE" -Fc --no-owner --no-acl \
  > "$DUMP" 2>>"$LOG" || die "pg_dump failed"

# Verify the dump rather than trusting that pg_dump exited zero.
#
# A dump truncated by a full disk still leaves a plausible-looking file behind, and the failure
# would not be discovered until someone needed it — which is the worst possible moment to discover
# it. `pg_restore --list` parses the archive's table of contents, so it fails loudly on a
# truncated or corrupt file, and a table count gives a sanity floor on top of that.
#
# Run inside the container: Postgres lives there, so the host has no pg_restore to call.
TOC_LINES=$(podman exec -i "$PG_CONTAINER" pg_restore --list < "$DUMP" 2>/dev/null | grep -c 'TABLE DATA' || true)
[ "${TOC_LINES:-0}" -ge 20 ] || die "dump verification failed — only ${TOC_LINES:-0} tables in $DUMP"
log "database: $(du -h "$DUMP" | cut -f1), $TOC_LINES tables"

# ---------------------------------------------------------------------------------------------
# 2. Objects (scanned returns and every other stored document)
# ---------------------------------------------------------------------------------------------
if [ -n "${MINIO_ROOT_USER:-}" ] && [ -n "${MINIO_ROOT_PASSWORD:-}" ]; then
  BUCKET="${S3_BUCKET_NAME:-fapoms-documents}"
  # Credentials go in as environment variables and the alias is set inside the container, rather
  # than being written into a URL — a password with a '@' or '/' in it silently corrupts a
  # credential URL, and this one is 40 characters of generated noise.
  podman run --rm --network "$NETWORK" \
    -v "$BACKUP_DIR/objects:/backup:z" \
    -e MC_USER="$MINIO_ROOT_USER" -e MC_PASS="$MINIO_ROOT_PASSWORD" \
    --entrypoint /bin/sh "$MC_IMAGE" -c \
    "mc alias set src http://minio:9000 \"\$MC_USER\" \"\$MC_PASS\" >/dev/null && \
     mc mirror --overwrite src/$BUCKET /backup" >>"$LOG" 2>&1 \
    || die "object mirror failed"
  log "objects: $(du -sh "$BACKUP_DIR/objects" | cut -f1) in $(find "$BACKUP_DIR/objects" -type f | wc -l | tr -d ' ') files"
else
  log "WARNING: MinIO credentials absent — documents were NOT backed up"
fi

# ---------------------------------------------------------------------------------------------
# 3. Retention
# ---------------------------------------------------------------------------------------------
# The first dump of each month is promoted before the nightly window prunes it away.
if [ "$(date +%d)" = "01" ] && [ ! -f "$BACKUP_DIR/monthly/db-$(date +%Y%m).dump" ]; then
  cp "$DUMP" "$BACKUP_DIR/monthly/db-$(date +%Y%m).dump"
  log "promoted to monthly: db-$(date +%Y%m).dump"
fi

find "$BACKUP_DIR/daily"   -name 'db-*.dump' -mtime "+$DAILY_KEEP_DAYS"   -delete
find "$BACKUP_DIR/monthly" -name 'db-*.dump' -mtime "+$MONTHLY_KEEP_DAYS" -delete

# ---------------------------------------------------------------------------------------------
# 4. Off-site
# ---------------------------------------------------------------------------------------------
if [ -n "${FAPOMS_OFFSITE_REMOTE:-}" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone sync "$BACKUP_DIR" "$FAPOMS_OFFSITE_REMOTE" --transfers 4 >>"$LOG" 2>&1 \
      || die "off-site sync to $FAPOMS_OFFSITE_REMOTE failed"
    log "off-site: synced to $FAPOMS_OFFSITE_REMOTE"
  else
    die "FAPOMS_OFFSITE_REMOTE is set but rclone is not installed"
  fi
else
  # Said out loud on every single run. A backup that only exists on the machine it is backing up
  # is one hardware fault away from being no backup, and that fact should never go quiet.
  log "NOTE: local only — set FAPOMS_OFFSITE_REMOTE for off-site copies"
fi

log "=== backup ok — $(du -sh "$BACKUP_DIR" | cut -f1) total ==="
