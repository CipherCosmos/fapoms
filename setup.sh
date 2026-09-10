#!/usr/bin/env bash
#
# First-run setup. One command, any machine, no file in this repository needs editing.
#
#   ./setup.sh                                  # local, http://localhost:8080
#   ./setup.sh --public-url https://audit.example.com
#   ./setup.sh --dev                            # relax the production-only gates
#   ./setup.sh --data-residency IN              # declare where this is hosted (CERT-In / RBI)
#
# ─────────────────────────────────────────────────────────────────────────────────────────────
# WHY THIS EXISTS
#
# The documented setup was four manual steps, and three of them had a way to go wrong that gave
# no useful signal:
#
#   1. `cp .env.production.example .env.docker` and "fill it in" — a 38 KB template in which five
#      values are genuinely mandatory and the rest are tuning. The API refuses to start without
#      them (`assertProductionSafeConfig`), which is right, but the failure arrives after a build
#      and a container start rather than at the point of the mistake.
#
#   2. Remember `--env-file .env.docker` on EVERY compose command, for ever. Compose resolves
#      `${VAR}` from the shell or `--env-file`, never from a service's own `env_file:` entry. Miss
#      it once against the prod file and Postgres is recreated with the healthcheck `pg_isready -U`
#      and no username, which fails for ever, which blocks every container that waits on it. That
#      is not a hypothetical: it happened on this deployment and took the API down until it was
#      diagnosed. Miss it against the DEV file and nothing complains at all — that one has
#      fallbacks, so it comes up silently on the two credentials in this repository's git history.
#      This script removes both traps instead of documenting them: compose auto-loads `.env` from
#      the directory holding the compose file, so `.env` and `deploy/.env` are linked to the one
#      real file and plain `docker compose up` is correct by construction in either directory.
#
#   3. `npm run seed:prod` — which TRUNCATES twenty-one tables. Told to a new operator as step
#      three of a first install, one mistyped `DB_HOST` away from emptying a live system. The seed
#      now refuses a populated database unless forced; this script calls it with `--if-empty`, so
#      running setup again on a working system does nothing rather than something terrible.
#
#   4. Sign in as `admin` / `admin123` and "change that password immediately". A default
#      credential that is only secure if somebody remembers a sentence in a README is not secure.
#      This script rotates it to a generated value and prints it once.
#
# Safe to re-run. It never overwrites an env file that already exists, never reseeds a populated
# database, and never rotates a password it did not just create.
# ─────────────────────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$REPO_ROOT/.env.docker"
EXAMPLE_FILE="$REPO_ROOT/.env.production.example"
COMPOSE_FILE="$REPO_ROOT/deploy/docker-compose.prod.yml"
COMPOSE_ENV_LINK="$REPO_ROOT/deploy/.env"

PUBLIC_URL="http://localhost:8080"
MODE="production"
RESIDENCY=""

while [ $# -gt 0 ]; do
  case "$1" in
    --public-url) PUBLIC_URL="${2:?--public-url needs a value}"; shift 2 ;;
    --dev)        MODE="development"; shift ;;
    # Declared hosting region. Not defaulted, and not guessed from the machine: CERT-In requires
    # logs in India and RBI requires customer data stored only in India, so "IN" is an assertion
    # about where the database, object store and logs physically live. Only the operator can make
    # it. Left unset, the API still starts and says on every boot that nobody has confirmed it.
    --data-residency) RESIDENCY="${2:?--data-residency needs a value, e.g. IN}"; shift 2 ;;
    -h|--help)    sed -n '3,9p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m==>\033[0m %s\n' "$1"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$1"; }
die()  { printf '\n\033[31mSetup stopped:\033[0m %s\n\n' "$1" >&2; exit 1; }

# ── 1. Tools ─────────────────────────────────────────────────────────────────────────────────
say "Checking prerequisites"

# `docker compose` and `podman compose` take the same arguments for everything used here, so the
# only question is which one exists. Podman is checked first only because a machine with both
# usually means Podman is the deliberate choice.
if command -v podman >/dev/null 2>&1 && podman compose version >/dev/null 2>&1; then
  COMPOSE=(podman compose)
elif command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  die "Neither 'podman compose' nor 'docker compose' is available. Install Docker (with the Compose plugin) or Podman, then run this again."
fi
ok "container runtime: ${COMPOSE[*]}"

command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets. Install it and run this again."
ok "openssl present"

[ -f "$COMPOSE_FILE" ] || die "Cannot find $COMPOSE_FILE — run this script from inside the repository."

# ── 2. Configuration ─────────────────────────────────────────────────────────────────────────
say "Configuration"

# Generated, not chosen. Every one of these is a value `assertProductionSafeConfig` refuses to
# start without, and it refuses specific literals as well as blanks — two secrets reached this
# repository's git history and are permanently burned. A human picking them is how a burned value
# gets picked again.
gen_hex()    { openssl rand -hex "$1"; }
# Alphanumeric after the `tr`, which matters twice: these end up inside a `postgres://` URL below,
# where a `/` or a `+` would need percent-encoding, and inside `ALTER ROLE … PASSWORD '…'`.
gen_pass()   { openssl rand -base64 24 | tr -d '/+=' | cut -c1-24; }

# Set a key wherever it appears (commented or not), else append it. Hoisted to the top level
# because BOTH branches below need it now: a fresh file gets every key, and an existing file gets
# the ones a newer version of this deployment requires and it has never heard of.
set_key() {
  local key="$1" value="$2"
  # `|` as the sed delimiter because values contain `/` and `+`.
  #
  # A temp file rather than `sed -i`, because `-i` is where GNU and BSD sed disagree and the
  # disagreement is SILENT. BSD sed takes the next argument as the backup suffix, so `sed -i -E`
  # reads `-E` as that suffix: it writes a stray `.env.docker-E`, and — the part that matters —
  # the script is then interpreted as a basic regular expression, where `#?` is a literal `#`
  # followed by a literal `?`. Every uncommented key stops matching, every replacement quietly
  # does nothing, and the file keeps the template's blank `# REQUIRED` values. `setup.sh` then
  # reports "wrote .env.docker with freshly generated secrets" having written none of them, and
  # the failure surfaces much later as `assertProductionSafeConfig` refusing to boot on an unset
  # JWT_SECRET. Without `-i` there is nothing for `-E` to be mistaken for.
  if grep -qE "^#? *${key}=" "$ENV_FILE"; then
    local tmp
    tmp="$(mktemp)"
    sed -E "s|^#? *${key}=.*|${key}=${value}|" "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

# The current value of a key, empty when absent or blank.
read_key() {
  sed -nE "s|^ *$1=(.*)$|\\1|p" "$ENV_FILE" | tail -1
}

if [ -f "$ENV_FILE" ]; then
  ok "$(basename "$ENV_FILE") already exists — leaving every value it already has exactly as it is"
  GENERATED_ENV=0

  # ── Keys this deployment now requires that an older env file has never heard of ────────────
  #
  # "Leave it exactly as it is" is the right rule for a value somebody chose. It is the wrong rule
  # for a key that did not exist when they wrote the file: the deployment simply will not start,
  # and it fails in `db-migrate` with "FAPOMS_MIGRATION_PASSWORD is not set", several layers away
  # from the file that is actually missing it.
  #
  # So: nothing already present is touched, and anything ABSENT that the compose file cannot start
  # without is added, named out loud. The three below arrived with the database role split — see
  # docs/database-roles.md.
  ADDED_KEYS=()
  add_missing() {
    if [ -z "$(read_key "$1")" ]; then
      set_key "$1" "$2"
      ADDED_KEYS+=("$1")
    fi
  }
  add_missing FAPOMS_RUNTIME_PASSWORD   "$(gen_pass)"
  add_missing FAPOMS_MIGRATION_PASSWORD "$(gen_pass)"
  # Built from the credentials the file already carries, so it names the superuser this compose
  # file actually created rather than one invented here.
  EXISTING_DB_USER="$(read_key DB_USERNAME)"
  EXISTING_DB_PASS="$(read_key DB_PASSWORD)"
  EXISTING_DB_HOST="$(read_key DB_HOST)"
  if [ -n "$EXISTING_DB_USER" ] && [ -n "$EXISTING_DB_PASS" ]; then
    add_missing DB_ADMIN_URL "postgres://${EXISTING_DB_USER}:${EXISTING_DB_PASS}@${EXISTING_DB_HOST:-postgres}:5432/postgres"
  fi

  if [ ${#ADDED_KEYS[@]} -gt 0 ]; then
    warn "added ${#ADDED_KEYS[@]} newly-required key(s) to $(basename "$ENV_FILE"): ${ADDED_KEYS[*]}"
    warn "these are the database role credentials — read docs/database-roles.md before the next deploy, and take a backup first"
  fi

  # NOT changed, deliberately, even though the compose file needs it false: flipping a value
  # somebody set is the one thing this branch promises not to do. The compose file sets it for the
  # API and the worker itself, so an old `true` here governs only a dev stack. Said out loud
  # anyway, because a reader comparing the two files should not have to work that out.
  if [ "$(read_key DB_MIGRATIONS_RUN)" = "true" ]; then
    warn "DB_MIGRATIONS_RUN=true is still in $(basename "$ENV_FILE"); the production compose overrides it to false for the API and the worker, and migrations run in the db-migrate step instead"
  fi
else
  [ -f "$EXAMPLE_FILE" ] || die "No $ENV_FILE and no $EXAMPLE_FILE to build one from."

  # A copy of the template with the mandatory values filled in. Everything else keeps the
  # template's own documented default, so the file a reader opens later is still the annotated one
  # rather than a stripped machine-written stub.
  umask 077
  cp "$EXAMPLE_FILE" "$ENV_FILE"

  set_key NODE_ENV                "$MODE"
  set_key JWT_SECRET              "$(gen_hex 32)"
  set_key PII_ENCRYPTION_KEY      "$(gen_hex 32)"
  # Captured, not inlined: DB_ADMIN_URL below is built from it.
  DB_PASSWORD_VALUE="$(gen_pass)"
  set_key DB_PASSWORD             "$DB_PASSWORD_VALUE"
  set_key MINIO_ROOT_PASSWORD     "$(gen_pass)"
  set_key MINIO_ROOT_USER         "fapoms"
  set_key DB_USERNAME             "fapoms"
  set_key DB_DATABASE             "fapoms"
  set_key DB_HOST                 "postgres"
  set_key DB_PORT                 "5432"
  # The schema is owned by migrations, and `synchronize` would let TypeORM reshape a live database
  # from the entity classes on every boot. Set here so it can never be absent by accident.
  set_key DB_SYNCHRONIZE          "false"
  # The API and the worker do NOT migrate. `deploy/docker-compose.prod.yml` runs `db-migrate`
  # first, as the deploy role, and both application services gate on it finishing. A process that
  # migrates needs schema privileges, and a runtime identity with schema privileges can remove the
  # audit triggers — which is the whole of docs/database-roles.md.
  #
  # The compose file sets this for the two application services regardless, so the value here only
  # governs a `docker-compose.yml` (dev) stack, where one role still does everything.
  set_key DB_MIGRATIONS_RUN       "false"
  set_key STARTUP_CHECKS_STRICT   "true"

  # ── The three database identities ──────────────────────────────────────────────────────────
  # Generated here for the same reason as every other secret above: a human picking them is how a
  # burned value gets picked again. `db-migrate` refuses to run without all three — its `env()`
  # throws on empty as well as unset, deliberately, because a role created with a password nobody
  # recorded is a deployment that cannot start.
  #
  # DB_ADMIN_URL points at the superuser THIS compose file creates: `postgres` in the compose
  # network, with the DB_USERNAME/DB_PASSWORD generated just above. It is used only by the
  # one-shot db-migrate container, never by the API or the worker.
  set_key FAPOMS_RUNTIME_PASSWORD   "$(gen_pass)"
  set_key FAPOMS_MIGRATION_PASSWORD "$(gen_pass)"
  set_key DB_ADMIN_URL              "postgres://fapoms:${DB_PASSWORD_VALUE}@postgres:5432/postgres"
  set_key CORS_ORIGINS            "$PUBLIC_URL"
  # Audit evidence on a container's local disk is destroyed by the next deploy, so production
  # requires object storage. MinIO ships in the compose file; nothing external is needed.
  set_key STORAGE_DRIVER          "s3"
  set_key S3_ENDPOINT             "http://minio:9000"
  set_key S3_BUCKET               "fapoms"
  # KYC scans and audit PDFs are scanned, and the upload path fails closed when the scanner is
  # unreachable. The ClamAV sidecar ships in the same compose file.
  set_key FILE_SCAN_REQUIRED      "true"
  set_key CLAMAV_HOST             "clamav"
  set_key REDIS_HOST              "redis"
  set_key REDIS_PORT              "6379"

  # Written only when declared, and an `if` rather than `[ -n … ] && set_key …` because under
  # `set -e` that one-liner returns non-zero whenever the flag is absent and would end the script
  # here — for every operator who did not pass it, which is most of them.
  #
  # Left unset is the honest state: the startup check then reports that nobody has confirmed where
  # this is hosted, which is worth more than a default quietly asserting India on their behalf.
  if [ -n "$RESIDENCY" ]; then
    set_key DATA_RESIDENCY_REGION "$RESIDENCY"
  fi

  GENERATED_ENV=1
  ok "wrote $(basename "$ENV_FILE") with freshly generated secrets"
  warn "back up PII_ENCRYPTION_KEY somewhere durable — it encrypts PAN, Aadhaar and bank details, and losing it makes that data unrecoverable"
fi

# ── The download snippet caddy imports ───────────────────────────────────────────────────────
#
# `deploy/Caddyfile` does `import /etc/caddy/apk-redirect.caddy`, bind-mounted from
# `$APK_DIR/apk-redirect.caddy`. A missing import is a hard error in Caddy, and a missing
# bind-mount SOURCE is worse: Docker creates a directory in its place, and caddy then refuses to
# start with "Could not import /etc/caddy/apk-redirect.caddy: is a directory".
#
# On a fresh host nothing created that file, so a clean install came up with seven healthy
# containers and a proxy in a crash loop — an application that answers nothing, with the only
# evidence in one container's log. The Caddyfile's own comment says the snippet "is written once
# with a local-file fallback and kept in place forever"; nothing was doing the writing.
#
# The fallback serves whatever APK is on disk. `deploy/publish-apk.sh` overwrites it with a redirect
# to the EAS artifact on the next real publish.
APK_DIR="${APK_DIR:-/srv/fapoms-downloads}"
APK_SNIPPET="$APK_DIR/apk-redirect.caddy"
if [ -f "$APK_SNIPPET" ]; then
  ok "apk-redirect.caddy already present — leaving it as it is"
elif mkdir -p "$APK_DIR" 2>/dev/null && cat > "$APK_SNIPPET" <<'SNIPPET'
root * /srv/fapoms-downloads
rewrite * /app.apk
file_server
SNIPPET
then
  ok "wrote a local-file fallback to $APK_SNIPPET (publish-apk.sh replaces it with a redirect)"
else
  warn "could not create $APK_SNIPPET — caddy will refuse to start with \"is a directory\". Create it by hand, or set APK_DIR to somewhere writable and re-run."
fi

# The trap, removed — for both compose files, because each fails a different way without it.
#
#   deploy/docker-compose.prod.yml has no fallbacks, so a missing env file empties the values and
#   compose says so: `pg_isready -U` with no username, a healthcheck that can never pass.
#
#   docker-compose.yml (dev) DOES have fallbacks, which is worse. Without the env file it comes up
#   silently on POSTGRES_PASSWORD=fapoms_dev and MINIO_ROOT_PASSWORD=fapoms_minio_secret — the two
#   literals in this repository's git history, the ones assertProductionSafeConfig refuses by name.
#   No warning, no failure, a working stack whose credentials are public. The data directory then
#   keeps that password until the volume is destroyed.
#
# Compose auto-loads `.env` from the directory holding the compose file. Linking both to the one
# real file makes plain `compose up` correct in either directory, with no flag to remember.
link_env() {
  local link="$1" target="$2" label="$3"
  if [ -e "$link" ] || [ -L "$link" ]; then
    ok "$label already present"
  else
    ln -s "$target" "$link"
    ok "linked $label → .env.docker so compose always resolves \${VAR}"
  fi
}
link_env "$COMPOSE_ENV_LINK" "../.env.docker" "deploy/.env"
link_env "$REPO_ROOT/.env"   ".env.docker"    ".env"

# ── 3. Build and start ───────────────────────────────────────────────────────────────────────
say "Building images (first run takes a few minutes)"
"${COMPOSE[@]}" -f "$COMPOSE_FILE" build >/dev/null
ok "images built"

say "Starting the stack"
"${COMPOSE[@]}" -f "$COMPOSE_FILE" up -d >/dev/null
ok "containers started"

# ── 4. Wait for the API ──────────────────────────────────────────────────────────────────────
# Migrations run on boot (`DB_MIGRATIONS_RUN=true`), and on a fresh database the baseline builds
# every table — so this wait is genuinely waiting for the schema, not just for a port to open.
# `database: up` in the health payload is the half that proves it.
say "Waiting for the API (migrations run on first boot)"
DEADLINE=$(( $(date +%s) + 600 ))
until curl -fsS -m 5 http://localhost:8080/api/v1/health 2>/dev/null | grep -q '"database":"up"'; do
  [ "$(date +%s)" -lt "$DEADLINE" ] || die "API did not become healthy within 10 minutes. Look at: ${COMPOSE[*]} -f $COMPOSE_FILE logs backend"
  sleep 5
done
ok "API healthy, schema in place"

# ── 5. Reference data and the first administrator ────────────────────────────────────────────
# `--if-empty` is what makes this safe to run again: on a database with data it prints a line and
# exits 0 without touching anything.
say "Seeding reference data (only if the database is empty)"
SEED_OUT="$("${COMPOSE[@]}" -f "$COMPOSE_FILE" exec -T backend \
  sh -c 'cd /app/packages/backend && node dist/infrastructure/database/seed.js --if-empty' 2>&1)" || {
    printf '%s\n' "$SEED_OUT" >&2
    die "Seeding failed. Nothing was left half-applied — the seed runs in one pass and reports its own failure."
  }

if printf '%s' "$SEED_OUT" | grep -q 'already has data'; then
  ok "database already populated — left untouched"
  ADMIN_PASSWORD=""
else
  ok "reference data seeded"

  # Rotate the seeded default. `admin123` is in this repository and in its git history; an install
  # that ends with it live is an install that shipped a public password. Rotated here rather than
  # in the seed so that a developer running the seed by hand still gets the predictable account.
  ADMIN_PASSWORD="$(gen_pass)"
  HASH="$("${COMPOSE[@]}" -f "$COMPOSE_FILE" exec -T backend \
    node -e "require('bcrypt').hash(process.argv[1],12).then(h=>process.stdout.write(h))" "$ADMIN_PASSWORD")"
  "${COMPOSE[@]}" -f "$COMPOSE_FILE" exec -T postgres \
    psql -U "$(grep -E '^DB_USERNAME=' "$ENV_FILE" | cut -d= -f2-)" \
         -d "$(grep -E '^DB_DATABASE=' "$ENV_FILE" | cut -d= -f2-)" \
         -v ON_ERROR_STOP=1 -q \
    -c "UPDATE users SET password_hash = '$HASH', must_change_password = true WHERE username = 'admin';" >/dev/null
  ok "rotated the seeded admin password"
fi

# ── 6. Done ──────────────────────────────────────────────────────────────────────────────────
say "Ready"
printf '    %-14s %s\n' "Application" "$PUBLIC_URL"
printf '    %-14s %s\n' "API health"  "$PUBLIC_URL/api/v1/health"
if [ -n "$ADMIN_PASSWORD" ]; then
  printf '\n    Sign in as \033[1madmin\033[0m with this password — it is shown once and you will be asked to change it:\n'
  printf '\n        \033[1m%s\033[0m\n' "$ADMIN_PASSWORD"
fi
if [ "$GENERATED_ENV" = "1" ]; then
  printf '\n    Secrets were generated into .env.docker. That file is gitignored; back it up.\n'
fi
printf '\n    Everyday commands (no --env-file needed, deploy/.env handles it):\n'
printf '        %s -f deploy/docker-compose.prod.yml ps\n' "${COMPOSE[*]}"
printf '        %s -f deploy/docker-compose.prod.yml logs -f backend\n' "${COMPOSE[*]}"
printf '\n'
