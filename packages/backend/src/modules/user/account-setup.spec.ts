import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { createHash } from 'crypto';
import { UserService } from './user.service';
import { UserEntity } from './user.entity';
import { RoleEntity } from './role.entity';
import { PermissionEntity } from './permission.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { EmailProvider } from '../../infrastructure/notifications/email-provider';
import { UserStatus } from '@fapoms/shared';

/**
 * ADDING A COLLEAGUE USED TO MEAN INVENTING THEIR PASSWORD.
 *
 * An administrator typed one into a form and passed it on — so every account began life with a
 * credential two people knew, usually sent over a messaging app, and usually never changed. The
 * link replaces that: the person sets their own, and nobody else ever sees it.
 *
 * The link IS the credential until it is spent, so the properties below are the ones that matter.
 */
describe('the link that lets somebody set their own password', () => {
  let service: UserService;
  let saved: Partial<UserEntity>[];
  let stored: Partial<UserEntity>;
  const email = { send: jest.fn().mockResolvedValue({ success: true }) };

  const audit = { recordEvent: jest.fn(), recordEventSafe: jest.fn() };

  beforeEach(async () => {
    saved = [];
    stored = {
      id: 'u1', username: 'priya', email: 'priya@example.in', displayName: 'Priya Sharma',
      firstName: 'Priya', lastName: 'Sharma', status: UserStatus.ACTIVE,
      failedLoginAttempts: 0, lockedUntil: null, mustChangePassword: false,
      passwordSetupTokenHash: null, passwordSetupExpiresAt: null,
    } as Partial<UserEntity>;
    jest.clearAllMocks();

    const users = {
      findOne: jest.fn(async (opts: any) => {
        const wanted = opts?.where?.passwordSetupTokenHash;
        if (wanted !== undefined) return stored.passwordSetupTokenHash === wanted ? stored : null;
        return stored;
      }),
      save: jest.fn(async (u: Partial<UserEntity>) => { saved.push({ ...u }); return u; }),
      find: jest.fn(async () => []),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(UserEntity), useValue: users },
        { provide: getRepositoryToken(RoleEntity), useValue: { find: jest.fn(async () => []) } },
        { provide: getRepositoryToken(PermissionEntity), useValue: { find: jest.fn(async () => []) } },
        { provide: AuditService, useValue: audit },
        { provide: DomainEventPublisher, useValue: { publish: jest.fn() } },
        { provide: CacheService, useValue: { del: jest.fn().mockResolvedValue(undefined) } },
        { provide: EmailProvider, useValue: email },
      ],
    }).compile();
    service = module.get(UserService);
  });

  const mint = () => service.sendPasswordSetupLink('u1', 'admin-1', 'NEW_ACCOUNT');
  const tokenFrom = (link: string) => link.split('/').pop()!;

  it('stores only the hash of the link it just sent', async () => {
    const { link } = await mint();
    const token = tokenFrom(link);

    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(stored.passwordSetupTokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    // The readable token must not be anywhere in the row.
    expect(JSON.stringify(saved)).not.toContain(token);
  });

  /** An audit trail an auditor can read must not hand them a working link into somebody's account. */
  it('keeps the token out of the audit trail', async () => {
    const { link } = await mint();
    expect(JSON.stringify(audit.recordEventSafe.mock.calls)).not.toContain(tokenFrom(link));
  });

  it('emails the person, and says whether the message actually went', async () => {
    const result = await mint();
    expect(email.send).toHaveBeenCalledWith(expect.objectContaining({ to: 'priya@example.in' }));
    expect(result.emailed).toBe(true);

    email.send.mockResolvedValueOnce({ success: false });
    expect((await mint()).emailed).toBe(false);
  });

  it('refuses to mint a link for somebody with no address to send it to', async () => {
    stored.email = undefined;  // the column is nullable; the entity types it as optional
    await expect(mint()).rejects.toThrow(/no email address/i);
  });

  it('lets the holder set their own password, and clears any lockout', async () => {
    const { link } = await mint();
    stored.status = UserStatus.LOCKED;
    stored.failedLoginAttempts = 5;
    stored.lockedUntil = new Date(Date.now() + 60_000);

    const after = await service.completePasswordSetup(tokenFrom(link), 'a-decent-password-42');

    expect(after.passwordHash).toBeDefined();
    expect(after.status).toBe(UserStatus.ACTIVE);
    expect(after.failedLoginAttempts).toBe(0);
    expect(after.lockedUntil).toBeNull();
    // They chose it themselves, so there is nothing to force them to change.
    expect(after.mustChangePassword).toBe(false);
  });

  it('works exactly once', async () => {
    const { link } = await mint();
    const token = tokenFrom(link);
    await service.completePasswordSetup(token, 'a-decent-password-42');

    await expect(service.completePasswordSetup(token, 'another-password-99'))
      .rejects.toThrow(BadRequestException);
  });

  it('stops working when it expires', async () => {
    const { link } = await mint();
    stored.passwordSetupExpiresAt = new Date(Date.now() - 1000);
    expect(await service.findByPasswordSetupToken(tokenFrom(link))).toBeNull();
  });

  /** A suspended account must not be re-openable by an old link. */
  it('will not let a suspended account be set up', async () => {
    const { link } = await mint();
    stored.status = UserStatus.SUSPENDED;
    expect(await service.findByPasswordSetupToken(tokenFrom(link))).toBeNull();
  });

  it('refuses a token nobody was issued', async () => {
    expect(await service.findByPasswordSetupToken('not-a-real-token')).toBeNull();
  });

  it('holds the password to the same rules as every other staff password', async () => {
    const { link } = await mint();
    await expect(service.completePasswordSetup(tokenFrom(link), 'short'))
      .rejects.toThrow();
  });
});

/**
 * Region scope had to be set in a second visit to the edit drawer, so every territorial account
 * existed as a national one first — for as long as it took somebody to remember.
 */
describe('the regions an account is created with', () => {
  it('validates them the same way an edit does, and refuses junk', async () => {
    const { UserService: Svc } = jest.requireActual('./user.service');
    const canonical = (Svc.prototype as any).canonicalRegions;
    expect(canonical.call({}, ['NORTH'])).toEqual(['NORTH']);
    expect(canonical.call({}, [])).toBeNull();
    expect(canonical.call({}, undefined)).toBeNull();
    expect(() => canonical.call({}, ['NORTH', 'NOT_A_REGION'])).toThrow(/canonical/i);
    // The same region twice is a slip, not a second grant.
    expect(canonical.call({}, ['NORTH', 'NORTH'])).toEqual(['NORTH']);
  });
});
