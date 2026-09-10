#!/bin/bash
# Adversarial guard check: remove a control, prove its test goes red, put it back byte for byte.
#
# Mutations are applied to SOURCE and exercised through jest. The running containers serve
# compiled `dist`, so nothing here changes the behaviour of the live acceptance rig.
set -u
REPO=/Users/deepstacker/WorkSpace/dupcq/gssAutomation
cd "$REPO" || exit 2

run_case() {
  local id="$1" file="$2" from="$3" to="$4" pattern="$5"
  local abs="$REPO/$file"

  if [ -n "$(git diff --name-only -- "$file")" ]; then
    echo "  SKIP [$id] $file already has uncommitted changes — not mutating somebody else's edit"
    return
  fi

  local before_sum; before_sum=$(shasum -a 256 "$abs" | cut -d' ' -f1)

  if ! grep -qF "$from" "$abs"; then
    echo "  SKIP [$id] anchor not found in $file — the control moved, re-target this case"
    return
  fi

  python3 - "$abs" "$from" "$to" <<'PY'
import sys
p, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
open(p, 'w').write(s.replace(a, b, 1))
PY

  local out; out=$(cd "$REPO/packages/backend" && npx jest "$pattern" --silent 2>&1 | tail -4)
  local red=1
  echo "$out" | grep -qE "Tests:.*[1-9][0-9]* failed" && red=0

  python3 - "$abs" "$from" "$to" <<'PY'
import sys
p, a, b = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(p).read()
open(p, 'w').write(s.replace(b, a, 1))
PY

  local after_sum; after_sum=$(shasum -a 256 "$abs" | cut -d' ' -f1)
  if [ "$before_sum" != "$after_sum" ]; then
    echo "  ERROR [$id] $file NOT restored byte for byte — restore it by hand before committing"
    return
  fi

  if [ "$red" -eq 0 ]; then
    echo "  PASS [$id] removing the control turns its test red, and the file is restored"
  else
    echo "  FAIL [$id] the control was removed and the suite still passed — the test does not guard it"
    echo "$out" | sed 's/^/        /'
  fi
}

echo "=== adversarial guard checks ==="

run_case G1-segregation-of-duties \
  packages/backend/src/modules/billing-engine/billing-engine.service.ts \
  'if (!otherPartyId || otherPartyId !== actorId) return;' \
  'if (true) return;' \
  'billing-engine.service.spec'

run_case G3-eligibility-hard-block \
  packages/backend/src/modules/assignment/assignment-target-eligibility.policy.ts \
  "export const STRICTLY_NON_OVERRIDABLE_STANDINGS = ['REJECTED', 'TERMINATED', 'EXPIRED', 'SUSPENDED'];" \
  "export const STRICTLY_NON_OVERRIDABLE_STANDINGS: string[] = [];" \
  'assignment-target-eligibility.policy.spec'

run_case G-min-override-reason \
  packages/backend/src/modules/assignment/assignment-target-eligibility.policy.ts \
  'export const MIN_OVERRIDE_REASON_LENGTH = 10;' \
  'export const MIN_OVERRIDE_REASON_LENGTH = 0;' \
  'assignment-target-eligibility.policy.spec'

echo "=== final tree check (must be clean) ==="
git status --short -- packages/backend/src | head -5 || true
