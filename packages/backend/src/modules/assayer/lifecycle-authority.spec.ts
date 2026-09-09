import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * ONE AUTHORITY FOR `lifecycle_status`, ENFORCED BY THE BUILD.
 *
 * ## Why a source scan and not a unit test
 *
 * The lifecycle certification found three separate routes that changed an assayer's lifecycle
 * state without the transition map ever being consulted, and the interesting thing about them is
 * that none was a bug in the state machine. The state machine was correct throughout. The defect
 * was that it was not the only thing writing the column:
 *
 *   - `operatorResetOnboardingStage` assigned `lifecycleStatus` directly and guarded only against
 *     the CURRENT state being ACTIVE, so a dismissed person could be dropped into TRAINING and
 *     then activated by an ordinary legal edge — two API calls from TERMINATED back to work, with
 *     no document-verification and no background-verification event on their record, because
 *     neither happened;
 *   - `operatorRevokeInvitation` assigned ARCHIVED directly, an edge the map called illegal, so
 *     the transition endpoint refused the move with a 400 at the same moment the recovery
 *     endpoint performed it;
 *   - `remove()` assigns ARCHIVED from any state at all.
 *
 * No test could have caught those by exercising the state machine, because they do not go through
 * it. What catches them is asking a different question — *who is allowed to write this column* —
 * and that question is answered by reading the source, which is what this file does.
 *
 * It is the same technique `derived-status.spec.ts` next door already uses to stop anybody
 * writing `lifecycle_status` through a QueryBuilder (which would bypass the entity hook that
 * derives `status`). That guard is about HOW the column is written; this one is about WHO writes
 * it. Both fail the build rather than a review.
 *
 * ## The rule
 *
 * Exactly three places in the backend may assign `lifecycleStatus`, and each is listed below with
 * the reason it is allowed. Anything else is a new writer, and a new writer is how the lifecycle
 * acquires a second opinion. Adding one to the list is deliberately awkward: you have to come
 * here, name it, and write down why it is not simply a transition.
 */

const BACKEND_SRC = join(__dirname, '..', '..');

/**
 * The permitted writers, by file, with the justification each one has to earn.
 *
 * Keyed by path relative to `packages/backend/src` so a file move shows up as a failure rather
 * than as a silently-skipped entry.
 */
const PERMITTED_WRITERS: Record<string, string> = {
  'modules/assayer/assayer.state-machine.ts':
    'THE authority. `applyTransition` is the only code that may move the column, and it runs only '
    + 'after `validateTransition` has accepted the edge against the shared map.',

  'modules/assayer/assayer.service.ts':
    'The funnel and the two policy operations that delegate to it. `doTransitionLifecycle` calls '
    + 'the state machine under a row lock; `operatorResetOnboardingStage` is a rewind confined to '
    + 'the onboarding stages, which are not transitions and have no edges in the map; `remove()` '
    + 'is an administrative deletion. Each is documented at its own definition.',

  'modules/assayer/roster-import.service.ts':
    'Bulk data import, deliberately outside the interactive funnel: it reconciles a spreadsheet '
    + 'against the roster under its own overwrite policy, where the incoming value is a statement '
    + 'of record rather than a decision somebody is making. It writes through the entity, so the '
    + '`@BeforeUpdate` hook still derives `status` — which is the failure this used to have, when '
    + 'it left 536 departed people operationally ACTIVE and offered as audit candidates.',
};

/** Every non-spec, non-migration TypeScript file in the backend. */
const sourceFiles = (): string[] => execSync(
  `git ls-files '*.ts' | grep -v '\\.spec\\.ts$' | grep -v '/migrations/'`,
  { cwd: BACKEND_SRC, encoding: 'utf8' },
).trim().split('\n').filter(Boolean);

/**
 * An assignment to the column, in any of the shapes it can take.
 *
 * Both the camelCase entity property and the snake_case database column, because a raw
 * `UPDATE … SET lifecycle_status = …` is the same defect wearing different clothes — and is
 * additionally invisible to the entity hook that derives `status`.
 */
const WRITE_PATTERNS: RegExp[] = [
  /**
   * An assignment onto a loaded assayer. This is the shape all three certification defects took.
   *
   * The receiver is named, not wildcarded, because `client.service.ts` legitimately writes
   * `client.lifecycleStatus` — clients have their own lifecycle, their own state machine and
   * their own column, and a guard that cannot tell the two apart either fails on honest code or
   * gets loosened until it catches nothing. Every real writer here calls its variable `assayer`
   * or `a`.
   */
  /(?:^|[^.\w])(?:assayer\w*|a)\.lifecycleStatus\s*=(?!=)/i,
  // Raw SQL, which additionally bypasses the `@BeforeUpdate` hook that derives `status`.
  /SET\s+lifecycle_status\s*=/i,
];

/**
 * Deliberately NOT matched: `lifecycleStatus: <value>` inside an object literal.
 *
 * That shape is overwhelmingly a read — a `select` projection, a DTO field, a returned row, a
 * type declaration — and a guard that shouts about 20 of those to catch none of the real defects
 * teaches people to add exclusions until it shouts about nothing. The forms that actually
 * bypassed the state machine were all assignments onto a loaded entity, and a create through
 * `repository.save()` is fine by construction: the entity hook derives the projection, and a new
 * row has no prior state to transition from.
 *
 * The one object-literal shape that IS dangerous — `repository.update(id, { lifecycleStatus })`
 * and `.update(Entity).set({ lifecycleStatus })`, which skip the entity and therefore the hook —
 * is already caught by `derived-status.spec.ts`, which exists for exactly that and is the
 * companion to this file.
 */

describe('only the lifecycle authority may write lifecycle_status', () => {
  const offenders: { file: string; line: number; text: string }[] = [];

  beforeAll(() => {
    for (const file of sourceFiles()) {
      if (PERMITTED_WRITERS[file]) continue;
      const body = readFileSync(join(BACKEND_SRC, file), 'utf8');
      /**
       * Only files that actually handle an assayer. Clients and projects have their own
       * `lifecycleStatus` on their own tables with their own state machines — `client.service.ts`
       * assigning `client.lifecycleStatus` is that module's business, not a bypass of this one.
       * Keying on the import is precise where keying on the word "assayers" is not: half the
       * backend mentions assayers somewhere in a comment.
       */
      if (!/\bAssayerEntity\b/.test(body)) continue;

      const lines = body.split('\n');
      lines.forEach((text, i) => {
        // A comparison is not a write, and neither is a `where` clause naming the column.
        if (/===|!==|==\s|>=|<=/.test(text)) return;
        if (/where|filter|order|select|group/i.test(text) && !/SET\s+lifecycle_status/i.test(text)) return;
        if (WRITE_PATTERNS.some((p) => p.test(text))) {
          offenders.push({ file, line: i + 1, text: text.trim() });
        }
      });
    }
  });

  it('finds source to scan at all, so a broken scan cannot pass as a clean result', () => {
    expect(sourceFiles().length).toBeGreaterThan(200);
  });

  it('names every permitted writer, and each of them still exists', () => {
    for (const file of Object.keys(PERMITTED_WRITERS)) {
      expect(() => readFileSync(join(BACKEND_SRC, file), 'utf8')).not.toThrow();
      expect(PERMITTED_WRITERS[file].length).toBeGreaterThan(80);
    }
  });

  /**
   * The permitted writers are whole files, which is coarser than it should be — `assayer.service.ts`
   * is 4,000 lines and this guard would not notice a third writer appearing in it. So the exact
   * assignments are pinned too, one per documented operation. A new one fails here and has to be
   * justified in `PERMITTED_WRITERS` before it can pass.
   */
  it('holds AssayerService to exactly its two documented writers', () => {
    const svc = readFileSync(join(BACKEND_SRC, 'modules/assayer/assayer.service.ts'), 'utf8');
    const writes = svc.split('\n')
      .map((t, i) => ({ line: i + 1, text: t.trim() }))
      .filter(({ text }) => /\.lifecycleStatus\s*=(?!=)/.test(text) && !/===|!==/.test(text));
    expect(writes.map((w) => w.text)).toEqual([
      // `remove()` — administrative deletion. See its own comment for why it is not a transition.
      'assayer.lifecycleStatus = AssayerLifecycleStatus.ARCHIVED;',
      // `operatorResetOnboardingStage` — the onboarding rewind, confined to the four joining
      // stages in both directions and refusing any source that is not already one of them.
      'assayer.lifecycleStatus = targetStage;',
    ]);
  });

  it('lets nobody else assign it', () => {
    const report = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n');
    expect(offenders.length === 0 ? '' : `\nUnpermitted writes to the assayer lifecycle:\n${report}\n\n`
      + 'Every change to lifecycle_status must go through AssayerService.doTransitionLifecycle, so\n'
      + 'that it is validated against the shared transition map under a row lock, demands a reason\n'
      + 'where one is required, and writes its audit row in the same transaction. If this really is\n'
      + 'a new policy operation rather than a transition, add it to PERMITTED_WRITERS above with\n'
      + 'the reason it is not simply an edge.\n').toBe('');
  });

  /**
   * The state machine's own writers, pinned.
   *
   * `applyTransition` sets three columns together — the lifecycle, the projection derived from
   * it, and the active flag — and they are only ever correct as a set. A future edit that moves
   * one of them somewhere else would break the invariant the database's own CHECK constraints
   * exist to catch, and would do it in the one file this guard cannot police by exclusion.
   */
  it('keeps the lifecycle, its projection and the active flag written together', () => {
    const machine = readFileSync(
      join(BACKEND_SRC, 'modules/assayer/assayer.state-machine.ts'), 'utf8',
    );
    const apply = machine.slice(machine.indexOf('private static applyTransition'));
    const body = apply.slice(0, apply.indexOf('\n  }'));
    expect(body).toMatch(/assayer\.lifecycleStatus\s*=\s*targetStatus/);
    expect(body).toMatch(/assayer\.status\s*=\s*operationalStatusFor\(targetStatus\)/);
    expect(body).toMatch(/assayer\.isActive\s*=\s*targetStatus\s*!==\s*AssayerLifecycleStatus\.ARCHIVED/);
  });

  /**
   * The reason requirement lives at the authority, not at a route.
   *
   * It used to be checked in `dispatchLifecycleTransition` and, separately, in
   * `bulkTransitionLifecycle` — where it tested the FINAL target only. A bulk walk whose
   * destination needed no reason therefore skipped it for every reason-requiring state it passed
   * through: `RESIGNED → … → ACTIVE` re-onboarded a departed person in one unreasoned call.
   * Asserting the check is inside the funnel is the cheapest way to stop it drifting back out to
   * the routes, where two of the three will always be the ones somebody forgets.
   */
  it('enforces the mandatory reason inside doTransitionLifecycle', () => {
    const svc = readFileSync(join(BACKEND_SRC, 'modules/assayer/assayer.service.ts'), 'utf8');
    const funnel = svc.slice(svc.indexOf('private async doTransitionLifecycle'));
    const body = funnel.slice(0, funnel.indexOf('\n  /**', 200));
    expect(body).toMatch(/LIFECYCLE_MOVES_NEEDING_A_REASON\.has\(targetStatus\)/);
    // And the row is locked before anything is decided.
    expect(body).toMatch(/FOR UPDATE/);
  });
});
