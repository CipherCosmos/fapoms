import { BadRequestException } from '@nestjs/common';
import { AssayerLifecycleStatus, OnboardingDocument } from '@fapoms/shared';
import { AssayerService } from './assayer.service';

/**
 * Nobody becomes active until somebody has established who they are.
 *
 * The gate sits inside `doTransitionLifecycle` — the one funnel every path runs through — rather
 * than in the state machine, which is static and holds no repository, and rather than at the
 * caller, which a bulk walk simply routes around by taking the hops either side of it.
 *
 * ## Why this harness runs the workflow callback
 *
 * It used to stub `workflowEngine.executeCommand` with a canned resolved value, so the closure
 * containing the actual transition never ran, and it stubbed `findOne` to return TRAINING no
 * matter what — a state from which activation is always legal. Between them those two mocks made
 * the spec blind to the defect the lifecycle certification then found by hand: the gate ran
 * BEFORE the edge was validated and OUTSIDE the transaction, so a refused `INVITED → ACTIVE`
 * still wrote "Activated without a verified identity" onto the timeline of somebody who was never
 * activated, on a connection the rejection could not roll back. Four attempts, four rows. Under
 * `enforce` the same ordering answered the wrong question entirely — go and chase documents, when
 * the real problem was that the transition does not exist.
 *
 * So the fake engine now INVOKES the action with a fake manager, and the source state is a
 * parameter rather than a constant. The spec exercises the ordering it is supposed to be about.
 */
describe('activation is gated on a verified identity', () => {
  const standing = (ok: boolean, missing: OnboardingDocument[] = []) => ({
    verified: ok ? [OnboardingDocument.AADHAAR_FRONT, OnboardingDocument.PAN_CARD] : [],
    missing, rejected: [], ok,
  });

  const serviceWith = (
    mode: string,
    identityOk: boolean,
    missing: OnboardingDocument[] = [],
    from: AssayerLifecycleStatus = AssayerLifecycleStatus.TRAINING,
  ) => {
    const row = () => ({
      id: 'asr-1', displayName: 'Ramesh Kumar', lifecycleStatus: from, version: 3,
    });
    const svc: any = Object.create(AssayerService.prototype);
    svc.logger = { warn: jest.fn(), log: jest.fn() };
    svc.rosterRecords = { identityStanding: jest.fn().mockResolvedValue(standing(identityOk, missing)) };
    svc.platformSettings = { get: jest.fn().mockResolvedValue(mode) };
    svc.findOne = jest.fn(async () => row());
    svc.hydrateWorkforceAttributes = jest.fn().mockResolvedValue(undefined);
    svc.recordActivity = jest.fn().mockResolvedValue(undefined);
    svc.auditService = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    svc.notificationDispatch = { emitSafe: jest.fn() };
    svc.eventPublisher = { publish: jest.fn() };
    svc.reconcileDepartureDates = jest.fn().mockReturnValue(null);
    svc.closeClientEmpanelmentsOnDeparture = jest.fn().mockResolvedValue(0);
    svc.cancelOpenAssignmentsOnDeparture = jest.fn().mockResolvedValue(0);

    // The locked read the funnel performs, and the repository it re-loads the entity through.
    const manager = {
      query: jest.fn().mockResolvedValue([{ lifecycle_status: from, version: 3 }]),
      getRepository: () => ({
        findOne: jest.fn(async () => row()),
        save: jest.fn(async (a: any) => a),
      }),
    };
    svc.workflowEngine = {
      executeCommand: jest.fn(async (...args: any[]) => {
        const action = args[8];
        return action(manager);
      }),
    };
    return svc;
  };

  const activate = (svc: any) =>
    svc.doTransitionLifecycle('asr-1', AssayerLifecycleStatus.ACTIVE, 'actor-1');

  it('refuses activation under enforce, naming the document that is missing', async () => {
    const svc = serviceWith('enforce', false, [OnboardingDocument.AADHAAR_FRONT]);
    await expect(activate(svc)).rejects.toBeInstanceOf(BadRequestException);
    await expect(activate(svc)).rejects.toThrow(/Aadhaar — front/);
  });

  /**
   * Warn is the shipped default, and it has to leave a trace. A control that lets something
   * through and records nothing is indistinguishable from one that is switched off.
   */
  it('allows activation under warn, but writes the fact on the record', async () => {
    const svc = serviceWith('warn', false, [OnboardingDocument.PAN_CARD]);
    await activate(svc);
    expect(svc.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/Identity gate \(warn only\)/));
    expect(svc.recordActivity).toHaveBeenCalledWith(
      'asr-1', 'ASSAYER_UPDATED', null, null, 'actor-1',
      expect.stringMatching(/without a verified identity/),
      expect.anything(),
    );
  });

  it('does not look at all under off', async () => {
    const svc = serviceWith('off', false);
    await activate(svc);
    expect(svc.rosterRecords.identityStanding).not.toHaveBeenCalled();
  });

  it('lets a verified person through under enforce', async () => {
    const svc = serviceWith('enforce', true);
    await expect(activate(svc)).resolves.toBeDefined();
  });

  /**
   * A rejected document is not the same as a missing one, and the sentence has to say so — "send
   * it again" and "it was refused" are different instructions for the desk.
   */
  it('says a document was sent back rather than that it is missing', async () => {
    const svc = serviceWith('enforce', false);
    svc.rosterRecords.identityStanding.mockResolvedValue({
      verified: [], missing: [], rejected: [OnboardingDocument.PAN_CARD], ok: false,
    });
    await expect(activate(svc)).rejects.toThrow(/was sent back and has not been replaced/);
  });

  /**
   * THE ORDERING. This is the case the old mocks could not reach.
   *
   * `INVITED → ACTIVE` is not an edge. The request must be refused for THAT reason, and it must
   * leave nothing behind — no warn-arm activity row claiming an activation, and under enforce no
   * document-chasing error that sends the desk after paperwork which would not have helped.
   */
  describe('when the transition itself is illegal', () => {
    const illegalSources = [
      AssayerLifecycleStatus.INVITED,
      AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
      AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
      AssayerLifecycleStatus.RESIGNED,
      AssayerLifecycleStatus.TERMINATED,
    ];

    it.each(illegalSources)('refuses %s → ACTIVE naming the transition, not the documents', async (from) => {
      const svc = serviceWith('enforce', false, [OnboardingDocument.PAN_CARD], from);
      await expect(activate(svc)).rejects.toThrow(/Invalid lifecycle transition/);
    });

    it.each(illegalSources)('writes no activity row when %s → ACTIVE is refused under warn', async (from) => {
      const svc = serviceWith('warn', false, [OnboardingDocument.PAN_CARD], from);
      await expect(activate(svc)).rejects.toThrow(/Invalid lifecycle transition/);
      expect(svc.recordActivity).not.toHaveBeenCalled();
      expect(svc.logger.warn).not.toHaveBeenCalled();
    });

    it('does not even consult the identity standing for an edge that does not exist', async () => {
      const svc = serviceWith('enforce', false, [], AssayerLifecycleStatus.INVITED);
      await expect(activate(svc)).rejects.toThrow(/Invalid lifecycle transition/);
      expect(svc.rosterRecords.identityStanding).not.toHaveBeenCalled();
    });
  });
});
