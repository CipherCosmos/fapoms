import { Test } from '@nestjs/testing';
import { getRepositoryToken, getDataSourceToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { EventCategory, AssayerLifecycleStatus } from '@fapoms/shared';
import { AssayerService } from './assayer.service';
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
