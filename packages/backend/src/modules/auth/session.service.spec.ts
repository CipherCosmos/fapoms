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
});
