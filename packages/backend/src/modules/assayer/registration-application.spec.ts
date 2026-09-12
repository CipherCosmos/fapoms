import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ApplicationStatus, EmploymentCategory, OnboardingDocument } from '@fapoms/shared';

import { RegistrationApplicationService, documentsRequestedFor } from './registration-application.service';

/**
 * The self-registration application layer.
 *
 * This is the one part of the Appraiser Recruitment work that is reachable with NO authentication —
 * the candidate's emailed link is the only credential — so the rules below are not conveniences,
 * they are the whole access-control story: what a token proves, how long it proves it, how many
 * codes one link may send, and what a half-finished application may and may not do.
 *
 * The service is constructed directly rather than through a testing module: it takes eleven
 * collaborators, all of which are mocked here, and a DI container would add a token-registration
 * ceremony without testing anything extra.
 */

const RAW_TOKEN = 'a'.repeat(64);
/** What the service stores for RAW_TOKEN — sha256 hex, the same `hashCode` the MFA codes use. */
const TOKEN_HASH = require('crypto').createHash('sha256').update(RAW_TOKEN).digest('hex');

type Row = Record<string, any>;

function makeService(overrides: { application?: Row | null; cache?: Record<string, any> } = {}) {
  const application: Row | null =
    overrides.application === undefined
      ? {
        id: 'app-1',
        mobile: '9822014455',
        email: 'candidate@example.com',
        fullName: 'Ramesh Kulkarni',
        status: ApplicationStatus.DRAFT,
        tokenHash: TOKEN_HASH,
        tokenExpiresAt: new Date(Date.now() + 3_600_000),
        tokenConsumedAt: null,
        employmentCategory: null,
        consentAcceptedAt: null,
        organizationId: 'org-1',
      }
        : overrides.application;

  const cacheData: Record<string, any> = overrides.cache ?? {};

  const applications = {
    findOne: jest.fn(async () => application),
    create: jest.fn((v: Row) => ({ ...v })),
    save: jest.fn(async (v: Row) => ({ ...v, id: v.id ?? 'app-new' })),
    find: jest.fn(async () => (application ? [application] : [])),
  };
  const applicationDocuments = {
    findOne: jest.fn(async () => null),
    create: jest.fn((v: Row) => ({ ...v })),
    save: jest.fn(async (v: Row) => ({ ...v, id: 'doc-1' })),
    find: jest.fn(async () => []),
  };
  const assayerService = {
    create: jest.fn(async (_dto: Row, _userId?: string, _org?: string | null, _roles?: string[]) =>
      ({ id: 'assayer-1', assayerCode: 'AS0009', displayName: 'Ramesh Kulkarni' })),
  };
  const rosterRecords = { attachFile: jest.fn(async () => ({})) };
  const auditService = { recordEventSafe: jest.fn(async () => undefined) };
  const notificationDispatch = { emitSafe: jest.fn(async () => undefined) };
  const emailProvider = { send: jest.fn(async () => ({ success: true })) };
  const smsProvider = { send: jest.fn(async (_phone: string, _message: string) => true) };
  const cache = {
    getJson: jest.fn(async (k: string) => (k in cacheData ? cacheData[k] : null)),
    setJson: jest.fn(async (k: string, v: unknown) => { cacheData[k] = v; }),
  };
  const settings = { getNumber: jest.fn(async (_k: string, fallback?: number) => fallback ?? 0) };
  const storage = { saveFile: jest.fn(async () => 'uploads/scan.png') };

  const service = new RegistrationApplicationService(
    applications as any, applicationDocuments as any, assayerService as any, rosterRecords as any,
    auditService as any, notificationDispatch as any, emailProvider as any, smsProvider as any,
    cache as any, settings as any, storage as any,
  );

  return {
    service, application, applications, applicationDocuments, assayerService, rosterRecords,
    auditService, notificationDispatch, emailProvider, smsProvider, cache, settings, storage, cacheData,
  };
}

/** Marks the token as OTP-verified, the way a successful `verifyOtp` would have. */
const verified = () => ({ [`regotp:verified:${TOKEN_HASH}`]: { phone: '9822014455' } });

describe('registration invite tokens', () => {
  it('stores only the hash of a freshly minted token, never the token itself', async () => {
    const { service, applications } = makeService({ application: null });
    await service.createInvite({ mobile: '9822014455', email: 'x@example.com', fullName: 'X' });

    const saved = applications.save.mock.calls[0][0];
    expect(saved.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // The raw token exists only in the emailed link. Nothing in the row may be usable as one.
    const serialised = JSON.stringify(saved);
    expect(serialised).not.toContain(saved.tokenHash.slice(0, 8).toUpperCase());
    expect(saved).not.toHaveProperty('token');
  });

  it('refuses a token nobody holds', async () => {
    const { service } = makeService({ application: null });
    await expect(service.hydrate('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses an expired link rather than quietly serving it', async () => {
    const { service } = makeService({
      application: {
        id: 'app-1', mobile: '9', status: ApplicationStatus.DRAFT,
        tokenHash: TOKEN_HASH, tokenExpiresAt: new Date(Date.now() - 1000),
      },
    });
    await expect(service.hydrate(RAW_TOKEN)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('stamps when the link was first opened, and only the first time', async () => {
    const { service, applications, application } = makeService();
    await service.hydrate(RAW_TOKEN);
    expect(application!.tokenConsumedAt).toBeInstanceOf(Date);

    applications.save.mockClear();
    await service.hydrate(RAW_TOKEN);
    expect(applications.save).not.toHaveBeenCalled();
  });
});

describe('pre-account OTP', () => {
  it('never stores the code itself — only its hash, beside the phone it was sent to', async () => {
    const { service, cacheData, smsProvider } = makeService();
    await service.requestOtp(RAW_TOKEN, '9822014455');

    const entry = cacheData[`regotp:code:${TOKEN_HASH}`];
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    const sent = smsProvider.send.mock.calls[0][1] as string;
    const code = sent.match(/\b(\d{6})\b/)![1];
    expect(entry).not.toMatchObject({ code });
  });

  it('caps how many codes one link may send, so a stolen link cannot bomb a phone', async () => {
    // IP throttling cannot stop this on its own — the same link from rotating addresses is one
    // person's phone being paid for, in real SMS, with no account to lock.
    const { service } = makeService({ cache: { [`regotp:sent:${TOKEN_HASH}`]: { count: 5 } } });
    await expect(service.requestOtp(RAW_TOKEN, '9822014455')).rejects.toThrow(/Too many verification codes/i);
  });

  it('makes a resend wait out the cooldown', async () => {
    const { service } = makeService({ cache: { [`regotp:lastsent:${TOKEN_HASH}`]: Date.now() } });
    await expect(service.requestOtp(RAW_TOKEN, '9822014455')).rejects.toThrow(/wait/i);
  });

  it('rejects a wrong code, and a right code offered for a different phone', async () => {
    const { service, cacheData, smsProvider } = makeService();
    await service.requestOtp(RAW_TOKEN, '9822014455');
    const code = (smsProvider.send.mock.calls[0][1] as string).match(/\b(\d{6})\b/)![1];

    await expect(service.verifyOtp(RAW_TOKEN, '9822014455', '000000')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.verifyOtp(RAW_TOKEN, '9999999999', code)).rejects.toBeInstanceOf(BadRequestException);

    await expect(service.verifyOtp(RAW_TOKEN, '9822014455', code)).resolves.toBeUndefined();
    expect(cacheData[`regotp:verified:${TOKEN_HASH}`]).toEqual({ phone: '9822014455' });
  });

  it('gates every write behind verification — a link alone is not enough', async () => {
    const { service } = makeService();
    await expect(service.updateDraft(RAW_TOKEN, { fullName: 'X' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.acceptConsent(RAW_TOKEN, 'v1')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.submit(RAW_TOKEN)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.uploadDocument(RAW_TOKEN, OnboardingDocument.PAN_CARD, {
        originalname: 'x.png', buffer: Buffer.from('x'), mimetype: 'image/png', size: 1,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('what a candidate may still change', () => {
  it('refuses edits once the application is with HR', async () => {
    const { service } = makeService({
      application: {
        id: 'app-1', mobile: '9', status: ApplicationStatus.PENDING_VALIDATION,
        tokenHash: TOKEN_HASH, tokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
      cache: verified(),
    });
    await expect(service.updateDraft(RAW_TOKEN, { fullName: 'X' })).rejects.toThrow(/no longer editable/i);
  });

  it('lets them back in when HR asked for more information', async () => {
    const { service } = makeService({
      application: {
        id: 'app-1', mobile: '9', status: ApplicationStatus.AWAITING_INFO,
        tokenHash: TOKEN_HASH, tokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
      cache: verified(),
    });
    await expect(service.updateDraft(RAW_TOKEN, { fullName: 'Fixed Name' })).resolves.toBeDefined();
  });

  it('only writes fields the candidate owns, ignoring anything else in the payload', async () => {
    const { service, application } = makeService({ cache: verified() });
    await service.updateDraft(RAW_TOKEN, { fullName: 'New Name', status: ApplicationStatus.APPROVED } as any);

    expect(application!.fullName).toBe('New Name');
    // A self-approving payload is the obvious attack on an unauthenticated write route.
    expect(application!.status).toBe(ApplicationStatus.DRAFT);
  });

  it('refuses a document type that is not in the vocabulary', async () => {
    const { service } = makeService({ cache: verified() });
    await expect(
      service.uploadDocument(RAW_TOKEN, 'NOT_A_DOCUMENT' as OnboardingDocument, {
        originalname: 'x.png', buffer: Buffer.from('x'), mimetype: 'image/png', size: 1,
      }),
    ).rejects.toThrow(/not a recognised document/i);
  });
});

describe('submitting', () => {
  const ready = (extra: Row = {}) => ({
    id: 'app-1', mobile: '9822014455', email: 'c@example.com', fullName: 'Ramesh Kulkarni',
    status: ApplicationStatus.DRAFT, tokenHash: TOKEN_HASH,
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    employmentCategory: EmploymentCategory.PROPRIETOR, consentAcceptedAt: new Date(),
    ...extra,
  });

  it('refuses without a name, without a category, and without the declaration', async () => {
    for (const missing of [{ fullName: '' }, { employmentCategory: null }, { consentAcceptedAt: null }]) {
      const { service } = makeService({ application: ready(missing), cache: verified() });
      await expect(service.submit(RAW_TOKEN)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('moves to Pending Validation and tells the HR desk there is something to review', async () => {
    const { service, notificationDispatch, application } = makeService({ application: ready(), cache: verified() });
    await service.submit(RAW_TOKEN);

    expect(application!.status).toBe(ApplicationStatus.PENDING_VALIDATION);
    expect(notificationDispatch.emitSafe).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ASSAYER_APPLICATION_SUBMITTED' }),
    );
  });

  it('records a re-submission distinctly from a first submission', async () => {
    const { service, auditService } = makeService({
      application: ready({ status: ApplicationStatus.AWAITING_INFO }),
      cache: verified(),
    });
    await service.submit(RAW_TOKEN);
    expect(auditService.recordEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ASSAYER_APPLICATION_RESUBMITTED' }),
    );
  });

  it('cannot be submitted twice', async () => {
    const { service } = makeService({
      application: ready({ status: ApplicationStatus.PENDING_VALIDATION }),
      cache: verified(),
    });
    await expect(service.submit(RAW_TOKEN)).rejects.toThrow(/already been submitted/i);
  });
});

describe('HR review', () => {
  const submitted = (extra: Row = {}) => ({
    id: 'app-1', mobile: '9822014455', email: 'c@example.com', fullName: 'Ramesh Kulkarni',
    state: 'Maharashtra', city: 'Pune', status: ApplicationStatus.PENDING_VALIDATION,
    employmentCategory: EmploymentCategory.PROPRIETOR, organizationId: 'org-1',
    tokenHash: TOKEN_HASH, tokenExpiresAt: new Date(Date.now() + 3_600_000), ...extra,
  });

  it('will not decide an application twice', async () => {
    for (const status of [ApplicationStatus.APPROVED, ApplicationStatus.REJECTED]) {
      const { service } = makeService({ application: submitted({ status }) });
      await expect(service.reject('app-1', 'user-1', 'no')).rejects.toThrow(/already been decided/i);
      await expect(service.approve('app-1', 'user-1', ['ADMIN'])).rejects.toThrow(/already been decided/i);
    }
  });

  it('requires a reason to reject, and sends that reason to the candidate', async () => {
    const { service, emailProvider, application } = makeService({ application: submitted() });
    await expect(service.reject('app-1', 'user-1', '   ')).rejects.toBeInstanceOf(BadRequestException);

    await service.reject('app-1', 'user-1', 'Shop proof did not match the Aadhaar address.');
    expect(application!.status).toBe(ApplicationStatus.REJECTED);
    expect(emailProvider.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Shop proof did not match') }),
    );
  });

  it('rotates the link when asking for more information, so the old one stops working', async () => {
    // Only the hash was ever stored, so "resend the same link" is not a thing this can do — and
    // rotating is the better answer anyway. What must not happen is the OLD link still opening.
    const { service, application } = makeService({ application: submitted() });
    await service.requestMoreInfo('app-1', 'user-1', 'Attach the shop entity proof.');

    expect(application!.status).toBe(ApplicationStatus.AWAITING_INFO);
    expect(application!.tokenHash).not.toBe(TOKEN_HASH);
    expect(application!.tokenConsumedAt).toBeNull();
  });

  it('refuses a request for more information with nothing asked for', async () => {
    const { service } = makeService({ application: submitted() });
    await expect(service.requestMoreInfo('app-1', 'user-1', '')).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('promotion to a real assayer', () => {
  const approved = () => ({
    id: 'app-1', mobile: '9822014455', email: 'c@example.com', fullName: 'Ramesh Kulkarni',
    state: 'Maharashtra', city: 'Pune', status: ApplicationStatus.PENDING_VALIDATION,
    employmentCategory: EmploymentCategory.PROPRIETOR, organizationId: 'org-1',
    expertise: 'Gold valuation', availability: 'Weekdays',
    tokenHash: TOKEN_HASH, tokenExpiresAt: new Date(Date.now() + 3_600_000),
  });

  it('re-homes every uploaded document onto the new assayer', async () => {
    /**
     * The step `AssayerService.create()` does NOT do, and the reason promotion is a named routine
     * rather than one call: documents are written only through `RosterRecordsService`. Without
     * this loop an approved candidate arrives on the roster with their scans left behind on the
     * application, and the PHOTOGRAPH write-through that puts a face on the record never runs.
     */
    const ctx = makeService({ application: approved() });
    ctx.applicationDocuments.find.mockResolvedValue([
      { requirement: OnboardingDocument.PAN_CARD, filePaths: ['uploads/pan.png'] },
      { requirement: OnboardingDocument.AADHAAR_FRONT, filePaths: ['uploads/a1.png', 'uploads/a2.png'] },
    ] as any);

    await ctx.service.approve('app-1', 'user-1', ['ADMIN']);

    expect(ctx.rosterRecords.attachFile).toHaveBeenCalledTimes(3);
    expect(ctx.rosterRecords.attachFile).toHaveBeenCalledWith(
      'assayer-1', OnboardingDocument.PAN_CARD, 'uploads/pan.png', 'user-1',
    );
  });

  it('records which assayer the application became, and closes it as approved', async () => {
    const { service, application } = makeService({ application: approved() });
    await service.approve('app-1', 'user-1', ['ADMIN']);

    expect(application!.status).toBe(ApplicationStatus.APPROVED);
    expect(application!.promotedAssayerId).toBe('assayer-1');
  });

  it('carries the candidate-only fields across, and keeps free text out of columns that have none', async () => {
    const { service, assayerService } = makeService({ application: approved() });
    await service.approve('app-1', 'user-1', ['ADMIN']);

    const [dto] = assayerService.create.mock.calls[0];
    expect(dto).toMatchObject({
      fullName: 'Ramesh Kulkarni',
      phone: '9822014455',
      state: 'Maharashtra',
      employmentCategory: EmploymentCategory.PROPRIETOR,
    });
    // `expertise` and `availability` have no column on the assayer — they ride in `notes` rather
    // than being silently dropped or forced into an enum they do not fit.
    expect(dto.notes).toContain('Gold valuation');
    expect(dto.notes).toContain('Weekdays');
  });

  it('tells the candidate their appraiser code', async () => {
    const { service, emailProvider } = makeService({ application: approved() });
    await service.approve('app-1', 'user-1', ['ADMIN']);
    expect(emailProvider.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('AS0009') }),
    );
  });
});

describe('which documents a candidate is asked for', () => {
  it('asks a proprietor for their shop entity proof and association letter', () => {
    const forProprietor = documentsRequestedFor(EmploymentCategory.PROPRIETOR);
    expect(forProprietor).toContain(OnboardingDocument.SHOP_ENTITY_PROOF);
    expect(forProprietor).toContain(OnboardingDocument.ASSOCIATION_LETTER);
    expect(forProprietor).not.toContain(OnboardingDocument.EXPERIENCE_LETTER);
  });

  it('asks a freelancer for an experience letter instead', () => {
    const forFreelancer = documentsRequestedFor(EmploymentCategory.FREELANCER);
    expect(forFreelancer).toContain(OnboardingDocument.EXPERIENCE_LETTER);
    expect(forFreelancer).not.toContain(OnboardingDocument.SHOP_ENTITY_PROOF);
  });

  it('asks everybody for the common set, including before a category is chosen', () => {
    for (const list of [
      documentsRequestedFor(null),
      documentsRequestedFor(EmploymentCategory.FREELANCER),
      documentsRequestedFor(EmploymentCategory.PROPRIETOR),
    ]) {
      expect(list).toEqual(expect.arrayContaining([
        OnboardingDocument.PAN_CARD,
        OnboardingDocument.AADHAAR_FRONT,
        OnboardingDocument.AADHAAR_BACK,
        OnboardingDocument.OFFICE_ADDRESS_PROOF,
      ]));
    }
  });
});
