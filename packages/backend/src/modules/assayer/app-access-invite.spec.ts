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
import { EmailProvider } from '../../infrastructure/notifications/email-provider';
import { SmsProvider } from '../../infrastructure/notifications/sms-provider';
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
        { provide: EmailProvider, useValue: { send: jest.fn().mockResolvedValue({ success: false }) } },
        { provide: SmsProvider, useValue: { send: jest.fn().mockResolvedValue(false) } },
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
});

/**
 * Issuing app access to a batch of assayers in one call, delivered by email and SMS instead of
 * read off a screen — the tool HR needed to clear the 540-of-548 backlog `issueAppAccess` above
 * was never built to reach.
 */
describe('AssayerService.bulkIssueAppAccess', () => {
  let service: AssayerService;
  let assayers: any;
  let audit: any;
  let email: any;
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
    email = { send: jest.fn().mockResolvedValue({ success: true }) };
    sms = { send: jest.fn().mockResolvedValue(true) };

    assayers = {
      // Keyed on the id in the `where` clause, unlike the single-person suite above, since a
      // batch needs to answer differently for different ids in the same run.
      findOne: jest.fn(({ where }: any) => Promise.resolve(people.get(where.id) ?? null)),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      find: jest.fn().mockResolvedValue([]),
      metadata: { findColumnWithPropertyName: () => ({ isNullable: true }) },
      manager: { query: jest.fn().mockResolvedValue([]) },
    };

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
        { provide: EmailProvider, useValue: email },
        { provide: SmsProvider, useValue: sms },
        { provide: UnitOfWork, useValue: { run: (work: any) => work(undefined) } },
        { provide: getDataSourceToken(), useValue: { query: jest.fn().mockResolvedValue([]) } },
        { provide: CacheService, useValue: { del: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();
    service = mod.get(AssayerService);
  });

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
    expect(email.send).toHaveBeenCalledTimes(2);
    expect(sms.send).toHaveBeenCalledTimes(2);
  });

  it('reports an empty channel list, not a failure, when every delivery attempt fails', async () => {
    people.set('p1', person('p1'));
    email.send.mockResolvedValue({ success: false });
    sms.send.mockResolvedValue(false);

    const out = await service.bulkIssueAppAccess(['p1'], ACTOR);

    // The credential is live either way — issueAppAccessCore already committed it — so a
    // channel failure is not a batch failure. `channels: []` is how HR sees nobody was reached.
    expect(out.succeeded).toEqual([{ id: 'p1', channels: [] }]);
    expect(out.failed).toEqual([]);
  });

  /**
   * The one that matters most: the temporary password reaches exactly two places (the email
   * body and the SMS body) and nowhere else — not the method's return value, not the summary
   * audit row, and not any Logger call, however this run happens to fail or succeed.
   */
  it('never puts the plaintext password anywhere but the two delivery calls', async () => {
    people.set('p1', person('p1', { email: 'p1@example.com', phone: '9999999999' }));
    let captured: string | undefined;
    email.send.mockImplementation(async (payload: any) => {
      captured = payload.text.match(/temporary password is (\S+)\./)?.[1];
      return { success: true };
    });

    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const debugSpy = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

    const out = await service.bulkIssueAppAccess(['p1'], ACTOR);

    expect(captured).toBeTruthy();
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
      metadata: expect.objectContaining({ requested: 2, succeeded: 1, skipped: 1, failed: 0 }),
    });
  });
});
