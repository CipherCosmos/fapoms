import { BadRequestException } from '@nestjs/common';
import { AssayerLifecycleStatus, AssayerUnavailableReason, BackgroundCheckVerdict } from '@fapoms/shared';
import { AssayerService } from './assayer.service';
import { AssayerActivityEntity } from './assayer-activity.entity';

/**
 * BACKGROUND VERIFICATION IS MANDATORY (owner, 2026-09-23) — and so is its report.
 *
 * It used to ride `onboarding.identityGate.mode`, which ships as WARN: anybody could be moved out
 * of background verification with no check at all, and only an activity row said so. Now onboarding
 * cannot be finished without a completed, clear check AND the uploaded report — whatever the mode.
 */
describe('background verification is mandatory to finish onboarding', () => {
  const serviceWith = (opts: {
    from: AssayerLifecycleStatus;
    verdict: BackgroundCheckVerdict | null;
    reportOnFile: boolean;
    /** What the operative check lacks of its address, CIBIL and court checks — `bgvPartsMissing`. */
    partsMissing?: string[];
    /** Where they were when last parked INACTIVE — the lifecycle trail's answer. */
    parkedFrom?: AssayerLifecycleStatus | null;
    mode?: string;
    unavailableReason?: AssayerUnavailableReason | null;
    /** Fields to change on the person — a missing bank account, a missing map pin. */
    record?: Record<string, unknown>;
  }) => {
    const row = () => ({
      id: 'asr-1', displayName: 'Ramesh Kumar', lifecycleStatus: opts.from, version: 3,
      unavailableReason: opts.unavailableReason ?? null,
      panNumber: 'ABCDE1234F', bankAccountNumber: '123456789012', ifscCode: 'HDFC0001234',
      latitude: 19.076, longitude: 72.877,
      ...opts.record,
    });
    const svc: any = Object.create(AssayerService.prototype);
    svc.logger = { warn: jest.fn(), log: jest.fn() };
    svc.hydrateWorkforceAttributes = jest.fn().mockResolvedValue(undefined);
    svc.findOne = jest.fn(async () => row());
    svc.recordActivity = jest.fn().mockResolvedValue(undefined);
    svc.auditService = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    svc.notificationDispatch = { emitSafe: jest.fn() };
    svc.eventPublisher = { publish: jest.fn() };
    svc.reconcileDepartureDates = jest.fn().mockReturnValue(null);
    svc.closeClientEmpanelmentsOnDeparture = jest.fn().mockResolvedValue(0);
    svc.cancelOpenAssignmentsOnDeparture = jest.fn().mockResolvedValue(0);
    svc.rosterRecords = {
      latestBackgroundVerdict: jest.fn().mockResolvedValue(opts.verdict),
      bgvReportOnFile: jest.fn().mockResolvedValue(opts.reportOnFile),
      bgvPartsMissing: jest.fn().mockResolvedValue(opts.partsMissing ?? []),
      identityStanding: jest.fn().mockResolvedValue({ ok: true, verified: [], missing: [], rejected: [] }),
    };
    // Every mode, including the one BGV used to hide behind.
    svc.platformSettings = { get: jest.fn().mockResolvedValue(opts.mode ?? 'warn') };

    const manager = {
      query: jest.fn().mockResolvedValue([{ lifecycle_status: opts.from, version: 3 }]),
      getRepository: (entity: unknown) => (entity === AssayerActivityEntity
        ? {
          findOne: jest.fn(async () => (opts.parkedFrom === undefined
            ? null
            : { newState: AssayerLifecycleStatus.INACTIVE, previousState: opts.parkedFrom })),
        }
        : {
          findOne: jest.fn(async () => row()), save: jest.fn(async (a: any) => a),
          // Entering approval opens its round on this same manager.
          create: jest.fn((a: any) => a),
        }),
    };
    svc.workflowEngine = { executeCommand: jest.fn(async (...args: any[]) => args[8](manager)) };
    return svc;
  };

  const move = (svc: any, to: AssayerLifecycleStatus) => svc.doTransitionLifecycle('asr-1', to, 'actor-1');

  /** Leaving background verification is being sent up for approval now (2026-09-23). */
  describe('leaving background verification', () => {
    const from = AssayerLifecycleStatus.BACKGROUND_VERIFICATION;

    it.each(['warn', 'off', 'enforce'])('refuses with no completed check, even under %s', async (mode) => {
      const svc = serviceWith({ from, verdict: null, reportOnFile: false, mode });
      await expect(move(svc, AssayerLifecycleStatus.FINAL_APPROVAL)).rejects.toThrow(/mandatory and no completed check/);
    });

    it('refuses a clear check whose report was never uploaded', async () => {
      const svc = serviceWith({ from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: false });
      await expect(move(svc, AssayerLifecycleStatus.FINAL_APPROVAL)).rejects.toThrow(/report has not been uploaded/);
    });

    /**
     * A clear check recorded before the three parts were asked for (2026-09-24), or brought in by
     * the import, of somebody still joining: joining now means all three, however it got on file.
     */
    it('refuses a clear check that lacks its address, CIBIL or court check', async () => {
      const svc = serviceWith({
        from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: true,
        partsMissing: ['the address check (physical or digital)', 'the court check'],
      });
      await expect(move(svc, AssayerLifecycleStatus.FINAL_APPROVAL))
        .rejects.toThrow(/missing the address check \(physical or digital\) and the court check\. A background check counts as done only with/);
    });

    it('sends them up for approval with a clear check and its report', async () => {
      const svc = serviceWith({ from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: true });
      await expect(move(svc, AssayerLifecycleStatus.FINAL_APPROVAL)).resolves.toBeDefined();
    });

    /** The approvers hear about it — the bell and email — keyed on the round, never on the person. */
    it('tells the approvers, with the note, once per round', async () => {
      const svc = serviceWith({ from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: true });
      await svc.doTransitionLifecycle('asr-1', AssayerLifecycleStatus.FINAL_APPROVAL, 'hr-1', 'Referee two was hard to reach.');

      expect(svc.notificationDispatch.emitSafe).toHaveBeenCalledWith(expect.objectContaining({
        type: 'ASSAYER_SENT_FOR_APPROVAL',
        actorUserId: 'hr-1',
        assayerId: 'asr-1',
        dedupeKey: expect.stringMatching(/^ASSAYER_SENT_FOR_APPROVAL:/),
        payload: expect.objectContaining({
          assayerName: 'Ramesh Kumar', noteLine: ' Their note: "Referee two was hard to reach.".',
        }),
      }));
    });

    it('does not tell anybody when the move is refused', async () => {
      const svc = serviceWith({ from, verdict: null, reportOnFile: false });
      await expect(move(svc, AssayerLifecycleStatus.FINAL_APPROVAL)).rejects.toThrow();
      expect(svc.notificationDispatch.emitSafe).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'ASSAYER_SENT_FOR_APPROVAL' }));
    });
  });

  /**
   * The side door: park a candidate INACTIVE, then "reactivate" somebody who was never active and
   * never checked. Reactivating someone parked mid-onboarding is finishing onboarding.
   */
  describe('activating somebody parked inactive', () => {
    const from = AssayerLifecycleStatus.INACTIVE;

    it('refuses when they were parked mid-onboarding and never checked', async () => {
      const svc = serviceWith({ from, verdict: null, reportOnFile: false, parkedFrom: AssayerLifecycleStatus.DOCUMENT_VERIFICATION });
      await expect(move(svc, AssayerLifecycleStatus.ACTIVE)).rejects.toBeInstanceOf(BadRequestException);
      await expect(move(svc, AssayerLifecycleStatus.ACTIVE)).rejects.toThrow(/mandatory/);
    });

    it('lets them in once the check and report are done', async () => {
      const svc = serviceWith({
        from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: true, parkedFrom: AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
      });
      await expect(move(svc, AssayerLifecycleStatus.ACTIVE)).resolves.toBeDefined();
    });

    it('refuses to finish onboarding on a clear check that lacks its parts', async () => {
      const svc = serviceWith({
        from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: true, partsMissing: ['the CIBIL check'],
        parkedFrom: AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
      });
      await expect(move(svc, AssayerLifecycleStatus.ACTIVE)).rejects.toThrow(/missing the CIBIL check/);
    });

    /** The imported roster's checks carry no parts; a working return never asked for them. */
    it('does not ask a working return for the parts', async () => {
      const svc = serviceWith({
        from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: false, partsMissing: ['the CIBIL check'],
        parkedFrom: AssayerLifecycleStatus.ACTIVE,
      });
      await expect(move(svc, AssayerLifecycleStatus.ACTIVE)).resolves.toBeDefined();
    });

    /** A working return is not onboarding — the roster predates these checks. */
    it('does not ask a working person back from an inactive spell for a check', async () => {
      const svc = serviceWith({ from, verdict: null, reportOnFile: false, parkedFrom: AssayerLifecycleStatus.ACTIVE });
      await expect(move(svc, AssayerLifecycleStatus.ACTIVE)).resolves.toBeDefined();
    });

    it('treats a record older than the lifecycle trail as a working return, not a mystery refusal', async () => {
      const svc = serviceWith({ from, verdict: null, reportOnFile: false });
      await expect(move(svc, AssayerLifecycleStatus.ACTIVE)).resolves.toBeDefined();
    });

    it('still refuses anybody whose latest check is adverse', async () => {
      const svc = serviceWith({ from, verdict: BackgroundCheckVerdict.CRIMINAL_CASE, reportOnFile: true, parkedFrom: AssayerLifecycleStatus.ACTIVE });
      await expect(move(svc, AssayerLifecycleStatus.ACTIVE)).rejects.toThrow(/adverse/);
    });
  });

  /**
   * RE-VERIFYING SOMEBODY WHO DID NOT PASS (owner, 2026-09-23). Parked as BGV_FAILED, they can be
   * taken back into background verification, and must then pass it with a new check and its own
   * report to go on to training. Nobody else parked inactive has a verification to re-open.
   */
  describe('re-opening a background verification that was not passed', () => {
    const from = AssayerLifecycleStatus.INACTIVE;

    it('takes somebody parked for failing it back in, no longer marked failed', async () => {
      const svc = serviceWith({
        from, verdict: BackgroundCheckVerdict.CRIMINAL_CASE, reportOnFile: true,
        unavailableReason: AssayerUnavailableReason.BGV_FAILED, parkedFrom: AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
      });
      const { saved: moved } = await move(svc, AssayerLifecycleStatus.BACKGROUND_VERIFICATION);
      expect(moved.lifecycleStatus).toBe(AssayerLifecycleStatus.BACKGROUND_VERIFICATION);
      expect(moved.unavailableReason).toBeNull();
    });

    it.each([null, AssayerUnavailableReason.NOT_INTERESTED])('refuses anybody parked for another reason (%s)', async (reason) => {
      const svc = serviceWith({ from, verdict: null, reportOnFile: false, unavailableReason: reason });
      await expect(move(svc, AssayerLifecycleStatus.BACKGROUND_VERIFICATION))
        .rejects.toThrow(/only for somebody parked because it was not passed/);
    });

    it('still will not send them on for approval on the check that failed them', async () => {
      const svc = serviceWith({ from: AssayerLifecycleStatus.BACKGROUND_VERIFICATION, verdict: BackgroundCheckVerdict.CRIMINAL_CASE, reportOnFile: true });
      await expect(move(svc, AssayerLifecycleStatus.FINAL_APPROVAL)).rejects.toThrow(/adverse|not clear|did not/i);
    });
  });

  /**
   * THE APPROVAL BEFORE TRAINING (owner, 2026-09-23). Only the approver's decision leaves it — not a
   * stage button, not a bulk move, not the API.
   */
  describe('awaiting approval', () => {
    const from = AssayerLifecycleStatus.FINAL_APPROVAL;
    const decide = (svc: any, to: AssayerLifecycleStatus, decision: 'APPROVED' | 'REJECTED') => {
      const inTransaction = jest.fn(async () => undefined);
      return {
        run: () => svc.doTransitionLifecycle('asr-1', to, 'boss-1', 'decided', undefined, undefined, { decision, inTransaction }),
        inTransaction,
      };
    };

    it('does not go on to training by a plain move', async () => {
      const svc = serviceWith({ from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: true });
      await expect(move(svc, AssayerLifecycleStatus.TRAINING)).rejects.toThrow(/when they are approved/);
    });

    it('is not parked by a plain move either — not approving them is the approver\'s decision', async () => {
      const svc = serviceWith({ from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: true });
      await expect(svc.doTransitionLifecycle('asr-1', AssayerLifecycleStatus.INACTIVE, 'hr-1', 'They withdrew.'))
        .rejects.toThrow(/approver decides it/);
    });

    it('goes on to training when approved, recording the decision in the same transaction', async () => {
      const svc = serviceWith({ from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: true });
      const d = decide(svc, AssayerLifecycleStatus.TRAINING, 'APPROVED');
      const { saved } = await d.run();
      expect(saved.lifecycleStatus).toBe(AssayerLifecycleStatus.TRAINING);
      expect(d.inTransaction).toHaveBeenCalled();
    });

    /**
     * STRAIGHT TO WORK (owner, 2026-09-24: "after approving the approver can also send them to
     * training or make them active"). Training may be skipped — by the approver, and only by the
     * approver — but nothing joining requires is: the background check with its report, the
     * identity documents, the bank account and the map pin are all asked for on this road too.
     */
    describe('approved straight to work', () => {
      it('is not reached by a plain move — only by the approval', async () => {
        const svc = serviceWith({ from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: true });
        await expect(move(svc, AssayerLifecycleStatus.ACTIVE)).rejects.toThrow(/made Active by being approved/);
      });

      it('makes them Active when approved that way, recording the decision in the same transaction', async () => {
        const svc = serviceWith({ from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: true });
        const d = decide(svc, AssayerLifecycleStatus.ACTIVE, 'APPROVED');
        const { saved } = await d.run();
        expect(saved.lifecycleStatus).toBe(AssayerLifecycleStatus.ACTIVE);
        expect(d.inTransaction).toHaveBeenCalled();
      });

      /** The approver's choice is what decides where they go — through the one door the approval uses. */
      it('sends them where the approver chose: straight to work, or training when nothing else is said', async () => {
        const svc = serviceWith({ from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: true });
        svc.cache = { del: jest.fn().mockResolvedValue(undefined) };
        const record = jest.fn(async () => undefined);

        const active = await svc.decideFinalApproval('asr-1', 'APPROVED', 'boss-1', 'Approved to join', record, 'ACTIVE');
        expect(active.lifecycleStatus).toBe(AssayerLifecycleStatus.ACTIVE);

        const trained = await svc.decideFinalApproval('asr-1', 'APPROVED', 'boss-1', 'Approved to join', record);
        expect(trained.lifecycleStatus).toBe(AssayerLifecycleStatus.TRAINING);
      });

      it('still needs a bank account — and records no decision when it is refused', async () => {
        const svc = serviceWith({ from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: true, record: { bankAccountNumber: null } });
        const d = decide(svc, AssayerLifecycleStatus.ACTIVE, 'APPROVED');
        await expect(d.run()).rejects.toThrow(/cannot be activated yet/);
        expect(d.inTransaction).not.toHaveBeenCalled();
      });

      it('still needs the map pin', async () => {
        const svc = serviceWith({ from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: true, record: { latitude: null } });
        await expect(decide(svc, AssayerLifecycleStatus.ACTIVE, 'APPROVED').run()).rejects.toThrow(/no map coordinates/);
      });

      /**
       * The joining gate, not the working-return one. Somebody coming back from leave is only
       * refused on an adverse check; somebody joining needs a clear check AND its report — and
       * skipping training must not be a way round the second half.
       */
      it('still needs the background check\'s report, as joining does', async () => {
        const svc = serviceWith({ from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: false });
        await expect(decide(svc, AssayerLifecycleStatus.ACTIVE, 'APPROVED').run()).rejects.toThrow(/report has not been uploaded/);
      });
    });

    it('is parked as not approved when rejected', async () => {
      const svc = serviceWith({ from, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: true });
      const { saved } = await decide(svc, AssayerLifecycleStatus.INACTIVE, 'REJECTED').run();
      expect(saved.lifecycleStatus).toBe(AssayerLifecycleStatus.INACTIVE);
      expect(saved.unavailableReason).toBe(AssayerUnavailableReason.APPROVAL_REJECTED);
    });

    it('can be put up again after a rejection, and nobody else inactive can', async () => {
      const again = serviceWith({
        from: AssayerLifecycleStatus.INACTIVE, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: true,
        unavailableReason: AssayerUnavailableReason.APPROVAL_REJECTED,
      });
      const { saved } = await move(again, AssayerLifecycleStatus.FINAL_APPROVAL);
      expect(saved.lifecycleStatus).toBe(AssayerLifecycleStatus.FINAL_APPROVAL);
      expect(saved.unavailableReason).toBeNull();

      const other = serviceWith({ from: AssayerLifecycleStatus.INACTIVE, verdict: BackgroundCheckVerdict.CLEAR, reportOnFile: true });
      await expect(move(other, AssayerLifecycleStatus.FINAL_APPROVAL)).rejects.toThrow(/only for somebody who was not approved/);
    });
  });
});
