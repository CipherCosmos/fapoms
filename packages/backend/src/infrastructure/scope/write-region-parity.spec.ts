import * as fs from 'fs';
import * as path from 'path';

/**
 * The region ceiling on a WRITE must match the READ on the same region-anchored resource.
 *
 * A family of bugs found 2026-09-04: several `GET :id` detail routes call a region assertion, but
 * their sibling state-changing routes did NOT — so a region-restricted operator refused *reading* an
 * out-of-region record could still *mutate* it. Confirmed on the schedule transition (live 403 on
 * read, no check on transition) and the branch/assignment mutations (source). All were money- or
 * state-bearing (accept sets the agreed fee; complete books the payable; reopen voids it; branch
 * delete soft-deletes the region anchor).
 *
 * This pins each fixed route to its region assertion by scanning the handler body (comments
 * stripped), so a future edit that drops the guard fails here rather than silently reopening the
 * cross-region write. Ownership-checked assayer routes are a no-op for these assertions (external
 * principals carry no `regions`), so adding them is safe there too.
 */
const B = path.join(__dirname, '../..', 'modules');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** Extract a single async handler body by method name from a controller source. */
function handlerBody(src: string, method: string): string {
  const clean = stripComments(src);
  const sig = clean.search(new RegExp(`async\\s+${method}\\s*\\(`));
  if (sig === -1) return '';
  // Skip the PARAMETER LIST first: walk balanced parens from the signature's '(' to its match,
  // so an inline object-type param (e.g. `@Body() body: { reason?: string }`) is not mistaken for
  // the function body. Only then look for the body's opening '{'.
  const parenOpen = clean.indexOf('(', sig);
  let pd = 0, afterParams = -1;
  for (let i = parenOpen; i < clean.length; i++) {
    if (clean[i] === '(') pd++;
    else if (clean[i] === ')') { pd--; if (pd === 0) { afterParams = i + 1; break; } }
  }
  if (afterParams === -1) return '';
  const open = clean.indexOf('{', afterParams);
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}') { depth--; if (depth === 0) return clean.slice(open, i + 1); }
  }
  return clean.slice(open);
}

/**
 * Bulk routes belong in this list, and were missing from it.
 *
 * The two `assayer` entries below were fixed on 2026-09-09 after a NORTH-scoped operator refused
 * `POST /assayers/:id/lifecycle` moved the same two WEST assayers by passing their ids in a list —
 * and neither fix was pinned here, so the next edit could have dropped the loop without a single
 * test noticing. A bulk route is the same defect as its single-id sibling with an extra `for`, and
 * the list of routes this file guards is the only place that fact is written down.
 *
 * The `project` and `document` entries are the same class, found in the sweep that followed:
 * `POST /projects/:id/branches` let a NORTH-only operator put a WEST branch — one it was refused a
 * plain `GET /branches/:id` on, 403, one second earlier — into a project, writing a
 * `project_branches` row and an `assessments` row stamped with its own id, and could then still
 * not see the link it had made. Dispatch is the sharper one: `branchEmail` is caller-supplied, so
 * an unguarded dispatch mails another region's bank paperwork wherever it is told to.
 */
const CASES: Array<{ file: string; method: string; assertion: string }> = [
  { file: 'branch/branch.controller.ts', method: 'update', assertion: 'assertBranchInScope' },
  { file: 'branch/branch.controller.ts', method: 'remove', assertion: 'assertBranchInScope' },
  { file: 'assignment/assignment.controller.ts', method: 'transition', assertion: 'assertAssignmentInScope' },
  { file: 'assignment/assignment.controller.ts', method: 'reopen', assertion: 'assertAssignmentInScope' },
  { file: 'assignment/assignment.controller.ts', method: 'escalate', assertion: 'assertAssignmentInScope' },
  { file: 'scheduling/scheduling.controller.ts', method: 'transition', assertion: 'assertScheduleInScope' },
  /*
   * The rest of the assignment write surface, added 2026-09-09.
   *
   * `transition`, `reopen` and `escalate` were pinned; the plain edit route and the two routes
   * that write onto an assignment's thread were not, and neither were attendance's two. All five
   * were confirmed live against a NORTH-scoped OPERATIONS account that `GET /assignments/<west
   * id>` answers 403 to: `PUT` changed the record, `comments` wrote a row, and `check-in` narrated
   * the assignment's state back in its refusal. Three routes on one controller asserting and five
   * not is what this file exists to prevent.
   */
  { file: 'assignment/assignment.controller.ts', method: 'update', assertion: 'assertAssignmentInScope' },
  { file: 'assignment/assignment.controller.ts', method: 'addComment', assertion: 'assertAssignmentInScope' },
  { file: 'assignment/assignment.controller.ts', method: 'reportIssue', assertion: 'assertAssignmentInScope' },
  { file: 'assignment/assignment.controller.ts', method: 'checkIn', assertion: 'assertAssignmentInScope' },
  { file: 'assignment/assignment.controller.ts', method: 'checkOut', assertion: 'assertAssignmentInScope' },
  // Bulk and batch routes — the same ceiling, applied per id before any of them is touched.
  { file: 'assayer/assayer.controller.ts', method: 'bulkTransitionLifecycle', assertion: 'assertAssayerInScope' },
  { file: 'assayer/assayer.controller.ts', method: 'bulkIssueAppAccess', assertion: 'assertAssayerInScope' },
  { file: 'project/project.controller.ts', method: 'associateBranches', assertion: 'assertBranchInScope' },
  { file: 'project/project.controller.ts', method: 'removeBranch', assertion: 'assertProjectBranchInScope' },
  { file: 'document/document.controller.ts', method: 'dispatchDocument', assertion: 'assertDocumentRegion' },
  { file: 'document/document.controller.ts', method: 'dispatchBatch', assertion: 'assertDocumentRegion' },
  { file: 'document/document.controller.ts', method: 'uploadGeneratedBatch', assertion: 'assertRegionAllowedStaged' },
];

/** The parameter list of a handler, so the scope argument can be checked separately from the body. */
function handlerParams(src: string, method: string): string {
  const clean = stripComments(src);
  const sig = clean.search(new RegExp(`async\\s+${method}\\s*\\(`));
  if (sig === -1) return '';
  const open = clean.indexOf('(', sig);
  let depth = 0;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === '(') depth++;
    else if (clean[i] === ')') { depth--; if (depth === 0) return clean.slice(open, i + 1); }
  }
  return '';
}

describe('write routes enforce the same region ceiling as their read sibling', () => {
  it.each(CASES)('$file :: $method() calls $assertion', ({ file, method, assertion }) => {
    const src = fs.readFileSync(path.join(B, file), 'utf8');
    const body = handlerBody(src, method);
    expect(body).not.toBe('');
    expect(body).toContain(assertion);
  });

  /**
   * A scope parameter is not decoration. Every assertion above reads `scope`, and each one
   * returns on its first line when it is `undefined` — `if (!branchId || !scope?.regions?.length)
   * return;`. So a handler that calls the assertion without taking `@GlobalScopeFilter()` refuses
   * nothing at all while reading, at a glance, as though it were guarded. That is a worse state
   * than no check, and it is cheap to pin.
   */
  it.each(CASES)('$file :: $method() takes the scope it asserts against', ({ file, method }) => {
    const src = fs.readFileSync(path.join(B, file), 'utf8');
    const params = handlerParams(src, method);
    expect(params).not.toBe('');
    expect(params).toContain('GlobalScopeFilter');
  });
});

/**
 * The read half of the same failure: a detail read that missed the ceiling its own sibling read
 * enforces.
 *
 * `GET /assayers/:id` has asserted `assertAssayerInScope` for as long as the ceiling has existed.
 * Two routes about the same person did not. Both were confirmed live against a NORTH-scoped
 * OPERATIONS account that `GET /assayers/<west id>` answers 403 to: the checklist returned that
 * person's whole KYC position, and the document route streamed their PAN card scan byte-identical
 * to what an administrator receives. `assertSelfOrPrivileged` was the only gate, and it admits
 * every ADMIN and OPERATIONS principal for every assayer id by design.
 *
 * Pinned in the same file as the write cases because the property is the same one — a route about
 * a region-anchored record asserts the ceiling — and splitting it across two files is how the
 * write half came to be pinned while the read half was not.
 */
const READ_CASES: Array<{ file: string; method: string; assertion: string }> = [
  { file: 'assayer/assayer-self-service.controller.ts', method: 'registrationChecklist', assertion: 'assertAssayerInScope' },
  { file: 'assayer/assayer-self-service.controller.ts', method: 'getOwnDocumentFile', assertion: 'assertAssayerInScope' },
];

describe('detail reads enforce the same region ceiling as their sibling read', () => {
  it.each(READ_CASES)('$file :: $method() calls $assertion', ({ file, method, assertion }) => {
    const src = fs.readFileSync(path.join(B, file), 'utf8');
    const body = handlerBody(src, method);
    expect(body).not.toBe('');
    expect(body).toContain(assertion);
    expect(handlerParams(src, method)).toContain('GlobalScopeFilter');
  });
});
