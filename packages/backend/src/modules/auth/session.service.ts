import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { EventCategory } from '@fapoms/shared';
import { AuditService } from '../../core/audit/audit.service';
import { UserSessionEntity } from './user-session.entity';
import { RefreshTokenEntity } from './refresh-token.entity';
import { parseUserAgent } from './parse-user-agent';

export interface CreateSessionInput {
  userId: string;
  principalType: 'USER' | 'ASSAYER';
  ipAddress?: string;
  userAgent?: string;
  loginMethod: 'PASSWORD' | 'BIOMETRIC';
  expiresAt: Date;
}

/** The session shape returned to the sessions/devices UI — no secrets, just where and what. */
export interface SessionView {
  id: string;
  ipAddress: string | null;
  device: string | null;
  browser: string | null;
  os: string | null;
  loginMethod: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  active: boolean;
  /** True for the session the request making this call is authenticated with. */
  current: boolean;
}

/**
 * The durable session store's operations: mint a session at login, keep its last-seen fresh as it
 * refreshes, list a user's sessions for the devices screen, and revoke one device or all of them.
 *
 * Revocation is expressed here rather than only on refresh tokens because a session is the thing a
 * person recognises ("my old phone"), and revoking it must revoke exactly that session's tokens and
 * leave the others alone — which the pre-existing all-sessions logout could not do.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    @InjectRepository(UserSessionEntity)
    private readonly sessions: Repository<UserSessionEntity>,
    @InjectRepository(RefreshTokenEntity)
    private readonly refreshTokens: Repository<RefreshTokenEntity>,
    private readonly audit: AuditService,
  ) {}

  /** Mint a session at login. Returns the row, whose `id` becomes the access token's `sid`. */
  async create(input: CreateSessionInput): Promise<UserSessionEntity> {
    const parsed = parseUserAgent(input.userAgent);
    const now = new Date();
    const row = this.sessions.create({
      userId: input.userId,
      principalType: input.principalType,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      deviceBrowser: parsed.browser,
      deviceOs: parsed.os,
      deviceLabel: parsed.label,
      loginMethod: input.loginMethod,
      lastSeenAt: now,
      expiresAt: input.expiresAt,
    });
    return this.sessions.save(row);
  }

  /**
   * Move a session's last-seen forward. Called on refresh, so "last active" tracks roughly the
   * access-token lifetime without a write per request. Best-effort: a failed touch must never fail
   * the refresh it rode in on.
   */
  async touch(sessionId: string, ipAddress?: string): Promise<void> {
    if (!sessionId) return;
    try {
      await this.sessions.update(
        { id: sessionId },
        { lastSeenAt: new Date(), ...(ipAddress ? { ipAddress } : {}) },
      );
    } catch (err) {
      this.logger.warn(`Failed to touch session ${sessionId}: ${(err as Error).message}`);
    }
  }

  /**
   * The PER-REQUEST session gate — the control that makes idle/absolute limits and revocation bite
   * on every authenticated request, not merely on refresh.
   *
   * ONE atomic statement both validates and touches: it moves `last_seen_at` forward only while the
   * session is still usable — not revoked, not past its absolute `expires_at`, and seen within
   * `idleMs`. `affected === 0` means the session is dead (revoked / absolute-expired / idle-expired),
   * and the caller must refuse the request.
   *
   * Race-safety (the WHERE clause is the gate, not a prior read): two concurrent requests arriving
   * after the idle or absolute boundary both match zero rows and are both refused — a stale write
   * cannot revive an expired or revoked session, because the same predicate that would refuse the
   * request also guards the write. A revoked session stays revoked; `last_seen_at` is only ever
   * pushed forward on a row that is still alive.
   *
   * Idle is defined as time since the LAST AUTHENTICATED REQUEST (this method runs on each one).
   * `idleMs <= 0` disables the idle arm (absolute + revocation still apply). A token with no `sid`
   * (issued before the session store) has nothing to gate here and is allowed through — those expire
   * on the short access-token clock.
   */
  async touchIfUsable(sessionId: string | undefined | null, idleMs: number): Promise<boolean> {
    if (!sessionId) return true;
    const qb = this.sessions
      .createQueryBuilder()
      .update(UserSessionEntity)
      .set({ lastSeenAt: () => 'now()' })
      .where('id = :id', { id: sessionId })
      .andWhere('revoked_at IS NULL')
      .andWhere('expires_at > now()');
    if (idleMs > 0) {
      // Postgres interval arithmetic in ms, so the idle window is exact and set-side.
      qb.andWhere('last_seen_at > now() - (:idleMs || \' milliseconds\')::interval', { idleMs: String(idleMs) });
    }
    const result = await qb.execute();
    return (result.affected ?? 0) > 0;
  }

  /**
   * The read-only counterpart for the refresh path, where the caller already re-reads the row and
   * wants to know if the session is still usable before rotating a token. Same predicate as
   * `touchIfUsable`, without the write (refresh does its own `touch`).
   */
  isUsable(session: UserSessionEntity | null | undefined, idleMs: number): boolean {
    if (!session) return false;
    const now = Date.now();
    if (session.revokedAt) return false;
    if (session.expiresAt.getTime() <= now) return false;
    if (idleMs > 0 && now - session.lastSeenAt.getTime() > idleMs) return false;
    return true;
  }

  /** A user's sessions, newest first, mapped for display and marked with which one is current. */
  async listForUser(userId: string, currentSessionId?: string): Promise<SessionView[]> {
    const rows = await this.sessions.find({
      where: { userId },
      order: { lastSeenAt: 'DESC' },
      take: 200,
    });
    return rows.map((s) => this.toView(s, currentSessionId));
  }

  /** One session, if it belongs to `userId` — the ownership check the self-service revoke needs. */
  async findOwned(sessionId: string, userId: string): Promise<UserSessionEntity | null> {
    return this.sessions.findOne({ where: { id: sessionId, userId } });
  }

  async findById(sessionId: string): Promise<UserSessionEntity | null> {
    return this.sessions.findOne({ where: { id: sessionId } });
  }

  /**
   * Revoke one session: mark it revoked and revoke exactly its refresh tokens. Already-revoked
   * sessions are left as they are (idempotent). The session's live access token keeps working until
   * it expires (≤ the access-token TTL) — standard for stateless JWTs — but it can no longer be
   * refreshed, so the device is signed out within that window.
   */
  async revoke(
    sessionId: string,
    byUserId: string | null,
    reason: string,
  ): Promise<void> {
    const session = await this.sessions.findOne({ where: { id: sessionId } });
    if (!session || session.revokedAt) return;

    await this.sessions.update(
      { id: sessionId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason, revokedByUserId: byUserId },
    );
    await this.refreshTokens.update(
      { sessionId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date() },
    );

    await this.audit.recordEventSafe({
      category: EventCategory.USER,
      eventType: 'SESSION_REVOKED',
      entityType: 'USER_SESSION',
      entityId: sessionId,
      userId: byUserId ?? undefined,
      remarks: reason,
      metadata: { sessionUserId: session.userId, device: session.deviceLabel ?? undefined },
    });
  }

  /**
   * Revoke every live session for a user — the store's side of the all-sessions logout and of
   * reuse-detection. Refresh-token revocation itself is handled by the caller (AuthService already
   * revokes the user's tokens on those paths); this closes the session rows to match.
   */
  async revokeAllForUser(userId: string, byUserId: string | null, reason: string): Promise<void> {
    await this.sessions.update(
      { userId, revokedAt: IsNull() },
      { revokedAt: new Date(), revokedReason: reason, revokedByUserId: byUserId },
    );
  }

  private toView(s: UserSessionEntity, currentSessionId?: string): SessionView {
    const active = !s.revokedAt && s.expiresAt > new Date();
    return {
      id: s.id,
      ipAddress: s.ipAddress,
      device: s.deviceLabel,
      browser: s.deviceBrowser,
      os: s.deviceOs,
      loginMethod: s.loginMethod,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
      revokedReason: s.revokedReason,
      active,
      current: !!currentSessionId && s.id === currentSessionId,
    };
  }
}
