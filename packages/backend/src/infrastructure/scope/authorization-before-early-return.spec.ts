import { readdirSync, readFileSync } from 'fs';
import { join, relative, sep } from 'path';

/**
 * NOTHING MAY ANSWER A REQUEST BEFORE THE REQUEST HAS BEEN AUTHORIZED.
 *
 * `POST /assignments/:id/check-in` read the locked row, took one of three idempotent shortcuts —
 * "already checked in", "already checked out", "nothing to do" — and asked whose assignment it
 * was AFTERWARDS. So an assayer with no relationship to the assignment got 201 and the whole
 * record back: the assignee's name, email and phone, the branch and its address, the check-in
 * coordinates and timestamp. Every shortcut was a correct piece of idempotency logic. The defect
 * was entirely in the ORDER.
 *
 * It survived its first repair, too. `check-out.spec.ts` builds a `dataSource` with no
 * `transaction`, so the shortcut branch is never taken in that harness and all of its ownership
 * assertions landed on a second copy of the check further down. The suite stayed green while a
 * stranger was still being handed the record; live HTTP re-verification is what caught it.
 * `attendance-ownership-fast-path.spec.ts` now drives the real branch and pins that route.
 *
 * ## What this file adds
 *
 * That spec proves one route. This one asks the question of every method in the backend: does a
 * method that authorizes anything contain a `return` that happens BEFORE it authorizes? The
 * answer today is 31 methods, every one of them reviewed and listed below with the reason its
 * early return is sound — almost all of them are the guards themselves, whose first line is
 * "this caller has no restriction, so there is nothing to check".
 *
 * It is a ratchet, not a clean bill of health. A new entry means somebody wrote a method that can
 * answer before it checks, and that person has to look at it and either move the check up or add
 * a line here saying why the shortcut discloses nothing. Both are cheap. Discovering the third
 * instance of this in production is not.
 *
 * ## Why source analysis and not a runtime test
 *
 * The property is about ORDER WITHIN A METHOD, which no unit test observes: a test that never
 * takes the shortcut branch — the exact hole the first repair fell through — passes either way.
 * Reading the source is what makes "there is no path that returns first" checkable at all.
 */

const SRC = join(__dirname, '..', '..');

/**
 * Calls whose whole purpose is to decide whether this caller may proceed, plus the two exceptions
 * that say the same thing inline. `NotFoundException` is deliberately NOT here: it is thrown for
 * a missing row far more often than as a disguised refusal, and including it would bury the
 * signal.
 */
const AUTHORIZATION_CALLS = [
  'assertAssayerInScope', 'assertAssignmentInScope', 'assertProjectInScope', 'assertBranchInScope',
  'assertProjectBranchInScope', 'assertScheduleInScope', 'assertProjectsInScope',
  'assertCoveragePlanInScope', 'assertRegionAllowed', 'assertRegionAllowedStaged',
  // The guards added on 2026-09-10 for the routes keyed on a CHILD row, plus the one that checks
  // the region a write is SETTING rather than the one it is replacing. Listed here for the same
  // reason as their siblings above: a method that returns before calling one of these is a method
  // that can answer before it has decided whether the caller may be answered, and this file's
  // whole subject is that ordering.
  'assertRegionSettable', 'assertBranchContactInScope', 'assertBranchDocumentInScope',
  'assertPayableInScope', 'assertPayablesInScope', 'assertBillingEntryInScope',
  'assertAssignmentsInScope', 'assertInvoiceInScope', 'assertPaymentInScope',
  'assertValidationCaseInScope', 'assertValidationCasesInScope', 'assertAssayerRemarkInScope',
  'assertAssayerInvoiceInScope', 'assertCommercialProfileInScope', 'assertAssayerDocumentInScope',
  'assertEmpanelmentInScope',
  // The four added on 2026-09-11 when the assayer workstream closed its sixteen child-row
  // routes and found four more child tables keyed the same way. Same standing as the three
  // above them.
  'assertWorkforceAttributeInScope', 'assertScoreOverrideInScope', 'assertAssayerReferenceInScope',
  'assertImportIssueInScope', 'assertImportIssuesInScope',
  'assertOwnedAssayer', 'assertTenantOwns', 'assertAssayerInTenant', 'assertSelfOrPrivileged',
  'assertAssayerMayDownload', 'assertJobVisibleTo', 'assertClientAllowed',
  'assertSegregationOfDuties', 'assertAssayerAssignedToBranch',
  'assertDocumentRegion', 'assertMaySubmitReturnFor', 'assertAssayerOwnsQuery',
  'assertCanOverrideEmpanelment', 'assertMayOverride', 'assertAudienceAllowed',
  'requireOrganizationId',
  // Check-in and check-out refuse with a structured result rather than an exception, so the
  // predicate itself has to be named here — otherwise the two routes this file exists for would
  // be invisible to it, which is a guard that cannot see its own subject.
  'actorMayRecordAttendance',
];
const AUTHORIZATION = new RegExp(
  `\\b(?:${AUTHORIZATION_CALLS.join('|')})\\s*\\(|throw new (?:Forbidden|Unauthorized)Exception\\b`,
);

/**
 * Reviewed, and sound. The key is `<file> :: <class>.<method>`; the value is why returning before
 * the check gives nothing away.
 *
 * Shrink this list where a check can simply move up; never add to it without reading the method.
 */
const REVIEWED: Record<string, string> = {
  // ── The guards themselves. Their first line is "this caller holds no restriction", which is
  //    what an unrestricted (national, or single-tenant) account is. Returning there is the
  //    check answering "allowed", not skipping itself.
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertRegionAllowed':
    'no regions on the account, or no region on the record — an unresolved region is a data gap and is left visible on purpose',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertRegionAllowedStaged':
    'the staged rollout is off, or the caller is unrestricted',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertAssayerInScope':
    'no reference to check, or an unrestricted caller — the row is not even loaded',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertAssignmentInScope':
    'unrestricted caller, or no assignment named — the branch region is never resolved',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertBranchInScope':
    'unrestricted caller, or no branch named — the row is never loaded',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertProjectBranchInScope':
    'unrestricted caller, or no project branch named — the row is never loaded',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertProjectInScope':
    'unrestricted caller, or no project named — the branch regions are never resolved',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertProjectsInScope':
    'unrestricted caller, or an empty id list — nothing is resolved and nothing is returned',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertCoveragePlanInScope':
    'unrestricted caller, or no plan named — the plan project is never resolved',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertScheduleInScope':
    'unrestricted caller, or no schedule named — the schedule branch is never resolved',
  // ── The guards added on 2026-09-10 to close the read/write asymmetry. Every one of them has
  //    the identical first line as the ten above — `if (!id || !scope?.regions?.length) return;`
  //    — and it is that line, not an oversight, that answers "this account holds every region".
  //    They exist because the routes keyed on a CHILD row (a branch contact, a payable, a client
  //    line, a validation case, an assayer's commercial profile) had no guard to call, so their
  //    authors wrote none.
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertRegionSettable':
    'unrestricted caller, or a target region that does not resolve — a null region is a data gap, the same one assertRegionAllowed lets through on the read side',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertBranchContactInScope':
    'unrestricted caller, or no contact named — the contact row is never loaded',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertBranchDocumentInScope':
    'unrestricted caller, or no document named — the document row is never loaded',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertPayableInScope':
    'unrestricted caller, or no payout named — the payable is never resolved to a branch',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertPayablesInScope':
    'unrestricted caller, or an empty id list — nothing is resolved and nothing is refused',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertBillingEntryInScope':
    'unrestricted caller, or no client line named — the entry is never resolved to a branch',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertAssignmentsInScope':
    'unrestricted caller, or an empty id list — nothing is resolved and nothing is refused',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertInvoiceInScope':
    'unrestricted caller, or no invoice named — the invoice lines are never resolved',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertPaymentInScope':
    'unrestricted caller, no payment named, or a payment row that does not exist — a payment settling nothing has no region to inherit and nothing has been disclosed',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertAssayerRemarkInScope':
    'unrestricted caller, or no remark named — the remark is never resolved to an assayer',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertAssayerInvoiceInScope':
    'unrestricted caller, or no assayer invoice named — the invoice is never resolved to an assayer',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertValidationCaseInScope':
    'unrestricted caller, or no case named — the case is never resolved to a branch',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertValidationCasesInScope':
    'unrestricted caller, or an empty id list — nothing is resolved and nothing is refused',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertCommercialProfileInScope':
    'unrestricted caller, or no profile named — the profile is never resolved to an assayer',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertAssayerDocumentInScope':
    'unrestricted caller, or no document named — the document is never resolved to an assayer',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertEmpanelmentInScope':
    'unrestricted caller, or no empanelment named — the row is never resolved to an assayer',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertWorkforceAttributeInScope':
    'unrestricted caller, or no attribute named — the row is never resolved to an assayer',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertScoreOverrideInScope':
    'unrestricted caller, or no override named — the row is never resolved to an assayer',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertAssayerReferenceInScope':
    'unrestricted caller, or no reference named — the row is never resolved to an assayer',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertImportIssueInScope':
    'unrestricted caller, or no issue named — the row is never resolved; an issue that names no assayer is separately let through by assertRegionAllowed, which is the rule listIssues already applies on the read side',
  'infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertImportIssuesInScope':
    'unrestricted caller, or an empty id list — nothing is resolved and nothing is refused',
  'modules/assayer/assayer.service.ts :: AssayerService.assertAssayerInTenant':
    'no tenant filter in force — single-organization deployments have nothing to compare against',
  'modules/assayer/roster-records.service.ts :: RosterRecordsService.assertOwnedAssayer':
    'no tenant filter in force',
  'modules/document/document.controller.ts :: DocumentController.assertDocumentRegion':
    'the document does not exist; the caller gets the same nothing either way',
  'modules/validation-query/validation-query.controller.ts :: ValidationQueryController.assertAssayerOwnsQuery':
    'a staff caller, already role-gated on the route — these routes are object-scoped for assayers only',
  'modules/document/document.controller.ts :: DocumentController.assertMaySubmitReturnFor':
    'a staff caller uploading on an assayer\'s behalf, already role-gated; createdBy records who really did it',
  'modules/assignment/assignment.service.ts :: AssignmentService.assertCanOverrideEmpanelment':
    'no override was requested, or the rule is not one an override applies to',
  'modules/assignment/assignment-target-eligibility.policy.ts :: AssignmentTargetEligibilityService.assertMayOverride':
    'nothing is barred, so there is no override for this to permit or refuse',
  // ── The tenant escape hatch, declared per operation rather than inferred.
  'infrastructure/tenancy/tenant-scoped.repository.ts :: TenantScopedRepository.scopedQuery':
    'the operation declared itself cross-tenant, which is the platform-level mode and not an absence of a check',
  'infrastructure/tenancy/tenant-scoped.repository.ts :: TenantScopedRepository.scopedWhere':
    'the operation declared itself cross-tenant; every OR branch is otherwise given the predicate',
  'infrastructure/settings/platform-settings.service.ts :: PlatformSettingsService.assertAudienceAllowed':
    'the setting has no restricted audience',
  'infrastructure/tenancy/ambient-tenant-context.ts :: AmbientTenantContext.requireOrganizationId':
    'no ambient tenant is in force',

  // ── Framework guards. The early return IS the grant, declared per route.
  'modules/auth/guards.ts :: RolesGuard.canActivate':
    '@Public() route — explicitly unauthenticated; everything else denies by default below',
  'modules/auth/guards.ts :: PermissionsGuard.canActivate':
    '@Public() route, or a route declaring no permission — RolesGuard has already refused an undeclared audience',
  'infrastructure/observability/metrics-auth.guard.ts :: MetricsAuthGuard.canActivate':
    'METRICS_TOKEN unset, which is the documented "restricted at the network layer instead" mode',

  // ── Business methods. Each shortcut was checked for what it hands back.
  'modules/assignment/assignment.service.ts :: AssignmentService.create':
    'idempotency replay, and the stored key\'s hash includes the acting userId — a different caller replaying the same clientRequestId gets 409, never the stored record',
  'modules/assignment/assignment.service.ts :: AssignmentService.executeAssignmentTransition':
    'idempotency replay, and the stored key\'s hash includes both the acting userId and the acting assayerId — a different actor replaying the same clientRequestId gets 409, never the stored record',
  'modules/billing-engine/billing-engine.service.ts :: BillingEngineService.approvePayableInTx':
    'the payable is already APPROVED, so there is nothing to approve; returns null, not the row',
  'modules/billing-engine/billing-engine.service.ts :: BillingEngineService.recordDisbursement':
    'a payment with this reference already exists on this payable — a replay of a disbursement that happened, creating no second one; the caller already reads payments through the payouts list',
  'modules/billing-engine/billing-engine.controller.ts :: BillingEngineController.inviteAssayerInvoices':
    'the bulk round, whose region narrowing is done by the service over assayers.region rather than per assayer here',
  'modules/scheduling/scheduling.controller.ts :: SchedulingController.getAssayerWorkload':
    'no assayer or no date was named — returns an empty result, naming nobody',
};

/** Blank out comments and string bodies, preserving offsets, so prose and SQL never match. */
function scrub(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (two === '//') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === '\\' ? 2 : 1;
      const close = Math.min(j, text.length - 1);
      out += c + text.slice(i + 1, close).replace(/[^\n]/g, ' ') + (close > i ? text[close] : '');
      i = close + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Index of the `{` that opens a method body, given the index of the `)` that closes its
 * parameter list.
 *
 * Not simply the next `{`: a return type is written between the two, and `Promise<{ success:
 * boolean; … }>` puts a brace there first. Taking that one made every method with an inline
 * object return type invisible to this scan — `recordCheckIn` and `recordCheckOut` among them,
 * which is to say the two routes this file was written about. The scan looked clean because it
 * could not see them.
 *
 * A `{` inside a type is always preceded by something that opens or continues a type (`:` `<`
 * `,` `|` `&` `(` `[` `=`, or the `>` of a `=>`). A body's `{` is preceded by the end of one:
 * the `)` of the parameter list, the `>` of a generic, a `}` or `]`, or the last letter of a
 * name. That distinction is the whole of the rule.
 */
function bodyBrace(text: string, afterParams: number): number {
  for (let i = afterParams; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let k = i - 1;
    while (k >= 0 && /\s/.test(text[k])) k -= 1;
    const prev = text[k];
    if (prev === undefined) return -1;
    if (prev === '>' && text[k - 1] === '=') continue; // an arrow-function type, still the type
    if (/[)>}\]\w]/.test(prev)) return i;
  }
  return -1;
}

/**
 * The end of the statement beginning at `from`, or the end of the text.
 *
 * Used to tell a delegating `return` from a shortcut. `recordCheckIn`'s entire body is
 * `return this.runTransactional(async (manager) => { … })`, so its first `return` sits above
 * every line in the method including the ownership check — but it does not RETURN above them, it
 * contains them. Counting it as a shortcut would have put both attendance routes on the reviewed
 * list permanently and made this file blind to the one defect it is named for.
 */
function statementEnd(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ';' && depth === 0) return i;
    if (depth < 0) return i;
  }
  return text.length;
}

/** Index of the `}` matching the `{` at `open`. */
function closingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}' && (depth -= 1) === 0) return i;
  }
  return -1;
}

interface Finding {
  key: string;
  file: string;
  method: string;
  returnLines: number[];
  authorizationLine: number;
}

function scan(): Finding[] {
  const files: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        // `_historical` binds no live route; migrations are DDL and authorize nothing.
        if (!['node_modules', '_historical', 'migrations'].includes(entry.name)) walk(p);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
        files.push(p);
      }
    }
  })(SRC);

  const findings: Finding[] = [];
  for (const path of files) {
    const raw = readFileSync(path, 'utf8');
    const text = scrub(raw);
    const file = relative(SRC, path).split(sep).join('/');
    const lineAt = (offset: number) => text.slice(0, offset).split('\n').length;

    /** The class a given offset sits in, for a key that survives two methods sharing a name. */
    const classes = [...text.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g)]
      .map((m) => ({ at: m.index!, name: m[1] }));
    const classAt = (offset: number) =>
      [...classes].reverse().find((c) => c.at < offset)?.name ?? '<module>';

    const member = /(?:^|\n)(?:\s*)(?:(?:public|private|protected|static|readonly|abstract|override)\s+)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\(/g;
    let m: RegExpExecArray | null;
    while ((m = member.exec(text))) {
      const name = m[1];
      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'super', 'typeof', 'await'].includes(name)) continue;

      // Balance the parameter list, then take the first `{` after it as the body.
      let depth = 0;
      let i = text.indexOf('(', m.index + m[0].length - 1);
      for (; i < text.length; i++) {
        if (text[i] === '(') depth += 1;
        else if (text[i] === ')' && (depth -= 1) === 0) break;
      }
      // A declaration, not a call: what follows the parameter list is a body or a return type.
      // `canOverrideAssignmentRule(rule) && stated` and `SetMetadata(KEY, roles)` both match the
      // member pattern at the start of a line and are neither.
      let after = i + 1;
      while (after < text.length && /\s/.test(text[after])) after += 1;
      if (text[after] !== '{' && text[after] !== ':') continue;
      const open = bodyBrace(text, i + 1);
      if (open < 0) continue;
      const end = closingBrace(text, open);
      if (end < 0) continue;
      const body = text.slice(open + 1, end);
      if (body.length < 40) continue;

      const authorizationAt = body.search(AUTHORIZATION);
      if (authorizationAt < 0) continue;

      // `return;` alone hands nothing back, so it cannot leak — but `return x` can, and so can a
      // bare `return` that ends a void method early having already done its work.
      const returnLines = [...body.slice(0, authorizationAt).matchAll(/\breturn\b/g)]
        .filter((r) => statementEnd(body, r.index!) < authorizationAt)
        .map((r) => lineAt(open + 1 + r.index!));
      if (returnLines.length === 0) continue;

      findings.push({
        key: `${file} :: ${classAt(m.index)}.${name}`,
        file,
        method: name,
        returnLines,
        authorizationLine: lineAt(open + 1 + authorizationAt),
      });
    }
  }
  return findings;
}

describe('authorization runs before anything can answer', () => {
  const findings = scan();
  const keys = [...new Set(findings.map((f) => f.key))].sort();

  it('scanned the backend, so a broken walker cannot pass as a clean result', () => {
    // A guard on the guard. If the scanner stopped matching methods, every check below would be
    // vacuously green — which is precisely the failure mode that let this defect through twice.
    expect(findings.length).toBeGreaterThan(20);
    expect(keys).toContain('infrastructure/scope/region-guard.service.ts :: RegionGuardService.assertRegionAllowed');
    expect(keys).toContain('modules/auth/guards.ts :: RolesGuard.canActivate');
  });

  it('has no method that can return before it authorizes, other than the ones reviewed', () => {
    // Move the check above the shortcut, or add the method to REVIEWED with the reason its
    // shortcut discloses nothing. Do not add it without reading it: the check-in defect looked
    // exactly like ordinary idempotency logic, and was.
    const unreviewed = keys
      .filter((k) => !(k in REVIEWED))
      .map((k) => {
        const f = findings.find((x) => x.key === k)!;
        return `${k} — returns at line(s) ${f.returnLines.join(', ')}, authorizes at ${f.authorizationLine}`;
      });
    expect({ unreviewed }).toEqual({ unreviewed: [] });
  });

  it('keeps no reviewed entry for a method that no longer has the shape', () => {
    // Otherwise the list stops being a truthful account of what is left and becomes a place
    // where a name can sit unexamined for years.
    const stale = Object.keys(REVIEWED).filter((k) => !keys.includes(k)).sort();
    expect({ fixedButStillListed: stale }).toEqual({ fixedButStillListed: [] });
  });

  it('gives every reviewed entry a reason somebody actually wrote', () => {
    const empty = Object.entries(REVIEWED).filter(([, why]) => why.trim().length < 20).map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it('still finds check-in and check-out asking who is calling first', () => {
    // The routes this whole file is named for. `actorMayRecordAttendance` is in the list above,
    // so if either method regains a `return` above it — which is the exact half-fix that shipped
    // once already — it appears here as an unreviewed entry and the check above goes red.
    const attendance = keys.filter((k) => /AssignmentService\.recordCheck(In|Out)$/.test(k));
    expect(attendance).toEqual([]);

    // And the predicate is still actually called in both, so "absent from the scan" cannot come
    // to mean "the check was deleted".
    const source = readFileSync(join(SRC, 'modules/assignment/assignment.service.ts'), 'utf8');
    for (const method of ['async recordCheckIn(', 'async recordCheckOut(']) {
      const at = source.indexOf(method);
      expect(at).toBeGreaterThan(-1);
      expect(source.slice(at, at + 12000)).toContain('actorMayRecordAttendance(');
    }
  });
});
