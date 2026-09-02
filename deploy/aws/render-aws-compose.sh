#!/usr/bin/env bash
# =============================================================================
# Derive the AWS compose file from the production one: the same stack, minus MinIO, because on
# AWS object storage is real S3 reached through the instance role.
#
# This lived inside bootstrap.sh, which meant it ran exactly once — at install time. The file it
# writes is generated from docker-compose.prod.yml and is not in git, so nothing regenerated it
# afterwards: a service added upstream, a changed image tag, a new healthcheck would land in the
# repository, be reset onto the box by auto-deploy, and never reach a container. The deploy log
# would report success the whole time, because from its point of view the deploy did succeed.
#
# It is now a script with two callers — bootstrap at install, auto-deploy on every tick — so the
# generated file cannot fall behind the file it is generated from.
#
#   ./render-aws-compose.sh [SRC] [DST]
#
# Defaults come from APP_DIR (/opt/fapoms).
# =============================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/fapoms}"
SRC="${1:-$APP_DIR/deploy/docker-compose.prod.yml}"
DST="${2:-$APP_DIR/deploy/docker-compose.aws.yml}"

[ -f "$SRC" ] || { echo "render-aws-compose: no such file: $SRC" >&2; exit 1; }

# Written to a temp file and renamed. `up -d` may be reading the destination at the same moment
# on a concurrent run, and half a YAML file is a stack that does not come back.
TMP="$(mktemp "${DST}.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

python3 - "$SRC" "$TMP" <<'PY'
import sys, yaml
src, dst = sys.argv[1], sys.argv[2]
d = yaml.safe_load(open(src))
svcs = d.get("services", {})
svcs.pop("minio", None)
be = svcs.get("backend", {})
dep = be.get("depends_on")
if isinstance(dep, dict): dep.pop("minio", None)
elif isinstance(dep, list) and "minio" in dep: dep.remove("minio")
d.get("volumes", {}).pop("miniodata", None)
yaml.safe_dump(d, open(dst, "w"), sort_keys=False)
PY

# Only touch the destination when the content actually differs, so `ls -l` on the box still shows
# when the compose file last really changed instead of when the timer last ran.
if [ -f "$DST" ] && cmp -s "$TMP" "$DST"; then
  echo "render-aws-compose: $DST already current"
else
  chmod 644 "$TMP"
  mv -f "$TMP" "$DST"
  echo "render-aws-compose: wrote $DST (minio removed)"
fi
