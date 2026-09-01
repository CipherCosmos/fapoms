import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Both targets get swept.
 *
 * The geo precision sweep walks rows whose coordinates are too coarse to plan against and tries
 * the free geocoders again. It has always been written to cover two kinds of row — branches and
 * assayer home addresses — and the module comment has always said so.
 *
 * It registered one schedule, carrying no data. The worker reads `job.data?.target ?? 'branch'`,
 * so every firing swept branches and nothing ever swept assayers: 1,155 of 1,163 imported
 * appraisers sat on no coordinates at all while a backfill ran past them every night. The
 * planner's distance filter passes anyone whose coordinates are missing, so those records were
 * being planned blind.
 *
 * Read from the source because the registration happens in `onModuleInit` against a live Redis,
 * which a unit test has no business standing up — and the failure being guarded against is a
 * missing line, which reading the file catches exactly.
 */
describe('the nightly precision sweep', () => {
  const source = readFileSync(join(__dirname, 'geo.module.ts'), 'utf8');

  it('registers a schedule for each target', () => {
    for (const target of ['branch', 'assayer']) {
      expect(source).toMatch(new RegExp(`data:\\s*\\{\\s*target:\\s*'${target}'`));
    }
  });

  it('gives each schedule its own jobId, or Bull keeps only the last', () => {
    // A repeatable is keyed by name, cron and jobId together. Two registrations of one job name
    // without distinct ids replace each other instead of joining.
    const ids = [...source.matchAll(/jobId:\s*'([^']+)'/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    // Branch sweep, assayer sweep, and the branch address-enrichment sweep.
    expect(ids).toHaveLength(3);
    expect(ids).toContain('enrich-branch-addresses');
  });

  it('does not leave a schedule relying on the worker default', () => {
    // A schedule with no `data` fires as 'branch' whatever it was meant to be — that is the
    // whole defect. Every registration in this module names its target.
    const registrations = (source.match(/name:\s*GEO_PRECISION_SWEEP_JOB/g) ?? []).length;
    const targeted = (source.match(/data:\s*\{\s*target:/g) ?? []).length;
    expect(targeted).toBe(registrations);
  });

  it('staggers them, because both walk the same rate-limited free geocoders', () => {
    const crons = [...source.matchAll(/SWEEP_CRON = '([^']+)'/g)].map((m) => m[1]);
    expect(new Set(crons).size).toBe(crons.length);
  });
});
