import {
  DAY_TRAVEL_REBALANCE_MARKER,
  DayTravelRow,
  DayTravelService,
  carriesDayTravel,
  dayTravelHold,
  isSystemQuotedFee,
  planDayTravel,
} from './assignment-day-travel';

/**
 * Travel once per assayer per day, AFTER the day changes (owner decision 2026-09-24, E2).
 *
 * When the job carrying the day's journey stops being live for that assayer on that day —
 * declined, auto-declined, cancelled (closure cascades included), reassigned away, or moved to
 * another date — the next live job that day takes the journey over; a job moved onto a day that
 * already carries travel drops to base only. Only a system-quoted fee whose money is not frozen is
 * ever moved. The rule is `planDayTravel`; `DayTravelService.rebalance` applies it under the lock.
 */

const row = (over: Partial<DayTravelRow> & { id: string }): DayTravelRow => ({
  createdAt: '2026-10-01T09:00:00Z',
  proposedFee: 1200,
  agreedFee: 1200,
  quotedBaseFee: 1200,
  quotedTravelFee: 0,
  counterTravelFee: null,
  quotedDistanceKm: 40,
  payableFrozen: false,
  clientLineFrozen: false,
  ...over,
});
/** A job carrying ₹300 travel on a ₹1,200 base, at the quote. */
const carrier = (over: Partial<DayTravelRow> & { id: string }) =>
  row({ proposedFee: 1500, agreedFee: 1500, quotedTravelFee: 300, ...over });

describe('isSystemQuotedFee — whose number is this fee?', () => {
  it('a fee equal to its own frozen quote (base + travel) is the calculator\'s', () => {
    expect(isSystemQuotedFee(carrier({ id: 'a' }))).toBe(true);
    expect(isSystemQuotedFee(row({ id: 'b' }))).toBe(true);
    // decimals as Postgres returns them
    expect(isSystemQuotedFee(row({ id: 'c', proposedFee: '1500.00', agreedFee: '1500.00', quotedTravelFee: '300.00' }))).toBe(true);
  });

  it('a fee the desk typed is not', () => {
    expect(isSystemQuotedFee(carrier({ id: 'a', proposedFee: 1700, agreedFee: 1700 }))).toBe(false);
  });

  it('two fee columns that disagree were edited by hand', () => {
    expect(isSystemQuotedFee(carrier({ id: 'a', proposedFee: 1400, agreedFee: 1500 }))).toBe(false);
  });

  it('a countered travel figure, or no quote on file, is never treated as the calculator\'s', () => {
    expect(isSystemQuotedFee(carrier({ id: 'a', counterTravelFee: 300 }))).toBe(false);
    expect(isSystemQuotedFee(row({ id: 'b', quotedBaseFee: null }))).toBe(false);
    expect(isSystemQuotedFee(row({ id: 'c', proposedFee: null, agreedFee: null }))).toBe(false);
  });
});

describe('dayTravelHold — the money gates', () => {
  it('a payout that is approved, paid, part-paid or on a sent bill is frozen', () => {
    expect(dayTravelHold(carrier({ id: 'a', payableFrozen: true }))).toBe('PAYOUT_FROZEN');
  });
  it('a client line already on an invoice is frozen', () => {
    expect(dayTravelHold(carrier({ id: 'a', clientLineFrozen: true }))).toBe('CLIENT_INVOICED');
  });
  it('a desk-typed fee is held', () => {
    expect(dayTravelHold(carrier({ id: 'a', proposedFee: 1800, agreedFee: 1800 }))).toBe('DESK_TYPED_FEE');
  });
  it('a system-quoted, unfrozen job may move', () => {
    expect(dayTravelHold(carrier({ id: 'a' }))).toBeNull();
  });
});

describe('carriesDayTravel — countered before quoted, like assignmentMoney', () => {
  it('reads the countered figure when there is one, even zero', () => {
    expect(carriesDayTravel({ counterTravelFee: 0, quotedTravelFee: 300 })).toBe(false);
    expect(carriesDayTravel({ counterTravelFee: null, quotedTravelFee: 300 })).toBe(true);
    expect(carriesDayTravel({ counterTravelFee: null, quotedTravelFee: null })).toBe(false);
  });
});

describe('planDayTravel — the rule', () => {
  const quotes = (entries: Array<[string, number]>) => new Map(entries);

  describe('the job carrying the journey is gone', () => {
    it('the next live job that day — earliest by creation — takes the journey over', () => {
      const plan = planDayTravel([
        row({ id: 'late', createdAt: '2026-10-01T11:00:00Z' }),
        row({ id: 'early', createdAt: '2026-10-01T10:00:00Z' }),
      ], { fullTravel: quotes([['early', 300], ['late', 250]]) });
      expect(plan).toEqual({ give: 'early', drop: [], held: [], needsQuote: [] });
    });

    it('ties on creation time are broken by id, so the choice never depends on read order', () => {
      const same = '2026-10-01T10:00:00Z';
      const a = planDayTravel([row({ id: 'b', createdAt: same }), row({ id: 'a', createdAt: same })], { fullTravel: quotes([['a', 300], ['b', 300]]) });
      const b = planDayTravel([row({ id: 'a', createdAt: same }), row({ id: 'b', createdAt: same })], { fullTravel: quotes([['a', 300], ['b', 300]]) });
      expect(a.give).toBe('a');
      expect(b.give).toBe('a');
    });

    it('asks for the quote it needs before deciding, and decides nothing else', () => {
      const plan = planDayTravel([row({ id: 'x' })], { fullTravel: quotes([]) });
      expect(plan).toEqual({ give: null, drop: [], held: [], needsQuote: ['x'] });
    });

    it('never skips past the desk\'s number: a desk-typed next job leaves the day alone, and says so', () => {
      const plan = planDayTravel([
        row({ id: 'typed', createdAt: '2026-10-01T10:00:00Z', proposedFee: 2000, agreedFee: 2000 }),
        row({ id: 'quoted', createdAt: '2026-10-01T11:00:00Z' }),
      ], { fullTravel: quotes([['quoted', 300]]) });
      expect(plan.give).toBeNull();
      expect(plan.held).toEqual([{ id: 'typed', why: 'DESK_TYPED_FEE' }]);
    });

    it('never re-prices a job whose payout is frozen', () => {
      const plan = planDayTravel([row({ id: 'paid', payableFrozen: true })], { fullTravel: quotes([['paid', 300]]) });
      expect(plan.give).toBeNull();
      expect(plan.held).toEqual([{ id: 'paid', why: 'PAYOUT_FROZEN' }]);
    });

    it('a job inside the free commute (no travel on its full quote) passes the turn to the next', () => {
      const plan = planDayTravel([
        row({ id: 'near', createdAt: '2026-10-01T10:00:00Z' }),
        row({ id: 'far', createdAt: '2026-10-01T11:00:00Z' }),
      ], { fullTravel: quotes([['near', 0], ['far', 400]]) });
      expect(plan.give).toBe('far');
    });

    it('a job with no measured distance (routing was down) is not handed a journey', () => {
      const plan = planDayTravel([row({ id: 'nodist', quotedDistanceKm: null })], { fullTravel: quotes([]) });
      expect(plan).toEqual({ give: null, drop: [], held: [], needsQuote: [] });
    });
  });

  it('exactly one job carrying travel is left alone', () => {
    const plan = planDayTravel([carrier({ id: 'a' }), row({ id: 'b' })], { fullTravel: quotes([]) });
    expect(plan).toEqual({ give: null, drop: [], held: [], needsQuote: [] });
  });

  describe('two jobs carry the journey (one was moved onto the day)', () => {
    it('the job that arrived drops to base only — even when it was created first', () => {
      const plan = planDayTravel([
        carrier({ id: 'moved', createdAt: '2026-09-01T10:00:00Z' }),
        carrier({ id: 'incumbent', createdAt: '2026-10-01T10:00:00Z' }),
      ], { arrivingId: 'moved', fullTravel: quotes([]) });
      expect(plan.drop).toEqual(['moved']);
    });

    it('with no arrival named, the earliest keeps it', () => {
      const plan = planDayTravel([
        carrier({ id: 'second', createdAt: '2026-10-01T11:00:00Z' }),
        carrier({ id: 'first', createdAt: '2026-10-01T10:00:00Z' }),
      ], { fullTravel: quotes([]) });
      expect(plan.drop).toEqual(['second']);
    });

    it('a carrier that cannot move keeps the journey; the one that can drops', () => {
      const plan = planDayTravel([
        carrier({ id: 'incumbent', createdAt: '2026-10-01T10:00:00Z' }),
        carrier({ id: 'moved-typed', createdAt: '2026-10-01T11:00:00Z', proposedFee: 1900, agreedFee: 1900 }),
      ], { arrivingId: 'moved-typed', fullTravel: quotes([]) });
      expect(plan.drop).toEqual(['incumbent']);
      expect(plan.held).toEqual([]);
    });

    it('two that cannot move are both left, and reported', () => {
      const plan = planDayTravel([
        carrier({ id: 'a', createdAt: '2026-10-01T10:00:00Z', payableFrozen: true }),
        carrier({ id: 'b', createdAt: '2026-10-01T11:00:00Z', proposedFee: 1900, agreedFee: 1900 }),
      ], { fullTravel: quotes([]) });
      expect(plan.drop).toEqual([]);
      expect(plan.held).toEqual([{ id: 'b', why: 'DESK_TYPED_FEE' }]);
    });
  });
});

describe('DayTravelService.rebalance — applies the rule under the assayer lock, after the change committed', () => {
  const make = (dayRows: any[], opts: { quoteTravel?: number; failQuote?: boolean } = {}) => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const emitted: Array<{ event: string; payload: any }> = [];
    const manager = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        if (sql.includes(DAY_TRAVEL_REBALANCE_MARKER)) return dayRows;
        return [];
      }),
    };
    const uow = { run: jest.fn(async (work: any) => work(manager, (event: string, payload: any) => emitted.push({ event, payload }))) };
    const feePolicy = {
      quote: jest.fn(async () => {
        if (opts.failQuote) throw new Error('rate card unreachable');
        return { travelFee: opts.quoteTravel ?? 300, transport: { recommended: { mode: 'BUS' } } };
      }),
    };
    const auditService = { recordEventSafe: jest.fn() };
    const refreshPush = { assignmentChanged: jest.fn() };
    const svc = new DayTravelService(uow as any, feePolicy as any, auditService as any, refreshPush as any);
    return { svc, calls, emitted, feePolicy, auditService, refreshPush, uow };
  };
  const dbRow = (over: any) => ({
    id: 'x', assignment_number: 'ASN-X', created_at: '2026-10-01T10:00:00Z',
    proposed_fee: '1200.00', agreed_fee: '1200.00', quoted_base_fee: '1200.00', quoted_travel_fee: '0.00',
    counter_travel_fee: null, quoted_distance_km: '40.00', client_id: 'cl-1', state: 'Kerala', region: 'South',
    payable_frozen: false, client_line_frozen: false,
    ...over,
  });

  it('hands the journey to the next job: base + full travel on both fee columns, audited, fee-updated emitted', async () => {
    const { svc, calls, emitted, feePolicy, auditService, refreshPush } = make([dbRow({ id: 'next', assignment_number: 'ASN-2' })]);
    const out = await svc.rebalance({ assayerId: 'as-1', day: '2026-10-05', userId: 'ops-1', reason: 'ASN-1 was declined' });

    expect(out.changed).toEqual([{ assignmentId: 'next', assignmentNumber: 'ASN-2', change: 'GAINED_TRAVEL', proposedFee: 1500, travelFee: 300 }]);
    // Quoted from the job's own recorded distance, place and day.
    expect(feePolicy.quote).toHaveBeenCalledWith(expect.objectContaining({
      assayerId: 'as-1', clientId: 'cl-1', distanceKm: 40, place: { state: 'Kerala', region: 'South' },
    }));
    const update = calls.find((c) => /UPDATE assignments/.test(c.sql))!;
    expect(update.params).toEqual(['next', 1500, 300, 'BUS', 'ops-1']);
    expect(update.sql).toMatch(/proposed_fee = \$2, agreed_fee = \$2/);
    expect(update.sql).toMatch(/entity_version = COALESCE\(entity_version, 1\) \+ 1/);
    expect(emitted).toEqual([expect.objectContaining({ event: 'assignment:fee-updated', payload: expect.objectContaining({ assignmentId: 'next', proposedFee: 1500, agreedFee: 1500 }) })]);
    expect(auditService.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'ASSIGNMENT_DAY_TRAVEL_REPRICED', entityId: 'next' }), expect.anything());
    expect(refreshPush.assignmentChanged).toHaveBeenCalledWith('as-1', 'next');
  });

  it('locks the assayer row BEFORE reading the day FOR UPDATE — the same lock create() and reassign take', async () => {
    const { svc, calls } = make([dbRow({ id: 'next' })]);
    await svc.rebalance({ assayerId: 'as-1', day: '2026-10-05', userId: 'ops-1', reason: 'r' });
    const lockAt = calls.findIndex((c) => /FROM assayers WHERE id = \$1 FOR UPDATE/.test(c.sql));
    const lockedReadAt = calls.findIndex((c) => c.sql.includes(DAY_TRAVEL_REBALANCE_MARKER) && /FOR UPDATE OF a/.test(c.sql));
    expect(lockAt).toBeGreaterThanOrEqual(0);
    expect(lockedReadAt).toBeGreaterThan(lockAt);
    expect(calls[lockAt].params).toEqual(['as-1']);
  });

  it('reads only live, active jobs of that assayer on that business day, with the money gates', async () => {
    const { svc, calls } = make([]);
    await svc.rebalance({ assayerId: 'as-1', day: '2026-10-05T20:00:00+05:30', userId: 'ops-1', reason: 'r' });
    const read = calls.find((c) => c.sql.includes(DAY_TRAVEL_REBALANCE_MARKER))!;
    expect(read.params).toEqual(['as-1', '2026-10-05']);
    for (const s of ['PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS', 'COMPLETED']) expect(read.sql).toContain(`'${s}'`);
    for (const s of ['REJECTED', 'CANCELLED']) expect(read.sql).not.toMatch(new RegExp(`a\\.status IN \\([^)]*'${s}'`));
    expect(read.sql).toMatch(/a\.is_active = true/);
    // A payout approved/paid/part-paid or on a SUBMITTED/APPROVED/PAID bill; a client line INVOICED/PAID.
    expect(read.sql).toMatch(/ap\.status IN \('APPROVED','PAID'\)/);
    expect(read.sql).toMatch(/ai\.status IN \('SUBMITTED','APPROVED','HOD_APPROVED','PAID'\)/);
    expect(read.sql).toMatch(/be\.state IN \('INVOICED','PAID'\)/);
    expect(read.sql).toMatch(/ORDER BY a\.created_at, a\.id/);
  });

  it('drops the job that arrived on a day already carrying travel to base only', async () => {
    const { svc, calls, emitted, feePolicy } = make([
      dbRow({ id: 'incumbent', created_at: '2026-10-01T10:00:00Z', proposed_fee: '1500.00', agreed_fee: '1500.00', quoted_travel_fee: '300.00' }),
      dbRow({ id: 'moved', created_at: '2026-09-01T10:00:00Z', proposed_fee: '1450.00', agreed_fee: '1450.00', quoted_travel_fee: '250.00' }),
    ]);
    const out = await svc.rebalance({ assayerId: 'as-1', day: '2026-10-05', userId: 'ops-1', reason: 'moved', arrivingAssignmentId: 'moved' });
    expect(out.changed).toEqual([expect.objectContaining({ assignmentId: 'moved', change: 'DROPPED_TRAVEL', proposedFee: 1200, travelFee: 0 })]);
    expect(calls.find((c) => /UPDATE assignments/.test(c.sql))!.params).toEqual(['moved', 1200, 0, null, 'ops-1']);
    expect(emitted).toHaveLength(1);
    expect(feePolicy.quote).not.toHaveBeenCalled();
  });

  it('touches nothing when a desk-typed fee is next in line', async () => {
    const { svc, calls, emitted } = make([dbRow({ id: 'typed', proposed_fee: '2000.00', agreed_fee: '2000.00' })]);
    const out = await svc.rebalance({ assayerId: 'as-1', day: '2026-10-05', userId: 'ops-1', reason: 'r' });
    expect(out).toEqual({ changed: [], held: [{ id: 'typed', why: 'DESK_TYPED_FEE' }] });
    expect(calls.some((c) => /UPDATE assignments/.test(c.sql))).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it('touches nothing when the payout is already on a sent bill', async () => {
    const { svc, calls } = make([dbRow({ id: 'billed', payable_frozen: true })]);
    const out = await svc.rebalance({ assayerId: 'as-1', day: '2026-10-05', userId: 'ops-1', reason: 'r' });
    expect(out.held).toEqual([{ id: 'billed', why: 'PAYOUT_FROZEN' }]);
    expect(calls.some((c) => /UPDATE assignments/.test(c.sql))).toBe(false);
  });

  it('never throws — a pricing failure is logged and the triggering change stands', async () => {
    const { svc, calls } = make([dbRow({ id: 'next' })], { failQuote: true });
    await expect(svc.rebalance({ assayerId: 'as-1', day: '2026-10-05', userId: 'ops-1', reason: 'r' })).resolves.toEqual({ changed: [], held: [] });
    expect(calls.some((c) => /UPDATE assignments/.test(c.sql))).toBe(false);
  });

  it('does nothing without an assayer or a day', async () => {
    const { svc, uow } = make([dbRow({ id: 'next' })]);
    await svc.rebalance({ assayerId: null, day: '2026-10-05', userId: 'ops-1', reason: 'r' });
    await svc.rebalance({ assayerId: 'as-1', day: null, userId: 'ops-1', reason: 'r' });
    expect(uow.run).not.toHaveBeenCalled();
  });

  it('rebalanceMany re-decides each (assayer, day) once', async () => {
    const { svc } = make([]);
    const spy = jest.spyOn(svc, 'rebalance');
    await svc.rebalanceMany([
      { assayerId: 'as-1', day: '2026-10-05' },
      { assayerId: 'as-1', day: '2026-10-05T12:00:00+05:30' },
      { assayerId: 'as-2', day: '2026-10-05' },
      { assayerId: null, day: '2026-10-05' },
    ], 'ops-1', 'closure');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
