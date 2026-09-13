import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ApplicationStatus, EmploymentCategory, OnboardingDocument, ApplicationSource } from '@fapoms/shared';

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
  /**
   * A photograph by default, because approval refuses without one.
   *
   * Every promotion fixture needs a face on file, so the harness supplies one rather than making
   * thirty tests repeat it. The refusal itself is tested by overriding this to an empty list —
   * see "approval refuses an application with no photograph".
   */
  const applicationDocuments = {
    findOne: jest.fn(async () => null),
    create: jest.fn((v: Row) => ({ ...v })),
    save: jest.fn(async (v: Row) => ({ ...v, id: 'doc-1' })),
    find: jest.fn(async () => ([
      { requirement: OnboardingDocument.PHOTOGRAPH, filePaths: ['uploads/face.jpg'] },
    ] as Row[])),
  };
  const assayerService = {
    create: jest.fn(async (_dto: Row, _userId?: string, _org?: string | null, _roles?: string[]) =>
      ({ id: 'assayer-1', assayerCode: 'AS0009', displayName: 'Ramesh Kulkarni' })),
  };
  const rosterRecords = { attachFile: jest.fn(async () => ({})) };
  const auditService = { recordEventSafe: jest.fn(async () => undefined) };
  const notificationDispatch = { emitSafe: jest.fn(async () => undefined) };
  const emailProvider = {
    send: jest.fn(async (_payload: { to: string; subject: string; text: string; html?: string }) =>
      ({ success: true } as { success: boolean; error?: string })),
  };
  const cache = {
    getJson: jest.fn(async (k: string) => (k in cacheData ? cacheData[k] : null)),
    setJson: jest.fn(async (k: string, v: unknown) => { cacheData[k] = v; }),
  };
  const settings = { getNumber: jest.fn(async (_k: string, fallback?: number) => fallback ?? 0) };
  const storage = { saveFile: jest.fn(async () => 'uploads/scan.png') };

  /** Read only so the reviewer sees the number HR typed beside the one the candidate confirmed. */
  const interviews = { findOne: jest.fn(async () => ({ mobile: '9822014455' })) };

  const service = new RegistrationApplicationService(
    applications as any, applicationDocuments as any, interviews as any,
    assayerService as any, rosterRecords as any,
    auditService as any, notificationDispatch as any, emailProvider as any,
    cache as any, settings as any, storage as any,
  );

  return {
    service, application, applications, applicationDocuments, interviews, assayerService, rosterRecords,
    auditService, notificationDispatch, emailProvider, cache, settings, storage, cacheData,
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
  it('never stores the code itself — only its hash, beside the phone it is bound to', async () => {
    const { service, cacheData, emailProvider } = makeService();
    await service.requestOtp(RAW_TOKEN, '9822014455');

    const entry = cacheData[`regotp:code:${TOKEN_HASH}`];
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    const sent = emailProvider.send.mock.calls[0][0].text;
    const code = sent.match(/\b(\d{6})\b/)![1];
    expect(entry).not.toMatchObject({ code });
  });

  it('caps how many codes one link may send, so a stolen link cannot bomb an inbox', async () => {
    // IP throttling cannot stop this on its own: the same link from rotating addresses hammers one
    // person's mailbox, with no account to lock and nothing else counting.
    const { service } = makeService({ cache: { [`regotp:sent:${TOKEN_HASH}`]: { count: 5 } } });
    await expect(service.requestOtp(RAW_TOKEN, '9822014455')).rejects.toThrow(/Too many verification codes/i);
  });

  it('makes a resend wait out the cooldown', async () => {
    const { service } = makeService({ cache: { [`regotp:lastsent:${TOKEN_HASH}`]: Date.now() } });
    await expect(service.requestOtp(RAW_TOKEN, '9822014455')).rejects.toThrow(/wait/i);
  });

  it('tells the candidate when the code could not be sent, instead of answering "sent"', async () => {
    /**
     * `EmailProvider.send` answers `{success:false}` — it does not throw — when the transport is
     * off. This used to log a warning and return success, so the page said a code was on its way
     * and the candidate waited for a message nobody had sent.
     */
    const ctx = makeService();
    ctx.emailProvider.send.mockResolvedValueOnce({ success: false, error: 'transport off' });
    await expect(ctx.service.requestOtp(RAW_TOKEN, '9822014455')).rejects.toThrow(/could not email you a verification code/i);
  });

  it('rejects a wrong code, and a right code offered for a different phone', async () => {
    const { service, cacheData, emailProvider } = makeService();
    await service.requestOtp(RAW_TOKEN, '9822014455');
    const code = emailProvider.send.mock.calls[0][0].text.match(/\b(\d{6})\b/)![1];

    await expect(service.verifyOtp(RAW_TOKEN, '9822014455', '000000')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.verifyOtp(RAW_TOKEN, '9999999999', code)).rejects.toBeInstanceOf(BadRequestException);

    await expect(service.verifyOtp(RAW_TOKEN, '9822014455', code)).resolves.toBeUndefined();
    expect(cacheData[`regotp:verified:${TOKEN_HASH}`]).toEqual({ phone: '9822014455' });
  });

  /**
   * The code gates FILING, not typing.
   *
   * It used to gate every write, which made an undelivered code a total block: a candidate holding
   * a valid link could not enter a character. The code reaches the same mailbox the link did, so
   * gating the form proved nothing the link had not, while turning a mail outage into "nobody can
   * register at all". Nothing is reviewed or promoted until the code confirms the person.
   */
  it('gates the filing, and lets the candidate fill the form with the link alone', async () => {
    const { service } = makeService();

    await expect(service.submit(RAW_TOKEN)).rejects.toBeInstanceOf(ForbiddenException);

    await expect(service.updateDraft(RAW_TOKEN, { fullName: 'X' })).resolves.toBeDefined();
    await expect(service.acceptConsent(RAW_TOKEN, 'v1')).resolves.toBeDefined();
    await expect(
      service.uploadDocument(RAW_TOKEN, OnboardingDocument.PAN_CARD, {
        originalname: 'x.png', buffer: Buffer.from('x'), mimetype: 'image/png', size: 1,
      }),
    ).resolves.toBeDefined();
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

  describe('resending a lost link', () => {
    it('mints a fresh link and kills the old one', async () => {
      // Both the candidate's "Ask HR to resend it" and the interview screen's advice pointed at
      // this; until it existed an undelivered invite was a dead end.
      const { service, application, emailProvider } = makeService({ application: submitted({ status: ApplicationStatus.DRAFT }) });
      const { emailed } = await service.resendInvite('app-1', 'user-1');

      expect(application!.tokenHash).not.toBe(TOKEN_HASH);
      expect(application!.tokenConsumedAt).toBeNull();
      expect(emailed).toBe(true);
      expect(emailProvider.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('earlier link has stopped working') }),
      );
    });

    it('reports honestly when the resend itself did not go out', async () => {
      const ctx = makeService({ application: submitted({ status: ApplicationStatus.DRAFT }) });
      ctx.emailProvider.send.mockResolvedValueOnce({ success: false, error: 'transport off' } as any);
      const { emailed } = await ctx.service.resendInvite('app-1', 'user-1');
      expect(emailed).toBe(false);
    });

    it('still mints a link when there is no address to send to — the desk delivers it', async () => {
      const noEmail = makeService({ application: submitted({ status: ApplicationStatus.DRAFT, email: null }) });
      const { emailed, inviteLink } = await noEmail.service.resendInvite('app-1', 'user-1');

      // No mailbox is not a refusal. The link is the deliverable; email is one way to deliver it,
      // and on a deployment with email switched off it is not a way at all.
      expect(emailed).toBe(false);
      expect(noEmail.emailProvider.send).not.toHaveBeenCalled();
      expect(inviteLink).toMatch(/\/register\/[0-9a-f]{16,}$/);
    });

    it('hands the minted link back to the caller, and it is the token that now resolves', async () => {
      const ctx = makeService({ application: submitted({ status: ApplicationStatus.DRAFT }) });
      const { inviteLink } = await ctx.service.resendInvite('app-1', 'user-1');
      const rawToken = inviteLink.split('/register/')[1];

      expect(rawToken).toBeTruthy();
      expect(require('crypto').createHash('sha256').update(rawToken).digest('hex'))
        .toBe(ctx.application!.tokenHash);
    });

    it('refuses once the application is decided', async () => {
      const decided = makeService({ application: submitted({ status: ApplicationStatus.APPROVED }) });
      await expect(decided.service.resendInvite('app-1', 'user-1')).rejects.toThrow(/already been decided/i);
    });
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
      { requirement: OnboardingDocument.PHOTOGRAPH, filePaths: ['uploads/face.jpg'] },
      { requirement: OnboardingDocument.PAN_CARD, filePaths: ['uploads/pan.png'] },
      { requirement: OnboardingDocument.AADHAAR_FRONT, filePaths: ['uploads/a1.png', 'uploads/a2.png'] },
    ] as any);

    await ctx.service.approve('app-1', 'user-1', ['ADMIN']);

    expect(ctx.rosterRecords.attachFile).toHaveBeenCalledTimes(4);
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

describe('who may approve an application', () => {
  /**
   * Everything in this queue is the candidate's own work, so the HR user who sent the invite is
   * the reviewer rather than the author. The desk's second intake — a staff account typing an
   * application and approving it — was withdrawn along with the routes nothing called; the gate
   * that guarded it is documented in `approve()` for whoever brings that shape back.
   */
  it('the inviter may approve — the candidate was the maker', async () => {
    const ctx = makeService({ application: {
      id: 'app-self', mobile: '9822014455', email: 'c@example.com', fullName: 'Candidate',
      state: 'Maharashtra', status: ApplicationStatus.PENDING_VALIDATION,
      organizationId: 'org-1', source: ApplicationSource.SELF_SERVICE, createdBy: 'hr-inviter',
    } });

    await ctx.service.approve('app-self', 'hr-inviter', ['ADMIN']);

    expect(ctx.assayerService.create).toHaveBeenCalled();
  });
});

describe('the extended profile the wizard collects', () => {
  const withProfile = () => ({
    id: 'app-x', mobile: '9822014455', fullName: 'Full Payload', state: 'Maharashtra',
    status: ApplicationStatus.PENDING_VALIDATION, organizationId: 'org-1',
    source: ApplicationSource.HR_DESK, createdBy: 'hr-maker',
    extendedProfile: {
      fields: { panNumber: 'ABCDE1234K', bankName: 'SBI' },
      commercial: { baseFee: 1500 },
      empanelments: [{ clientId: 'client-1', status: 'RECOMMENDED' }],
    },
  });

  const arm = (ctx: ReturnType<typeof makeService>) => {
    (ctx.assayerService as any).update = jest.fn(async () => ({}));
    (ctx.assayerService as any).createCommercialProfile = jest.fn(async () => ({}));
    (ctx.rosterRecords as any).setEmpanelment = jest.fn(async () => ({}));
    return ctx;
  };

  it('applies fields, rates and standings through the guarded services, after the person is real', async () => {
    const ctx = arm(makeService({ application: withProfile() }));

    await ctx.service.approve('app-x', 'hr-checker', ['ADMIN']);

    expect((ctx.assayerService as any).update).toHaveBeenCalledWith('assayer-1', expect.objectContaining({ panNumber: 'ABCDE1234K' }), 'hr-checker');
    expect((ctx.assayerService as any).createCommercialProfile).toHaveBeenCalledWith('assayer-1', expect.objectContaining({ baseFee: 1500 }), 'hr-checker');
    expect((ctx.rosterRecords as any).setEmpanelment).toHaveBeenCalledWith('assayer-1', 'client-1', expect.objectContaining({ status: 'RECOMMENDED' }), 'hr-checker');
  });

  it('a group the roster refuses becomes a NAMED gap in the approval audit — the promotion survives', async () => {
    const ctx = arm(makeService({ application: withProfile() }));
    (ctx.assayerService as any).createCommercialProfile = jest.fn(async () => { throw new Error('rate outside policy'); });

    const result = await ctx.service.approve('app-x', 'hr-checker', ['ADMIN']);

    expect(result.assayer.id).toBe('assayer-1'); // approved despite the gap
    // And the reviewer is TOLD. The gap used to reach only an audit remark, so a promotion whose
    // rate card was refused read to the person who approved it as a clean success.
    expect(result.gaps).toEqual([expect.stringContaining('commercial rates (rate outside policy)')]);
    expect(ctx.auditService.recordEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'ASSAYER_APPLICATION_APPROVED',
        remarks: expect.stringContaining('commercial rates (rate outside policy)'),
      }),
    );
  });
});

/**
 * One registration, whoever is typing.
 *
 * These cover the thing the pipeline previously could not do: carry the WHOLE person. A candidate
 * approved before this collected 48 of the record's 86 columns and reached the roster unable to be
 * paid, assigned, carded or signed in, because the candidate's form had no box for a PAN, a bank
 * account or an emergency contact and the desk's wizard wrote the record directly instead.
 */
describe('the application carries the whole person', () => {
  const patch = (record: Record<string, unknown>) => ({ record });

  it('stores the record-shaped answers the candidate typed', async () => {
    const ctx = makeService({ cache: verified() });
    await ctx.service.updateDraft(RAW_TOKEN, patch({
      panNumber: 'ABCDE1234F',
      bankAccountNumber: '123456789012',
      ifscCode: 'SBIN0001234',
      emergencyContactPhone: '9876500000',
    }) as never);

    const saved = ctx.applications.save.mock.calls.at(-1)![0];
    expect(saved.extendedProfile.fields).toEqual({
      panNumber: 'ABCDE1234F',
      bankAccountNumber: '123456789012',
      ifscCode: 'SBIN0001234',
      emergencyContactPhone: '9876500000',
    });
  });

  it('merges across saves, because the form is filled one screen at a time', async () => {
    const ctx = makeService({ cache: verified() });
    ctx.application!.extendedProfile = { fields: { panNumber: 'ABCDE1234F' } };

    await ctx.service.updateDraft(RAW_TOKEN, patch({ ifscCode: 'SBIN0001234' }) as never);

    const saved = ctx.applications.save.mock.calls.at(-1)![0];
    expect(saved.extendedProfile.fields).toEqual({ panNumber: 'ABCDE1234F', ifscCode: 'SBIN0001234' });
  });

  it('refuses a key registration may not set, rather than smuggling it into promotion', async () => {
    const ctx = makeService({ cache: verified() });
    await ctx.service.updateDraft(RAW_TOKEN, patch({
      panNumber: 'ABCDE1234F', lifecycleStatus: 'ACTIVE', qualificationScore: 99,
    }) as never);

    const saved = ctx.applications.save.mock.calls.at(-1)![0];
    expect(saved.extendedProfile.fields).toEqual({ panNumber: 'ABCDE1234F' });
  });

  it('checks the identifier while the candidate is still looking at the box', async () => {
    const ctx = makeService({ cache: verified() });
    await expect(ctx.service.updateDraft(RAW_TOKEN, patch({ panNumber: 'NOPE' }) as never))
      .rejects.toThrow(/PAN/i);
    await expect(ctx.service.updateDraft(RAW_TOKEN, patch({ ifscCode: 'nope' }) as never))
      .rejects.toThrow(/IFSC/i);
  });

  it('lets a candidate clear a field they got wrong', async () => {
    const ctx = makeService({ cache: verified() });
    await expect(ctx.service.updateDraft(RAW_TOKEN, patch({ panNumber: '' }) as never))
      .resolves.toBeDefined();
  });

  it('names what is still missing, and what each gap stops', async () => {
    const ctx = makeService();
    ctx.application!.extendedProfile = { fields: { panNumber: 'ABCDE1234F' } };

    const gaps = ctx.service.registrationGaps(ctx.application as never);
    expect(gaps.map((g) => g.key)).toEqual([
      'bankAccountNumber', 'ifscCode', 'joiningDate', 'emergencyContactPhone', 'latitude',
    ]);
    expect(gaps.find((g) => g.key === 'ifscCode')!.blocks).toMatch(/payout/i);
  });

  it('counts the phone the application already holds, so HR is not sent chasing it', async () => {
    const ctx = makeService();
    expect(ctx.service.registrationGaps(ctx.application as never).map((g) => g.key))
      .not.toContain('phone');
  });
});

/**
 * The number the candidate confirms is the number on the record.
 *
 * Both forms have always asked for it. `mobile` was not editable on the draft, so the answer keyed
 * a cache entry and was discarded, and the promoted record kept whatever HR typed at the interview
 * — for the first critical field there is.
 */
describe('the candidate owns their own phone number', () => {
  const withPending = (phone: string, code: string) => ({
    [`regotp:code:${TOKEN_HASH}`]: {
      hash: require('crypto').createHash('sha256').update(code).digest('hex'),
      phone,
    },
  });

  it('writes the confirmed number onto the application', async () => {
    const ctx = makeService({ cache: withPending('9812345678', '123456') });
    expect(ctx.application!.mobile).toBe('9822014455');

    await ctx.service.verifyOtp(RAW_TOKEN, '9812345678', '123456');

    expect(ctx.application!.mobile).toBe('9812345678');
    expect(ctx.applications.save).toHaveBeenCalled();
  });

  it('saves nothing when the number is the one already on file', async () => {
    const ctx = makeService({ cache: withPending('9822014455', '123456') });
    await ctx.service.verifyOtp(RAW_TOKEN, '9822014455', '123456');
    expect(ctx.applications.save).not.toHaveBeenCalled();
  });

  it('leaves a decided application alone — the record is HR‘s from then on', async () => {
    const ctx = makeService({
      application: {
        id: 'app-1', mobile: '9822014455', status: ApplicationStatus.APPROVED,
        tokenHash: TOKEN_HASH, tokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
      cache: withPending('9812345678', '123456'),
    });

    await ctx.service.verifyOtp(RAW_TOKEN, '9812345678', '123456');

    expect(ctx.application!.mobile).toBe('9822014455');
  });

  it('lets them correct it before verifying, too', async () => {
    const ctx = makeService();
    await ctx.service.updateDraft(RAW_TOKEN, { mobile: '9800000001' } as never);
    expect(ctx.applications.save.mock.calls.at(-1)![0].mobile).toBe('9800000001');
  });
});

describe('a face on file', () => {
  const submitted = () => ({
    id: 'app-1', mobile: '9822014455', email: 'c@example.com', fullName: 'Candidate',
    state: 'Maharashtra', status: ApplicationStatus.PENDING_VALIDATION, organizationId: 'org-1',
  });

  it('is asked for, whatever the candidate is engaged as', () => {
    for (const category of [undefined, EmploymentCategory.FREELANCER, EmploymentCategory.PROPRIETOR]) {
      expect(documentsRequestedFor(category)).toContain(OnboardingDocument.PHOTOGRAPH);
    }
  });

  /**
   * The one thing approval refuses over. Everything else incomplete is promoted and chased
   * afterwards; a card with no face on it is not a card, and it is what a bank's security desk
   * actually looks at.
   */
  it('is required before anybody can be approved', async () => {
    const ctx = makeService({ application: submitted() });
    ctx.applicationDocuments.find.mockResolvedValue([
      { requirement: OnboardingDocument.PAN_CARD, filePaths: ['uploads/pan.png'] },
    ] as any);

    await expect(ctx.service.approve('app-1', 'hr-1', ['ADMIN'])).rejects.toThrow(/photograph/i);
    expect(ctx.assayerService.create).not.toHaveBeenCalled();
  });

  it('is not satisfied by a requirement row with no file behind it', async () => {
    const ctx = makeService({ application: submitted() });
    ctx.applicationDocuments.find.mockResolvedValue([
      { requirement: OnboardingDocument.PHOTOGRAPH, filePaths: [] },
    ] as any);

    await expect(ctx.service.approve('app-1', 'hr-1', ['ADMIN'])).rejects.toThrow(/photograph/i);
  });
});

/**
 * Approving is the moment the person is hired, so it is the moment the terms are set.
 *
 * The reviewer could previously add nothing at all: the drawer was read-only and the call carried
 * no body, so a joining date — critical, and collected by no form in the product — was blank on
 * every person promoted through this queue.
 */
describe('the desk completes the person as it approves', () => {
  const ready = () => ({
    id: 'app-1', mobile: '9822014455', email: 'c@example.com', fullName: 'Candidate',
    state: 'Maharashtra', status: ApplicationStatus.PENDING_VALIDATION, organizationId: 'org-1',
  });

  it('applies the employment terms through the guarded update', async () => {
    const ctx = makeService({ application: ready() });
    (ctx.assayerService as any).update = jest.fn(async () => ({}));

    await ctx.service.approve('app-1', 'hr-1', ['ADMIN'], 'org-1', {
      terms: { joiningDate: '2026-10-01', maxDailyWorkload: 3 },
    });

    expect((ctx.assayerService as any).update).toHaveBeenCalledWith(
      'assayer-1', { joiningDate: '2026-10-01', maxDailyWorkload: 3 }, 'hr-1',
    );
  });

  it('refuses a term that is really a candidate answer, so ownership stays single', async () => {
    const ctx = makeService({ application: ready() });
    (ctx.assayerService as any).update = jest.fn(async () => ({}));

    await ctx.service.approve('app-1', 'hr-1', ['ADMIN'], 'org-1', {
      terms: { joiningDate: '2026-10-01', panNumber: 'ABCDE1234F' },
    });

    expect((ctx.assayerService as any).update).toHaveBeenCalledWith(
      'assayer-1', { joiningDate: '2026-10-01' }, 'hr-1',
    );
  });

  it('corrects what the candidate got wrong, through the registration allow-list', async () => {
    const ctx = makeService({ application: ready() });
    (ctx.assayerService as any).update = jest.fn(async () => ({}));

    await ctx.service.approve('app-1', 'hr-1', ['ADMIN'], 'org-1', {
      corrections: { ifscCode: 'SBIN0001234' },
    });

    expect((ctx.assayerService as any).update).toHaveBeenCalledWith(
      'assayer-1', expect.objectContaining({ ifscCode: 'SBIN0001234' }), 'hr-1',
    );
  });

  it('files the rate card and the first standing in the same action', async () => {
    const ctx = makeService({ application: ready() });
    (ctx.assayerService as any).update = jest.fn(async () => ({}));
    (ctx.assayerService as any).createCommercialProfile = jest.fn(async () => ({}));
    (ctx.rosterRecords as any).setEmpanelment = jest.fn(async () => ({}));

    await ctx.service.approve('app-1', 'hr-1', ['ADMIN'], 'org-1', {
      commercial: { baseFee: 1200 },
      empanelments: [{ clientId: 'client-1', status: 'RECOMMENDED' }],
    });

    expect((ctx.assayerService as any).createCommercialProfile).toHaveBeenCalled();
    expect((ctx.rosterRecords as any).setEmpanelment).toHaveBeenCalledWith(
      'assayer-1', 'client-1', expect.objectContaining({ status: 'RECOMMENDED' }), 'hr-1',
    );
  });

  it('hands a refused term back as a named gap rather than failing the hire', async () => {
    const ctx = makeService({ application: ready() });
    (ctx.assayerService as any).update = jest.fn(async () => { throw new Error('joining date is in the future'); });

    const { assayer, gaps } = await ctx.service.approve('app-1', 'hr-1', ['ADMIN'], 'org-1', {
      terms: { joiningDate: '2099-01-01' },
    });

    expect(assayer.id).toBe('assayer-1');
    expect(gaps).toEqual([expect.stringContaining('employment terms (joining date is in the future)')]);
  });

  it('shows the reviewer the interview number when it differs from the confirmed one', async () => {
    const ctx = makeService({ application: { ...ready(), mobile: '9812345678', interviewId: 'iv-1' } });
    ctx.interviews.findOne.mockResolvedValue({ mobile: '9822014455' } as never);

    const detail = await ctx.service.getApplication('app-1');

    expect(detail.invitedMobile).toBe('9822014455');
    expect(detail.gaps.map((g) => g.key)).toContain('panNumber');
  });

  it('says nothing when the two numbers agree', async () => {
    const ctx = makeService({ application: { ...ready(), interviewId: 'iv-1' } });
    ctx.interviews.findOne.mockResolvedValue({ mobile: '9822014455' } as never);

    expect((await ctx.service.getApplication('app-1')).invitedMobile).toBeNull();
  });
});

/**
 * Approving twice must not hire the same person twice.
 *
 * Promotion is four steps and only the last one closes the application, so a failure in the middle
 * left a real assayer on the roster with a consumed code and the application still pending. The
 * reviewer pressed Approve again and got a second person — or a hard refusal naming a duplicate
 * they had never knowingly created, with the first record orphaned and the application permanently
 * un-approvable.
 */
describe('approving is safe to repeat', () => {
  const ready = () => ({
    id: 'app-77', mobile: '9822014455', email: 'c@example.com', fullName: 'Candidate',
    state: 'Maharashtra', status: ApplicationStatus.PENDING_VALIDATION, organizationId: 'org-1',
  });

  it('keys the creation on the application, so a retry returns the same person', async () => {
    const ctx = makeService({ application: ready() });

    await ctx.service.approve('app-77', 'hr-1', ['ADMIN']);

    expect(ctx.assayerService.create).toHaveBeenCalledWith(
      expect.objectContaining({ clientRequestId: 'application:app-77' }),
      'hr-1', 'org-1', ['ADMIN'],
    );
  });
});

/**
 * A PAN already on the roster must be findable.
 *
 * It was not, on any deployment with a key configured: `pan_number` is encrypted with a fresh
 * random IV per call, so `WHERE pan_number = :pan` matched nothing — while the create path threw a
 * confident `DEFINITE_DUPLICATE: An assayer with PAN … already exists` from a branch that could not
 * fire. Aadhaar was never compared at all. Both are the identifiers the candidate is asked for,
 * uploads a scan of, and has validated at typing time.
 *
 * The comparison itself is `AssayerService.create`'s; what this pins is that the fingerprint is
 * deterministic over the shapes people actually type.
 */
describe('the identifiers a candidate gives can be matched against the roster', () => {
  const { fieldFingerprint, __resetKeyCacheForTests } =
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('../../infrastructure/security/field-encryption');

  beforeEach(() => {
    process.env.PII_ENCRYPTION_KEY = 'c'.repeat(64);
    __resetKeyCacheForTests();
  });

  afterEach(() => {
    delete process.env.PII_ENCRYPTION_KEY;
    __resetKeyCacheForTests();
  });

  it('finds the same person however they typed it', () => {
    expect(fieldFingerprint('abcde1234f')).toBe(fieldFingerprint(' ABCDE1234F '));
  });

  it('tells two people apart', () => {
    expect(fieldFingerprint('ABCDE1234F')).not.toBe(fieldFingerprint('ZZZZZ9999Z'));
  });

  it('has nothing to say about a blank, so empty columns do not all match each other', () => {
    expect(fieldFingerprint('')).toBeNull();
  });
});
