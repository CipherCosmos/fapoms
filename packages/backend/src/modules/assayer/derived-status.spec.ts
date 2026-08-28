import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { AssayerEntity } from './assayer.entity';
import { AssayerLifecycleStatus, AssayerStatus, operationalStatusFor } from '@fapoms/shared';

/**
 * `assayers.status` is a projection of `lifecycle_status`, never a second opinion.
 *
 * Two columns describe whether somebody can be sent to work. `lifecycle_status` is what HR
 * decided; `status` is what every planner filters on — the recommendation engine, the day
 * planner, the command centre's capacity, the operations snapshot — and it exists so those
 * queries can use one indexed column instead of reasoning about the lifecycle.
 *
 * The state machine derived it. The roster importer wrote `lifecycleStatus` straight onto the
 * entity, so `status` kept its column default of ACTIVE: 615 of 1,163 people whose HR record
 * said they had resigned, been terminated, been suspended or gone inactive were operationally
 * ACTIVE — passing the deployability gate and offered as candidates for real audits. Nothing
 * failed. The two columns said different things and only one of them was read.
 */
describe('the operational status projection', () => {
  describe('the rule', () => {
    it('is active only when the lifecycle is', () => {
      expect(operationalStatusFor(AssayerLifecycleStatus.ACTIVE)).toBe(AssayerStatus.ACTIVE);
    });

    it('keeps suspension distinguishable from every other kind of unavailable', () => {
      expect(operationalStatusFor(AssayerLifecycleStatus.SUSPENDED)).toBe(AssayerStatus.SUSPENDED);
    });

    it.each([
      AssayerLifecycleStatus.INVITED,
      AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
      AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
      AssayerLifecycleStatus.TRAINING,
      AssayerLifecycleStatus.ON_LEAVE,
      AssayerLifecycleStatus.INACTIVE,
      AssayerLifecycleStatus.RESIGNED,
      AssayerLifecycleStatus.TERMINATED,
      AssayerLifecycleStatus.ARCHIVED,
    ])('makes %s operationally inactive', (lifecycle) => {
      expect(operationalStatusFor(lifecycle)).toBe(AssayerStatus.INACTIVE);
    });

    it('treats leave as unavailable, not as active', () => {
      // Folding ON_LEAVE into ACTIVE left somebody marked away in HR sitting in the candidate
      // pool and counted as capacity. The dated `leaves` rows answer "away on the 14th?", which
      // is a different question from "away at all?".
      expect(operationalStatusFor(AssayerLifecycleStatus.ON_LEAVE)).toBe(AssayerStatus.INACTIVE);
    });

    it('is inactive for an unknown or missing lifecycle, never active', () => {
      // The safe direction: an extra exclusion is visible and explainable on the excluded panel,
      // a wrongly-included candidate is neither.
      expect(operationalStatusFor(null)).toBe(AssayerStatus.INACTIVE);
      expect(operationalStatusFor('SOMETHING_NEW')).toBe(AssayerStatus.INACTIVE);
    });
  });

  describe('the entity applies it, so no writer has to remember', () => {
    it.each([
      [AssayerLifecycleStatus.TERMINATED, AssayerStatus.INACTIVE],
      [AssayerLifecycleStatus.RESIGNED, AssayerStatus.INACTIVE],
      [AssayerLifecycleStatus.SUSPENDED, AssayerStatus.SUSPENDED],
      [AssayerLifecycleStatus.ACTIVE, AssayerStatus.ACTIVE],
    ])('overwrites a contradictory status on save (%s)', (lifecycle, expected) => {
      const a = new AssayerEntity();
      a.lifecycleStatus = lifecycle;
      // What the importer left behind: the column default, never corrected.
      a.status = AssayerStatus.ACTIVE;

      a.deriveOperationalStatus();

      expect(a.status).toBe(expected);
    });
  });

  /**
   * The hook fires on `save()`. It does not fire on `repository.update()` or a QueryBuilder
   * update, which bypass the entity entirely — so a writer that reaches for those puts the two
   * columns back out of step with nothing to catch it.
   */
  it('has no writer setting lifecycle_status behind the entity', () => {
    const ROOT = join(__dirname, '..', '..');
    const files = execSync(`git ls-files '*.ts' | grep -v '\\.spec\\.ts$' | grep -v '/migrations/'`, {
      cwd: ROOT, encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);

    const offenders: string[] = [];
    for (const rel of files) {
      const source = readFileSync(join(ROOT, rel), 'utf8');
      // `.update(...)` or `.set(...)` naming the lifecycle column or property.
      for (const m of source.matchAll(/\.(update|set)\(\s*\{[^}]*\blifecycle(_s|S)tatus\b/g)) {
        offenders.push(`${rel}: ${m[0].slice(0, 60)}…`);
      }
    }
    // Use `save()` so `deriveOperationalStatus` runs, or set both columns explicitly.
    expect({ writersBypassingTheEntity: offenders }).toEqual({ writersBypassingTheEntity: [] });
  });
});
