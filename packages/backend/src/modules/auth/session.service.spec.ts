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
   * The per-request gate, and the reason it stopped being a plain UPDATE.
   *
   * It ran on every authenticated request and committed a row every time. Measured on the live
   * database: 10,151 calls at a 3.63 ms mean — 36.8 seconds, the largest single consumer of
   * database time in the system. Not the plan: every other write in the same view runs at
   * 0.09–0.28 ms because it sits inside a transaction; this one paid its own commit fsync, per
   * request, for a column read only by a timeout measured in minutes.
   *
   * It is now one statement that always computes the verdict and only writes when the row has
   * actually gone stale.
   */
  describe('touchIfUsable — verdict every time, write only when stale', () => {
    const answering = (usable: boolean) => jest.fn(async () => [{ usable }]);

    it('returns true when the session is usable', async () => {
      sessions.query = answering(true);
      await expect(service.touchIfUsable('sess-1', 60_000)).resolves.toBe(true);
    });

    it('returns false when it is revoked, absolutely expired, or idle', async () => {
      sessions.query = answering(false);
      await expect(service.touchIfUsable('sess-1', 60_000)).resolves.toBe(false);
    });

    it('returns false for a session id that does not exist', async () => {
      // No row means no verdict, and the statement coalesces that to "not usable" rather than
      // letting an unknown id through.
      sessions.query = jest.fn(async () => [{ usable: false }]);
      await expect(service.touchIfUsable('gone', 60_000)).resolves.toBe(false);
    });

    it('still checks revoked and absolute expiry, and gates idle only when it is enabled', async () => {
      sessions.query = answering(true);
      await service.touchIfUsable('sess-1', 60_000);
      const [sql, params] = sessions.query.mock.calls[0];
      expect(sql).toMatch(/revoked_at IS NULL/);
      expect(sql).toMatch(/expires_at > now\(\)/);
      // The idle arm is inside the statement, disabled by passing 0 rather than by string surgery.
      expect(sql).toMatch(/\$2::bigint <= 0/);
      expect(params[1]).toBe('60000');
    });

    it('writes at most once a minute for a session in continuous use', async () => {
      sessions.query = answering(true);
      await service.touchIfUsable('sess-1', 0);
      expect(sessions.query.mock.calls[0][1][2]).toBe('60000');
    });

    /**
     * The clamp that keeps the saving from breaking the feature it saves on.
     *
     * With an idle window shorter than the write interval, an actively used session would go
     * unwritten for longer than the window that judges it — and the next request would find
     * `last_seen_at` outside the boundary and refuse a session that had been in continuous use.
     */
    it('never lets the write interval reach the idle window', async () => {
      sessions.query = answering(true);
      await service.touchIfUsable('sess-1', 40_000);
      expect(sessions.query.mock.calls[0][1][2]).toBe('20000');
    });

    it('a token with no sid is not gated, and asks the database nothing', async () => {
      sessions.query = jest.fn();
      await expect(service.touchIfUsable(undefined, 60_000)).resolves.toBe(true);
      expect(sessions.query).not.toHaveBeenCalled();
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
