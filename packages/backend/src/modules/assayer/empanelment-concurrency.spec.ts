import { BadRequestException, ConflictException } from '@nestjs/common';
import { EmpanelmentStatus } from '@fapoms/shared';
import { RosterRecordsService } from './roster-records.service';
import {
  assertEmpanelmentVersion, lockEmpanelmentRow, translateConcurrentEmpanelmentCreate,
} from './empanelment-version';

/**
 * TWO DESKS DECIDING AT ONCE, AND ONLY ONE DECISION SURVIVING.
 *
 * Three concurrent `PUT /assayers/:id/empanelment/:clientId` carrying three DIFFERENT standings
 * all answered **200**. The row kept one; the other two decisions were acknowledged to their
 * authors and discarded. The column that would have caught it — `version` — was on the row from
 * the day it was written, incrementing on every save, and read by nobody.
 *
 * This standing gates assignment eligibility, so the lost decision is not a cosmetic one. A
 * desk's REJECTED overwritten by a concurrent RECOMMENDED makes somebody deployable to a client
 * who declined them, and leaves an `EMPANELMENT_SET` audit row saying it was decided on purpose.
 *
 * ## The invariant these cases hold
 *
 * One writer commits, the stale writer gets a deterministic conflict, **no successful response is
 * ever returned for a decision that was discarded**, and the HTTP result corresponds to the value
 * that is actually persisted.
 *
 * The unit cases below pin the mechanism; the ordering rule — that the lock is taken BEFORE the
 * read — is pinned by `takes the lock before it reads anything`, because that is the half of the
 * pattern which is easy to get wrong and impossible to see in a passing 200.
 */
describe('empanelment version helper', () => {
  const locked = (over: Partial<{ version: number; status: EmpanelmentStatus }> = {}) => ({
    id: 'emp-1',
    version: 3,
    status: EmpanelmentStatus.RECOMMENDED,
    isActive: true,
    ...over,
  });

  describe('assertEmpanelmentVersion', () => {
    it('accepts the version that is actually committed', () => {
      expect(() => assertEmpanelmentVersion(locked(), 3)).not.toThrow();
    });

    /**
     * The refusal that matters most, because it is the one that used to be a 200. A writer that
     * decided against version 1 while version 3 is committed has not seen the standing it is
     * about to overwrite.
     */
    it('refuses a decision taken against an older version, and names both', () => {
      let thrown: any;
      try { assertEmpanelmentVersion(locked(), 1); } catch (e) { thrown = e; }

      expect(thrown).toBeInstanceOf(ConflictException);
      expect(thrown.message).toMatch(/^STALE_EMPANELMENT_VERSION:/);
      expect(thrown.message).toContain('version 3');
      expect(thrown.message).toContain('version 1');
      // It must say the change did not land. "Conflict" alone reads like a retryable hiccup.
      expect(thrown.message).toMatch(/NOT saved/);
    });

    /** The stale message names the standing the writer did not see, so the reload has a point. */
    it('tells a stale writer what the standing now says', () => {
      expect(() => assertEmpanelmentVersion(locked({ status: EmpanelmentStatus.REJECTED }), 1))
        .toThrow(/REJECTED/);
    });

    it('refuses a version from the future, in the other direction', () => {
      let thrown: any;
      try { assertEmpanelmentVersion(locked(), 9); } catch (e) { thrown = e; }

      expect(thrown).toBeInstanceOf(ConflictException);
      expect(thrown.message).toMatch(/^INVALID_EMPANELMENT_VERSION:/);
    });

    /**
     * Absent is refused rather than treated as "whatever is there now". A caller that does not
     * say what it read cannot be checked, and an unchecked write is the defect itself.
     */
    it.each([[undefined], [null]])('refuses an absent expectedVersion (%p)', (v) => {
      let thrown: any;
      try { assertEmpanelmentVersion(locked(), v as any); } catch (e) { thrown = e; }

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect(thrown.message).toMatch(/^MISSING_EXPECTED_VERSION:/);
      expect(thrown.message).toContain('currently 3');
    });

    it.each([[1.5], [NaN], ['3' as any]])('refuses a non-integer version (%p)', (v) => {
      expect(() => assertEmpanelmentVersion(locked(), v as any)).toThrow(BadRequestException);
    });
  });

  describe('translateConcurrentEmpanelmentCreate', () => {
    it('turns the unique violation into the conflict it actually is, not a 500', () => {
      let thrown: any;
      try { translateConcurrentEmpanelmentCreate({ code: '23505' }); } catch (e) { thrown = e; }

      expect(thrown).toBeInstanceOf(ConflictException);
      expect(thrown.message).toMatch(/^STALE_EMPANELMENT_VERSION:/);
      expect(thrown.message).toMatch(/NOT saved/);
    });

    it('reads the code off a wrapped driver error too', () => {
      expect(() => translateConcurrentEmpanelmentCreate({ driverError: { code: '23505' } }))
        .toThrow(ConflictException);
    });

    /** Anything else is somebody else's problem and must not be dressed up as a conflict. */
    it('rethrows an unrelated failure untouched', () => {
      const boom = new Error('connection terminated');
      expect(() => translateConcurrentEmpanelmentCreate(boom)).toThrow(boom);
    });
  });

  describe('lockEmpanelmentRow', () => {
    it('locks the pair for update, and returns the committed version and standing', async () => {
      const query = jest.fn().mockResolvedValue([
        { id: 'emp-1', version: '4', status: EmpanelmentStatus.REJECTED, is_active: false },
      ]);

      const row = await lockEmpanelmentRow({ query } as any, 'a1', 'c1');

      expect(query.mock.calls[0][0]).toMatch(/FOR UPDATE/);
      expect(query.mock.calls[0][1]).toEqual(['a1', 'c1']);
      // Numeric, not the string postgres hands back — `expectedVersion === locked.version` is a
      // strict comparison and '4' === 4 is false, which would refuse every honest writer.
      expect(row).toEqual({
        id: 'emp-1', version: 4, status: EmpanelmentStatus.REJECTED, isActive: false,
      });
    });

    /**
     * No `is_active` filter, deliberately. `removeEmpanelment` withdraws a standing by clearing
     * the flag while the unique constraint still holds the pair, and `setEmpanelment` reinstates
     * that same row. A lock that filtered it would miss the row, take the create path, and turn
     * an ordinary reinstatement into a unique violation.
     */
    it('locks a withdrawn standing too — it is still the row that will be edited', async () => {
      const query = jest.fn().mockResolvedValue([]);
      await lockEmpanelmentRow({ query } as any, 'a1', 'c1');
      expect(query.mock.calls[0][0]).not.toMatch(/is_active\s*=/);
    });

    it('returns null when the pair has no standing yet', async () => {
      expect(await lockEmpanelmentRow({ query: jest.fn().mockResolvedValue([]) } as any, 'a1', 'c1'))
        .toBeNull();
    });
  });
});

/**
 * The write path itself, with a double that records the ORDER of what it was asked to do.
 *
 * Every case here checks the two halves the invariant is made of: what the caller was told, and
 * what the row ended up holding. A test that only asserts the throw would pass against a version
 * check bolted on after the read — which is the bug in a different position.
 */
describe('setEmpanelment under concurrency', () => {
  interface Harness {
    svc: any;
    /** Every `save` the service asked for, in order. */
    saved: any[];
    audits: any[];
    /** Everything the service did, in order, including the lock. */
    trace: string[];
    /** The row the lock finds; mutate it to simulate somebody else committing. */
    row: { id: string; version: number; status: EmpanelmentStatus; is_active: boolean } | null;
  }

  const build = (initial: Harness['row'], opts: { insertRaces?: boolean } = {}): Harness => {
    const h: Partial<Harness> = { saved: [], audits: [], trace: [], row: initial };
    const repo = {
      findOne: jest.fn(async () => { h.trace!.push('repo.findOne'); return null; }),
      findOneOrFail: jest.fn(async () => {
        h.trace!.push('repo.findOneOrFail');
        return {
          id: 'emp-1', assayerId: 'a1', clientId: 'c1',
          version: (h.row?.version ?? 0) + 1,
          status: h.row?.status,
          ...(h.saved!.at(-1) ?? {}),
        };
      }),
      create: jest.fn((v: any) => ({ ...v })),
      save: jest.fn(async (r: any) => {
        h.trace!.push('repo.save');
        if (opts.insertRaces && !h.row) {
          // Somebody else inserted the first standing between our lock and our insert.
          const err: any = new Error('duplicate key value violates unique constraint');
          err.code = '23505';
          throw err;
        }
        h.saved!.push(r);
        if (h.row) h.row.version += 1;
        return { id: 'emp-1', ...r };
      }),
    };
    const svc: any = Object.create(RosterRecordsService.prototype);
    svc.assertOwnedAssayer = jest.fn(async () => { h.trace!.push('assertOwnedAssayer'); });
    svc.empanelments = repo;
    svc.dataSource = {
      transaction: (fn: any) => fn({
        query: jest.fn(async () => {
          h.trace!.push('lock');
          return h.row ? [{ ...h.row }] : [];
        }),
        getRepository: () => repo,
      }),
    };
    svc.auditService = { recordEventSafe: jest.fn(async (e: any) => { h.audits!.push(e); }) };
    h.svc = svc;
    return h as Harness;
  };

  const existing = (status = EmpanelmentStatus.RECOMMENDED, version = 1) =>
    ({ id: 'emp-1', version, status, is_active: true });

  it('saves a decision taken against the current version, and answers with what persisted', async () => {
    const h = build(existing(EmpanelmentStatus.RECOMMENDED, 1));

    const out = await h.svc.setEmpanelment(
      'a1', 'c1', { status: EmpanelmentStatus.ACTIVE, expectedVersion: 1 }, 'desk-1',
    );

    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].status).toBe(EmpanelmentStatus.ACTIVE);
    // The response is the re-read row, not the in-memory entity handed to `save`.
    expect(out.status).toBe(EmpanelmentStatus.ACTIVE);
    expect(h.trace.filter((t) => t === 'repo.findOneOrFail')).toHaveLength(2);
  });

  /**
   * THE ORDERING RULE, pinned on its own.
   *
   * `FOR UPDATE` first, entity second. Reading the entity first and locking afterwards leaves a
   * window in which the in-memory copy is already stale, and the save writes `stale + 1` straight
   * over the winner — a 200 for a decision nobody will ever see. The trace is the only way to
   * tell the two implementations apart from outside.
   */
  it('takes the lock before it reads anything', async () => {
    const h = build(existing());

    await h.svc.setEmpanelment('a1', 'c1', { status: EmpanelmentStatus.ACTIVE, expectedVersion: 1 }, 'desk-1');

    expect(h.trace.indexOf('lock')).toBeLessThan(h.trace.indexOf('repo.findOneOrFail'));
    // And nothing loaded the row through the unlocked reader on the way past.
    expect(h.trace).not.toContain('repo.findOne');
  });

  /** The tenancy check still comes before the write — an unscoped id must not reach the lock. */
  it('asserts ownership before it locks anything', async () => {
    const h = build(existing());
    await h.svc.setEmpanelment('a1', 'c1', { status: EmpanelmentStatus.ACTIVE, expectedVersion: 1 }, 'desk-1');
    expect(h.trace.indexOf('assertOwnedAssayer')).toBeLessThan(h.trace.indexOf('lock'));
  });

  /**
   * The reproduction, sequenced: the second desk decided against version 1, but the first desk's
   * REJECTED committed as version 2 in between. The second must be refused, and the row must
   * still say REJECTED.
   */
  it('refuses the stale writer and keeps the committed decision', async () => {
    const h = build(existing(EmpanelmentStatus.RECOMMENDED, 1));

    await h.svc.setEmpanelment('a1', 'c1', { status: EmpanelmentStatus.REJECTED, expectedVersion: 1 }, 'desk-1');
    h.row!.status = EmpanelmentStatus.REJECTED;

    await expect(h.svc.setEmpanelment(
      'a1', 'c1', { status: EmpanelmentStatus.RECOMMENDED, expectedVersion: 1 }, 'desk-2',
    )).rejects.toThrow(/STALE_EMPANELMENT_VERSION/);

    expect(h.saved).toHaveLength(1);
    expect(h.row!.status).toBe(EmpanelmentStatus.REJECTED);
    // And the discarded decision left no audit row claiming it happened.
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].newState).toBe(EmpanelmentStatus.REJECTED);
  });

  it('refuses a change to an existing standing that does not say what it read', async () => {
    const h = build(existing());

    await expect(h.svc.setEmpanelment('a1', 'c1', { status: EmpanelmentStatus.ACTIVE }, 'desk-1'))
      .rejects.toThrow(/MISSING_EXPECTED_VERSION/);

    expect(h.saved).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  /** A retry with the version the reload handed back is an ordinary write, not a special case. */
  it('lets the refused writer succeed on the version it reloaded', async () => {
    const h = build(existing(EmpanelmentStatus.RECOMMENDED, 1));

    await expect(h.svc.setEmpanelment(
      'a1', 'c1', { status: EmpanelmentStatus.ACTIVE, expectedVersion: 0 }, 'desk-2',
    )).rejects.toThrow(/STALE_EMPANELMENT_VERSION/);

    const out = await h.svc.setEmpanelment(
      'a1', 'c1', { status: EmpanelmentStatus.ACTIVE, expectedVersion: 1 }, 'desk-2',
    );

    expect(out.status).toBe(EmpanelmentStatus.ACTIVE);
    expect(h.saved).toHaveLength(1);
  });

  /**
   * The create race. There is no row to lock, so both callers get past the lock and the unique
   * constraint picks the winner. The loser used to receive a redacted **500**, which is the same
   * lie in a different costume — and a 500 invites the retry that would overwrite the winner.
   */
  it('turns the create race into a conflict rather than a 500', async () => {
    const h = build(null, { insertRaces: true });

    let thrown: any;
    try {
      await h.svc.setEmpanelment('a1', 'c1', { status: EmpanelmentStatus.ACTIVE }, 'desk-2');
    } catch (e) { thrown = e; }

    expect(thrown).toBeInstanceOf(ConflictException);
    expect(thrown.message).toMatch(/^STALE_EMPANELMENT_VERSION/);
    expect(h.saved).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it('creates the first standing without demanding a version', async () => {
    const h = build(null);

    const out = await h.svc.setEmpanelment('a1', 'c1', { status: EmpanelmentStatus.ACTIVE }, 'desk-1');

    expect(out.status).toBe(EmpanelmentStatus.ACTIVE);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0].previousState).toBeUndefined();
  });

  /**
   * Two callers sending the SAME standing at once is still a lost update — the second decision
   * was taken without seeing the first — but it is the harmless one, and it must be refused for
   * the same reason rather than special-cased into a success. "It happened to agree" is not
   * something the server can know: the reason, the outstanding documents and the client reference
   * all travel on the same request and none of them are compared.
   */
  it('refuses the stale writer even when the two standings agree', async () => {
    const h = build(existing(EmpanelmentStatus.RECOMMENDED, 1));

    await h.svc.setEmpanelment('a1', 'c1', { status: EmpanelmentStatus.ACTIVE, expectedVersion: 1 }, 'desk-1');

    await expect(h.svc.setEmpanelment(
      'a1', 'c1', { status: EmpanelmentStatus.ACTIVE, expectedVersion: 1 }, 'desk-2',
    )).rejects.toThrow(/STALE_EMPANELMENT_VERSION/);

    expect(h.saved).toHaveLength(1);
  });

  /**
   * The reversal guard is answered from the LOCKED status, not from a copy read before it.
   *
   * A writer that loaded RECOMMENDED at version 1 and submits ACTIVE is stale the moment somebody
   * commits REJECTED as version 2 — and the version check catches it first, which is the right
   * order: it is told it is behind, not lectured about a reversal it never saw.
   */
  it('does not let a concurrent rejection be reversed without a reason', async () => {
    const h = build(existing(EmpanelmentStatus.RECOMMENDED, 1));

    h.row!.status = EmpanelmentStatus.REJECTED;
    h.row!.version = 2;

    await expect(h.svc.setEmpanelment(
      'a1', 'c1', { status: EmpanelmentStatus.ACTIVE, expectedVersion: 1 }, 'desk-2',
    )).rejects.toThrow(/STALE_EMPANELMENT_VERSION/);

    // Reloaded, the same writer now sees REJECTED and is asked for the reason it always owed.
    await expect(h.svc.setEmpanelment(
      'a1', 'c1', { status: EmpanelmentStatus.ACTIVE, expectedVersion: 2 }, 'desk-2',
    )).rejects.toThrow(/why this client's rejection is being reversed/i);

    expect(h.saved).toHaveLength(0);
    expect(h.row!.status).toBe(EmpanelmentStatus.REJECTED);
  });

  /** A hard-block standing is not exempt from the version rule, in either direction. */
  it('holds the version rule for a hard-block standing too', async () => {
    const h = build(existing(EmpanelmentStatus.ACTIVE, 1));

    await expect(h.svc.setEmpanelment(
      'a1', 'c1', { status: EmpanelmentStatus.TERMINATED, expectedVersion: 0 }, 'desk-2',
    )).rejects.toThrow(/STALE_EMPANELMENT_VERSION/);

    const out = await h.svc.setEmpanelment(
      'a1', 'c1', { status: EmpanelmentStatus.TERMINATED, expectedVersion: 1, statusReason: 'Fake not identified' }, 'desk-1',
    );
    expect(out.status).toBe(EmpanelmentStatus.TERMINATED);
  });

  /** The audit row records the version the decision committed as, so a lost update is visible. */
  it('records the committed version on the audit row', async () => {
    const h = build(existing(EmpanelmentStatus.RECOMMENDED, 1));

    await h.svc.setEmpanelment('a1', 'c1', { status: EmpanelmentStatus.ACTIVE, expectedVersion: 1 }, 'desk-1');

    expect(h.audits[0].metadata.newValue.version).toBe(2);
    expect(h.audits[0].metadata.previousValue).toEqual({ status: EmpanelmentStatus.RECOMMENDED });
  });
});
