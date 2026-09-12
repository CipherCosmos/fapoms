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
# WHERE IT WRITES. Dumps land in ~/backups/fapoms/daily on the host (override with
# FAPOMS_BACKUP_DIR); objects mirror into ~/backups/fapoms/objects. Nothing is written to the
# `deploy_backupsdata` podman volume — that volume belongs to the data-reset danger zone's
# on-demand snapshots (backend infrastructure/data-reset/backup-on-demand.service.ts), a different
# feature with a different retention. Looking in that volume for a nightly dump finds a stale file
# and no trace of this script, which is exactly how a working backup gets reported as broken.
#
# IT SAYS WHAT IT DID. Every line goes to stdout as well as to the log, and the last line names
# the dump it wrote. Silence at the prompt means this script did not run. Any failure exits
# non-zero and names what failed on stderr — a run that ends without a dump can never exit 0.
#
# WHAT THIS DOES NOT PROTECT AGAINST. By default the copies land on the same machine, on /home.
# That covers a bad migration, a dropped table, an accidental delete, a corrupted volume — the
# things that actually happen most weeks. It does NOT cover loss of the machine or its disk. For
# that the copies have to leave the building; set FAPOMS_OFFSITE_REMOTE (see below) and they will.
#
# Usage:
#   ./backup.sh                 # run a backup now
#   ./backup.sh --help
#   FAPOMS_BACKUP_DIR=/srv/fapoms-backups ./backup.sh
#
# Environment:
#   FAPOMS_BACKUP_DIR       where backups live (default ~/backups/fapoms)
#   FAPOMS_BACKUP_LOG       the history file (default ~/apps/fapoms-ops/backup.log)
#   FAPOMS_REPO             checkout holding .env.docker (default ~/apps/fapoms)
#   FAPOMS_PG_CONTAINER     Postgres container name (default deploy-postgres-1)
#   FAPOMS_NETWORK          podman network the object store is on (default deploy_default)
#   FAPOMS_OFFSITE_REMOTE   an rclone remote, e.g. "b2:fapoms-backups". When set and rclone is
#                           installed, every run syncs there afterwards. Unset = local only, and
#                           the log says so on every run rather than letting it be forgotten.
#
# set -E so the ERR trap below also fires inside functions and subshells: this script's one
# unbreakable promise is that it never exits 0 without a verified dump, and an untrapped `set -e`
# exit is silent and indistinguishable from success at the prompt.
set -Eeuo pipefail

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

usage() {
  cat <<'USAGE'
backup.sh — dump the FAPOMS database and mirror the stored documents.

  ./backup.sh          run a backup now
  ./backup.sh --help   this text

Writes to ~/backups/fapoms (FAPOMS_BACKUP_DIR): daily/db-<stamp>.dump plus an append-only
objects/ mirror. Prints what it did; appends the same lines to ~/apps/fapoms-ops/backup.log.
Exits 0 only after the dump it wrote has been read back and verified. Any other outcome
exits non-zero and says why.

Prove a dump restores with:  deploy/restore.sh --drill
USAGE
}

case "${1:-}" in
  -h|--help) usage; exit 0 ;;
  '') ;;
  *) printf 'backup.sh: unknown argument "%s" — try --help\n' "$1" >&2; exit 2 ;;
esac

# ------------------------------------------------------------------------------------------------
# Talking
# ------------------------------------------------------------------------------------------------
# Two channels, on purpose. stdout is what a person sees when they run this by hand — and what
# journald captures under the timer. The log file is the history. A message that reaches only the
# file is a message the operator does not get, which is how this script came to be believed broken
# while it was in fact writing a good dump every night.
#
# The log append is best-effort: an unwritable log must not be able to swallow a failure message,
# and must not recurse back through this same function.
_emit() {
  local line
  line="$(date -Is)  $*"
  printf '%s\n' "$line" >>"$LOG" 2>/dev/null || true
  printf '%s\n' "$line"
}
say()  { _emit "$*"; }
warn() { _emit "WARNING: $*" >&2; }
die()  { _emit "FAILED: $*" >&2; exit 1; }

# The useful tail of a captured stderr file, for pasting into a failure message.
#
# podman prints its own warnings (a storage-driver mismatch, on this host) to stderr on every
# single invocation. Left in, they crowd out the one line that says what actually failed and eat
# the whole character budget of the message the operator reads. Filter them, keep the last few
# real lines, and fall back to the raw text if filtering left nothing.
last_error() {
  local text
  text=$(grep -vE '^time="[^"]*" level=(error|warning|info)' "$1" 2>/dev/null | grep -v '^[[:space:]]*$' | tail -3 | tr '\n' ' ' || true)
  [ -n "$text" ] || text=$(tr '\n' ' ' <"$1" 2>/dev/null | tail -c 300 || true)
  printf '%s' "${text:0:300}"
}

# The net under every step that has no explicit `|| die` of its own — a failed mkdir, cp, mv or
# command substitution. Without it those exit silently with a non-zero status and no explanation.
# Deliberately reports the line only, never the command text: this script handles object-store
# credentials, and a trap that echoed commands would put them in the log.
trap 'die "unexpected error at line $LINENO — nothing further was attempted"' ERR

PARTIAL=''
SCRATCH=''
KEPT=''
cleanup() {
  # Runs on every exit, including a failed one, so it disarms the ERR trap first: an error raised
  # in here would re-enter die() and print a second, misleading FAILED line over the real one.
  trap - ERR
  # A dump that was never verified must not survive this script. restore.sh picks the newest
  # daily/db-*.dump, so a half-written file left in that directory is a restore waiting to fail.
  if [ -n "$PARTIAL" ] && [ -f "$PARTIAL" ]; then rm -f "$PARTIAL"; fi
  if [ -n "$SCRATCH" ] && [ -d "$SCRATCH" ]; then rm -rf "$SCRATCH"; fi
  return 0
}
trap cleanup EXIT

# ------------------------------------------------------------------------------------------------
# Preflight — every check names the thing that is wrong and the knob that fixes it
# ------------------------------------------------------------------------------------------------
mkdir -p "$(dirname "$LOG")" 2>/dev/null || die "cannot create the log directory $(dirname "$LOG") (set FAPOMS_BACKUP_LOG)"
mkdir -p "$BACKUP_DIR"/{daily,monthly,objects} 2>/dev/null || die "cannot create the backup directories under $BACKUP_DIR (set FAPOMS_BACKUP_DIR)"
[ -w "$BACKUP_DIR/daily" ] || die "backup directory $BACKUP_DIR/daily is not writable by $(id -un)"

command -v podman >/dev/null 2>&1 || die "podman is not on PATH — this script dumps from the deployment's containers"

[ -r "$ENVFILE" ] || die "no readable env file at $ENVFILE (set FAPOMS_REPO if the checkout is elsewhere)"
# shellcheck disable=SC1090
set -a; . "$ENVFILE" || die "could not read $ENVFILE — check that it parses as shell"; set +a

[ -n "${DB_USERNAME:-}" ] || die "DB_USERNAME is missing from $ENVFILE — no role to dump as"
[ -n "${DB_DATABASE:-}" ] || die "DB_DATABASE is missing from $ENVFILE — no database named to dump"

podman container exists "$PG_CONTAINER" \
  || die "no container named $PG_CONTAINER — is the deployment up? (set FAPOMS_PG_CONTAINER)"
[ "$(podman inspect -f '{{.State.Running}}' "$PG_CONTAINER" 2>/dev/null || echo false)" = "true" ] \
  || die "container $PG_CONTAINER exists but is not running — start the deployment before backing up"

# One backup at a time. The nightly timer and an operator taking a pre-migration dump by hand can
# land together; two runs would race on the object mirror and on the retention prune.
LOCKFILE="$BACKUP_DIR/.backup.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCKFILE" || die "cannot open the lock file $LOCKFILE"
  flock -n 9 || die "another backup is already running (lock: $LOCKFILE) — refusing to run two at once"
fi

STAMP=$(date +%Y%m%d-%H%M%S)
DUMP="$BACKUP_DIR/daily/db-$STAMP.dump"
PARTIAL="$DUMP.partial"
REJECTED="$BACKUP_DIR/daily/db-$STAMP.rejected"
SCRATCH=$(mktemp -d) || die "cannot create a temporary directory"
ERRFILE="$SCRATCH/stderr"

say "=== backup start ==="

# ------------------------------------------------------------------------------------------------
# 1. Database
# ------------------------------------------------------------------------------------------------
# Ask the live database what the dump ought to contain, BEFORE taking it. A count captured first
# cannot be inflated by tables a deploy creates while the dump runs, and a floor that the database
# supplies cannot go stale the way a number written into this file does — the previous fixed floor
# of 20 was set when this schema had far fewer tables, and by now a dump containing a fifth of the
# database would have sailed past it.
#
# Extension-owned tables are excluded because pg_dump does not dump them; the one exception,
# PostGIS's spatial_ref_sys, is dumped as extension config data and so only ever makes the archive
# larger than this count. The comparison below is therefore ">=", never "==".
psql_scalar() {
  podman exec "$PG_CONTAINER" psql -U "$DB_USERNAME" -d "$DB_DATABASE" -tAc "$1" 2>"$ERRFILE" | tr -d '[:space:]'
}
EXPECTED_TABLES=$(psql_scalar "
  SELECT count(*) FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')") \
  || die "could not query $DB_DATABASE as $DB_USERNAME in $PG_CONTAINER: $(last_error "$ERRFILE")"

case "$EXPECTED_TABLES" in
  ''|*[!0-9]*) die "could not read a table count from $DB_DATABASE — refusing to take a dump with nothing to check it against" ;;
esac
[ "$EXPECTED_TABLES" -gt 0 ] || die "$DB_DATABASE reports zero tables in public — refusing to call an empty dump a backup"

podman exec "$PG_CONTAINER" \
  pg_dump -U "$DB_USERNAME" -d "$DB_DATABASE" -Fc --no-owner --no-acl \
  > "$PARTIAL" 2>"$ERRFILE" \
  || die "pg_dump of $DB_DATABASE as $DB_USERNAME failed: $(last_error "$ERRFILE")"
[ -s "$PARTIAL" ] || die "pg_dump exited 0 but wrote an empty file — no dump was produced"

# Verify the dump rather than trusting that pg_dump exited zero.
#
# A dump truncated by a full disk still leaves a plausible-looking file behind, and the failure
# would not be discovered until someone needed it — which is the worst possible moment to discover
# it. `pg_restore --list` parses the archive's table of contents, so it fails loudly on a
# truncated or corrupt file, and the table count gives a second check on top of that.
#
# Run inside the container: Postgres lives there, so the host has no pg_restore to call. The exit
# status is checked in its own right; it used to be discarded, which left the count as the only
# thing standing between a corrupt archive and a run that reported success.
#
# A dump that fails either check is set aside under a name that neither this script nor restore.sh
# will ever pick up again, and the operator is told where it is. Deleting it would throw away the
# only evidence of what went wrong.
set_aside() {
  if mv "$PARTIAL" "$REJECTED" 2>/dev/null; then
    KEPT="kept for inspection at $REJECTED"
    PARTIAL=''
  else
    KEPT="and could not even be set aside for inspection"
  fi
}
if ! TOC=$(podman exec -i "$PG_CONTAINER" pg_restore --list < "$PARTIAL" 2>"$ERRFILE"); then
  set_aside
  die "the file pg_dump wrote is not a readable Postgres archive (pg_restore --list failed): $(last_error "$ERRFILE") — $KEPT"
fi

TOC_TABLES=$(printf '%s\n' "$TOC" | grep -c ' TABLE DATA public ' || true)
if [ "${TOC_TABLES:-0}" -lt "$EXPECTED_TABLES" ]; then
  set_aside
  die "dump verification failed: the archive carries data for $TOC_TABLES tables but public held $EXPECTED_TABLES when the dump started — $KEPT"
fi

mv "$PARTIAL" "$DUMP" || die "could not move the verified dump into place at $DUMP"
PARTIAL=''
DUMP_SIZE=$(du -h "$DUMP" | cut -f1)
say "database: $DUMP ($DUMP_SIZE) — verified, $TOC_TABLES tables of data against $EXPECTED_TABLES live"

# ------------------------------------------------------------------------------------------------
# 2. Objects (scanned returns and every other stored document)
# ------------------------------------------------------------------------------------------------
BUCKET="${S3_BUCKET_NAME:-fapoms-documents}"
if [ -n "${MINIO_ROOT_USER:-}" ] && [ -n "${MINIO_ROOT_PASSWORD:-}" ]; then
  # Credentials go in as environment variables and the alias is set inside the container, rather
  # than being written into a URL — a password with a '@' or '/' in it silently corrupts a
  # credential URL, and this one is 40 characters of generated noise.
  #
  # The object count comes back on a sentinel line from the same container run, so the mirror can
  # be checked against the bucket instead of assumed. mc's own chatter goes to the log.
  MCOUT="$SCRATCH/mc.out"
  podman run --rm --network "$NETWORK" \
    -v "$BACKUP_DIR/objects:/backup:z" \
    -e MC_USER="$MINIO_ROOT_USER" -e MC_PASS="$MINIO_ROOT_PASSWORD" \
    --entrypoint /bin/sh "$MC_IMAGE" -c \
    "mc alias set src http://minio:9000 \"\$MC_USER\" \"\$MC_PASS\" >/dev/null && \
     mc mirror --overwrite src/$BUCKET /backup && \
     echo \"REMOTE_OBJECTS=\$(mc ls --recursive src/$BUCKET | wc -l)\"" >"$MCOUT" 2>&1 \
    || { cat "$MCOUT" >>"$LOG" 2>/dev/null || true
         die "mirroring bucket $BUCKET failed: $(last_error "$MCOUT")"; }
  cat "$MCOUT" >>"$LOG" 2>/dev/null || true

  REMOTE_OBJECTS=$(grep -o 'REMOTE_OBJECTS=[0-9]*' "$MCOUT" | tail -1 | cut -d= -f2 || true)
  LOCAL_OBJECTS=$(find "$BACKUP_DIR/objects" -type f | wc -l | tr -d ' ')
  case "${REMOTE_OBJECTS:-}" in
    ''|*[!0-9]*) die "mirrored bucket $BUCKET but could not count what is in it — the mirror cannot be called verified" ;;
  esac
  # The mirror is append-only, so it legitimately holds more than the bucket. Holding fewer means
  # objects the bucket has are not in the backup, which is the failure this check exists to catch.
  [ "$LOCAL_OBJECTS" -ge "$REMOTE_OBJECTS" ] \
    || die "object mirror is short: bucket $BUCKET holds $REMOTE_OBJECTS objects, $BACKUP_DIR/objects holds $LOCAL_OBJECTS"
  # Measured into a variable, not inside the message: a command substitution that fails inside an
  # argument fails only its own subshell, and this script must not be able to walk past an error.
  OBJECTS_SIZE=$(du -sh "$BACKUP_DIR/objects" | cut -f1)
  say "objects: $BACKUP_DIR/objects ($OBJECTS_SIZE, $LOCAL_OBJECTS files) — bucket $BUCKET holds $REMOTE_OBJECTS"
elif [ "${STORAGE_DRIVER:-local}" = "s3" ]; then
  # Half the irreplaceable data is in that bucket. Skipping it with a warning and then printing
  # "backup ok" is the script telling the operator something that is not true at the moment they
  # are relying on it most.
  die "STORAGE_DRIVER=s3 but MINIO_ROOT_USER/MINIO_ROOT_PASSWORD are absent from $ENVFILE — the scanned returns would not have been backed up. The database dump at $DUMP is good; the documents are not covered."
else
  warn "object storage is not configured here (STORAGE_DRIVER=${STORAGE_DRIVER:-local}) — documents were NOT backed up"
fi

# ------------------------------------------------------------------------------------------------
# 3. Retention
# ------------------------------------------------------------------------------------------------
# The first dump of each month is promoted before the nightly window prunes it away.
if [ "$(date +%d)" = "01" ] && [ ! -f "$BACKUP_DIR/monthly/db-$(date +%Y%m).dump" ]; then
  cp "$DUMP" "$BACKUP_DIR/monthly/db-$(date +%Y%m).dump" \
    || die "could not promote $DUMP into the monthly set"
  say "promoted to monthly: db-$(date +%Y%m).dump"
fi

PRUNED_DAILY=$(find "$BACKUP_DIR/daily" -name 'db-*.dump' -mtime "+$DAILY_KEEP_DAYS" -print -delete | wc -l | tr -d ' ')
# Rejected and half-written dumps age out on the same window. They are kept that long deliberately:
# a dump that failed verification is the evidence for why, and it is named so that neither this
# script nor restore.sh can ever mistake it for a usable backup.
PRUNED_BAD=$(find "$BACKUP_DIR/daily" \( -name 'db-*.rejected' -o -name 'db-*.dump.partial' \) -mtime "+$DAILY_KEEP_DAYS" -print -delete | wc -l | tr -d ' ')
PRUNED_MONTHLY=$(find "$BACKUP_DIR/monthly" -name 'db-*.dump' -mtime "+$MONTHLY_KEEP_DAYS" -print -delete | wc -l | tr -d ' ')
say "retention: pruned $PRUNED_DAILY nightly, $PRUNED_MONTHLY monthly, $PRUNED_BAD failed (keeping ${DAILY_KEEP_DAYS}d/${MONTHLY_KEEP_DAYS}d)"

# ------------------------------------------------------------------------------------------------
# 4. Off-site
# ------------------------------------------------------------------------------------------------
if [ -n "${FAPOMS_OFFSITE_REMOTE:-}" ]; then
  command -v rclone >/dev/null 2>&1 \
    || die "FAPOMS_OFFSITE_REMOTE is set to $FAPOMS_OFFSITE_REMOTE but rclone is not installed — the copies are still on this machine only"
  rclone sync "$BACKUP_DIR" "$FAPOMS_OFFSITE_REMOTE" --transfers 4 >>"$LOG" 2>&1 \
    || die "off-site sync to $FAPOMS_OFFSITE_REMOTE failed — the copies are still on this machine only"
  say "off-site: synced to $FAPOMS_OFFSITE_REMOTE"
else
  # Said out loud on every single run. A backup that only exists on the machine it is backing up
  # is one hardware fault away from being no backup, and that fact should never go quiet.
  say "NOTE: local only — set FAPOMS_OFFSITE_REMOTE for off-site copies"
fi

TOTAL_SIZE=$(du -sh "$BACKUP_DIR" | cut -f1)
say "=== backup ok — $DUMP ($DUMP_SIZE), $TOTAL_SIZE total in $BACKUP_DIR ==="
say "prove it restores: $REPO/deploy/restore.sh --drill"
