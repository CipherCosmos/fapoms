import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * PlanningWorkspace actually uses `assign-route` at each entry point.
 *
 * `assign-route.spec.ts` proves the rules; this proves the page is wired to them. Mounting the
 * 3,500-line workspace to click through a modal would test the same thing far more slowly, and
 * the failure this guards against is exactly a source-level one: somebody adding a new "assign"
 * button that goes straight to `POST /assignments` (which now 409s over a live offer, and used to
 * move it silently), or putting the day plan back on `Promise.all` (which makes the stop that
 * carries the day's travel depend on network timing).
 */
const src = readFileSync(join(__dirname, '..', 'PlanningWorkspace.tsx'), 'utf8');

/** The body of `const <name> = async (...) => { ... };` — up to the next top-level handler. */
function handler(name: string): string {
  const start = src.indexOf(`const ${name} = async`);
  if (start < 0) throw new Error(`${name} not found in PlanningWorkspace.tsx`);
  const next = src.indexOf('\n  const ', start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

describe('PlanningWorkspace — assign entry points route through assign-route', () => {
  it.each(['handleConfirmAssignment', 'handleAssignExcluded'])(
    '%s asks assignRoute first, and reassigns through reassignAndApply',
    (name) => {
      const body = handler(name);
      const routeAt = body.indexOf('assignRoute(');
      const createAt = body.search(/api\.request(<[^(]*>)?\('\/assignments'/);
      expect(routeAt).toBeGreaterThan(-1);
      expect(body).toContain('assignBlocker(');
      expect(body).toMatch(/route\.kind === 'reassign'[\s\S]*reassignAndApply\(/);
      // The routing decision comes before the create request, not after.
      expect(createAt).toBeGreaterThan(routeAt);
    },
  );

  it('the modal disables its submit while the reassign reason is missing', () => {
    expect(src).toMatch(/<button type="submit"[^>]*disabled=\{modalBlocker != null\}/);
    expect(src).toContain('Both assayers will be told.');
  });

  it('handleAssignDayPlan posts stops in order, not concurrently', () => {
    const body = handler('handleAssignDayPlan');
    expect(body).toContain('postStopsInOrder(');
    expect(body).not.toContain('Promise.all');
    expect(body).toMatch(/\.sort\(\(a, b\) => a\.order - b\.order\)/);
  });
});

/**
 * The fee box is prefilled with a travel-inclusive quote. Sent back as `proposedFee` it became the
 * desk's number, which the server never re-prices — so an assayer's second job that day carried
 * travel twice. Only a fee the desk typed may be sent, on create and reassign alike.
 */
describe('PlanningWorkspace — the prefilled fee is a reading, not the desk\'s number', () => {
  it('handleConfirmAssignment sends only a typed fee (feeToSend) on both paths', () => {
    const body = handler('handleConfirmAssignment');
    expect(body).toContain('feeToSend(agreedFeeInput, feeEdited)');
    expect(body).toMatch(/proposedFee: typedFee/);
    expect(body).toMatch(/reassignAndApply\([\s\S]*fee: typedFee/);
    expect(body).not.toMatch(/proposedFee: Number\(agreedFeeInput\)/);
  });

  it('typing in the fee box marks it edited; opening the form clears that', () => {
    expect(src).toMatch(/value=\{agreedFeeInput\} onChange=\{e => \{ setAgreedFeeInput\(e\.target\.value\); setFeeEdited\(true\); \}\}/);
    expect(handler('openAssignment')).toContain('setFeeEdited(false)');
  });

  it('the quote is asked for the form\'s date, through the one body builder', () => {
    const body = handler('fetchFeeQuote');
    expect(body).toContain('feeQuoteRequestBody(');
    expect(body).toMatch(/onDate,/);
    expect(src).toContain('dayTravelNote(feeQuote)');
  });
});

/** A call outcome of AGREED means somebody agreed on a call — Call & Assign, never Send to app. */
describe('PlanningWorkspace — AGREED is recorded only for Call & Assign', () => {
  it('every AGREED recordCall in handleConfirmAssignment is guarded by assignDirectly', () => {
    const body = handler('handleConfirmAssignment');
    const calls = body.match(/[^\n]*recordCall\([^\n]*'AGREED'/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const line of calls) {
      const at = body.indexOf(line);
      const before = body.slice(Math.max(0, at - 250), at + line.length);
      expect(before).toMatch(/if \(assignDirectly\)/);
    }
  });
});
