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
 * entity, so `status` kept its column default of ACTIVE: **615 of 1,163** people carry a
 * lifecycle other than ACTIVE, and every one of them was operationally ACTIVE — passing the
 * deployability gate and offered as candidates for real audits. Nothing failed. The two columns
 * said different things and only one of them was read.
 *
 * Of those 615, **536** had resigned, been terminated, been suspended or gone inactive, and the
 * remaining 79 were INVITED — people who had not finished onboarding being offered audit work,
 * which is the worst of the four cases and the one the shorter list used to leave out. The
 * migration's own note quotes 536 because it names only those four; both figures are right for
 * the population they describe, so do not "correct" either one to match the other.
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
   *
   * ## What these patterns look for, and why the first one had to change
   *
   * This guard used to read `\.update\(\s*\{[^}]*lifecycleStatus`, which requires the object
   * literal to be `update()`'s FIRST argument. TypeORM's signature is `update(criteria,
   * partialEntity)`, so the column always arrives in the second or third argument and the only
   * shape that pattern could ever match was the QueryBuilder's `.update(Entity).set({…})`. Every
   * plain repository form went straight past it — including `repository.update(id, {…})`, which
   * is the house idiom two live callers already use for other columns (`assayer.service.ts`
   * writes `liveLatitude` and the confirmed base location that way, deliberately, to avoid a
   * full-row `save()` reverting a concurrent security flag). The guard was reading for a style
   * this codebase does not write in.
   *
   * So the argument scan now walks the whole argument list — up to two levels of nested
   * parentheses, which covers `update({ id: In(ids) }, { lifecycleStatus })` — and a second
   * pattern covers raw SQL, which reaches the column without TypeORM at all.
   *
   * ## What no text scan can see
   *
   * `assayer.service.ts:1154` does `this.assayerRepository.update(id, update as any)`, where the
   * payload is a variable built earlier. If somebody put `lifecycleStatus` into that object the
   * call site would still read `update(id, update as any)` and no pattern over source text could
   * tell. That call is not an offender today — it writes coordinates, region and district — but
   * it is the shape this guard is blind to, and it is worth knowing that this test proves
   * "nothing writes the column in a form we can recognise", not "nothing writes the column".
   */
  const BEHIND_THE_ENTITY = [
    // `.update(criteria, { lifecycleStatus })`, `.update(Entity, id, { lifecycleStatus })`, and
    // the QueryBuilder's `.update(Entity).set({ lifecycleStatus })` — the column may sit in any
    // argument, so the whole list is scanned rather than only the first.
    /\.(?:update|set)\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\blifecycle(?:_s|S)tatus\b/g,
    // Raw SQL. Keywords are matched case-sensitively because SQL is written in caps here and a
    // case-insensitive `UPDATE` also matches the word `update` in every prose comment.
    /\bUPDATE\s+[\w".]+\s+SET\b[\s\S]{0,400}?\blifecycle_status\b/g,
  ];

  /**
   * The guard's own coverage, asserted rather than assumed.
   *
   * The pattern this replaced matched exactly one of the five shapes below and had been believed
   * to match all of them, in this file and in a claim on `assayer.entity.ts` that the build would
   * fail if a writer appeared. A source scan whose reach is never exercised is indistinguishable
   * from one that works, because both report zero offenders on a clean tree.
   */
  it('recognises every shape that writes the column behind the entity', () => {
    const caught = (line: string) => BEHIND_THE_ENTITY.some((p) => line.match(p) !== null);

    for (const shape of [
      "await repo.update(id, { lifecycleStatus: 'ACTIVE' });",
      'await repo.update({ id }, { lifecycleStatus: next });',
      'await manager.update(AssayerEntity, id, { lifecycleStatus: next });',
      'await manager.update(AssayerEntity, { id: In(ids) }, { lifecycleStatus: next });',
      'qb.update(AssayerEntity).set({ status: x, lifecycleStatus: y })',
      "await manager.query('UPDATE assayers SET lifecycle_status = $1 WHERE id = $2', [s, id]);",
    ]) expect({ shape, caught: caught(shape) }).toEqual({ shape, caught: true });

    for (const innocent of [
      // The blind spot named above: the payload is a variable, so there is nothing to read.
      'await this.assayerRepository.update(id, update as any);',
      // Other columns written the same way must not be dragged in.
      'await repo.update(id, { liveLatitude: lat, liveLongitude: lng });',
      // Reading and assigning on the entity are fine — the hook runs on save().
      'a.lifecycleStatus = next;',
      'if (p.lifecycleStatus === AssayerLifecycleStatus.RESIGNED) return true;',
    ]) expect({ innocent, caught: caught(innocent) }).toEqual({ innocent, caught: false });
  });

  it('has no writer setting lifecycle_status behind the entity', () => {
    const ROOT = join(__dirname, '..', '..');
    const files = execSync(`git ls-files '*.ts' | grep -v '\\.spec\\.ts$' | grep -v '/migrations/'`, {
      cwd: ROOT, encoding: 'utf8',
    }).trim().split('\n').filter(Boolean);

    const offenders: string[] = [];
    for (const rel of files) {
      const source = readFileSync(join(ROOT, rel), 'utf8');
      for (const pattern of BEHIND_THE_ENTITY) {
        for (const m of source.matchAll(pattern)) {
          offenders.push(`${rel}: ${m[0].slice(0, 60).replace(/\s+/g, ' ')}…`);
        }
      }
    }
    // Use `save()` so `deriveOperationalStatus` runs, or set both columns explicitly.
    expect({ writersBypassingTheEntity: offenders }).toEqual({ writersBypassingTheEntity: [] });
  });
});
