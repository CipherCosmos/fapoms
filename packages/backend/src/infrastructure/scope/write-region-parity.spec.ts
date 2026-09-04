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

const CASES: Array<{ file: string; method: string; assertion: string }> = [
  { file: 'branch/branch.controller.ts', method: 'update', assertion: 'assertBranchInScope' },
  { file: 'branch/branch.controller.ts', method: 'remove', assertion: 'assertBranchInScope' },
  { file: 'assignment/assignment.controller.ts', method: 'transition', assertion: 'assertAssignmentInScope' },
  { file: 'assignment/assignment.controller.ts', method: 'reopen', assertion: 'assertAssignmentInScope' },
  { file: 'assignment/assignment.controller.ts', method: 'escalate', assertion: 'assertAssignmentInScope' },
  { file: 'scheduling/scheduling.controller.ts', method: 'transition', assertion: 'assertScheduleInScope' },
];

describe('write routes enforce the same region ceiling as their read sibling', () => {
  it.each(CASES)('$file :: $method() calls $assertion', ({ file, method, assertion }) => {
    const src = fs.readFileSync(path.join(B, file), 'utf8');
    const body = handlerBody(src, method);
    expect(body).not.toBe('');
    expect(body).toContain(assertion);
  });
});
