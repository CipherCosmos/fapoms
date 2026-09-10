import { EmpanelmentStatus } from '@fapoms/shared';
import { RosterRecordsService } from './roster-records.service';

/**
 * Reversing a client's rejection is allowed, and has to be said out loud.
 *
 * The business decision (2026-09-10) was that `REJECTED` stays reversible rather than terminal: a
 * client changing its mind is ordinary, and making the standing terminal would push the correction
 * into a database edit where nobody would see it. So the rule is not a state machine — it is that
 * this one transition, the one that overturns somebody else's decision, carries a reason.
 *
 * These cases pin the shape of that, in both directions: the reversal that must be refused without
 * a reason, and the ordinary standing changes that must NOT suddenly start demanding one. The
 * second half matters more than it looks — a guard that quietly makes every empanelment edit
 * require prose is a worse outcome than the thing it was added for.
 */
describe('reversing a client rejection', () => {
  /** The service with only the collaborators this path touches. */
  const build = (existingStatus: EmpanelmentStatus | null) => {
    const saved: any[] = [];
    const audits: any[] = [];
    const svc: any = Object.create(RosterRecordsService.prototype);
    svc.assertOwnedAssayer = jest.fn().mockResolvedValue(undefined);
    svc.empanelments = {
      findOne: jest.fn().mockResolvedValue(
        existingStatus === null ? null : { assayerId: 'a1', clientId: 'c1', status: existingStatus },
      ),
      create: jest.fn((v: any) => ({ ...v })),
      save: jest.fn(async (row: any) => { saved.push(row); return row; }),
    };
    svc.auditService = { recordEventSafe: jest.fn(async (e: any) => { audits.push(e); }) };
    return { svc, saved, audits };
  };

  const set = (svc: any, status: EmpanelmentStatus, statusReason?: string) =>
    svc.setEmpanelment('a1', 'c1', { status, statusReason }, 'actor-1');

  it('refuses to lift a rejection with no reason, and writes nothing', async () => {
    const { svc, saved, audits } = build(EmpanelmentStatus.REJECTED);

    await expect(set(svc, EmpanelmentStatus.ACTIVE)).rejects.toThrow(/why this client's rejection is being reversed/i);

    expect(saved).toHaveLength(0);
    expect(audits).toHaveLength(0);
  });

  it('treats whitespace as no reason at all', async () => {
    const { svc, saved } = build(EmpanelmentStatus.REJECTED);

    await expect(set(svc, EmpanelmentStatus.ACTIVE, '   \n\t ')).rejects.toThrow(/reversed/i);

    expect(saved).toHaveLength(0);
  });

  it('allows the reversal when somebody says why, and the reason reaches the audit trail', async () => {
    const { svc, saved, audits } = build(EmpanelmentStatus.REJECTED);

    await set(svc, EmpanelmentStatus.ACTIVE, 'Client confirmed in writing that the earlier rejection was an error.');

    expect(saved).toHaveLength(1);
    expect(saved[0].status).toBe(EmpanelmentStatus.ACTIVE);
    expect(audits).toHaveLength(1);
    expect(audits[0].previousState).toBe(EmpanelmentStatus.REJECTED);
    expect(audits[0].newState).toBe(EmpanelmentStatus.ACTIVE);
    expect(audits[0].userId).toBe('actor-1');
    expect(audits[0].remarks).toMatch(/earlier rejection was an error/);
  });

  it('still lets a rejection be restated without ceremony', async () => {
    // REJECTED -> REJECTED overturns nothing, so it is not the transition the rule is about.
    const { svc, saved } = build(EmpanelmentStatus.REJECTED);

    await set(svc, EmpanelmentStatus.REJECTED);

    expect(saved).toHaveLength(1);
  });

  it.each([
    [EmpanelmentStatus.RECOMMENDED, EmpanelmentStatus.ACTIVE],
    [EmpanelmentStatus.ACTIVE, EmpanelmentStatus.INACTIVE],
    [EmpanelmentStatus.DOCUMENTS_PENDING, EmpanelmentStatus.ACTIVE],
    [EmpanelmentStatus.NOT_RECOMMENDED, EmpanelmentStatus.RECOMMENDED],
  ])('leaves an ordinary %s -> %s change alone', async (from, to) => {
    const { svc, saved } = build(from);

    await set(svc, to);

    expect(saved).toHaveLength(1);
    expect(saved[0].status).toBe(to);
  });

  it('does not demand a reason for a first standing, when there is nothing to overturn', async () => {
    const { svc, saved } = build(null);

    await set(svc, EmpanelmentStatus.ACTIVE);

    expect(saved).toHaveLength(1);
  });
});
