import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * THE WORKER'S HEALTH ROUTE HAS TO BE WHERE THE HEALTHCHECK LOOKS FOR IT.
 *
 * ## What went wrong
 *
 * `deploy/docker-compose.prod.yml` probes `/api/v1/health` on every container, worker included.
 * The worker bootstrap called `setGlobalPrefix('api/v1')` — but it called it AFTER `app.init()`,
 * and `init()` is what builds the route table. A prefix set afterwards rewrites nothing: the
 * routes stay where they were already mapped.
 *
 * So the worker served its health endpoint at `/health`, the healthcheck asked for
 * `/api/v1/health`, and got a 404 every fifteen seconds. Failing streak when this was found:
 * **297**, on a container that was sealing audit events and running data-integrity scans
 * perfectly the whole time.
 *
 * ## Why it is worth a test rather than a fixed line
 *
 * Nothing about it looks wrong. The prefix is set, the listener is up, the process does its job,
 * and the only symptom is a word in `podman ps` that everybody learns to ignore. Meanwhile
 * `depends_on: service_healthy` will block on it forever, and an orchestrator with a
 * restart-on-unhealthy policy kills a healthy process on a timer.
 *
 * A source-order assertion is the cheapest thing that catches it. Booting a worker and issuing a
 * real request would be a better test and a much heavier one — it needs Redis, Postgres and the
 * full module graph — and it would still only fail once somebody reordered these two lines, which
 * is exactly what this checks directly. Same technique as `derived-status.spec.ts` and
 * `route-permission-parity.spec.ts` next door: read the source, fail the build.
 */
describe('the worker bootstrap', () => {
  const main = readFileSync(join(__dirname, 'main.ts'), 'utf8');

  /** The `PROCESS_ROLE=worker` branch, from its guard to the `return` that ends it. */
  const workerBranch = (): string => {
    const start = main.indexOf("if (processRole === 'worker') {");
    expect(start).toBeGreaterThan(-1);
    const end = main.indexOf('\n    return;', start);
    expect(end).toBeGreaterThan(start);
    return main.slice(start, end);
  };

  it('sets the global prefix BEFORE init, or the prefix silently does nothing', () => {
    const branch = workerBranch();
    const prefixAt = branch.indexOf("app.setGlobalPrefix('api/v1')");
    const initAt = branch.indexOf('await app.init()');

    expect(prefixAt).toBeGreaterThan(-1);
    expect(initAt).toBeGreaterThan(-1);
    expect(prefixAt).toBeLessThan(initAt);
  });

  it('still listens, so there is something for the healthcheck to reach', () => {
    const branch = workerBranch();
    expect(branch).toMatch(/await app\.listen\(workerPort\)/);
    // And the port it listens on is the one the compose file publishes, unless overridden.
    expect(branch).toMatch(/process\.env\.WORKER_HEALTH_PORT \|\| process\.env\.PORT \|\| 3000/);
  });

  /**
   * The other half of the contract, read from the deployment rather than assumed.
   *
   * If somebody changes the probe path in compose, the prefix above is no longer the right one
   * and this fails with the two values side by side instead of leaving a container quietly
   * unhealthy for a week.
   */
  it('agrees with the path the deployment actually probes', () => {
    const compose = readFileSync(
      join(__dirname, '..', '..', '..', 'deploy', 'docker-compose.prod.yml'), 'utf8',
    );
    const probes = [...compose.matchAll(/wget -qO- http:\/\/localhost:\d+(\/[\w/-]*health)/g)]
      .map((m) => m[1]);

    expect(probes.length).toBeGreaterThan(0);
    for (const path of probes) expect(path).toBe('/api/v1/health');
  });
});
