import { SessionService } from './session.service';
import type { UserSessionEntity } from './user-session.entity';

/**
 * The session store's behaviour, over mocked repositories. The cases that matter for compliance and
 * safety: a mint parses the device, a revoke closes exactly that session's tokens and audits it, an
 * already-revoked session is left alone (idempotent), and the list marks the caller's current
 * session and computes active/expired correctly.
 */
describe('SessionService', () => {
  let sessions: any;
  let refreshTokens: any;
  let audit: any;
  let service: SessionService;

  beforeEach(() => {
    sessions = {
      create: jest.fn((d: any) => d),
      save: jest.fn(async (d: any) => ({ id: 'sess-new', ...d })),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    refreshTokens = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
    audit = { recordEventSafe: jest.fn().mockResolvedValue(undefined) };
    service = new SessionService(sessions, refreshTokens, audit);
  });

  it('mints a session with the device parsed from the user-agent', async () => {
    await service.create({
      userId: 'u1',
      principalType: 'USER',
      ipAddress: '203.0.113.5',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36',
      loginMethod: 'PASSWORD',
      expiresAt: new Date('2030-01-01'),
    });
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        principalType: 'USER',
        ipAddress: '203.0.113.5',
        deviceBrowser: 'Chrome',
        deviceOs: 'Windows',
        deviceLabel: 'Chrome on Windows',
        loginMethod: 'PASSWORD',
      }),
    );
  });

  it('revokes exactly the session’s tokens and writes an audit row', async () => {
    sessions.findOne.mockResolvedValue({ id: 'sess-1', userId: 'u1', revokedAt: null, deviceLabel: 'Chrome on Windows' });
    await service.revoke('sess-1', 'admin-1', 'ADMIN_REVOKED');

    expect(sessions.update).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'sess-1' }),
      expect.objectContaining({ revokedReason: 'ADMIN_REVOKED', revokedByUserId: 'admin-1' }),
    );
    // Only this session's tokens, by session_id — not the whole user.
    expect(refreshTokens.update).toHaveBeenCalledWith(
      { sessionId: 'sess-1', isRevoked: false },
      expect.objectContaining({ isRevoked: true }),
    );
    expect(audit.recordEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'SESSION_REVOKED', entityId: 'sess-1' }),
    );
  });

  it('is idempotent — an already-revoked session is left untouched', async () => {
    sessions.findOne.mockResolvedValue({ id: 'sess-1', userId: 'u1', revokedAt: new Date() });
    await service.revoke('sess-1', 'admin-1', 'ADMIN_REVOKED');
    expect(sessions.update).not.toHaveBeenCalled();
    expect(refreshTokens.update).not.toHaveBeenCalled();
    expect(audit.recordEventSafe).not.toHaveBeenCalled();
  });

  it('lists sessions, flags the current one, and computes active vs expired', async () => {
    const rows: Partial<UserSessionEntity>[] = [
      { id: 'sess-1', userId: 'u1', deviceLabel: 'Chrome', ipAddress: '1.1.1.1', loginMethod: 'PASSWORD',
        createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 1e6), revokedAt: null },
      { id: 'sess-2', userId: 'u1', deviceLabel: 'Old phone', ipAddress: '2.2.2.2', loginMethod: 'PASSWORD',
        createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() - 1e6), revokedAt: null },
    ];
    sessions.find.mockResolvedValue(rows);

    const view = await service.listForUser('u1', 'sess-1');
    expect(view[0]).toMatchObject({ id: 'sess-1', current: true, active: true });
    expect(view[1]).toMatchObject({ id: 'sess-2', current: false, active: false }); // expired
  });

  /**
   * The per-request gate. `touchIfUsable` is ONE atomic conditional UPDATE (not revoked, not past
   * absolute expiry, not idle) that also moves last-seen forward: affected>0 means usable+touched,
   * 0 means dead. `isUsable` is its read-only twin for the refresh path.
   */
  describe('touchIfUsable — atomic per-request check + touch', () => {
    const qbFor = (affected: number) => {
      const qb: any = {};
      for (const m of ['update', 'set', 'where', 'andWhere']) qb[m] = jest.fn(() => qb);
      qb.execute = jest.fn(async () => ({ affected }));
      return qb;
    };

    it('returns true and touches when the atomic update affects a row', async () => {
      const qb = qbFor(1);
      sessions.createQueryBuilder = jest.fn(() => qb);
      await expect(service.touchIfUsable('sess-1', 60_000)).resolves.toBe(true);
      // idle arm present when idleMs > 0
      expect(qb.andWhere).toHaveBeenCalledWith(expect.stringContaining('last_seen_at'), expect.anything());
      expect(qb.andWhere).toHaveBeenCalledWith(expect.stringContaining('expires_at'));
    });

    it('returns false when the update affects no row (revoked / absolute-expired / idle)', async () => {
      sessions.createQueryBuilder = jest.fn(() => qbFor(0));
      await expect(service.touchIfUsable('sess-1', 60_000)).resolves.toBe(false);
    });

    it('omits the idle predicate when idleMs is 0 (idle disabled), still checks revoked + absolute', async () => {
      const qb = qbFor(1);
      sessions.createQueryBuilder = jest.fn(() => qb);
      await service.touchIfUsable('sess-1', 0);
      const idleCalls = qb.andWhere.mock.calls.filter((c: any[]) => String(c[0]).includes('last_seen_at'));
      expect(idleCalls).toHaveLength(0);
      expect(qb.andWhere).toHaveBeenCalledWith(expect.stringContaining('expires_at'));
    });

    it('a token with no sid is not gated (returns true, no query)', async () => {
      sessions.createQueryBuilder = jest.fn();
      await expect(service.touchIfUsable(undefined, 60_000)).resolves.toBe(true);
      expect(sessions.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('isUsable — read-only twin for the refresh path', () => {
    const base = (over: Partial<UserSessionEntity> = {}): UserSessionEntity => ({
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      lastSeenAt: new Date(),
      ...over,
    } as any);

    it('true for a live session', () => expect(service.isUsable(base(), 60_000)).toBe(true));
    it('false when revoked', () => expect(service.isUsable(base({ revokedAt: new Date() }), 60_000)).toBe(false));
    it('false when past absolute expiry', () =>
      expect(service.isUsable(base({ expiresAt: new Date(Date.now() - 1) }), 60_000)).toBe(false));
    it('false when idle beyond the window', () =>
      expect(service.isUsable(base({ lastSeenAt: new Date(Date.now() - 120_000) }), 60_000)).toBe(false));
    it('idle ignored when idleMs is 0', () =>
      expect(service.isUsable(base({ lastSeenAt: new Date(Date.now() - 10 * 86_400_000) }), 0)).toBe(true));
    it('false for a null session', () => expect(service.isUsable(null, 60_000)).toBe(false));
  });
});
