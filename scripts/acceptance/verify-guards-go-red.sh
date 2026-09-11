#!/bin/bash
# Adversarial guard check: remove a control, prove its test goes red, put it back byte for byte.
#
# Mutations are applied to SOURCE and exercised through jest. The running containers serve
# compiled `dist`, so nothing here changes the behaviour of the live acceptance rig.
# ────────────────────────────────────────────────────────────────────────────────────────────
# SAFETY CLASSIFICATION: MUTATES SOURCE FILES
# ────────────────────────────────────────────────────────────────────────────────────────────
#
# source      : EDITS FILES IN THE WORKING TREE to remove a control, runs jest to prove the test
#               goes red, then restores the file and verifies the checksum matches byte for byte.
#               It SKIPS any file that already has uncommitted changes, so it will not mutate
#               another session's edit — but it is still writing to your checkout.
# deployment  : none. The containers serve compiled dist; nothing here reaches the running rig.
# gate        : the uncommitted-changes check, and nothing else. Do not run it mid-edit.
#
# The full table for every script here is in scripts/acceptance/README.md.

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


# ── Added 2026-09-10, during the role-by-role product acceptance campaign ──────────────────────
# Each case removes one control that this campaign certified, and expects the suite that claims to
# guard it to fail. A control whose removal nothing notices is a control in name only.

run_case G4-region-ceiling-on-create \
  packages/backend/src/modules/assignment/assignment.controller.ts \
  'await this.regionGuard.assertProjectBranchInScope(dto.projectBranchId, scope);' \
  'void dto.projectBranchId;' \
  'write-region-parity'

run_case G5-fee-self-dealing \
  packages/backend/src/modules/assignment/assignment.controller.ts \
  'const deskSuppliedFee = callerIsAssayer ? undefined : (body.fee ?? body.agreedFee);' \
  'const deskSuppliedFee = (body.fee ?? body.agreedFee);' \
  'fee-self-dealing'

run_case G6-masked-pii-write-back \
  packages/backend/src/modules/assayer/assayer.service.ts \
  '&& looksMasked(incoming)) {' \
  '&& false) {' \
  'roster-masked-bank-account|sensitive-field-reveal'

run_case G7-forced-password-gate \
  packages/backend/src/modules/auth/guards.ts \
  'if (user?.mustChangePassword === true) {' \
  'if (false) {' \
  'guards.spec|security-controls'

run_case G8-permissions-guard-in-chain \
  packages/backend/src/modules/user/system-dashboard.controller.ts \
  '@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)' \
  '@UseGuards(JwtAuthGuard, RolesGuard)' \
  'route-permission-parity'

run_case G9-rejected-empanelment-reason \
  packages/backend/src/modules/assayer/roster-records.service.ts \
  'if (previousStatus === EmpanelmentStatus.REJECTED && dto.status !== EmpanelmentStatus.REJECTED) {' \
  'if (false) {' \
  'empanelment-rejection-reversal'

run_case G10-assayer-child-row-region \
  packages/backend/src/modules/assayer/assayer.controller.ts \
  'await this.regionGuard.assertAssayerDocumentInScope(id, scope);
    const found = await this.rosterRecords.fileKey(id, Number(index));' \
  'const found = await this.rosterRecords.fileKey(id, Number(index));' \
  'write-region-parity|assayer-controller-region-scope'

echo "=== final tree check (must be clean) ==="
git status --short -- packages/backend/src | head -5 || true
