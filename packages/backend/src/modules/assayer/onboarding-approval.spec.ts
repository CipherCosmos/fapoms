import { ConflictException, ForbiddenException } from '@nestjs/common';
import { AssayerLifecycleStatus, OnboardingApprovalEventKind as K, OnboardingApprovalStatus as S } from '@fapoms/shared';
import { OnboardingApprovalService } from './onboarding-approval.service';

/**
 * THE APPROVAL BEFORE TRAINING (owner, 2026-09-23).
 *
 * A senior approves, rejects with a reason, or asks HR for more. Whoever sent the file up — or
 * answered on it — may not decide it. Every step is on the round's conversation and the audit trail.
 */
describe('the approval before training', () => {
  const HR = { id: 'hr-1', name: 'Asha (HR)' };
  const BOSS = { id: 'boss-1', name: 'Rao (Head)' };

  const setup = (over: { lifecycle?: AssayerLifecycleStatus; round?: Record<string, unknown> } = {}) => {
    const rounds: any[] = [{
      id: 'r-1', assayerId: 'a-1', round: 1, status: S.PENDING, submittedBy: HR.id, decidedBy: null, decidedAt: null,
      events: [{ kind: K.SUBMITTED, byId: HR.id, byName: null, at: '2026-09-23T10:00:00Z', text: 'All checks clear.' }],
      ...over.round,
    }];
    const match = (row: any, where: any) => Object.entries(where).every(([k, v]) => row[k] === v);
    const repo = {
      find: jest.fn(async ({ where }: any) => rounds.filter((r) => (Array.isArray(where) ? where : [where]).some((w: any) => match(r, w)))),
      findOne: jest.fn(async ({ where }: any) => rounds.find((r) => (Array.isArray(where) ? where : [where]).some((w: any) => match(r, w))) ?? null),
      save: jest.fn(async (r: any) => r),
    };
    const manager = {
      getRepository: () => repo,
      query: jest.fn(async () => [{ id: HR.id, display_name: 'Asha Menon' }]),
    };
    const unitOfWork = { run: jest.fn(async (work: any) => work(manager, jest.fn())) };
    const lifecycle = over.lifecycle ?? AssayerLifecycleStatus.FINAL_APPROVAL;
    const assayerService = {
      findOne: jest.fn(async () => ({ id: 'a-1', displayName: 'Ramesh Kumar', lifecycleStatus: lifecycle })),
      decideFinalApproval: jest.fn(async (_id: string, _d: string, _u: string, _r: string, inTx: any) => {
        await inTx(manager, { id: 'a-1' });
        return { id: 'a-1' };
      }),
    };
    const auditService = { recordEventSafe: jest.fn(async () => undefined) };
    const notifications = { emitSafe: jest.fn() };
    const service = new OnboardingApprovalService(assayerService as any, auditService as any, unitOfWork as any, notifications as any);
    return { service, rounds, assayerService, auditService, notifications };
  };

  it('approves: on to training, and the decision is on the round and the trail', async () => {
    const { service, rounds, assayerService, auditService } = setup();
    const view = await service.approve('a-1', 'Good file.', BOSS);

    expect(assayerService.decideFinalApproval).toHaveBeenCalledWith('a-1', 'APPROVED', BOSS.id, 'Approved to join: Good file.', expect.any(Function));
    expect(rounds[0]).toMatchObject({ status: S.APPROVED, decidedBy: BOSS.id });
    expect(view.events.map((e) => e.kind)).toEqual([K.SUBMITTED, K.APPROVED]);
    // The name the lifecycle could not know is filled in on the way out.
    expect(view.events[0].byName).toBe('Asha Menon');
    expect(auditService.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'ASSAYER_APPROVAL_APPROVED', newState: AssayerLifecycleStatus.TRAINING,
    }));
  });

  it('rejects only with a reason, and keeps it', async () => {
    const { service, rounds, assayerService } = setup();
    await expect(service.reject('a-1', 'no', BOSS)).rejects.toThrow(/Say why/);
    expect(assayerService.decideFinalApproval).not.toHaveBeenCalled();

    await service.reject('a-1', 'Declared experience could not be confirmed with two employers.', BOSS);
    expect(assayerService.decideFinalApproval).toHaveBeenCalledWith(
      'a-1', 'REJECTED', BOSS.id, expect.stringMatching(/Not approved: Declared experience/), expect.any(Function),
    );
    expect(rounds[0].status).toBe(S.REJECTED);
    expect(rounds[0].events.at(-1)).toMatchObject({ kind: K.REJECTED, text: expect.stringMatching(/two employers/) });
  });

  it('will not let the person who sent it up decide it', async () => {
    const { service, assayerService } = setup();
    await expect(service.approve('a-1', null, HR)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.requestInfo('a-1', 'Which branch did they train at?', HR)).rejects.toBeInstanceOf(ForbiddenException);
    expect(assayerService.decideFinalApproval).not.toHaveBeenCalled();
  });

  it('asks HR for more, takes their answer, and then counts the answerer as a preparer too', async () => {
    const { service, rounds } = setup();
    await service.requestInfo('a-1', 'Upload the previous employer\'s relieving letter.', BOSS);
    expect(rounds[0].status).toBe(S.INFO_REQUESTED);
    // Asked once; wait for the answer before asking again.
    await expect(service.requestInfo('a-1', 'And one more thing please.', BOSS)).rejects.toBeInstanceOf(ConflictException);

    const other = { id: 'hr-2', name: 'Vikram (HR)' };
    await service.answer('a-1', 'Uploaded to Documents as the experience letter.', other);
    expect(rounds[0].status).toBe(S.PENDING);
    expect(rounds[0].events.map((e: any) => e.kind)).toEqual([K.SUBMITTED, K.INFO_REQUESTED, K.ANSWERED]);

    await expect(service.approve('a-1', null, other)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.approve('a-1', null, BOSS)).resolves.toMatchObject({ status: S.APPROVED });
  });

  it('tells the approvers when HR has answered — it is back with them', async () => {
    const { service, notifications } = setup({ round: { status: S.INFO_REQUESTED } });
    await service.answer('a-1', 'Uploaded the relieving letter to Documents.', HR);

    expect(notifications.emitSafe).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ASSAYER_APPROVAL_ANSWERED',
      actorUserId: HR.id,
      assayerId: 'a-1',
      payload: expect.objectContaining({ assayerName: 'Ramesh Kumar', answeredBy: HR.name, answer: 'Uploaded the relieving letter to Documents.' }),
    }));
  });

  it('has nothing to answer when nothing was asked', async () => {
    const { service } = setup();
    await expect(service.answer('a-1', 'Here is the thing you asked for.', HR)).rejects.toThrow(/nothing to answer/);
  });

  it('will not decide somebody who is not awaiting approval', async () => {
    const { service } = setup({ lifecycle: AssayerLifecycleStatus.TRAINING });
    await expect(service.approve('a-1', null, BOSS)).rejects.toThrow(/not awaiting approval/);
  });

  it('will not decide the same round twice', async () => {
    const { service, rounds } = setup();
    const decide = (service as any).assayerService.decideFinalApproval;
    decide.mockImplementationOnce(async (_i: string, _d: string, _u: string, _r: string, inTx: any) => {
      rounds[0].status = S.APPROVED; // somebody else got there first
      await inTx({ getRepository: () => ({ findOne: async () => rounds[0], save: async (r: any) => r }) }, {});
    });
    await expect(service.approve('a-1', null, BOSS)).rejects.toThrow(/already been decided/);
  });

  /** HR hears what the approver did — each person who prepared the round, by name, and nobody else. */
  describe('telling HR', () => {
    const sent = (n: { emitSafe: jest.Mock }, type: string) => n.emitSafe.mock.calls.map((c) => c[0]).filter((e) => e.type === type);

    it('tells whoever sent it up that more is needed, with the question', async () => {
      const { service, notifications } = setup();
      await service.requestInfo('a-1', 'Upload the relieving letter from the last employer.', BOSS);

      const [emit] = sent(notifications, 'ASSAYER_APPROVAL_INFO_REQUESTED');
      expect(emit).toMatchObject({
        ownerUserId: HR.id, actorUserId: BOSS.id, assayerId: 'a-1',
        payload: { assayerName: 'Ramesh Kumar', askedBy: BOSS.name, question: 'Upload the relieving letter from the last employer.' },
      });
    });

    it('tells every preparer of the round the decision — the one who answered too', async () => {
      const { service, notifications } = setup({
        round: {
          events: [
            { kind: K.SUBMITTED, byId: HR.id, byName: null, at: '2026-09-23T10:00:00Z', text: null },
            { kind: K.INFO_REQUESTED, byId: BOSS.id, byName: null, at: '2026-09-23T11:00:00Z', text: 'Which branch?' },
            { kind: K.ANSWERED, byId: 'hr-2', byName: null, at: '2026-09-23T12:00:00Z', text: 'Pune Camp branch.' },
          ],
        },
      });
      await service.reject('a-1', 'Declared experience could not be confirmed.', BOSS);

      const emits = sent(notifications, 'ASSAYER_APPROVAL_REJECTED');
      expect(emits.map((e) => e.ownerUserId).sort()).toEqual(['hr-1', 'hr-2']);
      expect(emits[0].payload).toMatchObject({ decidedBy: BOSS.name, reason: 'Declared experience could not be confirmed.' });
      // The approver is not told about their own decision, and each person gets it once.
      expect(new Set(emits.map((e) => e.dedupeKey)).size).toBe(2);
    });

    it('tells them when it is approved', async () => {
      const { service, notifications } = setup();
      await service.approve('a-1', 'Strong file.', BOSS);
      expect(sent(notifications, 'ASSAYER_APPROVAL_APPROVED')).toEqual([
        expect.objectContaining({ ownerUserId: HR.id, payload: expect.objectContaining({ noteLine: ' Their note: "Strong file.".' }) }),
      ]);
    });

    it('tells nobody when the decision is refused', async () => {
      const { service, notifications } = setup();
      await expect(service.reject('a-1', 'no', BOSS)).rejects.toThrow();
      expect(notifications.emitSafe).not.toHaveBeenCalled();
    });
  });
});
