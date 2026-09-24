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
      const createAt = body.indexOf("api.request<{ status?: string }>('/assignments'") >= 0
        ? body.indexOf("api.request<{ status?: string }>('/assignments'")
        : body.indexOf("api.request('/assignments'");
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
