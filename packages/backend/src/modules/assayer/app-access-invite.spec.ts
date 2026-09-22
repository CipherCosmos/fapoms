import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { EventCategory, AssayerLifecycleStatus } from '@fapoms/shared';
import { AssayerService } from './assayer.service';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { AssayerEntity } from './assayer.entity';
import { AssayerCommercialProfileEntity } from './assayer-commercial-profile.entity';
import { WorkforceAttributeEntity } from './workforce-attribute.entity';
import { AssayerRemarkEntity } from './assayer-remark.entity';
import { AssayerActivityEntity } from './assayer-activity.entity';
import { TEMP_PASSWORD_WORDS } from './temp-password-words';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { WorkflowEngine } from '../platform/workflow/workflow.engine';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { NotificationService } from '../notifications/notification.service';
import { SmsService } from '../notifications/sms.service';
import { SMS_TEMPLATE_REGISTRY } from '../../infrastructure/notifications/sms-template-registry';
import { EmailService } from '../notifications/email.service';
import { EMAIL_TEMPLATE_REGISTRY } from '../../infrastructure/notifications/email-template-registry';
import { EmailTemplateLoader } from '../../infrastructure/notifications/email-template-loader';
import { EmailTemplateRenderer } from '../../infrastructure/notifications/email-template-renderer';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { rbacPrincipalCacheKey } from '../auth/auth.service';

/**
 * App access as a one-time invitation rather than a reset of a password that never existed.
 *
 * The only route to a credential was `resetPasswordByStaff` — the recovery path for somebody
 * locked out, which is what it says on screen — so first-time access was being handed out as a
 * reset, and `INVITED` was a lifecycle label nothing ever sent.
 */
describe('AssayerService.issueAppAccess', () => {
  let service: AssayerService;
  let assayers: any;
  let audit: any;
  let cache: any;
  let events: any;

  const ACTOR = '11111111-1111-4111-8111-111111111111';
  const ASSAYER_ID = '22222222-2222-4222-8222-222222222222';

  const person = (over: Record<string, unknown> = {}) => ({
    id: ASSAYER_ID,
    assayerCode: 'AS0323',
    displayName: 'Soni Paragkumar M',
    phone: '9000000000',
    email: null,
    lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
    ...over,
  });

  beforeEach(async () => {
    assayers = {
      findOne: jest.fn().mockResolvedValue(person()),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn().mockResolvedValue([]),
      metadata: { findColumnWithPropertyName: () => ({ isNullable: true }) },
      manager: { query: jest.fn().mockResolvedValue([]) },
    };
    audit = { recordEvent: jest.fn().mockResolvedValue({ id: 'ev-1' }), recordEventSafe: jest.fn() };
    cache = { del: jest.fn().mockResolvedValue(undefined) };
    events = { publish: jest.fn() };

    const mod = await Test.createTestingModule({
      providers: [
        AssayerService,
        { provide: getRepositoryToken(AssayerEntity), useValue: assayers },
        { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: {} },
        { provide: getRepositoryToken(WorkforceAttributeEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(AssayerRemarkEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerActivityEntity), useValue: { create: jest.fn((r) => r), save: jest.fn() } },
        { provide: AuditService, useValue: audit },
        { provide: DomainEventPublisher, useValue: events },
        { provide: WorkflowEngine, useValue: { registerWorkflow: jest.fn() } },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
        { provide: NotificationService, useValue: { notifyAssayer: jest.fn().mockResolvedValue({ inAppDelivered: true }) } },
        { provide: UnitOfWork, useValue: { run: (work: any) => work(undefined) } },
        { provide: getDataSourceToken(), useValue: { query: jest.fn().mockResolvedValue([]) } },
        { provide: CacheService, useValue: cache },
      ],
    }).compile();
    service = mod.get(AssayerService);
  });

  /**
   * Four BIP-39 words and a digit, kept because these are field workers reading a credential off
   * a phone call in bad light. A hex blob does not survive that trip; "tiger-mango-river-stone4"
   * does. Drawing 4 of 2,048 without repeats is ~2^44 possibilities, well beyond what the
   * five-attempt lockout allows anyone to search.
   */
  it('issues a sayable word-based password, not a random blob', async () => {
    const { temporaryPassword } = await service.issueAppAccess(ASSAYER_ID, ACTOR);

    const [words, digit] = [temporaryPassword.slice(0, -1).split('-'), temporaryPassword.slice(-1)];
    expect(words).toHaveLength(4);
    expect(new Set(words).size).toBe(4);
    for (const w of words) expect(TEMP_PASSWORD_WORDS).toContain(w);
    expect(digit).toMatch(/^[0-9]$/);
  });

  /**
   * The guard is live and enforced for assayer principals, so without this the invitation would
   * hand out a permanent staff-known credential — which is the defect the roster importer's
   * documented `assayer123` default already demonstrated across the whole workforce.
   */
  it('forces a password change at first sign-in, and stores only the hash', async () => {
    const { temporaryPassword } = await service.issueAppAccess(ASSAYER_ID, ACTOR);

    const [, patch] = assayers.update.mock.calls[0];
    expect(patch.mustChangePassword).toBe(true);
    expect(patch.passwordHash).not.toBe(temporaryPassword);
    await expect(bcrypt.compare(temporaryPassword, patch.passwordHash)).resolves.toBe(true);
  });

  /** A re-issue is usually a response to the first credential going astray. */
  it('clears the lockout and ends every session built on the previous credential', async () => {
    await service.issueAppAccess(ASSAYER_ID, ACTOR);

    const [, patch] = assayers.update.mock.calls[0];
    expect(patch.failedLoginAttempts).toBe(0);
    expect(patch.lockedUntil).toBeNull();
    expect(cache.del).toHaveBeenCalledWith(rbacPrincipalCacheKey(ASSAYER_ID));
    expect(events.publish).toHaveBeenCalledWith('user:password-changed', { userId: ASSAYER_ID });
  });

  it('records who issued access to whom, and never the password', async () => {
    const { temporaryPassword } = await service.issueAppAccess(ASSAYER_ID, ACTOR);

    expect(audit.recordEventSafe).toHaveBeenCalledTimes(1);
    const event = audit.recordEventSafe.mock.calls[0][0];
    expect(event).toMatchObject({
      category: EventCategory.USER,
      eventType: 'ASSAYER_APP_ACCESS_ISSUED',
      entityType: 'ASSAYER',
      entityId: ASSAYER_ID,
      userId: ACTOR,
    });
    expect(JSON.stringify(event)).not.toContain(temporaryPassword);
  });

  /**
   * The assayer code, because it is the one identifier every roster row has: phone is optional on
   * admission and email more so. Sign-in accepts code, phone or email.
   */
  it('names the assayer code as the username', async () => {
    const out = await service.issueAppAccess(ASSAYER_ID, ACTOR);
    expect(out.username).toBe('AS0323');
  });

  /**
   * Issuing access mid-onboarding is allowed on purpose — the handover happens when the person is
   * in front of you, which is rarely the day activation is clicked.
   *
   * Two questions, and they used to be conflated into one field. `canSignInNow` answers "does this
   * credential work at all"; `accessScope` answers "how far does it go". The four onboarding
   * stages now sign in to a session confined to finishing their own registration, so reporting
   * `false` for them would have HR reading "they cannot sign in yet" off a card whose password
   * works. SUSPENDED is the case that keeps `canSignInNow` honest: they genuinely cannot.
   */
  it.each([
    [AssayerLifecycleStatus.ACTIVE, true, 'FULL'],
    [AssayerLifecycleStatus.ON_LEAVE, true, 'FULL'],
    [AssayerLifecycleStatus.INVITED, true, 'REGISTRATION_ONLY'],
    [AssayerLifecycleStatus.DOCUMENT_VERIFICATION, true, 'REGISTRATION_ONLY'],
    [AssayerLifecycleStatus.BACKGROUND_VERIFICATION, true, 'REGISTRATION_ONLY'],
    [AssayerLifecycleStatus.TRAINING, true, 'REGISTRATION_ONLY'],
    [AssayerLifecycleStatus.SUSPENDED, false, 'FULL'],
    [AssayerLifecycleStatus.TERMINATED, false, 'FULL'],
  ])('issues access from %s and reports canSignInNow=%s scope=%s', async (lifecycleStatus, expected, scope) => {
    assayers.findOne.mockResolvedValue(person({ lifecycleStatus }));

    const out = await service.issueAppAccess(ASSAYER_ID, ACTOR);

    // Issued in every case — access is never withheld on lifecycle grounds, only reported on.
    expect(out.temporaryPassword).toBeTruthy();
    expect(out.canSignInNow).toBe(expected);
    expect(out.accessScope).toBe(scope);
  });

  it('states a validity window the card can read out', async () => {
    const before = Date.now();
    const { expiresAt } = await service.issueAppAccess(ASSAYER_ID, ACTOR);

    const ms = new Date(expiresAt).getTime() - before;
    expect(ms).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(ms).toBeLessThan(7.1 * 24 * 3600 * 1000);
  });

  it('404s for an assayer that does not exist, writing no credential', async () => {
    assayers.findOne.mockResolvedValue(null);
    await expect(service.issueAppAccess(ASSAYER_ID, ACTOR)).rejects.toBeInstanceOf(NotFoundException);
    expect(assayers.update).not.toHaveBeenCalled();
  });

  /** Two invitations must not produce the same words. */
  it('mints a fresh password each time', async () => {
    const a = await service.issueAppAccess(ASSAYER_ID, ACTOR);
    const b = await service.issueAppAccess(ASSAYER_ID, ACTOR);
    expect(a.temporaryPassword).not.toBe(b.temporaryPassword);
  });

  /**
   * This harness wires no EmailService. The bulk run must refuse before minting anything rather
   * than issue credentials it has no way to deliver.
   */
  it('refuses a bulk credential run when email is not wired in, issuing nothing', async () => {
    await expect(service.bulkIssueAppAccess([ASSAYER_ID], ACTOR)).rejects.toThrow(/email queue is not wired/i);
    expect(assayers.update).not.toHaveBeenCalled();
  });
});

/**
 * Issuing app access to a batch of assayers in one call, delivered by email and SMS instead of
 * read off a screen — the tool HR needed to clear the 540-of-548 backlog `issueAppAccess` above
 * was never built to reach.
 */
describe('AssayerService.bulkIssueAppAccess', () => {
  // Every issued credential is a real bcrypt hash at cost 12 (~0.3 s alone). Under the full suite's
  // parallel load three of them outlived Jest's default 5 s, so the limit is set for what the code
  // actually does rather than lowering the cost the production path uses.
  jest.setTimeout(30_000);

  let service: AssayerService;
  let assayers: any;
  let audit: any;
  let emails: any;
  let sms: any;
  let people: Map<string, any>;

  const ACTOR = '11111111-1111-4111-8111-111111111111';

  const person = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    assayerCode: `AS-${id}`,
    displayName: `Person ${id}`,
    phone: '9000000000',
    email: 'person@example.com',
    lifecycleStatus: AssayerLifecycleStatus.ACTIVE,
    ...over,
  });

  beforeEach(async () => {
    people = new Map();
    audit = { recordEvent: jest.fn().mockResolvedValue({ id: 'ev-1' }), recordEventSafe: jest.fn() };
    let queued = 0;
    emails = {
      queue: jest.fn(async (req: any) => ({ id: `email-${++queued}`, status: 'QUEUED', to: req.to })),
      sendNow: jest.fn(),
    };
    let texted = 0;
    sms = {
      queue: jest.fn(async (req: any) => ({ id: `sms-${++texted}`, channel: 'SMS', status: 'QUEUED', to: req.to })),
      sendNow: jest.fn(),
    };

    assayers = {
      // Keyed on the id in the `where` clause, unlike the single-person suite above, since a
      // batch needs to answer differently for different ids in the same run.
      findOne: jest.fn(({ where }: any) => Promise.resolve(people.get(where.id) ?? null)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn().mockResolvedValue([]),
      metadata: { findColumnWithPropertyName: () => ({ isNullable: true }) },
      manager: { query: jest.fn().mockResolvedValue([]) },
    };

    service = await build({ withSms: true });
  });

  /** The harness, with or without the SMS service wired in (it is `@Optional()` on the service). */
  const build = async ({ withSms }: { withSms: boolean }): Promise<AssayerService> => {
    const mod = await Test.createTestingModule({
      providers: [
        AssayerService,
        { provide: getRepositoryToken(AssayerEntity), useValue: assayers },
        { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: {} },
        { provide: getRepositoryToken(WorkforceAttributeEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
        { provide: getRepositoryToken(AssayerRemarkEntity), useValue: {} },
        { provide: getRepositoryToken(AssayerActivityEntity), useValue: { create: jest.fn((r) => r), save: jest.fn() } },
        { provide: AuditService, useValue: audit },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        { provide: WorkflowEngine, useValue: { registerWorkflow: jest.fn() } },
        { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
        { provide: NotificationService, useValue: { notifyAssayer: jest.fn().mockResolvedValue({ inAppDelivered: true }) } },
        ...(withSms ? [{ provide: SmsService, useValue: sms }] : []),
        { provide: EmailService, useValue: emails },
        { provide: UnitOfWork, useValue: { run: (work: any) => work(undefined) } },
        { provide: getDataSourceToken(), useValue: { query: jest.fn().mockResolvedValue([]) } },
        { provide: CacheService, useValue: { del: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    return mod.get(AssayerService);
  };

  it('rejects a batch over 500 before touching a single record', async () => {
    const ids = Array.from({ length: 501 }, (_, i) => `id-${i}`);

    await expect(service.bulkIssueAppAccess(ids, ACTOR)).rejects.toBeInstanceOf(BadRequestException);
    expect(assayers.findOne).not.toHaveBeenCalled();
  });

  it('accepts exactly 500', async () => {
    // None of these ids resolve to a real person, so every one lands in `failed` via the same
    // not-found path as a single bad id below — the point here is only that 500 itself is not
    // rejected by the cap.
    const ids = Array.from({ length: 500 }, (_, i) => `id-${i}`);

    const out = await service.bulkIssueAppAccess(ids, ACTOR);

    expect(out.failed).toHaveLength(500);
  });

  it('skips a person with neither email nor phone on file, with a reason, and issues no credential', async () => {
    people.set('no-contact', person('no-contact', { email: null, phone: null }));

    const out = await service.bulkIssueAppAccess(['no-contact'], ACTOR);

    expect(out.succeeded).toEqual([]);
    expect(out.skipped).toEqual([{ id: 'no-contact', reason: expect.stringContaining('email or phone') }]);
    expect(assayers.update).not.toHaveBeenCalled();
  });

  it("isolates one id's failure from the rest of the batch", async () => {
    people.set('ok-1', person('ok-1'));
    // 'missing' is never added to `people`, so the lookup 404s for it alone.

    const out = await service.bulkIssueAppAccess(['ok-1', 'missing'], ACTOR);

    expect(out.succeeded.map((s) => s.id)).toEqual(['ok-1']);
    expect(out.failed).toEqual([{ id: 'missing', reason: expect.any(String) }]);
  });

  it('records channels per available contact method — both, email-only and phone-only', async () => {
    people.set('both', person('both', { email: 'a@x.com', phone: '9999999999' }));
    people.set('email-only', person('email-only', { email: 'b@x.com', phone: null }));
    people.set('phone-only', person('phone-only', { email: null, phone: '8888888888' }));

    const out = await service.bulkIssueAppAccess(['both', 'email-only', 'phone-only'], ACTOR);

    const channelsOf = (id: string) => out.succeeded.find((s) => s.id === id)?.channels.slice().sort();
    expect(channelsOf('both')).toEqual(['EMAIL', 'SMS']);
    expect(channelsOf('email-only')).toEqual(['EMAIL']);
    expect(channelsOf('phone-only')).toEqual(['SMS']);
    // Queued, not sent inside the loop — the SMTP round trip per person is what made a 540-person
    // run take half an hour, and a gateway round trip per person would be the same again.
    expect(emails.queue).toHaveBeenCalledTimes(2);
    expect(emails.sendNow).not.toHaveBeenCalled();
    expect(sms.queue).toHaveBeenCalledTimes(2);
    expect(sms.sendNow).not.toHaveBeenCalled();
    expect(out.succeeded.find((s) => s.id === 'both')?.emailId).toMatch(/^email-/);
    expect(out.succeeded.find((s) => s.id === 'both')?.smsId).toMatch(/^sms-/);
    expect(out.succeeded.find((s) => s.id === 'email-only')?.smsId).toBeUndefined();
  });

  it('reports progress per person, for the screen watching the background run', async () => {
    people.set('p1', person('p1'));
    people.set('p2', person('p2'));
    const progress = jest.fn();

    await service.bulkIssueAppAccess(['p1', 'p2'], ACTOR, progress);

    expect(progress).toHaveBeenCalledWith(0, 2, expect.any(String));
    expect(progress).toHaveBeenLastCalledWith(2, 2, expect.any(String));
  });

  it('reports an empty channel list, not a failure, when every delivery attempt fails', async () => {
    people.set('p1', person('p1'));
    emails.queue.mockResolvedValue({ id: null, status: 'NOT_QUEUED', to: 'person@example.com', error: 'x' });
    sms.queue.mockResolvedValue({ id: null, channel: 'SMS', status: 'NOT_QUEUED', to: '9000000000', error: 'x' });

    const out = await service.bulkIssueAppAccess(['p1'], ACTOR);

    // The credential is live either way — issueAppAccessCore already committed it — so a
    // channel failure is not a batch failure. `channels: []` is how HR sees nobody was reached.
    expect(out.succeeded).toEqual([{ id: 'p1', channels: [] }]);
    expect(out.failed).toEqual([]);
  });

  /**
   * The one that matters most: the temporary password reaches exactly two places (the email
   * request and the SMS request, both as template data) and nowhere else — not the method's return
   * value, not the summary audit row, and not any Logger call, however this run happens to fail or
   * succeed.
   */
  it('never puts the plaintext password anywhere but the two delivery calls (both queues encrypt it)', async () => {
    people.set('p1', person('p1', { email: 'p1@example.com', phone: '9999999999' }));
    let captured: string | undefined;
    let texted: string | undefined;
    emails.queue.mockImplementation(async (payload: any) => {
      captured = payload.content?.data?.temporaryPassword;
      return { id: 'email-1', status: 'QUEUED', to: payload.to };
    });
    sms.queue.mockImplementation(async (payload: any) => {
      texted = payload.content?.data?.temporaryPassword;
      return { id: 'sms-1', channel: 'SMS', status: 'QUEUED', to: payload.to };
    });

    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    const out = await service.bulkIssueAppAccess(['p1'], ACTOR);

    expect(captured).toBeTruthy();
    // One credential, the same one down both channels.
    expect(texted).toBe(captured);
    expect(JSON.stringify(out)).not.toContain(captured);
    expect(JSON.stringify(audit.recordEventSafe.mock.calls)).not.toContain(captured);
    for (const spy of [warnSpy, logSpy, errorSpy, debugSpy]) {
      for (const call of spy.mock.calls) {
        for (const arg of call) expect(String(arg)).not.toContain(captured);
      }
    }
    warnSpy.mockRestore(); logSpy.mockRestore(); errorSpy.mockRestore(); debugSpy.mockRestore();
  });

  it('writes one summary audit row for the whole run, counts only', async () => {
    people.set('p1', person('p1'));
    people.set('no-contact', person('no-contact', { email: null, phone: null }));

    await service.bulkIssueAppAccess(['p1', 'no-contact'], ACTOR);

    const summary = audit.recordEventSafe.mock.calls.map((c: any) => c[0])
      .find((e: any) => e.eventType === 'BULK_APP_ACCESS_ISSUED');
    expect(summary).toMatchObject({
      userId: ACTOR,
      metadata: expect.objectContaining({ requested: 2, succeeded: 1, skipped: 1, failed: 0, emailsQueued: 1, smsQueued: 1 }),
    });
  });

  /**
   * The text goes on the outbound ledger like the email: queued, against the person who ran the
   * batch (the receipt is readable only by them), as the registered DLT template — a text that is
   * not a registered template is refused by the operator, so there is no free-text body to build.
   */
  it('queues each credential text as the registered template, against the batch runner, and reports its receipt', async () => {
    people.set('p1', person('p1', { email: null, phone: '9822014455' }));

    const out = await service.bulkIssueAppAccess(['p1'], ACTOR);

    expect(sms.queue).toHaveBeenCalledTimes(1);
    const [request] = sms.queue.mock.calls[0];
    expect(request).toEqual({
      kind: 'APP_ACCESS_CREDENTIALS', to: '9822014455', entityType: 'ASSAYER', entityId: 'p1', requestedBy: ACTOR,
      // Their name, so the registered wording may address them by it.
      recipientName: 'Person p1',
      content: {
        template: 'app-credentials',
        data: { username: 'AS-p1', temporaryPassword: expect.stringMatching(/^[a-z]+(-[a-z]+)+\d$/), validDays: '7' },
      },
    });
    // Everything the registered wording needs, and nothing it does not.
    expect(Object.keys(request.content.data).sort()).toEqual([...SMS_TEMPLATE_REGISTRY['app-credentials'].requiredTokens].sort());
    expect(out.succeeded).toEqual([{ id: 'p1', channels: ['SMS'], smsId: 'sms-1' }]);
  });

  /**
   * The SMS service is `@Optional()` (specs build this service positionally). Without it the run
   * still issues and emails every credential — only the SMS leg is refused, and `channels` shows it.
   */
  it('refuses only the SMS leg, not the run, when the SMS service is not wired in', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const withoutSms = await build({ withSms: false });
    people.set('both', person('both', { email: 'a@x.com', phone: '9999999999' }));
    people.set('phone-only', person('phone-only', { email: null, phone: '8888888888' }));

    const out = await withoutSms.bulkIssueAppAccess(['both', 'phone-only'], ACTOR);

    expect(out.succeeded).toEqual([
      { id: 'both', channels: ['EMAIL'], emailId: 'email-1' },
      { id: 'phone-only', channels: [] },
    ]);
    expect(out.failed).toEqual([]);
    expect(assayers.update).toHaveBeenCalledTimes(2);
    expect(sms.queue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/SMS queue is not wired/i));
    warn.mockRestore();
  });

  /**
   * A queue that THROWS is not the same as a queue that answers `NOT_QUEUED`, and the difference
   * used to matter: the throw escaped past the per-person catch and landed the person in `failed`
   * — after `issueAppAccessCore` had already replaced their password. HR read "failed" against
   * somebody whose old credential had just stopped working, so a run that half-succeeded looked
   * like a run to repeat.
   */
  it('does not report a person as failed when the credential was issued but a queue threw', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    people.set('p1', person('p1', { email: 'p1@example.com', phone: '9822014455' }));
    emails.queue.mockRejectedValueOnce(new Error('smtp down'));

    const out = await service.bulkIssueAppAccess(['p1'], ACTOR);

    expect(out.failed).toEqual([]);
    expect(out.succeeded).toEqual([{ id: 'p1', channels: ['SMS'], smsId: 'sms-1' }]);
    // The credential is live either way — the password was already committed before delivery.
    expect(assayers.update).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  /** Neither the address nor the password may travel into a log line when delivery goes wrong. */
  it('logs which person a failed delivery was for, and nothing else about them', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    people.set('p1', person('p1', { email: 'p1@example.com', phone: '9822014455' }));
    emails.queue.mockRejectedValueOnce(new Error('smtp down'));

    await service.bulkIssueAppAccess(['p1'], ACTOR);

    const lines = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).toMatch(/app-access email for p1/);
    expect(lines).not.toMatch(/p1@example\.com/);
    const issued = String(sms.queue.mock.calls[0][0].content.data.temporaryPassword);
    expect(lines).not.toContain(issued);
    warn.mockRestore();
  });

  /**
   * `issueAndDeliverAppAccess` is what approving a registration calls, and it is the SAME mint and
   * the SAME delivery this bulk run uses — one implementation, two entry points. Before it existed,
   * approval minted nothing at all and mailed the new appraiser a "Sign in" button over an account
   * with `passwordHash = NULL`.
   */
  describe('issuing to one person, delivered rather than read aloud', () => {
    it('mints the credential and queues it to both of their channels', async () => {
      const out = await service.issueAndDeliverAppAccess(
        person('solo', { email: 'solo@example.com', phone: '9822014455' }) as never,
        ACTOR,
      );

      expect(out).toEqual({ channels: ['EMAIL', 'SMS'], emailId: 'email-1', smsId: 'sms-1' });
      // The same stored shape the bulk run writes: hashed, must-change, lockout cleared.
      const [, patch] = assayers.update.mock.calls[0];
      expect(patch.mustChangePassword).toBe(true);
      expect(patch.passwordHash).toEqual(expect.stringMatching(/^\$2[aby]\$/));
    });

    it('sends the registered wording exactly what it needs, and nothing it does not', async () => {
      await service.issueAndDeliverAppAccess(
        person('solo', { email: null, phone: '9822014455' }) as never,
        ACTOR,
      );

      const [request] = sms.queue.mock.calls[0];
      expect(Object.keys(request.content.data).sort())
        .toEqual([...SMS_TEMPLATE_REGISTRY['app-credentials'].requiredTokens].sort());
    });

    /**
     * The one place this deliberately differs from `bulkIssueAppAccess`, which refuses a run with
     * no email queue outright. A bulk run exists only to deliver, so delivering to nobody is a
     * pointless run worth stopping. An approval is a hiring decision that happens to send a letter,
     * and refusing it because a mail server is down would be the wrong trade — so the credential is
     * still minted and the empty `channels` is what tells the caller a handover is owed.
     */
    it('still mints a credential when the email queue is not wired in, and says nothing was sent', async () => {
      const noEmail = await Test.createTestingModule({
        providers: [
          AssayerService,
          { provide: getRepositoryToken(AssayerEntity), useValue: assayers },
          { provide: getRepositoryToken(AssayerCommercialProfileEntity), useValue: {} },
          { provide: getRepositoryToken(WorkforceAttributeEntity), useValue: { find: jest.fn().mockResolvedValue([]) } },
          { provide: getRepositoryToken(AssayerRemarkEntity), useValue: {} },
          { provide: getRepositoryToken(AssayerActivityEntity), useValue: { create: jest.fn((r) => r), save: jest.fn() } },
          { provide: AuditService, useValue: audit },
          { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
          { provide: WorkflowEngine, useValue: { registerWorkflow: jest.fn() } },
          { provide: NotificationDispatchService, useValue: { emitSafe: jest.fn() } },
          { provide: NotificationService, useValue: { notifyAssayer: jest.fn().mockResolvedValue({ inAppDelivered: true }) } },
          { provide: UnitOfWork, useValue: { run: (work: any) => work(undefined) } },
          { provide: getDataSourceToken(), useValue: { query: jest.fn().mockResolvedValue([]) } },
          { provide: CacheService, useValue: { del: jest.fn().mockResolvedValue(undefined) } },
        ],
      }).compile();

      const out = await noEmail.get(AssayerService).issueAndDeliverAppAccess(
        person('solo', { email: 'solo@example.com', phone: null }) as never,
        ACTOR,
      );

      expect(out).toEqual({ channels: [] });
      expect(assayers.update).toHaveBeenCalledTimes(1);
      // …and the bulk tool still refuses outright, so the two policies stay visibly different.
      await expect(noEmail.get(AssayerService).bulkIssueAppAccess(['solo'], ACTOR))
        .rejects.toThrow(/email queue is not wired/i);
    });
  });

  /**
   * A text that could not even be queued is not reported as sent: no `SMS` channel and no receipt,
   * so HR's "texts queued" count and the watched receipts both leave this person out.
   */
  it('reports no SMS channel and no receipt for a text that was not queued', async () => {
    people.set('p1', person('p1', { email: 'p1@example.com', phone: '9822014455' }));
    sms.queue.mockResolvedValueOnce({ id: null, channel: 'SMS', status: 'NOT_QUEUED', to: '9822014455', error: 'x' });

    const out = await service.bulkIssueAppAccess(['p1'], ACTOR);

    expect(out.succeeded).toEqual([{ id: 'p1', channels: ['EMAIL'], emailId: 'email-1' }]);
  });

  /**
   * The receipt is readable only by the person who asked for it (`OutboundMessageService.receiptFor`),
   * so an email queued without a requester is one the HR screen that ran the batch gets 404 for.
   */
  it('queues each credential email against the person who ran the batch and the assayer it is for', async () => {
    people.set('p1', person('p1', { email: 'p1@example.com' }));

    await service.bulkIssueAppAccess(['p1'], ACTOR);

    expect(emails.queue).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'APP_ACCESS_CREDENTIALS', to: 'p1@example.com', entityType: 'ASSAYER', entityId: 'p1', requestedBy: ACTOR,
      content: {
        template: 'app-credentials',
        data: expect.objectContaining({ displayName: 'Person p1', username: 'AS-p1', validDays: '7' }),
      },
    }));
  });

  /**
   * The wording is the template's now, so this renders what the service asked for the two ways it
   * can go out — the shipped HTML (with its derived text) and the built-in fallback — rather than
   * trusting a copy of the letter written into the service.
   */
  it('puts the credential in both parts of the email, so a mail client showing only the HTML still shows it', async () => {
    people.set('p1', person('p1', { phone: null }));

    await service.bulkIssueAppAccess(['p1'], ACTOR);

    const [queued] = emails.queue.mock.calls[0];
    const password = queued.content.data.temporaryPassword;
    expect(password).toMatch(/^[a-z]+(-[a-z]+)+\d$/);

    const shipped = await new EmailTemplateRenderer(new EmailTemplateLoader()).render('app-credentials', queued.content.data);
    const builtIn = EMAIL_TEMPLATE_REGISTRY['app-credentials'].fallbackRenderer(queued.content.data);
    expect(shipped.metadata.source).toBe('filesystem');
    for (const message of [shipped, builtIn]) {
      expect(message.text).toContain(password);
      expect(message.html).toContain(password);
      expect(message.html).toContain('AS-p1');
    }
  });

  /** The roster's other bulk action, run by the same background worker. */
  describe('bulkNotify', () => {
    const notify = (ids: string[], sendEmail: boolean, progress?: jest.Mock) =>
      service.bulkNotify(ids, ' Holiday ', ' Closed Monday ', sendEmail, ACTOR, progress);

    it('queues the email rather than sending it inside the loop, against the person who ran it', async () => {
      people.set('p1', person('p1', { email: 'p1@example.com' }));

      const out = await notify(['p1'], true);

      expect(emails.sendNow).not.toHaveBeenCalled();
      expect(emails.queue).toHaveBeenCalledTimes(1);
      expect(emails.queue).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'ROSTER_MESSAGE', to: 'p1@example.com',
        // The desk wrote every word, so it goes out as the branded layout, not a template.
        content: {
          subject: 'Holiday', text: 'Closed Monday',
          layout: expect.objectContaining({ title: 'Holiday', bodyLines: ['Closed Monday'] }),
        },
        entityType: 'ASSAYER', entityId: 'p1', requestedBy: ACTOR,
      }));
      expect(out.succeeded).toEqual([{ id: 'p1', channels: ['IN_APP', 'EMAIL'], emailId: 'email-1' }]);
    });

    it('emails nobody when the operator did not ask for email', async () => {
      people.set('p1', person('p1'));

      const out = await notify(['p1'], false);

      expect(emails.queue).not.toHaveBeenCalled();
      expect(emails.sendNow).not.toHaveBeenCalled();
      expect(out.succeeded).toEqual([{ id: 'p1', channels: ['IN_APP'] }]);
    });

    it('reports progress per person, for the screen watching the background run', async () => {
      people.set('p1', person('p1'));
      people.set('p2', person('p2'));
      const progress = jest.fn();

      await notify(['p1', 'p2'], true, progress);

      expect(progress.mock.calls.map((c) => [c[0], c[1]])).toEqual([[0, 2], [1, 2], [2, 2]]);
    });
  });
});
