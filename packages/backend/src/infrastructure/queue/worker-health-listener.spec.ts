import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Task 2 of the api/worker split: PROCESS_ROLE=worker must still serve /api/v1/health.
 *
 * Before this, the worker branch in main.ts called `app.init()` and returned without ever
 * calling `app.listen()`, so the branch had no HTTP listener at all — yet the production
 * healthcheck (deploy/docker-compose.prod.yml) wgets /api/v1/health against every container,
 * worker included. A worker replica would fail its healthcheck forever despite processing jobs
 * correctly.
 *
 * This is a source-scan rather than a boot test because `bootstrap()` calls `NestFactory.create`
 * directly (module-level side effect, no DI seam) — a real supertest boot is what task 2's
 * PR-level verification does; this spec is the fast regression guard that the worker branch
 * still exposes an app.listen()'d /api/v1/health.
 */
describe('worker health listener', () => {
  const mainSrc = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf8');

  const workerBranch = (() => {
    const start = mainSrc.indexOf("processRole === 'worker'");
    const end = mainSrc.indexOf('\n  }', start);
    return mainSrc.slice(start, end);
  })();

  it("the worker branch exists and is where we think it is", () => {
    expect(workerBranch.length).toBeGreaterThan(0);
  });

  it('the worker branch sets the global api/v1 prefix', () => {
    expect(workerBranch).toMatch(/setGlobalPrefix\(\s*['"]api\/v1['"]\s*\)/);
  });

  it('the worker branch starts an HTTP listener (does not return before app.listen)', () => {
    expect(workerBranch).toMatch(/app\.listen\(/);
  });

  it('the worker branch still calls app.init() to register processors and schedules', () => {
    expect(workerBranch).toMatch(/app\.init\(\)/);
  });
});
