import { BadRequestException } from '@nestjs/common';
import { AssayerLifecycleStatus, OnboardingDocument } from '@fapoms/shared';
import { AssayerService } from './assayer.service';

/**
 * Nobody becomes active until somebody has established who they are.
 *
 * The gate sits in `doTransitionLifecycle` rather than in the state machine, which is static and
 * holds no repository — and rather than at the caller, because `doTransitionLifecycle` is the one
 * funnel every path runs through. That placement is the whole test: a bulk INVITED → ACTIVE move
 * walks four edges through `assayerLifecyclePath`, and a guard anywhere else is simply routed
 * around by the hops either side of it.
 */
describe('activation is gated on a verified identity', () => {
  const standing = (ok: boolean, missing: OnboardingDocument[] = []) => ({
    verified: ok ? [OnboardingDocument.AADHAAR_FRONT, OnboardingDocument.PAN_CARD] : [],
    missing, rejected: [], ok,
  });

  const serviceWith = (mode: string, identityOk: boolean, missing: OnboardingDocument[] = []) => {
    const svc: any = Object.create(AssayerService.prototype);
    svc.logger = { warn: jest.fn(), log: jest.fn() };
    svc.rosterRecords = { identityStanding: jest.fn().mockResolvedValue(standing(identityOk, missing)) };
    svc.platformSettings = { get: jest.fn().mockResolvedValue(mode) };
    svc.findOne = jest.fn().mockResolvedValue({
      id: 'asr-1', displayName: 'Ramesh Kumar', lifecycleStatus: AssayerLifecycleStatus.TRAINING,
    });
    svc.recordActivity = jest.fn().mockResolvedValue(undefined);
    svc.assayerRepository = { save: jest.fn(async (a: any) => a) };
    svc.eventPublisher = { publish: jest.fn() };
    // The gate sits before the transition itself; everything past it is another test's subject.
    svc.reconcileDepartureDates = jest.fn().mockReturnValue([]);
    svc.workflowEngine = {
      executeCommand: jest.fn().mockResolvedValue({ saved: { id: 'asr-1' }, event: null }),
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
    await expect(activate(svc)).rejects.toThrow(/sent back/);
  });

  /** Every other transition is untouched: the gate is about activation, not about joining. */
  it.each([
    AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
    AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
    AssayerLifecycleStatus.TRAINING,
  ])('does not gate the move to %s', async (target) => {
    const svc = serviceWith('enforce', false);
    svc.findOne.mockResolvedValue({
      id: 'asr-1', displayName: 'Ramesh Kumar', lifecycleStatus: AssayerLifecycleStatus.INVITED,
    });
    await svc.doTransitionLifecycle('asr-1', target, 'actor-1').catch(() => undefined);
    expect(svc.rosterRecords.identityStanding).not.toHaveBeenCalled();
  });
});
