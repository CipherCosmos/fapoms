import { BadRequestException } from '@nestjs/common';
import { AssayerLifecycleStatus, OnboardingDocument } from '@fapoms/shared';
import { AssayerService } from './assayer.service';

describe('document verification gate — BACKGROUND_VERIFICATION requires verified documents', () => {
  const standing = (ok: boolean, missing: OnboardingDocument[] = [], rejected: OnboardingDocument[] = []) => ({
    verified: ok ? [OnboardingDocument.AADHAAR_FRONT, OnboardingDocument.PAN_CARD] : [],
    missing,
    rejected,
    ok,
  });

  const serviceWith = (
    identityOk: boolean,
    missing: OnboardingDocument[] = [],
    rejected: OnboardingDocument[] = [],
    from: AssayerLifecycleStatus = AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
  ) => {
    const row = () => ({
      id: 'asr-1',
      displayName: 'Sunita Rao',
      lifecycleStatus: from,
      version: 2,
    });
    const svc: any = Object.create(AssayerService.prototype);
    svc.logger = { warn: jest.fn(), log: jest.fn() };
    svc.rosterRecords = {
      identityStanding: jest.fn().mockResolvedValue(standing(identityOk, missing, rejected)),
      latestBackgroundVerdict: jest.fn().mockResolvedValue(null),
    };
    svc.platformSettings = { get: jest.fn().mockResolvedValue('enforce') };
    svc.findOne = jest.fn(async () => row());
    svc.hydrateWorkforceAttributes = jest.fn().mockResolvedValue(undefined);
    svc.recordActivity = jest.fn().mockResolvedValue(undefined);
    svc.auditService = { recordEvent: jest.fn().mockResolvedValue(undefined) };
    svc.notificationDispatch = { emitSafe: jest.fn() };
    svc.eventPublisher = { publish: jest.fn() };
    svc.reconcileDepartureDates = jest.fn().mockReturnValue(null);
    svc.closeClientEmpanelmentsOnDeparture = jest.fn().mockResolvedValue(0);
    svc.cancelOpenAssignmentsOnDeparture = jest.fn().mockResolvedValue(0);

    const manager = {
      query: jest.fn().mockResolvedValue([{ lifecycle_status: from, version: 2 }]),
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

  const advanceToBgv = (svc: any) =>
    svc.doTransitionLifecycle('asr-1', AssayerLifecycleStatus.BACKGROUND_VERIFICATION, 'actor-1');

  it('refuses transition to BACKGROUND_VERIFICATION when required documents are missing', async () => {
    const svc = serviceWith(false, [OnboardingDocument.AADHAAR_FRONT, OnboardingDocument.PAN_CARD]);
    await expect(advanceToBgv(svc)).rejects.toBeInstanceOf(BadRequestException);
    await expect(advanceToBgv(svc)).rejects.toThrow(/cannot pass document verification yet/i);
    await expect(advanceToBgv(svc)).rejects.toThrow(/Aadhaar — front and PAN card/i);
  });

  it('refuses transition to BACKGROUND_VERIFICATION when a document was rejected', async () => {
    const svc = serviceWith(false, [], [OnboardingDocument.PAN_CARD]);
    await expect(advanceToBgv(svc)).rejects.toBeInstanceOf(BadRequestException);
    await expect(advanceToBgv(svc)).rejects.toThrow(/was sent back and has not been replaced/i);
  });

  it('allows transition to BACKGROUND_VERIFICATION when required documents are verified', async () => {
    const svc = serviceWith(true, [], []);
    const result = await advanceToBgv(svc);
    expect(result.saved.lifecycleStatus).toBe(AssayerLifecycleStatus.BACKGROUND_VERIFICATION);
  });

  it('calls identityStanding to evaluate required documents', async () => {
    const svc = serviceWith(true, [], []);
    await advanceToBgv(svc);
    expect(svc.rosterRecords.identityStanding).toHaveBeenCalledWith('asr-1');
  });

  it('accepts remarks on lifecycle transition payload and maps it to reason', async () => {
    const { validate } = await import('class-validator');
    const { plainToInstance } = await import('class-transformer');
    const { TransitionLifecycleDto, BulkTransitionLifecycleDto } = await import('./assayer.controller');

    const singleDto = plainToInstance(TransitionLifecycleDto, {
      targetStatus: 'BACKGROUND_VERIFICATION',
      remarks: 'Stage advanced via Onboarding Reviewer to Background Verification',
    });
    const singleErrors = await validate(singleDto, { whitelist: true, forbidNonWhitelisted: true });
    expect(singleErrors).toHaveLength(0);

    const bulkDto = plainToInstance(BulkTransitionLifecycleDto, {
      ids: ['73cc5ed9-65aa-4901-b3bd-35cd45cddd6c'],
      targetStatus: 'BACKGROUND_VERIFICATION',
      remarks: 'Stage advanced via Onboarding Reviewer to Background Verification',
    });
    const bulkErrors = await validate(bulkDto, { whitelist: true, forbidNonWhitelisted: true });
    expect(bulkErrors).toHaveLength(0);
  });
});
