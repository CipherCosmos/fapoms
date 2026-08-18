#!/usr/bin/env bash
# Fast path for the exact same OTA publish `.eas/workflows/publish-update.yml` does, run
# LOCALLY instead of on EAS's remote job queue.
#
# The workflow is correct but slow: `fingerprint` and `get-build` each queue for a fresh
# remote worker, and the `update` job's own worker then runs `npm ci` from scratch before it
# can even start bundling — that queueing and cold install is most of the 15-40 minutes it
# takes, not the actual publish. Every one of those steps can run right here instead, where
# node_modules and the Expo CLI are already warm: `eas fingerprint:generate` computes the same
# native-project hash locally, `eas build:list` reads the same "does a compatible build exist"
# answer the workflow's `get-build` job asks for, and `eas update` performs the same publish.
# Verified once that the two fingerprinting paths agree (matched a real build's stored hash
# byte-for-byte) before relying on it here.
#
# Same safety property as the workflow, same channel, same guard — just without paying for a
# queue slot three times over. Use this for routine JS-only changes. The GitHub-triggered
# workflow is left in place as the safety net for anyone pushing without running this locally.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ Fingerprinting the native project (local)…"
LOCAL_FP=$(npx eas fingerprint:generate --platform android --non-interactive --json 2>/dev/null | node -e "
  let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
    const j=JSON.parse(d);
    console.log(j.android?.hash || j.hash || '');
  });
")

if [ -z "$LOCAL_FP" ]; then
  echo "✗ Could not compute a local fingerprint. Falling back to the remote workflow:"
  echo "  npx eas workflow:run .eas/workflows/publish-update.yml --non-interactive"
  exit 1
fi
echo "  fingerprint: $LOCAL_FP"

echo "→ Checking for a production build with that fingerprint…"
BUILD_FP=$(npx eas build:list --platform android --status finished --profile production-apk \
  --limit 1 --non-interactive --json 2>/dev/null | node -e "
  let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
    const b=JSON.parse(d)[0];
    console.log(b?.fingerprint?.hash || '');
  });
")

if [ "$LOCAL_FP" != "$BUILD_FP" ]; then
  echo "✗ Native code changed since the last production build (local=$LOCAL_FP, last build=$BUILD_FP)."
  echo "  This commit is NOT safe to publish over the air — it needs a real build:"
  echo "  npx eas build --platform android --profile production-apk --non-interactive"
  exit 1
fi
echo "  ✓ matches the latest build — safe to publish over the air."

echo "→ Compiling @fapoms/shared…"
(cd ../shared && npm run build >/dev/null)

MSG="${1:-$(git log -1 --pretty=%s)}"
echo "→ Publishing to the production channel…"
npx eas update --branch production --platform android --non-interactive --message "$MSG"

echo "✓ Done."
