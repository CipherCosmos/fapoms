import { createHash } from 'crypto';
import {
  BadRequestException, ConflictException, ForbiddenException, NotFoundException, ValidationPipe,
} from '@nestjs/common';
import {
  ApplicationStatus, EmploymentCategory, OnboardingDocument, ApplicationSource, ASSAYER_ERROR_CODES,
} from '@fapoms/shared';

import {
  RegistrationApplicationService, documentsRequestedFor, maskedMobile, maskedEmail,
} from './registration-application.service';
import { __resetPincodeCache } from '../geo/pincode-lookup.helper';
import { clearIfscCache } from '../geo/ifsc-lookup.helper';
import { OpenWithoutInterviewDto } from './hr-applications.controller';
import { runWithRequestContext } from '../../core/context/request-context';
import { __resetKeyCacheForTests } from '../../infrastructure/security/field-encryption';
import { CURRENT_CONSENT_VERSION, CURRENT_CONSENT_NOTICE } from '@fapoms/shared';
import { EMAIL_TEMPLATE_REGISTRY, REGISTRATION_INVITE_INTRO } from '../../infrastructure/notifications/email-template-registry';
import type { EmailContent, EmailRequest } from '../notifications/email.service';
import type { SmsRequest } from '../notifications/sms.service';
import { SMS_TEMPLATE_REGISTRY } from '../../infrastructure/notifications/sms-template-registry';

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

/** The harness's default application: a draft, consented, with a mobile and an email on it. */
const baseApplication = (): Row => ({
  id: 'app-1',
  mobile: '9822014455',
  email: 'candidate@example.com',
  fullName: 'Ramesh Kulkarni',
  status: ApplicationStatus.DRAFT,
  tokenHash: TOKEN_HASH,
  tokenExpiresAt: new Date(Date.now() + 3_600_000),
  tokenConsumedAt: null,
  employmentCategory: null,
  // A candidate who is filling the form in has, by definition, already agreed to the notice —
  // the server refuses every write until they have. Tests about that gate build their own
  // un-consented fixture; see "what a candidate agrees to, and when".
  consentAcceptedAt: new Date(),
  consentWithdrawnAt: null,
  organizationId: 'org-1',
});

function makeService(overrides: { application?: Row | null; cache?: Record<string, any>; smsEnabled?: boolean } = {}) {
  const application: Row | null =
    overrides.application === undefined
      ? baseApplication()
        /*
          A fixture that says nothing about consent is a candidate who agreed — that is the ordinary
          state of an application now, and the server refuses every write until it is true. Tests
          about the gate itself say `consentAcceptedAt: null` explicitly, and win this spread.
        */
        : overrides.application === null
          ? null
          : { consentAcceptedAt: new Date(), ...overrides.application };

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
    remove: jest.fn(async (v: unknown) => v),
    create: jest.fn((v: Row) => ({ ...v })),
    save: jest.fn(async (v: Row) => ({ ...v, id: 'doc-1' })),
    // A complete application's scans: the face approval needs, and the passbook submit needs.
    find: jest.fn(async () => ([
      { requirement: OnboardingDocument.PHOTOGRAPH, filePaths: ['uploads/face.jpg'] },
      { requirement: OnboardingDocument.BANK_PASSBOOK, filePaths: ['uploads/passbook.jpg'] },
    ] as Row[])),
  };
  const assayerService = {
    create: jest.fn(async (_dto: Row, _userId?: string, _org?: string | null, _roles?: string[]): Promise<Row> =>
      ({ id: 'assayer-1', assayerCode: 'AS0009', displayName: 'Ramesh Kulkarni' })),
    /**
     * The hiring-review handoff: a hired candidate starts at document verification, not invited.
     * A no-op by default — the default `create` above returns no lifecycle status, so the
     * promotion's guarded hop skips and these tests keep asserting what they are about.
     */
    verifyDocuments: jest.fn(async (id: string) => ({ id })),
    /**
     * Approving now mints and sends the credential (see `promote`). Stubbed as delivered by both
     * channels so these tests keep asserting what they are about — which gaps the profile and the
     * terms produce — rather than picking up the "app access could not be sent" follow-up gap.
     */
    issueAndDeliverAppAccess: jest.fn(async () => ({ channels: ['EMAIL', 'SMS'] as ('EMAIL' | 'SMS')[], emailId: 'em-cred', smsId: 'sms-cred' })),
    setSourceReferral: jest.fn(async (_id: string, raw: unknown) => raw),
  };
  const rosterRecords = { attachFile: jest.fn(async () => ({})), notifyUntoldReferees: jest.fn(async () => undefined) };
  const auditService = { recordEventSafe: jest.fn(async () => undefined) };
  const notificationDispatch = { emitSafe: jest.fn(async () => undefined) };
  /**
   * Where a composed message lands, so the assertions about a message's wording read one place.
   *
   * Composed from the registry's built-in letter, never from anything the service wrote: the
   * service passes data, and the wording a recipient reads is the registry's. A sentence that only
   * the service knows (a resend's "any earlier link has stopped working") is therefore only here if
   * it went through as a token the template renders.
   */
  const mailbox = {
    send: jest.fn(async (_message: { to: string; subject: string; text: string; html?: string }) => undefined),
  };
  const compose = (content: EmailContent) => {
    if ('template' in content) return EMAIL_TEMPLATE_REGISTRY[content.template].fallbackRenderer(content.data);
    if ('rendered' in content) return content.rendered;
    if ('layout' in content) return { subject: content.subject, text: content.text || '', html: '' };
    throw new Error('This service sends only registered templates.');
  };
  type Receipt = { id: string | null; status: string; to: string; error?: string | null };
  /** The one email service. `queue` answers QUEUED — the service cannot know more than that. */
  const emailService = {
    queue: jest.fn(async (req: EmailRequest): Promise<Receipt> => {
      await mailbox.send({ to: req.to, ...compose(req.content) });
      return { id: 'email-1', status: 'QUEUED', to: req.to };
    }),
    sendNow: jest.fn(async (req: EmailRequest): Promise<{ sent: boolean; error?: string; receipt: Receipt }> => {
      await mailbox.send({ to: req.to, ...compose(req.content) });
      return { sent: true, receipt: { id: 'email-2', status: 'SENT', to: req.to } };
    }),
    isEnabled: jest.fn(() => true),
  };
  /**
   * The one SMS service. Off unless a test says otherwise — SMS is built but not configured, so
   * "off" is what every other test in this file is describing. `phone` is the handset: what a text
   * sent to a number says, so a test can read the code off it the way the candidate would.
   */
  const phone = {
    receive: jest.fn((_message: { to: string; text: string }) => undefined),
  };
  const smsService = {
    isEnabled: jest.fn(() => overrides.smsEnabled ?? false),
    sendNow: jest.fn(async (req: SmsRequest): Promise<{ sent: boolean; error?: string; receipt: Receipt }> => {
      const words = SMS_TEMPLATE_REGISTRY[req.content.template].defaultText
        .replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => String(req.content.data[k] ?? ''));
      phone.receive({ to: req.to, text: words });
      return { sent: true, receipt: { id: 'sms-1', status: 'SENT', to: req.to } };
    }),
    queue: jest.fn(),
  };
  const cache = {
    getJson: jest.fn(async (k: string) => (k in cacheData ? cacheData[k] : null)),
    setJson: jest.fn(async (k: string, v: unknown) => { cacheData[k] = v; }),
    del: jest.fn(async (...keys: string[]) => { for (const k of keys) delete cacheData[k]; }),
  };
  const settings = {
    getNumber: jest.fn(async (_k: string, fallback?: number) => fallback ?? 0),
    // The consent notice asks for the grievance officer; an unnamed one is a real state the
    // notice handles in words, so the double returns nothing rather than a convenient name.
    get: jest.fn(async () => ''),
  };
  const storage = {
    saveFile: jest.fn(async () => 'uploads/scan.png'),
    deleteFile: jest.fn(async () => undefined),
  };

  /** Read only so the reviewer sees the number HR typed beside the one the candidate confirmed. */
  const interviews = { findOne: jest.fn(async () => ({ mobile: '9822014455' })) };
  /** Written to only for the consent carry-over — see the service's own note on why. */
  const assayers = { update: jest.fn(async () => ({ affected: 1 })), findOne: jest.fn(async () => null) };

  /**
   * The approval claim, kept the way Postgres keeps it: `pg_try_advisory_xact_lock` says yes to
   * the first holder of a key and no to everybody else until that holder's transaction ends —
   * however it ends, which is the property the retry tests lean on. One set per harness, so two
   * approvals on one service contend exactly as two requests would.
   */
  const heldClaims = new Set<string>();
  const uow = {
    run: jest.fn(async (work: (manager: unknown, emit: () => void) => Promise<unknown>) => {
      const taken: string[] = [];
      const manager = {
        query: jest.fn(async (sql: string, params: unknown[] = []) => {
          if (!sql.includes('pg_try_advisory_xact_lock')) throw new Error(`Unexpected query in the claim: ${sql}`);
          const key = params.join(':');
          if (heldClaims.has(key)) return [{ claimed: false }];
          heldClaims.add(key);
          taken.push(key);
          return [{ claimed: true }];
        }),
      };
      try {
        return await work(manager, () => undefined);
      } finally {
        taken.forEach((key) => heldClaims.delete(key));
      }
    }),
  };
  const geoPrecision = { enqueueBackfill: jest.fn(async (_target: string, _ids: string[], _reason?: string) => undefined) };

  const service = new RegistrationApplicationService(
    applications as any, applicationDocuments as any, interviews as any, assayers as any,
    assayerService as any, rosterRecords as any,
    auditService as any, notificationDispatch as any, emailService as any,
    cache as any, settings as any, storage as any,
    uow as any, geoPrecision as any, smsService as any,
  );

  return {
    service, application, applications, applicationDocuments, interviews, assayers, assayerService, rosterRecords,
    auditService, notificationDispatch, mailbox, emailService, cache, settings, storage, cacheData,
    uow, heldClaims, geoPrecision, smsService, phone,
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

  /** Only the requester (or an administrator) may read an email's receipt; without one it is a 404. */
  it('queues the invite against the person who asked for it, so their screen can watch it go', async () => {
    const { service, emailService } = makeService({ application: null });
    const { emailDelivery } = await service.createInvite({
      mobile: '9822014455', email: 'x@example.com', fullName: 'X', requestedBy: 'user-7',
    });

    expect(emailService.queue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'REGISTRATION_INVITE', to: 'x@example.com', entityType: 'ASSAYER_APPLICATION', requestedBy: 'user-7',
      content: {
        template: 'registration-invite',
        data: expect.objectContaining({ fullName: 'X', intro: REGISTRATION_INVITE_INTRO }),
      },
    }));
    expect(emailDelivery).toMatchObject({ id: 'email-1', status: 'QUEUED' });
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
    const { service, cacheData, mailbox } = makeService();
    await service.requestOtp(RAW_TOKEN, '9822014455');

    const entry = cacheData[`regotp:code:${TOKEN_HASH}`];
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    const sent = mailbox.send.mock.calls[0][0].text;
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
     * `sendNow` answers `{sent:false}` — it does not throw — when the transport is off. This used
     * to log a warning and return success, so the page said a code was on its way and the
     * candidate waited for a message nobody had sent.
     */
    const ctx = makeService();
    ctx.emailService.sendNow.mockResolvedValueOnce({
      sent: false, error: 'transport off', receipt: { id: null, status: 'FAILED', to: 'x' },
    });
    await expect(ctx.service.requestOtp(RAW_TOKEN, '9822014455')).rejects.toThrow(/could not send you a verification code/i);
  });

  /**
   * Sent while the candidate waits, not queued: a queued code answers "on its way" before anybody
   * knows whether it will be, which is the lie the refusal above exists to prevent.
   */
  it('sends the code now, as the registration code template, and never through the queue', async () => {
    const ctx = makeService();
    await expect(ctx.service.requestOtp(RAW_TOKEN, '9822014455'))
      .resolves.toEqual({ channel: 'EMAIL', sentTo: 'c•••@example.com', cooldownSeconds: 60, expiresInSeconds: 300 });

    expect(ctx.emailService.queue).not.toHaveBeenCalled();
    expect(ctx.emailService.sendNow).toHaveBeenCalledTimes(1);
    const request = ctx.emailService.sendNow.mock.calls[0][0];
    expect(request).toMatchObject({
      kind: 'REGISTRATION_OTP',
      content: { template: 'otp-verification', data: { validMinutes: '5' } },
      entityType: 'ASSAYER_APPLICATION',
    });
    expect((request.content as unknown as { data: { otpCode: string } }).data.otpCode).toMatch(/^\d{6}$/);
  });

  /**
   * The owner's decision: the code goes by text to the number being verified when SMS is set up,
   * and by email only as the fallback. A texted code is what actually proves the number is theirs.
   */
  describe('which channel carries the code', () => {
    it('texts the code to the number being verified when SMS is set up, and sends no email', async () => {
      const ctx = makeService({ smsEnabled: true });

      await expect(ctx.service.requestOtp(RAW_TOKEN, '9822014455'))
        .resolves.toEqual({ channel: 'SMS', sentTo: '••••• 4455', cooldownSeconds: 60, expiresInSeconds: 300 });

      expect(ctx.emailService.sendNow).not.toHaveBeenCalled();
      expect(ctx.smsService.queue).not.toHaveBeenCalled();
      expect(ctx.smsService.sendNow).toHaveBeenCalledTimes(1);
      const request = ctx.smsService.sendNow.mock.calls[0][0];
      expect(request).toEqual({
        kind: 'REGISTRATION_OTP',
        to: '9822014455',
        // The candidate's own name, so a text may address them by it.
        recipientName: 'Ramesh Kulkarni',
        content: { template: 'registration-otp', data: { code: expect.stringMatching(/^\d{6}$/), validMinutes: '5' } },
        entityType: 'ASSAYER_APPLICATION',
        entityId: 'app-1',
      });
      // The texted code is the one the cache holds for this phone — verifying with it works.
      const code = ctx.phone.receive.mock.calls[0][0].text.match(/\b(\d{6})\b/)![1];
      await expect(ctx.service.verifyOtp(RAW_TOKEN, '9822014455', code)).resolves.toBeUndefined();
    });

    /** A gateway that refuses one text must not strand the candidate when their mailbox works. */
    it('falls back to email when the text did not go', async () => {
      const ctx = makeService({ smsEnabled: true });
      ctx.smsService.sendNow.mockResolvedValueOnce({
        sent: false, error: 'DLT template not approved', receipt: { id: null, status: 'FAILED', to: '9822014455' },
      });

      await expect(ctx.service.requestOtp(RAW_TOKEN, '9822014455'))
        .resolves.toEqual({ channel: 'EMAIL', sentTo: 'c•••@example.com', cooldownSeconds: 60, expiresInSeconds: 300 });

      expect(ctx.smsService.sendNow).toHaveBeenCalledTimes(1);
      expect(ctx.emailService.sendNow).toHaveBeenCalledTimes(1);
      // One code for the attempt: the email carries the same code the cache is waiting for.
      const texted = ctx.smsService.sendNow.mock.calls[0][0].content.data.code;
      const emailed = (ctx.emailService.sendNow.mock.calls[0][0].content as unknown as { data: { otpCode: string } }).data.otpCode;
      expect(emailed).toBe(texted);
    });

    it('falls back to email when sending the text throws', async () => {
      const ctx = makeService({ smsEnabled: true });
      ctx.smsService.sendNow.mockRejectedValueOnce(new Error('ledger unavailable'));

      await expect(ctx.service.requestOtp(RAW_TOKEN, '9822014455'))
        .resolves.toEqual({ channel: 'EMAIL', sentTo: 'c•••@example.com', cooldownSeconds: 60, expiresInSeconds: 300 });
    });

    /** Today's state: SMS built but not configured. Everything keeps working exactly as before. */
    it('emails the code, and never tries a text, when SMS is not set up', async () => {
      const ctx = makeService({ smsEnabled: false });

      await expect(ctx.service.requestOtp(RAW_TOKEN, '9822014455'))
        .resolves.toEqual({ channel: 'EMAIL', sentTo: 'c•••@example.com', cooldownSeconds: 60, expiresInSeconds: 300 });

      expect(ctx.smsService.sendNow).not.toHaveBeenCalled();
      expect(ctx.emailService.sendNow).toHaveBeenCalledTimes(1);
    });

    it('refuses only when neither the text nor the email went', async () => {
      const ctx = makeService({ smsEnabled: true });
      ctx.smsService.sendNow.mockResolvedValueOnce({ sent: false, error: 'x', receipt: { id: null, status: 'FAILED', to: 'x' } });
      ctx.emailService.sendNow.mockResolvedValueOnce({ sent: false, error: 'y', receipt: { id: null, status: 'FAILED', to: 'x' } });

      await expect(ctx.service.requestOtp(RAW_TOKEN, '9822014455'))
        .rejects.toThrow('We could not send you a verification code just now. Contact HR — they can help you finish registering.');
    });

    /** With SMS set up the mailbox is only the fallback, so a missing address is no reason to refuse. */
    it('texts a candidate whose application has no email, when SMS is set up', async () => {
      const ctx = makeService({ smsEnabled: true, application: { ...baseApplication(), email: null } });

      await expect(ctx.service.requestOtp(RAW_TOKEN, '9822014455'))
        .resolves.toEqual({ channel: 'SMS', sentTo: '••••• 4455', cooldownSeconds: 60, expiresInSeconds: 300 });
    });

    it('refuses a candidate with no email only when SMS is not set up, before counting a send', async () => {
      const ctx = makeService({ smsEnabled: false, application: { ...baseApplication(), email: null } });

      await expect(ctx.service.requestOtp(RAW_TOKEN, '9822014455')).rejects.toThrow(/no email address on this application/i);
      expect(ctx.cacheData[`regotp:sent:${TOKEN_HASH}`]).toBeUndefined();
    });

    it('refuses a candidate with no email when the text did not go, rather than answering "sent"', async () => {
      const ctx = makeService({ smsEnabled: true, application: { ...baseApplication(), email: null } });
      ctx.smsService.sendNow.mockResolvedValueOnce({ sent: false, error: 'x', receipt: { id: null, status: 'FAILED', to: 'x' } });

      await expect(ctx.service.requestOtp(RAW_TOKEN, '9822014455')).rejects.toThrow(/could not send you a verification code/i);
      expect(ctx.emailService.sendNow).not.toHaveBeenCalled();
    });

    /** The send cap, cooldown and consent gates are the same whichever channel would carry the code. */
    it('keeps the send cap, the cooldown and the consent gate in front of a text too', async () => {
      const capped = makeService({ smsEnabled: true, cache: { [`regotp:sent:${TOKEN_HASH}`]: { count: 5 } } });
      await expect(capped.service.requestOtp(RAW_TOKEN, '9822014455')).rejects.toThrow(/Too many verification codes/i);
      const cooling = makeService({ smsEnabled: true, cache: { [`regotp:lastsent:${TOKEN_HASH}`]: Date.now() } });
      await expect(cooling.service.requestOtp(RAW_TOKEN, '9822014455')).rejects.toThrow(/wait/i);
      const unconsented = makeService({ smsEnabled: true, application: { ...baseApplication(), consentAcceptedAt: null } });
      await expect(unconsented.service.requestOtp(RAW_TOKEN, '9822014455')).rejects.toThrow(/agree to it before/i);
      for (const ctx of [capped, cooling, unconsented]) expect(ctx.smsService.sendNow).not.toHaveBeenCalled();
    });

    /** Enough for the candidate to recognise where to look; not enough to read the number or address off the page. */
    it('masks the destination: the last four digits of a mobile, the first letter of a mailbox', () => {
      expect(maskedMobile('9822014455')).toBe('••••• 4455');
      expect(maskedMobile('+91 98220 14455')).toBe('••••• 4455');
      expect(maskedEmail('ramesh.k@example.com')).toBe('r•••@example.com');
      expect(maskedEmail('not-an-address')).toBe('•••');
    });

    /** The destination is repeated back masked, and never written whole into a log line. */
    it('never logs the code or the whole number when a text fails', async () => {
      const ctx = makeService({ smsEnabled: true });
      const warn = jest.spyOn((ctx.service as any).logger, 'warn').mockImplementation(() => undefined);
      ctx.smsService.sendNow.mockResolvedValueOnce({ sent: false, error: 'x', receipt: { id: null, status: 'FAILED', to: 'x' } });

      await ctx.service.requestOtp(RAW_TOKEN, '9822014455');

      const code = ctx.smsService.sendNow.mock.calls[0][0].content.data.code as string;
      const logged = warn.mock.calls.map((c: unknown[]) => c.join(' ')).join('\n');
      expect(logged).toContain('4455');
      expect(logged).not.toContain('9822014455');
      expect(logged).not.toContain(code);
      warn.mockRestore();
    });
  });

  it('rejects a wrong code, and a right code offered for a different phone', async () => {
    const { service, cacheData, mailbox } = makeService();
    await service.requestOtp(RAW_TOKEN, '9822014455');
    const code = mailbox.send.mock.calls[0][0].text.match(/\b(\d{6})\b/)![1];

    await expect(service.verifyOtp(RAW_TOKEN, '9822014455', '000000')).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.verifyOtp(RAW_TOKEN, '9999999999', code)).rejects.toBeInstanceOf(BadRequestException);

    await expect(service.verifyOtp(RAW_TOKEN, '9822014455', code)).resolves.toBeUndefined();
    expect(cacheData[`regotp:verified:${TOKEN_HASH}`]).toEqual({ phone: '9822014455' });
  });

  it('caps how many codes one phone number may receive across tokens to prevent SMS bombing', async () => {
    const { service } = makeService({ cache: { [`regotp:phonesent:9822014455`]: { count: 5 } } });
    await expect(service.requestOtp(RAW_TOKEN, '9822014455')).rejects.toThrow(/Too many verification codes have been requested for this mobile number/i);
  });

  it('reports the exact remaining seconds during cooldown', async () => {
    // 25 seconds ago, with 60 second cooldown => 35 seconds remaining
    const { service } = makeService({ cache: { [`regotp:lastsent:${TOKEN_HASH}`]: Date.now() - 25_000 } });
    await expect(service.requestOtp(RAW_TOKEN, '9822014455')).rejects.toThrow(/Please wait 35 seconds before requesting another code/i);
  });

  it('invalidates the code after 5 failed verification attempts to prevent brute-forcing', async () => {
    const { service, cacheData, mailbox } = makeService();
    await service.requestOtp(RAW_TOKEN, '9822014455');
    const code = mailbox.send.mock.calls[0][0].text.match(/\b(\d{6})\b/)![1];

    // Attempts 1 to 4 should state remaining attempts
    await expect(service.verifyOtp(RAW_TOKEN, '9822014455', '000001')).rejects.toThrow(/4 attempts remaining/i);
    await expect(service.verifyOtp(RAW_TOKEN, '9822014455', '000002')).rejects.toThrow(/3 attempts remaining/i);
    await expect(service.verifyOtp(RAW_TOKEN, '9822014455', '000003')).rejects.toThrow(/2 attempts remaining/i);
    await expect(service.verifyOtp(RAW_TOKEN, '9822014455', '000004')).rejects.toThrow(/1 attempt remaining/i);

    // 5th attempt invalidates the code
    await expect(service.verifyOtp(RAW_TOKEN, '9822014455', '000005')).rejects.toThrow(/This code has been invalidated. Please request a new code/i);
    expect(cacheData[`regotp:code:${TOKEN_HASH}`]).toBeUndefined();

    // Even with the original correct code, it cannot be verified anymore
    await expect(service.verifyOtp(RAW_TOKEN, '9822014455', code)).rejects.toThrow(/That code has expired or has not been requested/i);
  });

  it('consumes the code on successful verification to prevent replay attacks', async () => {
    const { service, cacheData, mailbox } = makeService();
    await service.requestOtp(RAW_TOKEN, '9822014455');
    const code = mailbox.send.mock.calls[0][0].text.match(/\b(\d{6})\b/)![1];

    // Verification succeeds
    await expect(service.verifyOtp(RAW_TOKEN, '9822014455', code)).resolves.toBeUndefined();
    expect(cacheData[`regotp:code:${TOKEN_HASH}`]).toBeUndefined();
    expect(cacheData[`regotp:verified:${TOKEN_HASH}`]).toEqual({ phone: '9822014455' });

    // Attempting to reuse the exact same code again fails immediately
    await expect(service.verifyOtp(RAW_TOKEN, '9822014455', code)).rejects.toThrow(/That code has expired or has not been requested/i);
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
    await expect(service.acceptConsent(RAW_TOKEN, CURRENT_CONSENT_VERSION)).resolves.toBeDefined();
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
    // A candidate who reaches submit named somebody who can be rung — the form requires it.
    extendedProfile: {
      references: [{ fullName: 'Meera Rao', phone: '9822014455', relationship: 'Former manager' }],
    },
    ...extra,
  });

  it('refuses without a name, without a category, and without the declaration', async () => {
    for (const missing of [{ fullName: '' }, { employmentCategory: null }, { consentAcceptedAt: null }]) {
      const { service } = makeService({ application: ready(missing), cache: verified() });
      await expect(service.submit(RAW_TOKEN)).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  it('refuses without anybody to vouch for them — a name with no number is not a reference', async () => {
    for (const references of [
      undefined,
      [],
      [{ fullName: 'Meera Rao' }],
      [{ fullName: 'Meera Rao', phone: '123' }],
    ]) {
      const profile = references === undefined ? null : { references };
      const { service } = makeService({
        application: ready({ extendedProfile: profile }),
        cache: verified(),
      });
      await expect(service.submit(RAW_TOKEN)).rejects.toThrow(/reference/i);
    }
  });

  /**
   * The passbook is the evidence of the account a payout goes to; a candidate cannot file without
   * one. Judged on what is attached — a row with a file — not on a form's tick.
   */
  it('refuses without a passbook scan, and says a cheque or statement will do', async () => {
    for (const docs of [
      [{ requirement: OnboardingDocument.PHOTOGRAPH, filePaths: ['uploads/face.jpg'] }],
      [{ requirement: OnboardingDocument.BANK_PASSBOOK, filePaths: [] }],
    ]) {
      const ctx = makeService({ application: ready(), cache: verified() });
      (ctx.applicationDocuments.find as jest.Mock).mockResolvedValue(docs);
      await expect(ctx.service.submit(RAW_TOKEN)).rejects.toThrow(/Upload Bank passbook before submitting.*cancelled cheque/i);
      expect(ctx.application!.status).toBe(ApplicationStatus.DRAFT);
    }
  });

  it('asks every candidate for the passbook, whichever way they practise', async () => {
    for (const category of [null, EmploymentCategory.FREELANCER, EmploymentCategory.PROPRIETOR]) {
      expect(documentsRequestedFor(category)).toContain(OnboardingDocument.BANK_PASSBOOK);
    }
  });

  /** The account number's shape, at the door every application answer comes through. */
  it('stores an account number as its digits, and refuses one that cannot be an account', async () => {
    const { service, application } = makeService({ cache: verified() });
    await service.updateDraft(RAW_TOKEN, { record: { bankAccountNumber: '1234 5678-9012' } } as never);
    expect(((application!.extendedProfile as Row).fields as Row).bankAccountNumber).toBe('123456789012');

    for (const bad of ['12345', 'ABCD12345678', '1234567890123456789']) {
      await expect(service.updateDraft(RAW_TOKEN, { record: { bankAccountNumber: bad } } as never))
        .rejects.toThrow(/9 to 18 digits/);
    }
  });

  it('stores references trimmed and capped when the draft is saved', async () => {
    const { service, application } = makeService({ cache: verified() });
    await service.updateDraft(RAW_TOKEN, {
      references: [
        { fullName: '  Meera Rao ', phone: '98 220 14455', relationship: 'Former manager', email: 'Meera@Example.com' },
        { fullName: '', phone: '' },
      ],
    } as never);

    expect((application!.extendedProfile as Row).references).toEqual([
      { fullName: 'Meera Rao', phone: '9822014455', relationship: 'Former manager', email: 'meera@example.com' },
    ]);
  });

  it('refuses a fourth reference on the draft rather than silently dropping it', async () => {
    const { service } = makeService({ cache: verified() });
    const four = [1, 2, 3, 4].map((n) => ({ fullName: `Ref ${n}`, phone: '9822014455' }));
    await expect(service.updateDraft(RAW_TOKEN, { references: four } as never))
      .rejects.toThrow(/Only 3 references/);
  });

  /**
   * HR's field asks leave the to-do list when the field is actually corrected.
   *
   * Document asks cleared themselves on a fresh scan; field asks never did, so "Date of birth —
   * please correct" stayed on the candidate's link and on HR's "waiting on candidate" list after it
   * had been fixed.
   */
  describe('what HR asked to have corrected', () => {
    const asked = (extra: Row = {}) => ready({
      status: ApplicationStatus.AWAITING_INFO,
      dateOfBirth: new Date('1985-03-14T00:00:00Z'),
      extendedProfile: {
        references: [{ fullName: 'Meera Rao', phone: '9822014455' }],
        fields: { ifscCode: 'SBIN0000001' },
      },
      infoRequests: [
        { kind: 'field', key: 'dateOfBirth', label: 'Date of birth', message: 'Does not match the PAN.' },
        { kind: 'field', key: 'ifscCode', label: 'IFSC code', message: 'Does not match the passbook.' },
        { kind: 'document', key: 'PAN_CARD', label: 'PAN card', message: 'Retake in better light.' },
      ],
      ...extra,
    });
    const keys = (app: Row | null) => ((app?.infoRequests ?? []) as Row[]).map((i) => `${i.kind}:${i.key}`);

    it('drops an ask once its field actually changes', async () => {
      const { service, application } = makeService({ application: asked(), cache: verified() });

      await service.updateDraft(RAW_TOKEN, { dateOfBirth: '1986-01-02' } as never);
      expect(keys(application)).toEqual(['field:ifscCode', 'document:PAN_CARD']);

      await service.updateDraft(RAW_TOKEN, { record: { ifscCode: 'SBIN0001234' } } as never);
      expect(keys(application)).toEqual(['document:PAN_CARD']);
    });

    /**
     * The form saves every box on blur. Tabbing past the date of birth sends the same day back —
     * as a string, against a stored Date — and must not count as having fixed it.
     */
    it('keeps an ask when the same value is merely saved again', async () => {
      const { service, application } = makeService({ application: asked(), cache: verified() });

      await service.updateDraft(RAW_TOKEN, { dateOfBirth: '1985-03-14', record: { ifscCode: 'SBIN0000001' } } as never);

      expect(keys(application)).toEqual(['field:dateOfBirth', 'field:ifscCode', 'document:PAN_CARD']);
    });

    /**
     * Resubmitting is the candidate's answer to every field ask; HR reads the whole form again. A
     * document whose sent-back scan was never replaced is still genuinely owed, so it stays.
     */
    it('settles the field asks on resubmission and keeps a document still owed', async () => {
      const { service, application } = makeService({ application: asked(), cache: verified() });

      await service.submit(RAW_TOKEN);

      expect(application!.status).toBe(ApplicationStatus.PENDING_VALIDATION);
      expect(keys(application)).toEqual(['document:PAN_CARD']);
    });

    it('clears the list entirely when nothing is left owed', async () => {
      const { service, application } = makeService({
        application: asked({ infoRequests: [{ kind: 'field', key: 'ifscCode', label: 'IFSC code', message: 'x' }] }),
        cache: verified(),
      });

      await service.submit(RAW_TOKEN);

      expect(application!.infoRequests).toBeNull();
    });
  });

  it('moves to Pending Validation and tells the HR desk there is something to review', async () => {
    const { service, notificationDispatch, application } = makeService({ application: ready(), cache: verified() });
    await service.submit(RAW_TOKEN);

    expect(application!.status).toBe(ApplicationStatus.PENDING_VALIDATION);
    expect(notificationDispatch.emitSafe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ASSAYER_APPLICATION_SUBMITTED',
        entityType: 'ASSAYER_APPLICATION',
        entityId: application!.id,
        payload: expect.objectContaining({
          applicantName: application!.fullName,
          applicationId: application!.id,
          mobile: application!.mobile,
        }),
      }),
    );
  });

  it('queues a confirmation email to the candidate when email is present', async () => {
    const { service, emailService, application } = makeService({
      application: ready({ email: 'candidate@example.com', fullName: 'Asha Verma' }),
      cache: verified(),
    });
    await service.submit(RAW_TOKEN);

    expect(emailService.queue).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'REGISTRATION_SUBMITTED',
        to: 'candidate@example.com',
        recipientName: 'Asha Verma',
        entityType: 'ASSAYER_APPLICATION',
        entityId: application!.id,
      }),
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
    const { service, mailbox, application } = makeService({ application: submitted() });
    await expect(service.reject('app-1', 'user-1', '   ')).rejects.toBeInstanceOf(BadRequestException);

    await service.reject('app-1', 'user-1', 'Shop proof did not match the Aadhaar address.');
    expect(application!.status).toBe(ApplicationStatus.REJECTED);
    expect(mailbox.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Shop proof did not match') }),
    );
  });

  it('queues the rejection letter rather than holding the reviewer on the mail server', async () => {
    const { service, emailService } = makeService({ application: submitted() });
    await service.reject('app-1', 'user-1', 'Shop proof did not match the Aadhaar address.');
    expect(emailService.queue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'APPLICATION_REJECTED', entityId: 'app-1', requestedBy: 'user-1',
      content: {
        template: 'application-rejected',
        data: expect.objectContaining({ reviewNotes: 'Shop proof did not match the Aadhaar address.' }),
      },
    }));
    expect(emailService.sendNow).not.toHaveBeenCalled();
  });

  /**
   * HR's asks are the whole point of this email. They travel as an item list the candidate's SAME
   * link renders as a to-do list — never as a fresh link, because minting one would kill the link
   * the candidate already holds at exactly the moment they are asked to use it.
   */
  it('tells the candidate what HR asked for, without minting a new link', async () => {
    const { service, emailService, mailbox } = makeService({ application: submitted() });
    await service.requestMoreInfo('app-1', 'user-1', 'Attach the shop entity proof.');

    expect(emailService.queue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'APPLICATION_INFO_REQUESTED',
      content: {
        template: 'application-info-requested',
        data: expect.objectContaining({ itemsText: expect.stringContaining('Attach the shop entity proof.') }),
      },
    }));
    expect(mailbox.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Attach the shop entity proof.') }),
    );
  });

  it('keeps the SAME link working when asking for more information', async () => {
    // The link the candidate holds (or has open in a tab) must survive the request: only the
    // hash was ever stored, so "send them the same link" is not a thing this can do — keeping
    // the stored hash untouched while extending its window is.
    const { service, application } = makeService({ application: submitted() });
    await service.requestMoreInfo('app-1', 'user-1', 'Attach the shop entity proof.');

    expect(application!.status).toBe(ApplicationStatus.AWAITING_INFO);
    expect(application!.tokenHash).toBe(TOKEN_HASH);
    expect(new Date(application!.tokenExpiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('stores ticked documents and fields as the candidate to-do list', async () => {
    const { service, application, applicationDocuments } = makeService({ application: submitted() });
    await service.requestMoreInfo('app-1', 'user-1', {
      notes: 'Two things to fix.',
      documents: [{ requirement: OnboardingDocument.PAN_CARD, reason: 'ILLEGIBLE' }],
      fields: [{ key: 'ifscCode', message: 'Does not match the passbook.' }],
    });

    const saved = application!;
    expect(saved.status).toBe(ApplicationStatus.AWAITING_INFO);
    expect(saved.infoRequests).toEqual([
      expect.objectContaining({ kind: 'document', key: 'PAN_CARD', message: expect.stringContaining('better light') }),
      expect.objectContaining({ kind: 'field', key: 'ifscCode', label: 'IFSC code' }),
    ]);
    // The flagged document row carries the verdict for the review queue to read back.
    const rows = applicationDocuments.save.mock.calls.map((c: any[]) => c[0]);
    expect(rows).toContainEqual(expect.objectContaining({
      requirement: 'PAN_CARD', reviewStatus: 'NEEDS_RESUBMIT', rejectionReason: 'ILLEGIBLE',
    }));
  });

  it('refuses a structured request that names nothing the candidate can fix', async () => {
    const { service } = makeService({ application: submitted() });
    await expect(service.requestMoreInfo('app-1', 'user-1', {
      documents: [{ requirement: 'BIRTH_CERTIFICATE' as any }],
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.requestMoreInfo('app-1', 'user-1', {
      fields: [{ key: 'assayerCode', message: 'fix it' }],
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a request for more information with nothing asked for', async () => {
    const { service } = makeService({ application: submitted() });
    await expect(service.requestMoreInfo('app-1', 'user-1', '')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sends back one document without rejecting the application', async () => {
    const { service, application } = makeService({ application: submitted() });
    const row = await service.reviewApplicationDocument(
      'app-1', OnboardingDocument.PAN_CARD, 'NEEDS_RESUBMIT',
      { reason: 'ILLEGIBLE', note: '' }, 'user-1',
    );

    expect(row.reviewStatus).toBe('NEEDS_RESUBMIT');
    expect(row.rejectionReason).toBe('ILLEGIBLE');
    expect(application!.status).toBe(ApplicationStatus.AWAITING_INFO);
    // Same link: the stored hash is untouched, only its window is extended.
    expect(application!.tokenHash).toBe(TOKEN_HASH);
    expect(application!.infoRequests).toEqual([
      expect.objectContaining({ kind: 'document', key: 'PAN_CARD' }),
    ]);
  });

  it('refuses to approve a document nobody attached', async () => {
    const { service, applicationDocuments } = makeService({ application: submitted() });
    applicationDocuments.findOne.mockResolvedValueOnce(null);
    await expect(service.reviewApplicationDocument(
      'app-1', OnboardingDocument.PAN_CARD, 'APPROVED', {}, 'user-1',
    )).rejects.toThrow(/no scan/i);
  });

  it('a resubmitted scan clears its own send-back', async () => {
    const sentBack = {
      applicationId: 'app-1',
      requirement: OnboardingDocument.PAN_CARD,
      filePaths: ['uploads/blurry.png'],
      reviewStatus: 'NEEDS_RESUBMIT',
      rejectionReason: 'ILLEGIBLE',
      rejectionNote: null,
    };
    const ctx = makeService({
      application: {
        ...submitted(),
        status: ApplicationStatus.AWAITING_INFO,
        infoRequests: [{ kind: 'document', key: 'PAN_CARD', label: 'PAN card', message: 'Retake.' }],
      },
      cache: { [`regotp:verified:${TOKEN_HASH}`]: { phone: '9822014455' } },
    });
    (ctx.applicationDocuments.findOne as jest.Mock).mockResolvedValueOnce(sentBack);

    await ctx.service.uploadDocument(RAW_TOKEN, OnboardingDocument.PAN_CARD, {
      originalname: 'pan.png', buffer: Buffer.from('x'), mimetype: 'image/png', size: 10,
    });

    const savedRow = ctx.applicationDocuments.save.mock.calls[ctx.applicationDocuments.save.mock.calls.length - 1][0];
    expect(savedRow.reviewStatus).toBe('PENDING');
    expect(savedRow.rejectionReason).toBeNull();
  });

  describe('resending a lost link', () => {
    it('mints a fresh link and kills the old one', async () => {
      // Both the candidate's "Ask HR to resend it" and the interview screen's advice pointed at
      // this; until it existed an undelivered invite was a dead end.
      const { service, application, mailbox } = makeService({ application: submitted({ status: ApplicationStatus.DRAFT }) });
      const { emailDelivery } = await service.resendInvite('app-1', 'user-1');

      expect(application!.tokenHash).not.toBe(TOKEN_HASH);
      expect(application!.tokenConsumedAt).toBeNull();
      expect(emailDelivery).toMatchObject({ id: 'email-1', status: 'QUEUED' });
      expect(mailbox.send).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('earlier link has stopped working') }),
      );
    });

    it('reports honestly when the resend could not even be queued', async () => {
      const ctx = makeService({ application: submitted({ status: ApplicationStatus.DRAFT }) });
      ctx.emailService.queue.mockResolvedValueOnce({ id: null, status: 'NOT_QUEUED', to: 'x', error: 'db down' });
      const { emailDelivery, inviteLink } = await ctx.service.resendInvite('app-1', 'user-1');
      expect(emailDelivery?.status).toBe('NOT_QUEUED');
      expect(inviteLink).toMatch(/\/register\/[0-9a-f]{16,}$/);
    });

    it('queues the email instead of making the desk wait on the mail server', async () => {
      const ctx = makeService({ application: submitted({ status: ApplicationStatus.DRAFT }) });
      await ctx.service.resendInvite('app-1', 'user-1');
      expect(ctx.emailService.queue).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'REGISTRATION_INVITE', entityType: 'ASSAYER_APPLICATION', requestedBy: 'user-1',
        content: {
          template: 'registration-invite',
          data: expect.objectContaining({
            intro: 'Here is a fresh link to complete your Appraiser registration. Any earlier link has stopped working.',
          }),
        },
      }));
    });

    it('still mints a link when there is no address to send to — the desk delivers it', async () => {
      const noEmail = makeService({ application: submitted({ status: ApplicationStatus.DRAFT, email: null }) });
      const { emailDelivery, inviteLink } = await noEmail.service.resendInvite('app-1', 'user-1');

      // No mailbox is not a refusal. The link is the deliverable; email is one way to deliver it,
      // and on a deployment with email switched off it is not a way at all.
      expect(emailDelivery).toBeNull();
      expect(noEmail.emailService.queue).not.toHaveBeenCalled();
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

  it('lands a hired candidate at document verification, not invited', async () => {
    // INVITED means "on the roster, nothing reviewed yet" — untrue of somebody HR just
    // reviewed, asked, and approved. Landing there asked the desk to verify the same scans
    // twice: once off-stage to leave INVITED, once in the stage flow.
    const ctx = makeService({ application: approved() });
    ctx.assayerService.create.mockResolvedValueOnce({
      id: 'assayer-1', assayerCode: 'AS0009', displayName: 'Ramesh Kulkarni',
      lifecycleStatus: 'INVITED',
    });
    await ctx.service.approve('app-1', 'user-1', ['ADMIN']);

    expect(ctx.assayerService.verifyDocuments).toHaveBeenCalledWith('assayer-1', 'user-1');
  });

  it('does not re-take the handoff hop when a retried promotion finds the person moved on', async () => {
    // Same idempotency key, second attempt: `create` answers with the existing person, already
    // past INVITED. Re-taking the hop would fail on a transition that already happened.
    const ctx = makeService({ application: approved() });
    ctx.assayerService.create.mockResolvedValueOnce({
      id: 'assayer-1', assayerCode: 'AS0009', displayName: 'Ramesh Kulkarni',
      lifecycleStatus: 'DOCUMENT_VERIFICATION',
    });
    await ctx.service.approve('app-1', 'user-1', ['ADMIN']);

    expect(ctx.assayerService.verifyDocuments).not.toHaveBeenCalled();
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
    const { service, mailbox } = makeService({ application: approved() });
    await service.approve('app-1', 'user-1', ['ADMIN']);
    expect(mailbox.send).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('AS0009') }),
    );
  });

  it('queues the approval letter, so approving does not wait on the mail server', async () => {
    const { service, emailService } = makeService({ application: approved() });
    await service.approve('app-1', 'user-1', ['ADMIN']);
    expect(emailService.queue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'APPLICATION_APPROVED', entityType: 'ASSAYER_APPLICATION', entityId: 'app-1', requestedBy: 'user-1',
      content: {
        template: 'application-approved',
        // `fullName` too: the shipped HTML greets and names the person by it.
        data: expect.objectContaining({ assayerCode: 'AS0009', fullName: expect.any(String) }),
      },
    }));
    expect(emailService.sendNow).not.toHaveBeenCalled();
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

    /**
     * The refusal names somebody else's record. It is for the desk (the audit row carries it), and
     * it once rode into the approval email's data as `remarks` — unrendered only by luck of the
     * shipped HTML, and one template edit away from a candidate reading another person's name.
     */
    it("keeps the desk's refusal messages out of the candidate's approval email", async () => {
      const { ctx } = refusingIdentity(arm(makeService({ application: { ...fullProfile(), email: 'c@example.com' } })));

      const result = await ctx.service.approve('app-x', 'hr-checker', ['ADMIN']);

      expect(result.gaps).toHaveLength(1);
      const approval = ctx.emailService.queue.mock.calls.find(([r]) => r.kind === 'APPLICATION_APPROVED');
      expect(approval).toBeDefined();
      expect(JSON.stringify(approval![0])).not.toMatch(/Ramesh Iyer|AS-77|remarks/);
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
 * Referees hear when the candidate is hired — the moment they become references FOR somebody on
 * the record, which is where HR's call to them is recorded.
 */
describe('an approved candidate’s referees are told', () => {
  const candidate = () => ({
    id: 'app-x', mobile: '9822014455', fullName: 'Full Payload', state: 'Maharashtra',
    status: ApplicationStatus.PENDING_VALIDATION, organizationId: 'org-1',
    source: ApplicationSource.HR_DESK, createdBy: 'hr-maker', email: 'candidate@example.com',
  });

  it('tells them once the person exists, after the approval letter, by the reviewer', async () => {
    const order: string[] = [];
    const ctx = makeService({ application: candidate() });
    ctx.emailService.queue.mockImplementation(async (r: Row) => {
      order.push(`email:${r.kind}`);
      return { id: 'e', status: 'QUEUED', to: r.to };
    });
    (ctx.rosterRecords as any).notifyUntoldReferees = jest.fn(async () => { order.push('referees'); });

    await ctx.service.approve('app-x', 'hr-checker', ['ADMIN']);

    expect((ctx.rosterRecords as any).notifyUntoldReferees).toHaveBeenCalledWith('assayer-1', 'hr-checker');
    // The candidate learns they are hired before their referees learn they may be rung.
    expect(order.indexOf('email:APPLICATION_APPROVED')).toBeLessThan(order.indexOf('referees'));
  });

  it('does not fail the hire when the referees cannot be told', async () => {
    const ctx = makeService({ application: candidate() });
    (ctx.rosterRecords as any).notifyUntoldReferees = jest.fn(async () => { throw new Error('outbox down'); });

    const result = await ctx.service.approve('app-x', 'hr-checker', ['ADMIN']);

    expect(result.assayer.id).toBe('assayer-1');
  });
});

/**
 * THE KEY IS HANDED OVER AT THE MOMENT OF HIRING.
 *
 * Approval promoted a candidate to `INVITED` — a stage `ONBOARDING_SIGN_IN` deliberately lets sign
 * in — and then mailed them a button reading "Sign in to FAPOMS". The account behind it had
 * `passwordHash = NULL`, and `AuthService.login` answers that with the same bare `Invalid
 * credentials` a mistyped password gets, so the person could not tell "nobody gave me a password"
 * from "I typed it wrong". The only two ways a credential had ever been minted were an HR officer
 * reading one aloud off the record screen and the 500-at-a-time bulk tool; neither was reachable
 * from this flow, and nothing told HR somebody was waiting.
 */
describe('an approved candidate is given a way in', () => {
  const candidate = (over: Row = {}) => ({
    id: 'app-x', mobile: '9822014455', fullName: 'Full Payload', state: 'Maharashtra',
    status: ApplicationStatus.PENDING_VALIDATION, organizationId: 'org-1',
    source: ApplicationSource.HR_DESK, createdBy: 'hr-maker',
    email: 'candidate@example.com',
    ...over,
  });

  it('issues and sends a credential through the one path the bulk tool uses', async () => {
    const ctx = makeService({ application: candidate() });

    const result = await ctx.service.approve('app-x', 'hr-checker', ['ADMIN']);

    const issue = (ctx.assayerService as any).issueAndDeliverAppAccess;
    expect(issue).toHaveBeenCalledTimes(1);
    // The person who was just created, and the reviewer as the actor — not the candidate.
    expect(issue.mock.calls[0][0]).toMatchObject({ id: 'assayer-1', assayerCode: 'AS0009' });
    expect(issue.mock.calls[0][1]).toBe('hr-checker');
    expect(result.gaps).toEqual([]);
  });

  /** Minted after the person exists, or there is no account to attach a password to. */
  it('issues only once the assayer record has been created', async () => {
    const order: string[] = [];
    const ctx = makeService({ application: candidate() });
    (ctx.assayerService as any).create = jest.fn(async () => {
      order.push('create');
      return { id: 'assayer-1', assayerCode: 'AS0009', displayName: 'Ramesh Kulkarni' };
    });
    (ctx.assayerService as any).issueAndDeliverAppAccess = jest.fn(async () => {
      order.push('issue');
      return { channels: ['EMAIL'] };
    });

    await ctx.service.approve('app-x', 'hr-checker', ['ADMIN']);

    expect(order).toEqual(['create', 'issue']);
  });

  /**
   * A hiring decision must not be refused because a mail server is down. The person is hired
   * either way — the unsent credential becomes a named follow-up for the desk instead.
   */
  it('does not fail the approval when the credential cannot be sent, and names it as a gap', async () => {
    const ctx = makeService({ application: candidate() });
    (ctx.assayerService as any).issueAndDeliverAppAccess = jest.fn(async () => {
      throw new Error('smtp unreachable');
    });

    const result = await ctx.service.approve('app-x', 'hr-checker', ['ADMIN']);

    expect(result.assayer.id).toBe('assayer-1');
    expect(result.gaps).toEqual([expect.stringContaining('app access')]);
  });

  /** Issued, but reaching nobody, is the same follow-up: silence is what has to be visible. */
  it('names the gap when the credential was minted but no channel carried it', async () => {
    const ctx = makeService({ application: candidate() });
    (ctx.assayerService as any).issueAndDeliverAppAccess = jest.fn(async () => ({ channels: [] }));

    const result = await ctx.service.approve('app-x', 'hr-checker', ['ADMIN']);

    expect(result.gaps).toEqual([expect.stringContaining('app access')]);
    // …and the desk reads it on the approval audit row, where the other gaps are.
    const approved = (ctx.auditService.recordEventSafe as jest.Mock).mock.calls
      .map(([e]: [Row]) => e)
      .find((e: Row) => e.eventType === 'ASSAYER_APPLICATION_APPROVED');
    expect(String(approved!.remarks)).toMatch(/app access/);
  });

  /**
   * The letter sends them to the app, not to a web login they have no surface on and no password
   * for. `loginUrl` is gone from this template's data entirely: leaving it would put the old
   * button back the moment an administrator's published version still referenced it.
   */
  it('points the approval letter at the app download and never at a sign-in', async () => {
    const ctx = makeService({ application: candidate() });

    await ctx.service.approve('app-x', 'hr-checker', ['ADMIN']);

    const approval = ctx.emailService.queue.mock.calls.find(([r]) => r.kind === 'APPLICATION_APPROVED');
    const data = (approval![0].content as { data: Row }).data;
    expect(data.appDownloadUrl).toMatch(/\/download\/app\.apk$/);
    expect(data).not.toHaveProperty('loginUrl');

    const letter = ctx.mailbox.send.mock.calls.at(-1)![0];
    expect(letter.text).toContain('/download/app.apk');
    expect(letter.text).not.toMatch(/sign in to fapoms/i);
  });

  /** So the reader knows a second message is coming and does not go hunting for a password. */
  it('tells them their sign-in details arrive separately', async () => {
    const ctx = makeService({ application: candidate() });

    await ctx.service.approve('app-x', 'hr-checker', ['ADMIN']);

    const letter = ctx.mailbox.send.mock.calls.at(-1)![0];
    expect(letter.text).toMatch(/separate message/i);
  });

  /** No address is not a reason to withhold the credential: the SMS leg still carries it. */
  it('still issues a credential for a candidate with no email address', async () => {
    const ctx = makeService({ application: candidate({ email: null }) });

    await ctx.service.approve('app-x', 'hr-checker', ['ADMIN']);

    expect((ctx.assayerService as any).issueAndDeliverAppAccess).toHaveBeenCalledTimes(1);
    expect(ctx.emailService.queue.mock.calls.filter(([r]) => r.kind === 'APPLICATION_APPROVED')).toHaveLength(0);
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

  it('does not report conflict for soft-deleted or terminal applications', async () => {
    const ctx = makeService();
    ctx.assayers.findOne = jest.fn(async () => null);

    // Soft-deleted application
    ctx.applications.findOne = jest.fn(async () => ({
      id: 'app-old-1',
      mobile: '9822014455',
      fullName: 'Old Candidate',
      isActive: false,
      status: ApplicationStatus.DRAFT,
    } as any));
    expect(await ctx.service.checkMobileConflict('9822014455', null, 'app-new')).toBeNull();

    // Approved application (roster is already checked separately)
    ctx.applications.findOne = jest.fn(async () => ({
      id: 'app-old-2',
      mobile: '9822014455',
      fullName: 'Priya Sharma',
      isActive: true,
      status: ApplicationStatus.APPROVED,
    } as any));
    expect(await ctx.service.checkMobileConflict('9822014455', null, 'app-new')).toBeNull();

    // Withdrawn application
    ctx.applications.findOne = jest.fn(async () => ({
      id: 'app-old-3',
      mobile: '9822014455',
      fullName: 'Withdrawn Candidate',
      isActive: true,
      status: ApplicationStatus.WITHDRAWN,
    } as any));
    expect(await ctx.service.checkMobileConflict('9822014455', null, 'app-new')).toBeNull();
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
    const paper = { storageKey: 'uploads/test.pdf', fileName: 'test.pdf' };
    ctx.interviews.findOne.mockResolvedValue({
      id: 'iv-1', mobile: '9822014455', outcome: 'PASS', notes: 'Steady hands; knows the acid test.',
      interviewedAt: when, interviewedByName: 'Meera Rao', attachments: [paper], previousInterviewId: null,
    } as never);

    const detail = await ctx.service.getApplication('app-1');

    expect(detail.interview).toEqual({
      id: 'iv-1', outcome: 'PASS', notes: 'Steady hands; knows the acid test.',
      interviewedAt: when, interviewedByName: 'Meera Rao',
      // The test papers the pass rested on, for the person deciding the application.
      attachments: [paper], earlier: null,
    });
  });

  /** Passed only when interviewed again: the reviewer sees the attempt that did not, papers and all. */
  it('shows the earlier interview that did not pass, when they passed on a second one', async () => {
    const ctx = makeService({ application: { ...ready(), interviewId: 'iv-2' } });
    const first = new Date('2026-09-01T10:00:00.000Z');
    const second = new Date('2026-09-20T10:00:00.000Z');
    (ctx.interviews.findOne as jest.Mock).mockImplementation(async ({ where }: any) => (where.id === 'iv-2'
      ? { id: 'iv-2', mobile: '9822014455', outcome: 'PASS', notes: null, interviewedAt: second, interviewedByName: 'Meera Rao', attachments: [], previousInterviewId: 'iv-1' }
      : { id: 'iv-1', mobile: '9822014455', outcome: 'FAIL', notes: 'Unsure on the acid test.', interviewedAt: first, interviewedByName: 'Meera Rao', attachments: [{ storageKey: 'k', fileName: 'first.pdf' }] }) as never);

    const detail = await ctx.service.getApplication('app-1');

    expect(detail.interview?.earlier).toMatchObject({
      id: 'iv-1', outcome: 'FAIL', notes: 'Unsure on the acid test.', attachments: [{ fileName: 'first.pdf' }],
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

  /** Lets the event loop run until `done` is true — how a test gets one approval part way in. */
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await new Promise((r) => setImmediate(r));
    expect(done()).toBe(true);
  };

  /**
   * The double click, and the client's 30 s timeout followed by its retry.
   *
   * `create` answered the second request with the same person, so nothing LOOKED wrong — but every
   * step after it ran twice while the first was still going: each scan filed as a second version,
   * each profile group applied again, the letter queued twice. The second caller is now told the
   * application is already being approved, and nothing it would have done happens.
   */
  it('refuses a second approval of the same application while the first is still going through', async () => {
    const ctx = makeService({ application: ready() });
    let finishCreating!: () => void;
    const creating = new Promise<void>((resolve) => { finishCreating = resolve; });
    ctx.assayerService.create.mockImplementationOnce(async () => {
      await creating;
      return { id: 'assayer-1', assayerCode: 'AS0009', displayName: 'Candidate' };
    });

    const first = ctx.service.approve('app-77', 'hr-1', ['ADMIN']);
    await until(() => ctx.assayerService.create.mock.calls.length === 1);

    const second = ctx.service.approve('app-77', 'hr-2', ['ADMIN']);
    await expect(second).rejects.toBeInstanceOf(ConflictException);
    await expect(second).rejects.toThrow(/already being approved/);

    finishCreating();
    await expect(first).resolves.toMatchObject({ assayer: { id: 'assayer-1' } });
    expect(ctx.assayerService.create).toHaveBeenCalledTimes(1);
    // Once per scan the application holds (the photograph and the passbook) — filed once, not twice.
    expect(ctx.rosterRecords.attachFile).toHaveBeenCalledTimes(2);
    expect(ctx.emailService.queue).toHaveBeenCalledTimes(1);
  });

  /**
   * The claim must not outlive the attempt that took it.
   *
   * A promotion that fails part way has already made the person; the only way to finish it is to
   * approve again. A claim that stayed held — or a failure reported as a success — would leave the
   * application stuck with a person on the roster and nobody able to close it.
   */
  it('lets the desk approve again after an attempt that failed part way', async () => {
    const ctx = makeService({ application: ready() });
    ctx.rosterRecords.attachFile.mockRejectedValueOnce(new Error('could not file the scan'));

    await expect(ctx.service.approve('app-77', 'hr-1', ['ADMIN'])).rejects.toThrow('could not file the scan');
    expect(ctx.application!.status).toBe(ApplicationStatus.PENDING_VALIDATION);
    expect(ctx.heldClaims.size).toBe(0);

    await expect(ctx.service.approve('app-77', 'hr-1', ['ADMIN'])).resolves.toMatchObject({ assayer: { id: 'assayer-1' } });
    expect(ctx.application!.status).toBe(ApplicationStatus.APPROVED);
    // The same key both times, so the create path returns the person the first attempt made.
    expect(ctx.assayerService.create.mock.calls.map(([dto]) => dto.clientRequestId))
      .toEqual(['application:app-77', 'application:app-77']);
  });

  /** The application is judged as it stands once the claim is held, not as it stood before. */
  it('reads the application only after it holds the claim', async () => {
    const ctx = makeService({ application: ready() });
    await ctx.service.approve('app-77', 'hr-1', ['ADMIN']);

    const claimedAt = ctx.uow.run.mock.invocationCallOrder[0];
    expect(ctx.applications.findOne.mock.invocationCallOrder[0]).toBeGreaterThan(claimedAt);
  });
});

/**
 * Approving used to wait on the free geocoders.
 *
 * With no Google key, `AssayerService.create` walked India Post, Nominatim and the public Photon
 * inside the request — 2–6 s typically, past the web client's 30 s timeout at worst, which is what
 * sent reviewers back to press Approve again. Placement is now the precision worker's, handed the
 * person once approval's own writes are done.
 */
describe('where an approved person is placed on the map', () => {
  const ready = () => ({
    id: 'app-88', mobile: '9822014455', email: 'c@example.com', fullName: 'Candidate',
    state: 'Maharashtra', status: ApplicationStatus.PENDING_VALIDATION, organizationId: 'org-1',
  });

  it('hands an unplaced person to the precision worker, after everything approval writes', async () => {
    const ctx = makeService({ application: ready() });
    await ctx.service.approve('app-88', 'hr-1', ['ADMIN']);

    expect(ctx.geoPrecision.enqueueBackfill).toHaveBeenCalledWith('assayer', ['assayer-1'], expect.any(String));
    // After the application is closed: the worker saves the whole row, and running it while the
    // profile groups were still landing could put back what they had just written.
    const closedAt = Math.max(...ctx.applications.save.mock.invocationCallOrder);
    expect(ctx.geoPrecision.enqueueBackfill.mock.invocationCallOrder[0]).toBeGreaterThan(closedAt);
  });

  it('leaves a person pinned by hand alone — there is nothing for the worker to improve', async () => {
    const ctx = makeService({ application: ready() });
    ctx.assayerService.create.mockResolvedValueOnce({
      id: 'assayer-1', assayerCode: 'AS0009', displayName: 'Candidate',
      latitude: 18.5204, longitude: 73.8567, geoSource: 'manual', geoAccuracyMeters: 10,
    } as any);

    await ctx.service.approve('app-88', 'hr-1', ['ADMIN']);
    expect(ctx.geoPrecision.enqueueBackfill).not.toHaveBeenCalled();
  });

  it('passes a pin the application carries through to the person as it was placed', async () => {
    const ctx = makeService({
      application: {
        ...ready(),
        extendedProfile: { fields: { latitude: '18.5204', longitude: '73.8567', district: 'Pune' } },
      },
    });
    await ctx.service.approve('app-88', 'hr-1', ['ADMIN']);

    const [dto] = ctx.assayerService.create.mock.calls[0];
    expect(dto).toMatchObject({ latitude: 18.5204, longitude: 73.8567, district: 'Pune' });
  });

  it('does not wait for the hand-off to be accepted', async () => {
    const ctx = makeService({ application: ready() });
    ctx.geoPrecision.enqueueBackfill.mockImplementationOnce(() => new Promise(() => undefined));

    const outcome = await Promise.race([
      ctx.service.approve('app-88', 'hr-1', ['ADMIN']).then(() => 'approved'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting on the queue'), 300)),
    ]);
    expect(outcome).toBe('approved');
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
      references: [{ fullName: 'A Referee', phone: '9811100022', email: 'Ref@Example.com' }],
      empanelments: [{ clientId: 'client-1', status: 'EMPANELLED' }],
    }, 'hr-maker');

    const profile = saved.extendedProfile as any;
    expect(profile.commercial).toMatchObject({ baseFee: 900 });
    expect(profile.references).toEqual([
      { fullName: 'A Referee', phone: '9811100022', email: 'ref@example.com' },
    ]);
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
    // Explicitly un-agreed: a desk-opened application has no candidate consent yet, and this test
    // exists to prove the desk cannot supply it for them.
    const ctx = makeService({ application: draft({ consentAcceptedAt: null }) });
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
  beforeEach(() => {
    __resetPincodeCache();
    clearIfscCache();
  });

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
    expect(result.emailDelivery).toMatchObject({ status: 'QUEUED', to: 'ramesh@example.com' });
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
    expect(ctx.mailbox.send.mock.invocationCallOrder[0]).toBeGreaterThan(lastSave);
  });

  it('queues the invite against the desk member who admitted the candidate, so their screen can watch it', async () => {
    const ctx = emptyQueue();
    await ctx.service.openWithoutInterview(INPUT, ACTOR);

    expect(ctx.emailService.queue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'REGISTRATION_INVITE', to: 'ramesh@example.com', entityId: 'app-new', requestedBy: 'hr-1',
    }));
  });

  it('still hands back the link when the email could not be queued, and says so', async () => {
    const ctx = emptyQueue();
    ctx.emailService.queue.mockResolvedValueOnce({ id: null, status: 'NOT_QUEUED', to: INPUT.email, error: 'db down' });
    const result = await ctx.service.openWithoutInterview(INPUT, ACTOR);

    expect(result.emailDelivery?.status).toBe('NOT_QUEUED');
    expect(result.inviteLink).toMatch(/\/register\/[0-9a-f]{64}$/);
  });

  it('refuses a number that already belongs to somebody on the roster', async () => {
    const ctx = emptyQueue();
    ctx.assayers.findOne.mockResolvedValueOnce({ assayerCode: 'AS0007', displayName: 'Ramesh K' } as never);

    await expect(ctx.service.openWithoutInterview(INPUT, ACTOR))
      .rejects.toBeInstanceOf(ConflictException);
    // Nothing minted, nothing sent: the refusal is before the first write.
    expect(ctx.applications.save).not.toHaveBeenCalled();
    expect(ctx.mailbox.send).not.toHaveBeenCalled();
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
    expect(ctx.mailbox.send).not.toHaveBeenCalled();
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
/**
 * CONSENT COMES BEFORE COLLECTION, AND CAN BE TAKEN BACK.
 *
 * The tick-box used to sit on the last step of the form, beside Submit — by which point the name,
 * PAN, Aadhaar, bank account and every scan had already been typed, uploaded and saved. Agreeing
 * afterwards is not a decision about whether to hand any of it over, and there was no way at all to
 * change your mind.
 */
describe('what a candidate agrees to, and when', () => {
  const draft = (over: Record<string, unknown> = {}) => ({
    id: 'app-1', mobile: '9822014455', email: 'candidate@example.com', fullName: 'Ramesh Kulkarni',
    status: ApplicationStatus.DRAFT, tokenHash: TOKEN_HASH, organizationId: 'org-1',
    tokenExpiresAt: new Date(Date.now() + 3_600_000), tokenConsumedAt: null,
    employmentCategory: 'FREELANCER', consentAcceptedAt: null, consentWithdrawnAt: null,
    ...over,
  });

  it('refuses every collection until the notice is accepted', async () => {
    const ctx = makeService({ application: draft(), cache: verified() });

    await expect(ctx.service.updateDraft(RAW_TOKEN, { record: { panNumber: 'ABCDE1234F' } } as never))
      .rejects.toThrow(/agree to it before filling anything in/);
    await expect(ctx.service.requestOtp(RAW_TOKEN, '9822014455'))
      .rejects.toThrow(/agree to it before filling anything in/);
    await expect(ctx.service.uploadDocument(RAW_TOKEN, 'AADHAAR_FRONT' as never, {
      originalname: 'a.jpg', buffer: Buffer.from('x'), mimetype: 'image/jpeg', size: 1,
    })).rejects.toThrow(/agree to it before filling anything in/);

    expect(ctx.applications.save).not.toHaveBeenCalledWith(
      expect.objectContaining({ extendedProfile: expect.anything() }),
    );
  });

  it('lets the same writes through once they have agreed', async () => {
    const ctx = makeService({ application: draft({ consentAcceptedAt: new Date() }), cache: verified() });
    await expect(ctx.service.updateDraft(RAW_TOKEN, { record: { ifscCode: 'SBIN0001234' } } as never))
      .resolves.toBeDefined();
  });

  it('hands the form the notice to show, with somebody to complain to', async () => {
    const ctx = makeService({ application: draft(), cache: verified() });
    const view = await ctx.service.hydrate(RAW_TOKEN);
    expect(view.consentNotice.version).toBe(CURRENT_CONSENT_VERSION);
    expect(view.consentNotice.purposes.length).toBeGreaterThan(3);
    expect(view.consentNotice.grievanceContact).toBeTruthy();
  });

  /** A row claiming consent to wording nobody can produce is worse than no row at all. */
  it('refuses a version it never published', async () => {
    const ctx = makeService({ application: draft(), cache: verified() });
    await expect(ctx.service.acceptConsent(RAW_TOKEN, 'v1')).rejects.toThrow(/out of date/);
  });

  it('keeps the exact words that were accepted, beside the acceptance', async () => {
    const ctx = makeService({ application: draft(), cache: verified() });
    const saved = await ctx.service.acceptConsent(RAW_TOKEN, CURRENT_CONSENT_VERSION);
    expect(saved.consentAcceptedAt).toBeInstanceOf(Date);
    expect(saved.consentVersion).toBe(CURRENT_CONSENT_VERSION);
    expect((saved.consentNotice as any).purposes).toHaveLength(CURRENT_CONSENT_NOTICE.purposes.length);
    expect((saved.consentNotice as any).grievanceContact).toBeTruthy();
  });

  describe('withdrawing it', () => {
    it('erases the answers and deletes the scans, not just a flag', async () => {
      const ctx = makeService({
        application: draft({
          status: ApplicationStatus.PENDING_VALIDATION,
          consentAcceptedAt: new Date(),
          extendedProfile: { fields: { panNumber: 'enc:v1:whatever' } },
        }),
        cache: verified(),
      });
      ctx.applicationDocuments.find.mockResolvedValue([
        { id: 'd1', applicationId: 'app-1', requirement: 'AADHAAR_FRONT', filePaths: ['k1', 'k2'] },
      ] as never);

      const saved = await ctx.service.withdrawConsent(RAW_TOKEN, 'Changed my mind');

      expect(saved.status).toBe(ApplicationStatus.WITHDRAWN);
      expect(saved.consentWithdrawnAt).toBeInstanceOf(Date);
      expect(saved.extendedProfile).toBeNull();
      expect(ctx.storage.deleteFile).toHaveBeenCalledWith('k1');
      expect(ctx.storage.deleteFile).toHaveBeenCalledWith('k2');
      expect(ctx.applicationDocuments.remove).toHaveBeenCalled();
    });

    it('closes the form to anything further', async () => {
      const ctx = makeService({
        application: draft({ consentAcceptedAt: new Date(), consentWithdrawnAt: new Date() }),
        cache: verified(),
      });
      await expect(ctx.service.updateDraft(RAW_TOKEN, { record: { ifscCode: 'SBIN0001234' } } as never))
        .rejects.toThrow(/was withdrawn/);
    });

    it('cannot then be approved into a person', async () => {
      const ctx = makeService({
        application: draft({ status: ApplicationStatus.WITHDRAWN, consentWithdrawnAt: new Date() }),
      });
      await expect(ctx.service.approve('app-1', 'hr-checker', ['ADMIN']))
        .rejects.toThrow(/withdrew their application/);
    });

    /** An approved candidate is an employee: this link cannot erase a roster record. */
    it('refuses once the person has been taken on, and says where to write', async () => {
      const ctx = makeService({
        application: draft({ status: ApplicationStatus.APPROVED, consentAcceptedAt: new Date() }),
        cache: verified(),
      });
      await expect(ctx.service.withdrawConsent(RAW_TOKEN))
        .rejects.toThrow(/grievance officer/);
    });

    it('does nothing further if it was already withdrawn', async () => {
      const ctx = makeService({
        application: draft({ status: ApplicationStatus.WITHDRAWN, consentWithdrawnAt: new Date() }),
        cache: verified(),
      });
      await ctx.service.withdrawConsent(RAW_TOKEN);
      expect(ctx.storage.deleteFile).not.toHaveBeenCalled();
    });
  });
});

/**
 * THE APPLICATION MUST NOT BE A PLAINTEXT COPY OF SOMEBODY'S IDENTITY.
 *
 * `assayers` has encrypted PAN, Aadhaar and bank account for a long time. The application — the
 * same numbers, typed by the same person minutes earlier — kept them as plain text in a jsonb
 * column, went on holding them after approval, and returned them whole to every HR screen. An
 * audit found them sitting in the live database in the clear.
 */
describe('the identity numbers a candidate types', () => {
  const originalKey = process.env.PII_ENCRYPTION_KEY;
  beforeAll(() => { process.env.PII_ENCRYPTION_KEY = 'b'.repeat(64); __resetKeyCacheForTests(); });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
    else process.env.PII_ENCRYPTION_KEY = originalKey;
    __resetKeyCacheForTests();
  });

  const storedFields = (ctx: any) => {
    const saved = ctx.applications.save.mock.calls.at(-1)![0];
    return (saved.extendedProfile as any).fields as Record<string, string>;
  };

  it('never writes a PAN, Aadhaar or bank account to the row in the clear', async () => {
    const ctx = makeService({ cache: verified() });
    await ctx.service.updateDraft(RAW_TOKEN, {
      record: {
        panNumber: 'ABCDE1234F', aadhaarNumber: '234567890124',
        bankAccountNumber: '50100123456789', ifscCode: 'SBIN0001234',
      },
    } as never);

    const fields = storedFields(ctx);
    for (const key of ['panNumber', 'aadhaarNumber', 'bankAccountNumber']) {
      expect(fields[key].startsWith('enc:v1:')).toBe(true);
    }
    expect(JSON.stringify(fields)).not.toContain('ABCDE1234F');
    expect(JSON.stringify(fields)).not.toContain('234567890124');
    expect(JSON.stringify(fields)).not.toContain('50100123456789');
    // The IFSC identifies a bank, not a person, and stays readable.
    expect(fields.ifscCode).toBe('SBIN0001234');
  });

  it('gives the candidate their own numbers back, so a resumed form still shows them', async () => {
    const ctx = makeService({ cache: verified() });
    await ctx.service.updateDraft(RAW_TOKEN, { record: { panNumber: 'ABCDE1234F' } } as never);
    ctx.application!.extendedProfile = { fields: storedFields(ctx) };

    const view = await ctx.service.hydrate(RAW_TOKEN);
    expect((view.application.extendedProfile as any).fields.panNumber).toBe('ABCDE1234F');
  });

  /**
   * Found by probing the running system: the form saves as you type, and this response feeds the
   * same boxes the candidate is typing into.
   */
  it('answers a draft save with the number, not the ciphertext that was stored', async () => {
    const ctx = makeService({ cache: verified() });
    const saved = await ctx.service.updateDraft(RAW_TOKEN, { record: { panNumber: 'ABCDE1234F' } } as never);

    expect((saved.extendedProfile as any).fields.panNumber).toBe('ABCDE1234F');
    // ...while what actually went to the database stayed sealed.
    const stored = ctx.applications.save.mock.calls.at(-1)![0];
    expect((stored.extendedProfile as any).fields.panNumber.startsWith('enc:v1:')).toBe(true);
  });

  it('shows HR the last four digits and never the number', async () => {
    const ctx = makeService({ cache: verified() });
    await ctx.service.updateDraft(RAW_TOKEN, {
      record: { panNumber: 'ABCDE1234F', aadhaarNumber: '234567890124', bankAccountNumber: '50100123456789' },
    } as never);
    ctx.application!.extendedProfile = { fields: storedFields(ctx) };

    const detail = await ctx.service.getApplication('app-1');
    const text = JSON.stringify(detail.application);
    expect(text).not.toContain('ABCDE1234F');
    expect(text).not.toContain('234567890124');
    expect(text).not.toContain('50100123456789');
    expect((detail.application.extendedProfile as any).fields.panNumber).toMatch(/234F$/);
    // Nor in the queue every HR screen opens with.
    expect(JSON.stringify(await ctx.service.listApplications())).not.toContain('ABCDE1234F');
  });

  /**
   * Once the record holds the number, the application has no use for it — and three approved
   * applications were still holding theirs in the live database.
   */
  it('stops holding the numbers once the record has them', async () => {
    const application = {
      id: 'app-x', mobile: '9822014455', fullName: 'Full Payload', state: 'Maharashtra',
      status: ApplicationStatus.PENDING_VALIDATION, organizationId: 'org-1',
      source: ApplicationSource.HR_DESK, createdBy: 'hr-maker',
      extendedProfile: { fields: { panNumber: 'ABCDE1234K', aadhaarNumber: '234567890124', bankAccountNumber: '123456789012', ifscCode: 'SBIN0001234' } },
    };
    const ctx = makeService({ application });
    (ctx.assayerService as any).update = jest.fn(async () => ({}));

    await ctx.service.approve('app-x', 'hr-checker', ['ADMIN']);

    const saved = ctx.applications.save.mock.calls.at(-1)![0];
    const fields = (saved.extendedProfile as any).fields;
    expect(fields).not.toHaveProperty('panNumber');
    expect(fields).not.toHaveProperty('aadhaarNumber');
    expect(fields).not.toHaveProperty('bankAccountNumber');
    // What is not an identity number stays: it is how the desk sees what was collected.
    expect(fields.ifscCode).toBe('SBIN0001234');
  });

  /** If the record refused a number, this row is the only remaining copy — it must keep it. */
  it('keeps a number the record refused, rather than losing it from both places', async () => {
    const application = {
      id: 'app-y', mobile: '9822014455', fullName: 'Refused Identity', state: 'Maharashtra',
      status: ApplicationStatus.PENDING_VALIDATION, organizationId: 'org-1',
      source: ApplicationSource.HR_DESK, createdBy: 'hr-maker',
      extendedProfile: { fields: { panNumber: 'ABCDE1234K', bankAccountNumber: '123456789012' } },
    };
    const ctx = makeService({ application });
    (ctx.assayerService as any).update = jest.fn(async (_id: string, dto: Record<string, unknown>) => {
      if ('panNumber' in dto) throw new Error('That PAN is already on somebody else');
      return {};
    });

    await ctx.service.approve('app-y', 'hr-checker', ['ADMIN']);

    const fields = (ctx.applications.save.mock.calls.at(-1)![0].extendedProfile as any).fields;
    expect(fields.panNumber).toBeDefined();
    expect(fields).not.toHaveProperty('bankAccountNumber');   // that one landed
  });

  /** A screen that sent back what it was shown would replace a real number with its own mask. */
  it('refuses to store the mask a screen displayed', async () => {
    const ctx = makeService({ cache: verified() });
    await expect(ctx.service.updateDraft(RAW_TOKEN, { record: { panNumber: '••••••234F' } } as never))
      .rejects.toThrow(/masked copy/);
  });
});

describe('what submit refuses that the roster sweep used to catch later', () => {
  /*
    The identifier checks compare FINGERPRINTS, which need the PII key: without it
    `fieldFingerprint` returns null and the duplicate check quietly does nothing. Production sets
    the key; a bare test process does not, so set it here — and that silence is exactly why the
    roster sweep stays as the backstop rather than being deleted.
  */
  const originalKey = process.env.PII_ENCRYPTION_KEY;
  /*
    The key module resolves the key ONCE and caches it — including caching "no key". Applications
    now seal their identity numbers as they are typed, so earlier tests in this file reach the key
    module first and cache a null; without these resets, setting the variable here would have no
    effect and the duplicate check would silently pass everything.
  */
  beforeAll(() => {
    process.env.PII_ENCRYPTION_KEY = 'a'.repeat(64);
    __resetKeyCacheForTests();
  });
  afterAll(() => {
    if (originalKey === undefined) delete process.env.PII_ENCRYPTION_KEY;
    else process.env.PII_ENCRYPTION_KEY = originalKey;
    __resetKeyCacheForTests();
  });

  const ready = (over: Record<string, unknown> = {}) => ({
    id: 'app-1', mobile: '9822014455', email: 'candidate@example.com', fullName: 'Ramesh Kulkarni',
    status: ApplicationStatus.DRAFT, tokenHash: TOKEN_HASH,
    tokenExpiresAt: new Date(Date.now() + 3_600_000), tokenConsumedAt: null,
    employmentCategory: 'FREELANCER', consentAcceptedAt: new Date(), organizationId: 'org-1',
    // Submit demands somebody ringable; these tests are about the checks after that gate.
    extendedProfile: {
      references: [{ fullName: 'Meera Rao', phone: '9822014455' }],
    },
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
      application: ready({ extendedProfile: { fields: { dateOfBirth: seventeenYearsAgo() }, references: [{ fullName: 'Meera Rao', phone: '9822014455' }], } }),
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
      application: ready({ dateOfBirth: '1990-06-15', extendedProfile: { fields: { panNumber: 'ABCDE1234F' }, references: [{ fullName: 'Meera Rao', phone: '9822014455' }], } }),
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
        extendedProfile: { fields: { panNumber: 'ABCDE1234F' }, references: [{ fullName: 'Meera Rao', phone: '9822014455' }], },
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

/**
 * WHO REFERRED THEM — the source reference (owner, 2026-09-23). HR records it at intake; the
 * candidate may fill it on their form when HR left it blank; approval keeps it on the person.
 */
describe('the source referral on an application', () => {
  const ravi = { type: 'ASSAYER', name: 'Ravi Kumar', mobile: '9876543210', email: 'ravi@example.in' };
  const draftWith = (sourceReferral?: Record<string, unknown>) => ({
    id: 'app-1', mobile: '9822014455', fullName: 'Ramesh Kulkarni', status: ApplicationStatus.DRAFT,
    organizationId: 'org-1', tokenHash: TOKEN_HASH, tokenExpiresAt: new Date(Date.now() + 3_600_000),
    consentAcceptedAt: new Date(), consentVersion: CURRENT_CONSENT_NOTICE.version,
    extendedProfile: sourceReferral ? { sourceReferral } : null,
  });

  it('lets the candidate name who referred them when HR has not', async () => {
    const { service, application } = makeService({ application: draftWith() as never, cache: verified() });
    await service.updateDraft(RAW_TOKEN, { sourceReferral: ravi } as never);
    expect((application!.extendedProfile as Row).sourceReferral).toEqual({ ...ravi, recordedBy: 'CANDIDATE' });
  });

  it('does not let the candidate change what HR recorded', async () => {
    const { service, application } = makeService({ application: draftWith({ ...ravi, recordedBy: 'HR' }) as never, cache: verified() });
    await expect(service.updateDraft(RAW_TOKEN, { sourceReferral: { ...ravi, name: 'Someone Else' } } as never))
      .rejects.toThrow(/HR has recorded who referred you/);
    expect(((application!.extendedProfile as Row).sourceReferral as Row).name).toBe('Ravi Kumar');
  });

  it('refuses an entry nobody could reach, with the shared rule\'s words', async () => {
    const { service } = makeService({ application: draftWith() as never, cache: verified() });
    await expect(service.updateDraft(RAW_TOKEN, { sourceReferral: { ...ravi, mobile: '', email: '' } } as never))
      .rejects.toThrow(/mobile or an email for Ravi Kumar/);
  });

  it('lets the desk record or correct it, as HR', async () => {
    const ctx = makeService({ application: draftWith({ ...ravi, recordedBy: 'CANDIDATE' }) as never });
    const saved = await ctx.service.updateStaffDraft('app-1', { sourceReferral: { ...ravi, type: 'STAFF' } } as never, 'hr-1');
    expect((saved.extendedProfile as Row).sourceReferral).toMatchObject({ type: 'STAFF', recordedBy: 'HR' });
  });

  it('carries HR\'s intake entry onto the application an interview opens', async () => {
    const { service, applications } = makeService();
    const referral = { ...ravi, recordedBy: 'HR' } as never;
    await service.createInviteRecord({ mobile: '9822014455', fullName: 'Ramesh Kulkarni', sourceReferral: referral });
    expect(applications.create).toHaveBeenCalledWith(expect.objectContaining({ extendedProfile: { sourceReferral: referral } }));
  });

  it('keeps it on the person at approval, as whoever recorded it', async () => {
    const ctx = makeService({
      application: {
        ...draftWith({ ...ravi, recordedBy: 'CANDIDATE' }),
        status: ApplicationStatus.PENDING_VALIDATION, email: 'c@example.com', state: 'Maharashtra', city: 'Pune',
        employmentCategory: EmploymentCategory.PROPRIETOR,
      } as never,
    });
    await ctx.service.approve('app-1', 'user-1', ['ADMIN']);
    expect(ctx.assayerService.setSourceReferral).toHaveBeenCalledWith(
      'assayer-1', expect.objectContaining({ name: 'Ravi Kumar' }), 'user-1', 'CANDIDATE',
    );
  });
});

/**
 * THE "REPLACE" BUTTON REPLACES, AND A WRONG FILE CAN BE TAKEN OFF.
 *
 * Both forms offered "Replace" on an attached scan, and the server appended whatever it was sent:
 * a candidate fixing a blurred PAN card left the blurred one on the application too, and HR read
 * "(2 files)" with no way to know which was meant. Nor could the candidate remove a wrong file at
 * all — only HR could have, and HR could not either.
 */
describe('a candidate correcting the files on a requirement', () => {
  const scan = { originalname: 'pan.png', buffer: Buffer.from('x'), mimetype: 'image/png', size: 10 };
  const rowWith = (filePaths: string[], extra: Row = {}) => ({
    id: 'doc-1', applicationId: 'app-1', requirement: OnboardingDocument.PAN_CARD, filePaths,
    reviewStatus: 'PENDING', rejectionReason: null, rejectionNote: null, ...extra,
  });
  const lastSaved = (ctx: ReturnType<typeof makeService>) =>
    ctx.applicationDocuments.save.mock.calls[ctx.applicationDocuments.save.mock.calls.length - 1][0] as Row;
  const auditTypes = (ctx: ReturnType<typeof makeService>) =>
    (ctx.auditService.recordEventSafe.mock.calls as unknown as Array<[Row]>).map(([e]) => e.eventType);

  describe('replacing', () => {
    it('puts the new file in place of every earlier one, and deletes those from storage', async () => {
      const ctx = makeService();
      (ctx.applicationDocuments.findOne as jest.Mock).mockResolvedValueOnce(rowWith(['uploads/blurry.png', 'uploads/other.png']));

      const row = await ctx.service.uploadDocument(RAW_TOKEN, OnboardingDocument.PAN_CARD, scan, { replace: true });

      expect(row.filePaths).toEqual(['uploads/scan.png']);
      expect(ctx.storage.deleteFile).toHaveBeenCalledWith('uploads/blurry.png');
      expect(ctx.storage.deleteFile).toHaveBeenCalledWith('uploads/other.png');
      expect(ctx.storage.deleteFile).not.toHaveBeenCalledWith('uploads/scan.png');
      expect(ctx.auditService.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'ASSAYER_APPLICATION_DOCUMENT_REPLACED',
        entityType: 'ASSAYER_APPLICATION',
        entityId: 'app-1',
        metadata: expect.objectContaining({ requirement: OnboardingDocument.PAN_CARD, filesReplaced: 2 }),
      }));
    });

    it('deletes the displaced files only after the row stops pointing at them', async () => {
      const ctx = makeService();
      (ctx.applicationDocuments.findOne as jest.Mock).mockResolvedValueOnce(rowWith(['uploads/blurry.png']));
      const order: string[] = [];
      ctx.applicationDocuments.save.mockImplementation(async (v: Row) => { order.push(`save:${v.filePaths.join(',')}`); return { ...v, id: 'doc-1' }; });
      ctx.storage.deleteFile.mockImplementation(async (...args: unknown[]) => { order.push(`delete:${String(args[0])}`); });

      await ctx.service.uploadDocument(RAW_TOKEN, OnboardingDocument.PAN_CARD, scan, { replace: true });

      expect(order.indexOf('save:uploads/scan.png')).toBeLessThan(order.indexOf('delete:uploads/blurry.png'));
    });

    it('still succeeds when storage cannot delete the old file — the orphan sweep has it', async () => {
      const ctx = makeService();
      (ctx.applicationDocuments.findOne as jest.Mock).mockResolvedValueOnce(rowWith(['uploads/blurry.png']));
      ctx.storage.deleteFile.mockRejectedValueOnce(new Error('bucket unreachable') as never);

      const row = await ctx.service.uploadDocument(RAW_TOKEN, OnboardingDocument.PAN_CARD, scan, { replace: true });

      expect(row.filePaths).toEqual(['uploads/scan.png']);
      expect(ctx.auditService.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'ASSAYER_APPLICATION_DOCUMENT_REPLACED',
        metadata: expect.objectContaining({ storageDeleteFailures: 1 }),
      }));
    });

    it('without the flag still appends — the "add a page" case — and deletes nothing', async () => {
      const ctx = makeService();
      (ctx.applicationDocuments.findOne as jest.Mock).mockResolvedValueOnce(rowWith(['uploads/front.png']));

      const row = await ctx.service.uploadDocument(RAW_TOKEN, OnboardingDocument.PAN_CARD, scan);

      expect(row.filePaths).toEqual(['uploads/front.png', 'uploads/scan.png']);
      expect(ctx.storage.deleteFile).not.toHaveBeenCalled();
      expect(auditTypes(ctx)).not.toContain('ASSAYER_APPLICATION_DOCUMENT_REPLACED');
    });

    it('on a requirement with nothing on it yet is simply the first file, with nothing to audit as replaced', async () => {
      const ctx = makeService();
      const row = await ctx.service.uploadDocument(RAW_TOKEN, OnboardingDocument.PAN_CARD, scan, { replace: true });
      expect(row.filePaths).toEqual(['uploads/scan.png']);
      expect(ctx.storage.deleteFile).not.toHaveBeenCalled();
      expect(auditTypes(ctx)).not.toContain('ASSAYER_APPLICATION_DOCUMENT_REPLACED');
    });

    it('answers a send-back the way a fresh upload does: back to pending, the ask dropped', async () => {
      const ctx = makeService({
        application: {
          ...baseApplication(),
          status: ApplicationStatus.AWAITING_INFO,
          infoRequests: [{ kind: 'document', key: 'PAN_CARD', label: 'PAN card', message: 'Retake.' }],
        },
      });
      (ctx.applicationDocuments.findOne as jest.Mock).mockResolvedValueOnce(
        rowWith(['uploads/blurry.png'], { reviewStatus: 'NEEDS_RESUBMIT', rejectionReason: 'ILLEGIBLE', rejectionNote: 'Blurred' }),
      );

      await ctx.service.uploadDocument(RAW_TOKEN, OnboardingDocument.PAN_CARD, scan, { replace: true });

      const saved = lastSaved(ctx);
      expect(saved.filePaths).toEqual(['uploads/scan.png']);
      expect(saved.reviewStatus).toBe('PENDING');
      expect(saved.rejectionReason).toBeNull();
      expect(saved.rejectionNote).toBeNull();
    });

    it('sends a document HR had approved back to pending — the new file is one HR has not seen', async () => {
      const ctx = makeService({ application: { ...baseApplication(), status: ApplicationStatus.AWAITING_INFO } });
      (ctx.applicationDocuments.findOne as jest.Mock).mockResolvedValueOnce(
        rowWith(['uploads/approved.png'], { reviewStatus: 'APPROVED', reviewedBy: 'hr-1', reviewedAt: new Date() }),
      );

      await ctx.service.uploadDocument(RAW_TOKEN, OnboardingDocument.PAN_CARD, scan, { replace: true });

      const saved = lastSaved(ctx);
      expect(saved.filePaths).toEqual(['uploads/scan.png']);
      expect(saved.reviewStatus).toBe('PENDING');
      expect(saved.reviewedBy).toBeNull();
    });

    it('is refused once the application is with HR, and without consent — the upload gates', async () => {
      for (const over of [
        { status: ApplicationStatus.PENDING_VALIDATION },
        { consentAcceptedAt: null },
        { consentWithdrawnAt: new Date() },
      ]) {
        const ctx = makeService({ application: { ...baseApplication(), ...over } });
        (ctx.applicationDocuments.findOne as jest.Mock).mockResolvedValue(rowWith(['uploads/blurry.png']));
        await expect(ctx.service.uploadDocument(RAW_TOKEN, OnboardingDocument.PAN_CARD, scan, { replace: true }))
          .rejects.toBeInstanceOf(BadRequestException);
        expect(ctx.storage.saveFile).not.toHaveBeenCalled();
        expect(ctx.storage.deleteFile).not.toHaveBeenCalled();
      }
    });
  });

  describe('removing one file', () => {
    it('takes that file off, keeps the rest in order, deletes it from storage and audits it', async () => {
      const ctx = makeService();
      (ctx.applicationDocuments.findOne as jest.Mock).mockResolvedValueOnce(rowWith(['k0', 'k1', 'k2']));

      const row = await ctx.service.removeDocumentFile(RAW_TOKEN, OnboardingDocument.PAN_CARD, 1);

      expect(row.filePaths).toEqual(['k0', 'k2']);
      expect(row.requirement).toBe(OnboardingDocument.PAN_CARD);
      expect(ctx.storage.deleteFile).toHaveBeenCalledTimes(1);
      expect(ctx.storage.deleteFile).toHaveBeenCalledWith('k1');
      expect(ctx.auditService.recordEventSafe).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'ASSAYER_APPLICATION_DOCUMENT_REMOVED',
        entityType: 'ASSAYER_APPLICATION',
        entityId: 'app-1',
        metadata: expect.objectContaining({ requirement: OnboardingDocument.PAN_CARD, index: 1, filesRemaining: 2 }),
      }));
    });

    it('answers an emptied requirement as a row with no files, keeping HR\'s send-back on it', async () => {
      const ctx = makeService();
      (ctx.applicationDocuments.findOne as jest.Mock).mockResolvedValueOnce(
        rowWith(['k0'], { reviewStatus: 'NEEDS_RESUBMIT', rejectionReason: 'ILLEGIBLE' }),
      );

      const row = await ctx.service.removeDocumentFile(RAW_TOKEN, OnboardingDocument.PAN_CARD, 0);

      expect(row.filePaths).toEqual([]);
      expect(row.requirement).toBe(OnboardingDocument.PAN_CARD);
      // Taking the wrong file off is not answering the send-back.
      expect(row.reviewStatus).toBe('NEEDS_RESUBMIT');
      expect(ctx.applicationDocuments.remove).not.toHaveBeenCalled();
    });

    it('withdraws an approval when a file is taken off — it no longer describes what is attached', async () => {
      const ctx = makeService();
      (ctx.applicationDocuments.findOne as jest.Mock).mockResolvedValueOnce(
        rowWith(['k0', 'k1'], { reviewStatus: 'APPROVED', reviewedBy: 'hr-1', reviewedAt: new Date() }),
      );

      const row = await ctx.service.removeDocumentFile(RAW_TOKEN, OnboardingDocument.PAN_CARD, 0);

      expect(row.filePaths).toEqual(['k1']);
      expect(row.reviewStatus).toBe('PENDING');
      expect(row.reviewedBy).toBeNull();
    });

    it('404s an index past either end, and a requirement with nothing attached', async () => {
      for (const index of [-1, 3, 99, 1.5]) {
        const ctx = makeService();
        (ctx.applicationDocuments.findOne as jest.Mock).mockResolvedValueOnce(rowWith(['k0', 'k1', 'k2']));
        await expect(ctx.service.removeDocumentFile(RAW_TOKEN, OnboardingDocument.PAN_CARD, index))
          .rejects.toBeInstanceOf(NotFoundException);
        expect(ctx.applicationDocuments.save).not.toHaveBeenCalled();
        expect(ctx.storage.deleteFile).not.toHaveBeenCalled();
      }
      const none = makeService();
      await expect(none.service.removeDocumentFile(RAW_TOKEN, OnboardingDocument.PAN_CARD, 0))
        .rejects.toBeInstanceOf(NotFoundException);
      const unknown = makeService();
      await expect(unknown.service.removeDocumentFile(RAW_TOKEN, 'NOT_A_DOCUMENT' as OnboardingDocument, 0))
        .rejects.toBeInstanceOf(NotFoundException);
    });

    it('is refused on a submitted application, without consent, after withdrawal, and on a dead link', async () => {
      for (const over of [
        { status: ApplicationStatus.PENDING_VALIDATION },
        { status: ApplicationStatus.APPROVED },
        { consentAcceptedAt: null },
        { consentWithdrawnAt: new Date() },
        { tokenExpiresAt: new Date(Date.now() - 1000) },
      ]) {
        const ctx = makeService({ application: { ...baseApplication(), ...over } });
        (ctx.applicationDocuments.findOne as jest.Mock).mockResolvedValue(rowWith(['k0']));
        await expect(ctx.service.removeDocumentFile(RAW_TOKEN, OnboardingDocument.PAN_CARD, 0))
          .rejects.toBeInstanceOf(BadRequestException);
        expect(ctx.applicationDocuments.save).not.toHaveBeenCalled();
        expect(ctx.storage.deleteFile).not.toHaveBeenCalled();
        expect(auditTypes(ctx)).not.toContain('ASSAYER_APPLICATION_DOCUMENT_REMOVED');
      }
    });

    it('is allowed again when HR sent the application back for more information', async () => {
      const ctx = makeService({ application: { ...baseApplication(), status: ApplicationStatus.AWAITING_INFO } });
      (ctx.applicationDocuments.findOne as jest.Mock).mockResolvedValueOnce(rowWith(['k0', 'k1']));
      await expect(ctx.service.removeDocumentFile(RAW_TOKEN, OnboardingDocument.PAN_CARD, 0))
        .resolves.toEqual(expect.objectContaining({ filePaths: ['k1'] }));
    });
  });
});

/**
 * Both forms refuse to submit without the ID photograph; the server did not, so an application
 * with no face on it reached HR and was refused only at approval — the ID card cannot be issued
 * without one. The server now says so at submit, in the passbook refusal's words.
 */
describe('submitting without a photograph', () => {
  const ready = () => ({
    id: 'app-1', mobile: '9822014455', email: 'c@example.com', fullName: 'Ramesh Kulkarni',
    status: ApplicationStatus.DRAFT, tokenHash: TOKEN_HASH,
    tokenExpiresAt: new Date(Date.now() + 3_600_000),
    employmentCategory: EmploymentCategory.FREELANCER, consentAcceptedAt: new Date(),
    extendedProfile: { references: [{ fullName: 'Meera Rao', phone: '9822014455', relationship: 'Former manager' }] },
  });

  it('is refused, whether there is no photo row or an emptied one', async () => {
    for (const photo of [[], [{ requirement: OnboardingDocument.PHOTOGRAPH, filePaths: [] }]]) {
      const ctx = makeService({ application: ready(), cache: verified() });
      (ctx.applicationDocuments.find as jest.Mock).mockResolvedValue([
        { requirement: OnboardingDocument.BANK_PASSBOOK, filePaths: ['uploads/passbook.jpg'] },
        ...photo,
      ]);
      await expect(ctx.service.submit(RAW_TOKEN)).rejects.toThrow(/Upload Photograph before submitting/);
      expect(ctx.application!.status).toBe(ApplicationStatus.DRAFT);
    }
  });

  it('goes through with one', async () => {
    const ctx = makeService({ application: ready(), cache: verified() });
    const saved = await ctx.service.submit(RAW_TOKEN);
    expect(saved.status).toBe(ApplicationStatus.PENDING_VALIDATION);
  });
});
