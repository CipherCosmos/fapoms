import { createHash } from 'crypto';
import {
  BadRequestException, ConflictException, ForbiddenException, NotFoundException, ValidationPipe,
} from '@nestjs/common';
import {
  ApplicationStatus, EmploymentCategory, OnboardingDocument, ApplicationSource, ASSAYER_ERROR_CODES,
} from '@fapoms/shared';

import { RegistrationApplicationService, documentsRequestedFor } from './registration-application.service';
import { __resetPincodeCache } from '../geo/pincode-lookup.helper';
import { OpenWithoutInterviewDto } from './hr-applications.controller';
import { runWithRequestContext } from '../../core/context/request-context';

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
  /** Written to only for the consent carry-over — see the service's own note on why. */
  const assayers = { update: jest.fn(async () => ({ affected: 1 })), findOne: jest.fn(async () => null) };

  const service = new RegistrationApplicationService(
    applications as any, applicationDocuments as any, interviews as any, assayers as any,
    assayerService as any, rosterRecords as any,
    auditService as any, notificationDispatch as any, emailProvider as any,
    cache as any, settings as any, storage as any,
  );

  return {
    service, application, applications, applicationDocuments, interviews, assayers, assayerService, rosterRecords,
    auditService, notificationDispatch, emailProvider, cache, settings, storage, cacheData,
  };
}

/** Marks the token as OTP-verified, the way a successful `verifyOtp` would have. */
const verified = () => ({ [`regotp:verified:${TOKEN_HASH}`]: { phone: '9822014455' } });

describe('registration invite tokens', () => {
  /**
   * Rewritten 2026-09-16: this used to assert the row did not contain
   * `tokenHash.slice(0, 8).toUpperCase()` — eight hex characters of the HASH, upper-cased. When
   * those eight happened to be all digits (about one run in forty) upper-casing was a no-op, the
   * row of course contained its own hash, and the suite went red for no reason. It also never
   * tested the property it names: the thing that must not be in the row is the RAW token, which
   * lives only in the emailed link.
   */
  it('stores only the hash of a freshly minted token, never the token itself', async () => {
    const { service, applications } = makeService({ application: null });
    const { inviteLink } = await service.createInvite({ mobile: '9822014455', email: 'x@example.com', fullName: 'X' });

    const saved = applications.save.mock.calls[0][0];
    const rawToken = inviteLink.split('/').pop()!;
    expect(rawToken).toMatch(/^[0-9a-f]{32,}$/);

    // The row keeps the hash OF that token, and nothing anybody could present as the token.
    expect(saved.tokenHash).toBe(createHash('sha256').update(rawToken).digest('hex'));
    expect(JSON.stringify(saved)).not.toContain(rawToken);
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

/**
 * A SUBMITTED APPLICATION'S LINK STOPS BEING A KEY TO THE CANDIDATE'S IDENTITY.
 *
 * The registration link is a bearer credential. It returned the whole application — PAN, Aadhaar,
 * bank account — for as long as it lived, including after approval, and an audit of the running
 * stack found hundreds of those links sitting in proxy logs. Once the application is out of the
 * candidate's hands, the link shows where they stand and nothing they told us.
 */
describe('the registration link after the form is submitted', () => {
  const withProfile = (status: ApplicationStatus) => ({
    id: 'app-1', mobile: '9822014455', email: 'candidate@example.com', fullName: 'Ramesh Kulkarni',
    status, tokenHash: TOKEN_HASH, tokenExpiresAt: new Date(Date.now() + 3_600_000),
    tokenConsumedAt: new Date(), employmentCategory: 'FREELANCER', organizationId: 'org-1',
    dateOfBirth: '1986-04-12', address: '14 MG Road', pincode: '560001',
    extendedProfile: { fields: { panNumber: 'ABCDE1234F', aadhaarNumber: '234567890124', bankAccountNumber: '50100123456789' } },
  });

  it.each([ApplicationStatus.PENDING_VALIDATION, ApplicationStatus.APPROVED, ApplicationStatus.REJECTED])(
    'shows a %s application without anything the candidate told us',
    async (status) => {
      const { service, applicationDocuments } = makeService({ application: withProfile(status) }) as any;
      applicationDocuments?.find?.mockResolvedValue?.([{ requirement: 'PAN_CARD', filePaths: ['uploads/1-pan.jpg'] }]);

      const view = await service.hydrate(RAW_TOKEN);
      const text = JSON.stringify(view);

      for (const secret of ['ABCDE1234F', '234567890124', '50100123456789', '1986-04-12', '14 MG Road', 'uploads/1-pan.jpg', '9822014455']) {
        expect(text).not.toContain(secret);
      }
      // …and still enough for the page to say where they stand.
      expect(view.application).toMatchObject({ status, fullName: 'Ramesh Kulkarni', email: 'candidate@example.com' });
    },
  );

  it('still gives the candidate their whole form while it is theirs to fill in', async () => {
    const { service } = makeService({ application: withProfile(ApplicationStatus.DRAFT) });
    const view = await service.hydrate(RAW_TOKEN);
    expect(JSON.stringify(view)).toContain('ABCDE1234F');
  });

  /** Sent back for more information, it is the candidate's form again. */
  it('gives the form back when HR asks for more information', async () => {
    const { service } = makeService({ application: withProfile(ApplicationStatus.AWAITING_INFO) });
    const view = await service.hydrate(RAW_TOKEN);
    expect(JSON.stringify(view)).toContain('ABCDE1234F');
  });

  it('refuses to open a scan through the link once the application is submitted', async () => {
    const { service } = makeService({ application: withProfile(ApplicationStatus.APPROVED) });
    await expect(service.documentFileKeyForToken(RAW_TOKEN, 'PAN_CARD' as never, 0))
      .rejects.toBeInstanceOf(ForbiddenException);
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
   * Maker–checker, and the distinction it turns on: who typed the substance.
   *
   * A candidate's own application has no maker on staff, so the HR user who sent the invite is the
   * reviewer rather than the author and may approve freely — `createdBy` is null on every
   * application an interview created, which is why the rule tests it rather than assuming it. A
   * desk-filled one does have a maker, and that account is refused. The same rule this product
   * already enforces for money: one person must not be able to manufacture a reviewed-looking
   * record alone.
   */
  const deskApplication = (over: Record<string, unknown> = {}) => ({
    id: 'app-desk', mobile: '9822014455', email: 'c@example.com', fullName: 'Typed By The Desk',
    state: 'Maharashtra', status: ApplicationStatus.PENDING_VALIDATION,
    organizationId: 'org-1', source: ApplicationSource.HR_DESK, createdBy: 'hr-maker',
    ...over,
  });

  it('the inviter may approve — the candidate was the maker', async () => {
    const ctx = makeService({ application: {
      id: 'app-self', mobile: '9822014455', email: 'c@example.com', fullName: 'Candidate',
      state: 'Maharashtra', status: ApplicationStatus.PENDING_VALIDATION,
      organizationId: 'org-1', source: ApplicationSource.SELF_SERVICE, createdBy: 'hr-inviter',
    } });

    await ctx.service.approve('app-self', 'hr-inviter', ['ADMIN']);

    expect(ctx.assayerService.create).toHaveBeenCalled();
  });

  it('refuses the account that typed it in', async () => {
    const ctx = makeService({ application: deskApplication() });
    await expect(ctx.service.approve('app-desk', 'hr-maker', ['ADMIN']))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(ctx.assayerService.create).not.toHaveBeenCalled();
  });

  it('carries the code, so a client can tell this refusal from a permission one', async () => {
    // `withCode` puts the code on the response body, which is what reaches the browser — not on
    // the exception object, which does not.
    const ctx = makeService({ application: deskApplication() });
    const error = await ctx.service.approve('app-desk', 'hr-maker', ['ADMIN']).catch((e) => e);
    expect(error.getResponse()).toMatchObject({
      code: ASSAYER_ERROR_CODES.APPLICATION_MAKER_CHECKER,
    });
  });

  it('records the attempt, because a refused approval is a thing that happened', async () => {
    const ctx = makeService({ application: deskApplication() });
    await ctx.service.approve('app-desk', 'hr-maker', ['ADMIN']).catch(() => undefined);
    expect(ctx.auditService.recordEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ASSAYER_APPLICATION_APPROVAL_REFUSED', userId: 'hr-maker' }),
    );
  });

  it('lets a different account approve the same application', async () => {
    const ctx = makeService({ application: deskApplication() });
    await ctx.service.approve('app-desk', 'hr-checker', ['ADMIN']);
    expect(ctx.assayerService.create).toHaveBeenCalled();
  });

  /**
   * The case a single `createdBy` cannot see. Two clerks share the typing; whoever touched the
   * form second would otherwise be free to approve the first one's work — or, with the other
   * ordering, the person who typed almost all of it approves their own.
   */
  it('refuses anybody who touched it, not only whoever touched it first', async () => {
    const ctx = makeService({ application: deskApplication({
      extendedProfile: { deskEditors: ['hr-maker', 'hr-second'] },
    }) });
    await expect(ctx.service.approve('app-desk', 'hr-second', ['ADMIN']))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  it('still refuses on createdBy alone, for an application typed before that list existed', async () => {
    const ctx = makeService({ application: deskApplication({ extendedProfile: {} }) });
    await expect(ctx.service.approve('app-desk', 'hr-maker', ['ADMIN']))
      .rejects.toBeInstanceOf(ForbiddenException);
  });

  /**
   * Order matters here. The refusal sits before `mergeRecordFields`, which mutates the entity in
   * place and throws its own message on a bad PAN — so a reviewer doing something they may not do
   * at all is told that, rather than being handed a validation error about the correction they
   * were making while doing it.
   */
  it('refuses before it looks at the corrections being submitted with the approval', async () => {
    const ctx = makeService({ application: deskApplication() });
    await expect(ctx.service.approve('app-desk', 'hr-maker', ['ADMIN'], undefined, {
      corrections: { panNumber: 'NOT-A-PAN' },
    })).rejects.toBeInstanceOf(ForbiddenException);
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

  /**
   * ONE REFUSED VALUE USED TO EMPTY THE WHOLE RECORD.
   *
   * Every field went to one `update`. A PAN already on somebody else threw, and nothing landed —
   * not the bank account, not the emergency contact, not the location. The person arrived on the
   * roster with none of it, and onboarding asked the desk for everything the candidate had already
   * typed in. Each group now fails alone.
   */
  describe('when one group of fields is refused', () => {
    const fullProfile = () => ({
      ...withProfile(),
      extendedProfile: {
        fields: {
          panNumber: 'ABCDE1234K', aadhaarNumber: '234567890124',
          bankAccountNumber: '123456789012', ifscCode: 'SBIN0001234', bankName: 'SBI',
          emergencyContactName: 'Sita', emergencyContactPhone: '9876500000',
          qualification: 'B.Sc', latitude: 19.07, longitude: 72.87, district: 'Mumbai',
        },
      },
    });

    /**
     * The record as the roster would actually hold it: an `update` that throws writes nothing.
     * Asserting on what was SENT is not enough — a single all-in-one call sends the bank account
     * too, right before it throws and keeps none of it. What matters is what LANDED.
     */
    const refusingIdentity = (ctx: ReturnType<typeof makeService>) => {
      const landed: Record<string, unknown> = {};
      (ctx.assayerService as any).update = jest.fn(async (_id: string, dto: Record<string, unknown>) => {
        if ('panNumber' in dto) throw new Error('That PAN is already on Ramesh Iyer (AS-77)');
        Object.assign(landed, dto);
        return {};
      });
      return { ctx, landed };
    };

    it('still carries the bank, contact, qualification and location onto the record', async () => {
      const { ctx, landed } = refusingIdentity(arm(makeService({ application: fullProfile() })));

      await ctx.service.approve('app-x', 'hr-checker', ['ADMIN']);

      expect(landed).toMatchObject({
        bankAccountNumber: '123456789012', ifscCode: 'SBIN0001234', bankName: 'SBI',
        emergencyContactName: 'Sita', emergencyContactPhone: '9876500000',
        qualification: 'B.Sc',
        latitude: 19.07, longitude: 72.87, district: 'Mumbai',
      });
      // …and only the refused group is missing.
      expect(landed).not.toHaveProperty('panNumber');
    });

    it('names exactly the group that was refused, and why', async () => {
      const { ctx } = refusingIdentity(arm(makeService({ application: fullProfile() })));

      const result = await ctx.service.approve('app-x', 'hr-checker', ['ADMIN']);

      expect(result.assayer.id).toBe('assayer-1');
      expect(result.gaps).toEqual([expect.stringContaining('identity numbers (That PAN is already on Ramesh Iyer (AS-77))')]);
    });

    /** Coordinates are only taken when both arrive, and the district is checked against the pincode. */
    it('sends latitude, longitude and district in one call', async () => {
      const ctx = arm(makeService({ application: fullProfile() }));

      await ctx.service.approve('app-x', 'hr-checker', ['ADMIN']);

      const sent = (ctx.assayerService as any).update.mock.calls.map((c: unknown[]) => c[1]);
      const location = sent.find((dto: Record<string, unknown>) => 'latitude' in dto);
      expect(location).toEqual({ latitude: 19.07, longitude: 72.87, district: 'Mumbai' });
    });
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

  it('rejects requestOtp when mobile is already registered to an active assayer', async () => {
    const ctx = makeService();
    ctx.assayers.findOne.mockResolvedValueOnce({ assayerCode: 'AS001', displayName: 'Existing Assayer' } as never);
    await expect(ctx.service.requestOtp(RAW_TOKEN, '9822014455')).rejects.toThrow(
      /already in use by somebody on our roster/i,
    );
  });

  it('rejects verifyOtp when mobile is already registered to an active assayer', async () => {
    const ctx = makeService({ cache: withPending('9812345678', '123456') });
    ctx.assayers.findOne.mockResolvedValueOnce({ assayerCode: 'AS001', displayName: 'Existing Assayer' } as never);
    await expect(ctx.service.verifyOtp(RAW_TOKEN, '9812345678', '123456')).rejects.toThrow(
      /already in use by somebody on our roster/i,
    );
  });

  it('rejects updateDraft when mobile is changed to a conflicting number', async () => {
    const ctx = makeService();
    ctx.assayers.findOne.mockResolvedValueOnce({ assayerCode: 'AS002', displayName: 'Another Assayer' } as never);
    await expect(ctx.service.updateDraft(RAW_TOKEN, { mobile: '9899999999' } as never)).rejects.toThrow(
      /already in use by somebody on our roster/i,
    );
  });

  /**
   * THE CANDIDATE IS NOT SOMEBODY ELSE.
   *
   * Approving an application CREATES an assayer carrying the candidate's number, so from that
   * moment the roster held a row matching their own application. With nothing excluding it, every
   * OTP request, verification and submit came back "This mobile number is already registered with
   * someone else" — about them, to them, on a form they could no longer get past. Observed live:
   * both approved applications on the box matched the very record they had produced.
   */
  it('never reports a candidate as a conflict with the record their own approval created', async () => {
    const ctx = makeService({
      application: {
        id: 'app-1', mobile: '9822014455', email: 'candidate@example.com', status: ApplicationStatus.DRAFT,
        promotedAssayerId: 'assayer-from-this-application',
        tokenHash: TOKEN_HASH, tokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    ctx.assayers.findOne.mockResolvedValue({
      id: 'assayer-from-this-application', assayerCode: 'AS0017', displayName: 'Priya Sharma',
    } as never);

    await expect(ctx.service.requestOtp(RAW_TOKEN, '9822014455')).resolves.not.toThrow();
  });

  it('still refuses a number held by a DIFFERENT person on the roster, and names them for the desk', async () => {
    const ctx = makeService({
      application: {
        id: 'app-1', mobile: '9822014455', email: 'candidate@example.com', status: ApplicationStatus.DRAFT,
        promotedAssayerId: 'assayer-from-this-application',
        tokenHash: TOKEN_HASH, tokenExpiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    ctx.assayers.findOne.mockResolvedValue({
      id: 'somebody-else', assayerCode: 'AS-01', displayName: 'Nilesh Rahane',
    } as never);

    // The candidate is told there is a clash, but never whose number it is.
    await expect(ctx.service.requestOtp(RAW_TOKEN, '9822014455')).rejects.toThrow(
      /already in use by somebody on our roster/i,
    );
    const conflict = await ctx.service.checkMobileConflict('9822014455', null, 'app-1', 'assayer-from-this-application');
    expect(conflict!.message).not.toMatch(/Nilesh|AS-01/);
    // The desk's copy names them, which is the only way a clerk can tell a duplicate from a typo.
    expect(conflict!.detail).toMatch(/Nilesh Rahane \(AS-01\)/);
  });

  it('rejects submit when application mobile has a conflict', async () => {
    const ctx = makeService({ cache: verified() });
    ctx.assayers.findOne.mockResolvedValueOnce({ assayerCode: 'AS001', displayName: 'Existing Assayer' } as never);
    await expect(ctx.service.submit(RAW_TOKEN)).rejects.toThrow(
      /already in use by somebody on our roster/i,
    );
  });

  it('allows HR to update application mobile with updateApplicationMobile', async () => {
    const ctx = makeService();
    ctx.applications.findOne = jest.fn(async () => ({ ...ctx.application, status: ApplicationStatus.PENDING_VALIDATION }));
    const updated = await ctx.service.updateApplicationMobile('app-1', '9811223344', 'hr-user-1');
    expect(updated.mobile).toBe('9811223344');
    expect(ctx.auditService.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'ASSAYER_APPLICATION_MOBILE_UPDATED',
    }));
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

  /**
   * The interviewer's notes were written down every time and shown on no screen. This method
   * already loaded the interview row and read one field off it — the mobile — so the reviewer
   * deciding the application could not see what the interviewer had written.
   */
  it('gives the reviewer what the interviewer wrote', async () => {
    const ctx = makeService({ application: { ...ready(), interviewId: 'iv-1' } });
    const when = new Date('2026-09-02T10:00:00.000Z');
    ctx.interviews.findOne.mockResolvedValue({
      mobile: '9822014455', outcome: 'PASS', notes: 'Steady hands; knows the acid test.',
      interviewedAt: when, interviewedByName: 'Meera Rao',
    } as never);

    const detail = await ctx.service.getApplication('app-1');

    expect(detail.interview).toEqual({
      outcome: 'PASS', notes: 'Steady hands; knows the acid test.',
      interviewedAt: when, interviewedByName: 'Meera Rao',
    });
  });

  it('has no interview to show for somebody let in without one', async () => {
    const ctx = makeService({ application: { ...ready(), interviewId: null } });

    expect((await ctx.service.getApplication('app-1')).interview).toBeNull();
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

/**
 * What a candidate agreed to has to survive becoming an employee.
 *
 * Submitting is refused without the declaration, and promotion then copied thirteen fields onto
 * the new record with neither the acceptance nor its version among them, because `assayers` had
 * nowhere to put them. The one artefact with a compliance life of its own lived only on a row
 * whose purpose ends at approval.
 */
describe('consent follows the person onto the roster', () => {
  const accepted = (at: Date | null, version: string | null) => ({
    id: 'app-c', mobile: '9822014455', email: 'c@example.com', fullName: 'Candidate',
    state: 'Maharashtra', status: ApplicationStatus.PENDING_VALIDATION, organizationId: 'org-1',
    consentAcceptedAt: at, consentVersion: version,
  });

  it('writes the acceptance and the wording it was given as', async () => {
    const when = new Date('2026-09-13T06:00:00.000Z');
    const ctx = makeService({ application: accepted(when, 'v1') });

    await ctx.service.approve('app-c', 'hr-1', ['ADMIN']);

    expect(ctx.assayers.update).toHaveBeenCalledWith('assayer-1', {
      consentAcceptedAt: when, consentVersion: 'v1',
    });
  });

  /** A consent nobody recorded must read as absent, not be invented at the boundary. */
  it('writes nothing when there is no consent on the application', async () => {
    const ctx = makeService({ application: accepted(null, null) });

    await ctx.service.approve('app-c', 'hr-1', ['ADMIN']);

    expect(ctx.assayers.update).not.toHaveBeenCalled();
  });
});

/**
 * Somebody mid-form is not somebody to hire.
 *
 * `mustBeReviewable` refuses a DECIDED application and nothing else, so a DRAFT could be approved
 * straight out of the queue — routing around both of `submit()`'s checks at once, the declaration
 * and the verification code. Found by running the journey against the live server, where an
 * application the candidate had never submitted promoted cleanly to a real appraiser code.
 */
describe('an unfinished application cannot be approved', () => {
  const at = (status: ApplicationStatus) => ({
    id: 'app-d', mobile: '9822014455', email: 'c@example.com', fullName: 'Candidate',
    state: 'Maharashtra', status, organizationId: 'org-1',
  });

  it('refuses a draft, and says what the candidate still has to do', async () => {
    const ctx = makeService({ application: at(ApplicationStatus.DRAFT) });

    await expect(ctx.service.approve('app-d', 'hr-1', ['ADMIN']))
      .rejects.toThrow(/has not submitted|declaration/i);
    expect(ctx.assayerService.create).not.toHaveBeenCalled();
  });

  it('still allows one HR asked more of — deciding to proceed is theirs to make', async () => {
    const ctx = makeService({ application: at(ApplicationStatus.AWAITING_INFO) });

    await ctx.service.approve('app-d', 'hr-1', ['ADMIN']);

    expect(ctx.assayerService.create).toHaveBeenCalled();
  });
});

/**
 * The review queue is a list of people who have applied for a job and not got one. It was served
 * with no organisation predicate at all, so an OPERATIONS user in one organisation read every
 * other organisation's candidates — names, mobile numbers, email addresses, and whatever they had
 * filled in about themselves.
 *
 * The rows have carried `organizationId` since the table was created. Nothing read it back.
 */
describe('whose applications the queue returns', () => {
  const asPrincipal = (roleNames: string[], organizationId: string | undefined, fn: () => unknown) =>
    runWithRequestContext(
      { method: 'GET', route: '/hr/applications', roleNames, organizationId } as never,
      fn as never,
    );

  it('confines an OPERATIONS user to their own organisation', async () => {
    const ctx = makeService();
    await asPrincipal(['OPERATIONS'], 'org-a', () => ctx.service.listApplications());
    expect(ctx.applications.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-a' } }),
    );
  });

  it('keeps the status filter alongside it rather than replacing it', async () => {
    const ctx = makeService();
    await asPrincipal(['OPERATIONS'], 'org-a', () =>
      ctx.service.listApplications(ApplicationStatus.PENDING_VALIDATION));
    expect(ctx.applications.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: ApplicationStatus.PENDING_VALIDATION, organizationId: 'org-a' },
      }),
    );
  });

  it('lets ADMIN read across, which is what the platform operator is for', async () => {
    const ctx = makeService();
    await asPrincipal(['ADMIN'], 'org-a', () => ctx.service.listApplications());
    expect(ctx.applications.find).toHaveBeenCalledWith(expect.objectContaining({ where: {} }));
  });
});

/**
 * Two PASS verdicts for one candidate, from the application layer's side.
 *
 * `openApplicationForMobile` is what stops a second interview minting a rival application. It
 * deliberately ignores terminal ones: somebody rejected a year ago and interviewed again is a new
 * candidate, and remembering that against them would be the wrong kind of memory.
 */
describe('openApplicationForMobile', () => {
  it('finds an application the candidate has not finished', async () => {
    const ctx = makeService({ application: {
      id: 'app-open', mobile: '9822014455', status: ApplicationStatus.DRAFT, organizationId: 'org-1',
    } });
    expect(await ctx.service.openApplicationForMobile('9822014455', 'org-1')).toMatchObject({ id: 'app-open' });
  });

  it('ignores one that was already decided', async () => {
    const ctx = makeService({ application: {
      id: 'app-done', mobile: '9822014455', status: ApplicationStatus.REJECTED, organizationId: 'org-1',
    } });
    expect(await ctx.service.openApplicationForMobile('9822014455', 'org-1')).toBeNull();
  });

  it('answers null for a blank number rather than searching for one', async () => {
    const ctx = makeService();
    expect(await ctx.service.openApplicationForMobile('  ', 'org-1')).toBeNull();
    expect(ctx.applications.find).not.toHaveBeenCalled();
  });
});

/**
 * The desk filling a candidate's form in for them — the second typist, not a second pipeline.
 *
 * The application is still created by an interview PASS, the candidate still verifies their own
 * number and accepts the declaration, and Submit is still theirs to press. All this does is save
 * them typing, for the case where they are sitting at the desk or have sent their papers in.
 */
describe('the desk filling in an application', () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    id: 'app-1', mobile: '9822014455', fullName: null, status: ApplicationStatus.DRAFT,
    organizationId: 'org-1', source: ApplicationSource.SELF_SERVICE, createdBy: null,
    extendedProfile: null, ...over,
  });

  it('writes the application’s own columns and the record half in one save', async () => {
    const ctx = makeService({ application: draft() });
    const saved = await ctx.service.updateStaffDraft('app-1', {
      fullName: 'Ramesh Kulkarni',
      city: 'Pune',
      record: { panNumber: 'ABCDE1234F', bankName: 'State Bank' },
    }, 'hr-maker');

    expect(saved.fullName).toBe('Ramesh Kulkarni');
    expect(saved.city).toBe('Pune');
    expect((saved.extendedProfile as any).fields).toMatchObject({
      panNumber: 'ABCDE1234F', bankName: 'State Bank',
    });
  });

  it('refuses a field registration may not set, rather than storing it quietly', async () => {
    // The same filter the candidate's door uses. An application is not a back door into columns
    // the desk cannot set on the record itself.
    const ctx = makeService({ application: draft() });
    const saved = await ctx.service.updateStaffDraft('app-1', {
      record: { panNumber: 'ABCDE1234F', lifecycleStatus: 'ACTIVE', qualificationScore: 100 },
    }, 'hr-maker');
    expect((saved.extendedProfile as any).fields).toEqual({ panNumber: 'ABCDE1234F' });
  });

  it('checks a PAN at the moment it is typed, the same as the candidate’s form does', async () => {
    const ctx = makeService({ application: draft() });
    await expect(ctx.service.updateStaffDraft('app-1', { record: { panNumber: 'NOPE' } }, 'hr-maker'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * These three have appliers in `approve()` and, until the desk could send them, no producer at
   * all — which is why every candidate promoted through this pipeline arrived with no rate card
   * and no client standing, and could not be given work until somebody noticed.
   */
  it('carries the rate card, the references and the first client standings', async () => {
    const ctx = makeService({ application: draft() });
    const saved = await ctx.service.updateStaffDraft('app-1', {
      commercial: { baseFee: 900, currency: 'INR' },
      references: [{ fullName: 'A Referee', phone: '9811100022' }],
      empanelments: [{ clientId: 'client-1', status: 'EMPANELLED' }],
    }, 'hr-maker');

    const profile = saved.extendedProfile as any;
    expect(profile.commercial).toMatchObject({ baseFee: 900 });
    expect(profile.references).toHaveLength(1);
    expect(profile.empanelments[0].clientId).toBe('client-1');
  });

  it('marks the application as desk-typed, and names who typed it', async () => {
    const ctx = makeService({ application: draft() });
    const saved = await ctx.service.updateStaffDraft('app-1', { fullName: 'X' }, 'hr-maker');
    expect(saved.source).toBe(ApplicationSource.HR_DESK);
    expect(saved.createdBy).toBe('hr-maker');
  });

  it('does not hand the maker title to whoever saved second', async () => {
    const ctx = makeService({ application: draft({
      source: ApplicationSource.HR_DESK, createdBy: 'hr-maker',
    }) });
    const saved = await ctx.service.updateStaffDraft('app-1', { city: 'Pune' }, 'hr-second');
    expect(saved.createdBy).toBe('hr-maker');
    // But the second clerk is remembered, so approval can refuse them too.
    expect((saved.extendedProfile as any).deskEditors).toContain('hr-second');
  });

  /**
   * The same predicate the candidate's own door uses, not merely "not terminal". Once they submit,
   * what is under review stops changing — otherwise "approve what you read" is not true.
   * `requestMoreInfo` is the way back: it returns the row to AWAITING_INFO, which is editable.
   */
  it('stops once the candidate has submitted', async () => {
    const ctx = makeService({ application: draft({ status: ApplicationStatus.PENDING_VALIDATION }) });
    await expect(ctx.service.updateStaffDraft('app-1', { city: 'Pune' }, 'hr-maker'))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('is available again after HR asks for more information', async () => {
    const ctx = makeService({ application: draft({ status: ApplicationStatus.AWAITING_INFO }) });
    const saved = await ctx.service.updateStaffDraft('app-1', { city: 'Pune' }, 'hr-maker');
    expect(saved.city).toBe('Pune');
  });

  it('records that the desk typed it, so the trail says approval must come from elsewhere', async () => {
    const ctx = makeService({ application: draft() });
    await ctx.service.updateStaffDraft('app-1', { fullName: 'X' }, 'hr-maker');
    expect(ctx.auditService.recordEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ASSAYER_APPLICATION_DESK_EDITED', userId: 'hr-maker' }),
    );
  });

  it('cannot accept consent or submit on the candidate’s behalf — there is no such field', async () => {
    const ctx = makeService({ application: draft() });
    // Sent as keys the shape has no room for: `EDITABLE_DRAFT_FIELDS` does not list either, and
    // the loop only copies what it lists. The candidate's declaration stays the candidate's.
    const smuggled = {
      consentAcceptedAt: new Date(),
      status: ApplicationStatus.PENDING_VALIDATION,
    } as unknown as Parameters<typeof ctx.service.updateStaffDraft>[1];
    const saved = await ctx.service.updateStaffDraft('app-1', smuggled, 'hr-maker');
    expect(saved.consentAcceptedAt).toBeFalsy();
    expect(saved.status).toBe(ApplicationStatus.DRAFT);
  });
});

describe('candidate lookups (pincode → address, IFSC → bank)', () => {
  // The directory answer is cached process-wide (it costs ~3.6s and pincodes do not move), so a
  // suite that stubs `fetch` has to start from an empty one or it tests the previous test's answer.
  beforeEach(() => __resetPincodeCache());

  /**
   * The directory is read through the invite token, not a session — so the token
   * gate is tested first, and a bad token spends no network at all.
   */
  it('refuses lookups on an unknown token without touching the network', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      const ctx = makeService({ application: null });
      await expect(ctx.service.lookupPincode('bogus-token', '411001'))
        .rejects.toBeInstanceOf(NotFoundException);
      await expect(ctx.service.lookupIfsc('bogus-token', 'HDFC0001234'))
        .rejects.toBeInstanceOf(NotFoundException);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('answers a malformed pincode or IFSC without a network call', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    try {
      const ctx = makeService();
      // Three digits is not a pincode anybody holds — that is the directory's answer, not an outage.
      await expect(ctx.service.lookupPincode(RAW_TOKEN, '123')).resolves.toEqual({ status: 'not-found' });
      await expect(ctx.service.lookupIfsc(RAW_TOKEN, 'NOTACODE')).resolves.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('returns the directory answer for a recognised pincode and IFSC', async () => {
    const ctx = makeService();
    const fetchSpy = jest.spyOn(global, 'fetch')
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { Status: 'Success', PostOffice: [{ State: 'Maharashtra', District: 'Pune', Block: 'Haveli' }] },
        ]),
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ BANK: 'HDFC Bank', BRANCH: 'MG Road', CITY: 'Pune', STATE: 'Maharashtra' }),
      } as any);
    try {
      /*
        The town is Pune, not the block's "Haveli" — Haveli is the taluka around Pune, and the
        directory's block is only taken as a town when the district or the division corroborates
        it. See `townFromDirectory`: an uncorroborated block is what filed Guwahati as "Gmc".
      */
      await expect(ctx.service.lookupPincode(RAW_TOKEN, '411001')).resolves.toEqual({
        status: 'found', state: 'Maharashtra', district: 'Pune', city: 'Pune', source: 'directory',
      });
      await expect(ctx.service.lookupIfsc(RAW_TOKEN, 'HDFC0001234')).resolves.toMatchObject({
        bankName: 'HDFC Bank',
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('says the lookup was unavailable when the directory is unreachable, rather than throwing', async () => {
    const ctx = makeService();
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('directory down'));
    try {
      /*
        The distinction the form depends on. An unreachable directory is NOT "no such pincode":
        reporting it as one is what told every candidate to check digits that were correct, because
        the deployed container cannot reach the postal API at all.
      */
      await expect(ctx.service.lookupPincode(RAW_TOKEN, '411001')).resolves.toEqual({ status: 'unavailable' });
      await expect(ctx.service.lookupIfsc(RAW_TOKEN, 'HDFC0001234')).resolves.toBeNull();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

/**
 * The second door into the hiring pipeline, and the reason it is allowed to exist.
 *
 * A PASS used to be the only way in, so a walk-in or a referral could be hired only by recording
 * an interview that never happened — which does not protect the gate, it only poisons the
 * screening record of everybody who really was interviewed. The step is skippable now, and what
 * makes that safe is that the skip is written down twice: stamped on the candidate's own
 * application, and in the audit trail beside the name of whoever decided it.
 */
describe('a candidate admitted without an interview', () => {
  const ACTOR = { id: 'hr-1', name: 'Priya Nair', organizationId: 'org-1' };
  const INPUT = {
    fullName: 'Ramesh Kulkarni',
    mobile: '9822014455',
    email: 'ramesh@example.com',
    reason: 'Walk-in referred by the Pune branch manager; interviewed informally on the floor.',
  };

  /** No row anywhere: nobody on the roster, nothing open in the queue. */
  const emptyQueue = () => makeService({ application: null });

  it('opens an application and hands back a link the desk can read out', async () => {
    const ctx = emptyQueue();
    const result = await ctx.service.openWithoutInterview(INPUT, ACTOR);

    expect(result.applicationId).toBe('app-new');
    // Always returned, whatever the email did — a deployment with no mailbox still has to be able
    // to get a candidate in. The raw token lives only here and in the email.
    expect(result.inviteLink).toMatch(/\/register\/[0-9a-f]{64}$/);
    expect(result.emailed).toBe(true);
  });

  it('stamps the reason and the person who decided it onto the application', async () => {
    const ctx = emptyQueue();
    await ctx.service.openWithoutInterview(INPUT, ACTOR);

    const saved = ctx.applications.save.mock.calls.at(-1)![0];
    expect(saved.extendedProfile.openedWithoutInterview).toMatchObject({
      reason: INPUT.reason,
      byId: 'hr-1',
      byName: 'Priya Nair',
    });
    expect(Date.parse(saved.extendedProfile.openedWithoutInterview.at)).not.toBeNaN();
  });

  /**
   * `HR_DESK` is not a label for "HR started this" — it means the desk typed the substance, and
   * `approve()` bars every account it names from reviewing the result. Claiming it here would
   * quietly lock whoever added the candidate out of their own queue.
   */
  it('leaves the candidate as the author of their own form, and the interview column empty', async () => {
    const ctx = emptyQueue();
    await ctx.service.openWithoutInterview(INPUT, ACTOR);

    const saved = ctx.applications.save.mock.calls.at(-1)![0];
    expect(saved.source).toBeUndefined();
    expect(saved.interviewId).toBeNull();
    expect(saved.status).toBe(ApplicationStatus.DRAFT);
  });

  it('writes the decision to the audit trail, carrying the reason and the actor', async () => {
    const ctx = emptyQueue();
    await ctx.service.openWithoutInterview(INPUT, ACTOR);

    expect(ctx.auditService.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'ASSAYER_APPLICATION_OPENED_WITHOUT_INTERVIEW',
      entityType: 'ASSAYER_APPLICATION',
      userId: 'hr-1',
      remarks: expect.stringContaining(INPUT.reason),
    }));
  });

  /**
   * The order the rest of this service is built on: an email cannot be recalled, so it goes last.
   * A stamp that failed to save after the send would leave a candidate holding a live link into a
   * pipeline with no record of why they are in it — the exact state this endpoint exists to avoid.
   */
  it('saves the stamp before the invite is sent, not after', async () => {
    const ctx = emptyQueue();
    await ctx.service.openWithoutInterview(INPUT, ACTOR);

    const lastSave = ctx.applications.save.mock.invocationCallOrder.at(-1)!;
    expect(ctx.emailProvider.send.mock.invocationCallOrder[0]).toBeGreaterThan(lastSave);
  });

  it('still hands back the link when the email did not go, and says so', async () => {
    const ctx = emptyQueue();
    ctx.emailProvider.send.mockResolvedValueOnce({ success: false, error: 'transport off' });
    const result = await ctx.service.openWithoutInterview(INPUT, ACTOR);

    expect(result.emailed).toBe(false);
    expect(result.inviteLink).toMatch(/\/register\/[0-9a-f]{64}$/);
  });

  it('refuses a number that already belongs to somebody on the roster', async () => {
    const ctx = emptyQueue();
    ctx.assayers.findOne.mockResolvedValueOnce({ assayerCode: 'AS0007', displayName: 'Ramesh K' } as never);

    await expect(ctx.service.openWithoutInterview(INPUT, ACTOR))
      .rejects.toBeInstanceOf(ConflictException);
    // Nothing minted, nothing sent: the refusal is before the first write.
    expect(ctx.applications.save).not.toHaveBeenCalled();
    expect(ctx.emailProvider.send).not.toHaveBeenCalled();
  });

  /**
   * The failure the interview path already learned: two live links for one person, with no unique
   * index to stop it, and whichever one the candidate happened to open becoming the real one.
   */
  it('refuses a person who already has an application open, naming them and it', async () => {
    const ctx = makeService({
      application: {
        id: 'app-open', mobile: '9822014455', fullName: 'Ramesh Kulkarni',
        status: ApplicationStatus.PENDING_VALIDATION, organizationId: 'org-1',
      },
    });

    const thrown = await ctx.service.openWithoutInterview(INPUT, ACTOR).catch((e) => e);
    expect(thrown).toBeInstanceOf(ConflictException);
    expect(thrown.message).toContain('Ramesh Kulkarni');
    expect(thrown.message).toMatch(/already has an open application/i);
    // The id travels in the body so the screen can offer "open it" rather than sending the desk
    // back to the queue to search for a name it has just been told.
    expect(thrown.getResponse()).toMatchObject({ applicationId: 'app-open' });
    expect(ctx.applications.save).not.toHaveBeenCalled();
    expect(ctx.emailProvider.send).not.toHaveBeenCalled();
  });

  it('treats a decided application as no obstacle — that is a new candidate', async () => {
    const ctx = makeService({
      application: {
        id: 'app-old', mobile: '9822014455', fullName: 'Ramesh Kulkarni',
        status: ApplicationStatus.REJECTED, organizationId: 'org-1',
      },
    });
    await expect(ctx.service.openWithoutInterview(INPUT, ACTOR)).resolves.toMatchObject({
      applicationId: expect.any(String),
    });
  });

  it('refuses a reason too short to be one, before anything is written', async () => {
    const ctx = emptyQueue();
    await expect(ctx.service.openWithoutInterview({ ...INPUT, reason: 'walk in' }, ACTOR))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(ctx.service.openWithoutInterview({ ...INPUT, reason: '   ' }, ACTOR))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(ctx.applications.save).not.toHaveBeenCalled();
  });

  /**
   * The same floor at the edge, so a caller never reaches the service's copy of it. Run through a
   * real `ValidationPipe` with main.ts's options rather than by reading the decorators, because
   * what is being checked is that the request is refused — not that a decorator is present.
   */
  describe('what the endpoint will accept at all', () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const through = (body: Record<string, unknown>) =>
      pipe.transform(body, { type: 'body', metatype: OpenWithoutInterviewDto } as never);

    it('takes a full request', async () => {
      await expect(through({ ...INPUT })).resolves.toMatchObject({ reason: INPUT.reason });
    });

    it('refuses a missing reason', async () => {
      const { reason: _dropped, ...withoutReason } = INPUT;
      await expect(through(withoutReason)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a reason nobody could read later', async () => {
      await expect(through({ ...INPUT, reason: 'ok' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a nameless or numberless candidate', async () => {
      await expect(through({ ...INPUT, fullName: 'R' })).rejects.toBeInstanceOf(BadRequestException);
      await expect(through({ ...INPUT, mobile: '123' })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts no email at all, and refuses one that is not an address', async () => {
      const { email: _none, ...withoutEmail } = INPUT;
      await expect(through(withoutEmail)).resolves.toMatchObject({ mobile: INPUT.mobile });
      await expect(through({ ...INPUT, email: 'not-an-address' })).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});

/**
 * `listApplications` returns entities, so the queue has always been able to see the stamp. The
 * review drawer reads a projection, and saw only `interviewId: null` — a data gap, not a decision.
 */
describe('the review drawer can see why there was no interview', () => {
  const stamped = {
    id: 'app-1', mobile: '9822014455', fullName: 'Ramesh Kulkarni', organizationId: 'org-1',
    status: ApplicationStatus.PENDING_VALIDATION, interviewId: null,
    extendedProfile: {
      openedWithoutInterview: {
        reason: 'Walk-in referred by the Pune branch manager.',
        byId: 'hr-1', byName: 'Priya Nair', at: '2026-09-16T09:00:00.000Z',
      },
    },
  };

  it('hands the stamp to the reviewer beside the application it excused', async () => {
    const ctx = makeService({ application: stamped });
    const view = await ctx.service.getApplication('app-1');
    expect(view.openedWithoutInterview).toEqual({
      reason: 'Walk-in referred by the Pune branch manager.',
      byId: 'hr-1', byName: 'Priya Nair', at: '2026-09-16T09:00:00.000Z',
    });
  });

  it('answers null for a candidate who came through an interview', async () => {
    const ctx = makeService();
    expect((await ctx.service.getApplication('app-1')).openedWithoutInterview).toBeNull();
  });

  /** Half a stamp renders as "Added without an interview — undefined", which is worse than none. */
  it('answers null for a stamp with no reason in it', async () => {
    const ctx = makeService({
      application: { ...stamped, extendedProfile: { openedWithoutInterview: { byId: 'hr-1' } } },
    });
    expect((await ctx.service.getApplication('app-1')).openedWithoutInterview).toBeNull();
  });
});

/**
 * THE CHECKS THAT USED TO ARRIVE AS REVIEW-QUEUE FINDINGS.
 *
 * `data-integrity.service.ts` refuses an age outside 18–90 and flags a PAN, Aadhaar or email that
 * already belongs to somebody — but it sweeps rows that exist, so the candidate had registered,
 * been approved and reached the roster days before HR saw it. Submit asks the same questions at
 * the one moment the answer can still change the outcome.
 */
describe('what submit refuses that the roster sweep used to catch later', () => {
  /*
    The identifier checks compare FINGERPRINTS, which need the PII key: without it
    `fieldFingerprint` returns null and the duplicate check quietly does nothing. Production sets
    the key; a bare test process does not, so set it here — and that silence is exactly why the
    roster sweep stays as the backstop rather than being deleted.
  */
  const originalKey = process.env.PII_ENCRYPTION_KEY;
  beforeAll(() => { process.env.PII_ENCRYPTION_KEY = 'a'.repeat(64); });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
    else process.env.PII_ENCRYPTION_KEY = originalKey;
  });

  const ready = (over: Record<string, unknown> = {}) => ({
    id: 'app-1', mobile: '9822014455', email: 'candidate@example.com', fullName: 'Ramesh Kulkarni',
    status: ApplicationStatus.DRAFT, tokenHash: TOKEN_HASH,
    tokenExpiresAt: new Date(Date.now() + 3_600_000), tokenConsumedAt: null,
    employmentCategory: 'FREELANCER', consentAcceptedAt: new Date(), organizationId: 'org-1',
    ...over,
  });

  const seventeenYearsAgo = () => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 17);
    return d.toISOString().slice(0, 10);
  };

  it('refuses somebody under eighteen, and says so in their own words', async () => {
    const ctx = makeService({ application: ready({ dateOfBirth: seventeenYearsAgo() }), cache: verified() });
    await expect(ctx.service.submit(RAW_TOKEN)).rejects.toThrow(/at least 18/);
    expect(ctx.applications.save).not.toHaveBeenCalled();
  });

  it('reads the date of birth out of the form answers too, not only the column', async () => {
    const ctx = makeService({
      application: ready({ extendedProfile: { fields: { dateOfBirth: seventeenYearsAgo() } } }),
      cache: verified(),
    });
    await expect(ctx.service.submit(RAW_TOKEN)).rejects.toThrow(/at least 18/);
  });

  it('lets an ordinary working age through', async () => {
    const ctx = makeService({ application: ready({ dateOfBirth: '1990-06-15' }), cache: verified() });
    await expect(ctx.service.submit(RAW_TOKEN)).resolves.toMatchObject({
      status: ApplicationStatus.PENDING_VALIDATION,
    });
  });

  it('refuses a PAN that already belongs to somebody on the roster, naming nobody', async () => {
    const ctx = makeService({
      application: ready({ dateOfBirth: '1990-06-15', extendedProfile: { fields: { panNumber: 'ABCDE1234F' } } }),
      cache: verified(),
    });
    // Only the PAN lookup finds anybody: a blanket match would trip the phone check first and
    // prove nothing about which question was asked.
    (ctx.assayers.findOne as jest.Mock).mockImplementation(async (q: any) => (
      q?.where?.panFingerprint ? { id: 'someone-else', displayName: 'Nilesh Rahane' } : null
    ));

    await expect(ctx.service.submit(RAW_TOKEN)).rejects.toThrow(/PAN is already registered to somebody/);
    // Whose PAN it is belongs to them — the candidate is told there is a clash, not who.
    await expect(ctx.service.submit(RAW_TOKEN)).rejects.not.toThrow(/Nilesh/);
  });

  it('does not count the record this very application created as somebody else', async () => {
    const ctx = makeService({
      application: ready({
        dateOfBirth: '1990-06-15',
        promotedAssayerId: 'assayer-from-this-application',
        extendedProfile: { fields: { panNumber: 'ABCDE1234F' } },
      }),
      cache: verified(),
    });
    (ctx.assayers.findOne as jest.Mock).mockImplementation(async (q: any) => (
      q?.where?.panFingerprint ? { id: 'assayer-from-this-application' } : null
    ));

    await expect(ctx.service.submit(RAW_TOKEN)).resolves.toBeTruthy();
  });

  it('refuses an email already on the roster', async () => {
    const ctx = makeService({ application: ready({ dateOfBirth: '1990-06-15' }), cache: verified() });
    (ctx.assayers.findOne as jest.Mock).mockImplementation(async (q: any) => (
      q?.where?.email ? { id: 'someone-else' } : null
    ));

    await expect(ctx.service.submit(RAW_TOKEN)).rejects.toThrow(/email address is already registered/);
  });
});
