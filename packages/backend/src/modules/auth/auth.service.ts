/**
 * FAPOMS — Authentication Service
 *
 * Handles login, token refresh, and logout (Part 8 §4, §16).
 *
 * Authorization flow per Part 8 §16:
 * 1. Authenticate the user
 * 2. Validate session
 * 3. Load roles
 * 4. Load permissions
 * 5-8. (Handled by guards on individual routes)
 */

import {
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, ILike, Not, IsNull } from 'typeorm';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { ConfigService } from '@nestjs/config';

import { UserEntity } from '../user/user.entity';
import { RefreshTokenEntity } from './refresh-token.entity';
import { AuditService } from '../../core/audit/audit.service';
import { AssayerEntity } from '../assayer/assayer.entity';
import { AssayerLifecycleStatus, AUTH_ERROR_CODES, EventCategory, UserStatus } from '@fapoms/shared';
import { withCode } from '../../infrastructure/http/api-error';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { permissionKeysHeldBy } from './guards';
import { businessTodayDateKey } from '@fapoms/shared';

/**
 * A real cost-12 bcrypt hash of a throwaway string, compared against on the account-not-found
 * path so that path costs the same as a genuine password check. It must match the cost factor
 * used for real passwords (12) or the timing it is meant to equalise would differ. It is never a
 * valid credential — nobody knows the plaintext and nothing checks it for correctness.
 */
const DUMMY_BCRYPT_HASH = '$2b$12$StcDs0lSbteaKXRTjYJSf.NLoQkM942PTrxyk4KjSBOQzhkTVzLvS';

/**
 * The lifecycle states an assayer may sign in from.
 *
 * ON_LEAVE is here because leave is not a withdrawal of access. Somebody on holiday still needs
 * to see when they are due back, read a message from the desk, and set their availability for
 * the weeks after — and the app is the only place any of that is visible to them. What leave
 * actually means is "do not offer them work", and that is already handled elsewhere and
 * separately: `deriveOperationalStatus` maps ON_LEAVE to INACTIVE, so the planner stops selecting
 * them the moment HR sets it. Refusing the login as well locked an employed person out over a
 * holiday and told them "Account is on_leave", which reads like a fault with their account.
 *
 * The four onboarding stages sign in too, but into a RESTRICTED session — see
 * `ONBOARDING_SIGN_IN` below. They are listed separately rather than folded in here because the
 * two groups are allowed different things, and a single list would have hidden that.
 */
const MAY_SIGN_IN: AssayerLifecycleStatus[] = [
  AssayerLifecycleStatus.ACTIVE,
  AssayerLifecycleStatus.ON_LEAVE,
];

/**
 * Stages that may sign in only to finish their own registration.
 *
 * This is the deliberate decision the note above used to ask for, not a loosened condition. The
 * phone half of registration — the assayer photographing their own Aadhaar instead of travelling
 * to the office with it — is worthless if it only unlocks after they are already active, because
 * by then the documents it was meant to collect have been collected some other way.
 *
 * What makes it safe is not this list but what the session can reach: a principal in one of these
 * stages is marked `onboarding`, and `JwtAuthGuard` refuses it on every route that is not
 * explicitly marked `@OnboardingAllowed()`. Deny-by-default, so bringing these people through the
 * door does not require having audited all nine controllers an ASSAYER role can otherwise reach —
 * and a route added tomorrow is closed to them until somebody decides otherwise.
 *
 * They still cannot be given work: deployability is `isActive && status === ACTIVE`, and the
 * derived status for every stage here is INACTIVE. Signing in is not being on duty.
 */
const ONBOARDING_SIGN_IN: AssayerLifecycleStatus[] = [
  AssayerLifecycleStatus.INVITED,
  AssayerLifecycleStatus.DOCUMENT_VERIFICATION,
  AssayerLifecycleStatus.BACKGROUND_VERIFICATION,
  AssayerLifecycleStatus.TRAINING,
];

/**
 * Either kind of session: full duty, or restricted to finishing registration.
 *
 * Exported because the app-access card has to tell HR whether the credential it is handing over
 * works at all, and answering that from a second copy of the list is how the two would drift.
 */
export function maySignIn(status: AssayerLifecycleStatus): boolean {
  return MAY_SIGN_IN.includes(status) || ONBOARDING_SIGN_IN.includes(status);
}

/** Is this a registration-only session? Drives the `onboarding` flag on the principal. */
export function isOnboardingStage(status?: string | null): boolean {
  return ONBOARDING_SIGN_IN.includes(status as AssayerLifecycleStatus);
}

/**
 * Why sign-in was refused, in words the person reading them can act on.
 *
 * This said "Account is invited" / "Account is suspended" — the enum, lower-cased. An assayer
 * standing outside a branch with a phone in their hand learns nothing from that, and "Account is
 * inactive" reads like a fault to report rather than a state somebody chose. The detail is safe
 * here: the password has already been verified two checks above, so this only ever reaches
 * somebody holding valid credentials for the account it describes.
 */
function signInRefusal(status: AssayerLifecycleStatus): ForbiddenException {
  // The four onboarding stages used to be refused here, with "your registration is not finished
  // yet". They are not refused any more — they sign in to a session confined to finishing that
  // registration (`ONBOARDING_SIGN_IN`), and the guard is what tells them where they can and
  // cannot go. That branch is gone rather than left unreachable: a refusal message nothing can
  // produce still reads as live policy to whoever finds it next.
  //
  // Returns the exception rather than the sentence so that the message and its `code` are chosen
  // in the same branch. Split across two functions they would drift the first time a lifecycle
  // state moved from one arm to the other, and a client would then act on a code describing a
  // refusal other than the one the reader is looking at.
  switch (status) {
    case AssayerLifecycleStatus.SUSPENDED:
      return withCode(
        new ForbiddenException('Your access is on hold. Please speak to your HR contact.'),
        AUTH_ERROR_CODES.ACCOUNT_ON_HOLD,
      );
    default:
      return withCode(
        new ForbiddenException('This account is closed. If you think that is wrong, please speak to your HR contact.'),
        AUTH_ERROR_CODES.ACCOUNT_CLOSED,
      );
  }
}

/**
 * The key `validateJwtPayload` caches a resolved principal under. Exported so a password-change
 * path elsewhere (currently `UserService`) can invalidate it deterministically and synchronously
 * — awaited before the HTTP response returns — rather than relying only on the fire-and-forget
 * domain-event subscription in `onModuleInit`, which does not guarantee completion before a
 * caller's very next request. See `revokeAllSessions` and the `user:password-changed` handler
 * below for the event-based path, which still exists for its other job: revoking every refresh
 * token.
 */
export function rbacPrincipalCacheKey(userId: string): string {
  return `rbac:principal:${userId}`;
}

export interface JwtPayload {
  sub: string;           // User ID
  username: string;
  email: string;
  roles: string[];
  permissions: string[];
  organizationId: string | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly accessExpiration: number;
  private readonly refreshExpiration: number;
  private readonly principalCacheTtl: number;

  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(RefreshTokenEntity)
    private readonly refreshTokenRepository: Repository<RefreshTokenEntity>,
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
    private readonly cache: CacheService,
    private readonly events: DomainEventPublisher,
    private readonly notificationDispatch: NotificationDispatchService,
  ) {
    this.accessExpiration = AuthService.expirationSeconds(
      this.configService.get<any>('JWT_ACCESS_EXPIRATION'),
      900, // 15 minutes
      'JWT_ACCESS_EXPIRATION',
    );
    this.refreshExpiration = AuthService.expirationSeconds(
      this.configService.get<any>('JWT_REFRESH_EXPIRATION'),
      604800, // 7 days
      'JWT_REFRESH_EXPIRATION',
    );
    // Short by design: this cache removes the per-request 5-join RBAC load, but a
    // suspension or role change must take effect quickly. Explicit invalidation
    // (below + on logout) makes changes near-instant; the TTL only bounds the worst
    // case if an invalidation is ever missed.
    this.principalCacheTtl = Number(this.configService.get<any>('RBAC_CACHE_TTL_SECONDS', 30));
  }

  /**
   * Keep the request-time principal cache honest. A user's status or roles changing
   * anywhere in the cluster publishes one of these events on the node that made the
   * change; because the cache lives in shared Redis, deleting the key on that node
   * clears it for every replica at once.
   */
  onModuleInit(): void {
    const invalidate = (payload: any) => {
      const id = payload?.userId || payload?.aggregateId || payload?.id;
      if (id) void this.cache.del(this.principalKey(id));
    };
    this.events.subscribe('user:updated', invalidate);
    this.events.subscribe('user:role-changed', invalidate);
    // A password change or admin reset must END every existing session — otherwise a stolen or
    // lingering refresh token keeps rotating into fresh access tokens for the full refresh TTL,
    // which defeats the entire point of changing the password after a compromise. The caller
    // (UserService) additionally drops the principal cache itself, synchronously, before its
    // response returns — see rbacPrincipalCacheKey — so this handler's own (fire-and-forget)
    // cache invalidation is a belt-and-suspenders backstop, not the only mechanism.
    this.events.subscribe('user:password-changed', (payload: any) => {
      const id = payload?.userId;
      if (id) void this.revokeAllSessions(id);
    });
  }

  private principalKey(userId: string): string {
    return rbacPrincipalCacheKey(userId);
  }

  /**
   * Authenticate user with username/email and password.
   */
  async login(
    usernameOrEmail: string,
    password: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenPair & { user: any }> {
    // 1. Find user by username or email in UserEntity
    const user = await this.userRepository.findOne({
      where: [
        { username: usernameOrEmail },
        { email: usernameOrEmail },
      ],
      relations: ['roles', 'roles.permissions', 'roles.responsibilities', 'roles.responsibilities.capabilities', 'roles.responsibilities.capabilities.permissions'],
    });
    if (user) {
      // passwordHash is `select: false` on the entity, so the relation-loaded row above does not
      // carry it. Authentication is the one read that legitimately needs it — opt back in with a
      // targeted lookup rather than making every principal read pull the hash.
      const cred = await this.userRepository.findOne({ where: { id: user.id }, select: { id: true, passwordHash: true } });
      if (cred) user.passwordHash = cred.passwordHash;
    }

    if (!user) {
      // 2. Check Assayer Master Database if not found in system users. Exact-identifier
      // match only (code, phone, or email) — no fuzzy/partial matching, and no fallback
      // to "any active assayer" when nothing matches. An unrecognized identifier must fail.
      const cleanKey = usernameOrEmail.trim();
      // passwordHash is `select: false` on the entity so it never leaves the
      // database on ordinary reads; authentication is the one place that needs it,
      // so it opts back in explicitly here.
      const assayer = await this.assayerRepository.findOne({
        where: [
          { assayerCode: ILike(cleanKey) },
          { phone: cleanKey },
          { email: ILike(cleanKey) },
        ],
        select: {
          id: true, assayerCode: true, displayName: true, email: true, phone: true,
          organizationId: true, lifecycleStatus: true, passwordHash: true,
          failedLoginAttempts: true, lockedUntil: true, mustChangePassword: true,
          tempPasswordExpiresAt: true,
        },
      });

      if (!assayer) {
        // Spend the same work a real password check would, so "no such account" and "wrong
        // password" take about the same time. Without this, an unknown identifier returned
        // immediately while a known one paid a full bcrypt compare (~250ms) — a timing oracle
        // that lets an attacker enumerate which usernames/assayer codes exist before guessing
        // passwords. The hash is a fixed dummy; the result is discarded.
        await bcrypt.compare(password, DUMMY_BCRYPT_HASH).catch(() => undefined);
        throw withCode(new UnauthorizedException('Invalid credentials'), AUTH_ERROR_CODES.INVALID_CREDENTIALS);
      }

      /**
       * Brute-force lockout, matching the staff-login branch below.
       *
       * This branch had no attempt counter at all, and the application has no rate limiting,
       * so an assayer code could be guessed against indefinitely. Combined with the bulk
       * importer's documented default password (`assayer123`, which every account it creates
       * keeps until something forces a change), a single guess per account was enough to take
       * the whole field workforce.
       */
      if (assayer.lockedUntil && assayer.lockedUntil > new Date()) {
        const minutes = Math.max(1, Math.ceil((assayer.lockedUntil.getTime() - Date.now()) / 60000));
        throw withCode(
          new ForbiddenException(
            `Too many incorrect sign-in attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
          ),
          AUTH_ERROR_CODES.ACCOUNT_LOCKED,
        );
      }

      // An assayer with no password set has never completed onboarding — deny access
      // rather than silently skipping verification.
      if (!assayer.passwordHash) {
        throw withCode(new UnauthorizedException('Invalid credentials'), AUTH_ERROR_CODES.INVALID_CREDENTIALS);
      }

      const isPasswordValid = await bcrypt.compare(password, assayer.passwordHash);
      if (!isPasswordValid) {
        const attempts = (assayer.failedLoginAttempts ?? 0) + 1;
        const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
        await this.assayerRepository
          .update(assayer.id, { failedLoginAttempts: attempts, lockedUntil })
          .catch(() => undefined);
        if (lockedUntil) this.notifyAccountLocked(`Assayer ${assayer.displayName ?? assayer.assayerCode ?? assayer.id}`, assayer.id, attempts);
        throw withCode(new UnauthorizedException('Invalid credentials'), AUTH_ERROR_CODES.INVALID_CREDENTIALS);
      }

      if (!maySignIn(assayer.lifecycleStatus as AssayerLifecycleStatus)) {
        throw signInRefusal(assayer.lifecycleStatus as AssayerLifecycleStatus);
      }

      /**
       * A temporary password stops working on the date HR was told it would.
       *
       * Issuing app access returns an `expiresAt` that HR reads out or sends on, and for a while
       * nothing compared against it — a credential an administrator chose, spoke aloud and
       * possibly wrote on paper worked for ever, while the API said otherwise in the same breath
       * as issuing it. Checked only while `mustChangePassword` is still true: once the assayer
       * has chosen their own password the expiry is cleared, so this can never shut somebody out
       * of a credential they picked. A null expiry means none applies — that is the honest state
       * for the accounts whose password predates the column, and they are not locked out for it.
       */
      if (assayer.mustChangePassword && assayer.tempPasswordExpiresAt
        && assayer.tempPasswordExpiresAt.getTime() <= Date.now()) {
        throw withCode(
          new ForbiddenException(
            'The temporary password you were given has expired. Ask your HR contact to send you a new one.',
          ),
          AUTH_ERROR_CODES.TEMPORARY_PASSWORD_EXPIRED,
        );
      }

      // Successful sign-in clears the counter.
      if (assayer.failedLoginAttempts || assayer.lockedUntil) {
        await this.assayerRepository
          .update(assayer.id, { failedLoginAttempts: 0, lockedUntil: null })
          .catch(() => undefined);
      }

      const payload: JwtPayload = {
        sub: assayer.id,
        username: assayer.assayerCode,
        email: assayer.email || `${assayer.assayerCode.toLowerCase()}@fapoms.com`,
        roles: ['ASSAYER'],
        permissions: ['assignment:read:organization', 'assignment:update:organization'],
        organizationId: assayer.organizationId,
      };

      const tokens = await this.generateTokenPair(payload, ipAddress, userAgent);

      await this.auditService.recordEventSafe({
        category: EventCategory.USER,
        eventType: 'USER_LOGIN',
        entityType: 'ASSAYER',
        entityId: assayer.id,
        userId: assayer.id,
        userDisplayName: assayer.displayName,
        ipAddress: ipAddress ?? undefined,
      });

      return {
        ...tokens,
        user: {
          id: assayer.id,
          username: assayer.assayerCode,
          name: assayer.displayName,
          email: assayer.email,
          phone: assayer.phone,
          status: assayer.lifecycleStatus,
          // The client uses this to route straight to a change-password screen. Returned
          // rather than enforced server-side at login so the user can still authenticate —
          // they need a session in order to change the password at all.
          mustChangePassword: !!assayer.mustChangePassword,
        },
      };
    }

    // Check user status — only ACTIVE users may access the platform (Part 8 §5)
    if (user.status !== UserStatus.ACTIVE) {
      throw withCode(
        new ForbiddenException(`Account is ${user.status.toLowerCase()}`),
        AUTH_ERROR_CODES.ACCOUNT_INACTIVE,
      );
    }

    // Check if account is locked
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw withCode(
        new ForbiddenException('Account is temporarily locked'),
        AUTH_ERROR_CODES.ACCOUNT_LOCKED,
      );
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      // Track failed attempts
      user.failedLoginAttempts += 1;
      if (user.failedLoginAttempts >= 5) {
        user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // Lock for 15 min
        user.status = UserStatus.LOCKED;
        this.notifyAccountLocked(
          `${user.displayName ?? user.username} (${user.email})`,
          user.id,
          user.failedLoginAttempts,
        );
      }
      await this.userRepository.save(user);
      throw withCode(new UnauthorizedException('Invalid credentials'), AUTH_ERROR_CODES.INVALID_CREDENTIALS);
    }

    // Reset failed attempts on success
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    user.lastLoginAt = new Date();
    await this.userRepository.save(user);

    // Generate tokens
    const tokens = await this.generateTokenPair(user, ipAddress, userAgent);

    // Record audit event
    await this.auditService.recordEventSafe({
      category: EventCategory.USER,
      eventType: 'USER_LOGIN',
      entityType: 'USER',
      entityId: user.id,
      userId: user.id,
      userDisplayName: user.displayName,
      ipAddress: ipAddress ?? undefined,
    });

    return {
      ...tokens,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        roles: user.roles,
        /**
         * The flat permission keys this user holds, sent so the browser can decide what to show.
         *
         * `roles` serialises to names, and a name is all the web app had. Its route table gates on
         * `SystemRole[]` — a closed set — so a role created in Admin → Roles matched no entry and
         * `canAccessRoute` returned false for every path: the person signed in successfully and
         * then had no page to land on. The API was taught to authorise by permission; without the
         * same information reaching the client, the app would keep hiding screens the server would
         * now happily serve.
         *
         * Same keys, same shape, same helper the guards use, so the two ends cannot form different
         * opinions about what somebody holds.
         */
        permissions: [...permissionKeysHeldBy(user)],
        mustChangePassword: !!user.mustChangePassword,
      },
    };
  }

  /**
   * Biometric login — the on-device Face ID/fingerprint prompt (handled entirely
   * client-side) gates whether the app attempts to redeem a refresh token that was
   * only ever issued by a prior real password login on this device. The server never
   * trusts the biometric assertion itself — it trusts the same hashed, expiry- and
   * revocation-checked refresh token used by /auth/refresh. This is why the mobile app
   * must have completed a normal login at least once before biometric login can work.
   */
  async biometricLogin(
    refreshToken: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenPair & { user: any }> {
    const { tokens, user } = await this.redeemRefreshToken(refreshToken, ipAddress, userAgent);

    await this.auditService.recordEvent({
      category: EventCategory.USER,
      eventType: 'BIOMETRIC_LOGIN',
      entityType: user.roles ? 'USER' : 'ASSAYER',
      entityId: user.id,
      userId: user.id,
      ipAddress: ipAddress ?? undefined,
    });

    return { ...tokens, user };
  }

  /**
   * Refresh an access token using a refresh token.
   * Implements token rotation — old refresh token is revoked.
   */
  async refreshAccessToken(
    refreshToken: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenPair> {
    const { tokens } = await this.redeemRefreshToken(refreshToken, ipAddress, userAgent);
    return tokens;
  }

  /**
   * Validates a refresh token (hash lookup, not revoked, not expired) and rotates it,
   * resolving the underlying System User or Assayer account. Shared by both
   * refreshAccessToken() and biometricLogin() so there is exactly one code path that
   * ever trusts a refresh token — no separate/weaker verification anywhere.
   */
  private async redeemRefreshToken(
    refreshToken: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{ tokens: TokenPair; user: any }> {
    const tokenHash = this.hashToken(refreshToken);

    // Look the token up by hash ALONE — not `isRevoked: false` — so a token that has already
    // been rotated is *found* rather than silently missed. A presented-but-revoked token is the
    // signature of theft: the legitimate holder rotated it, and now someone is replaying the old
    // one. Telling those two cases apart is the whole point of detecting reuse (below), and a
    // WHERE that filters out revoked rows made them indistinguishable from a random bad token.
    const storedToken = await this.refreshTokenRepository.findOne({
      where: { tokenHash },
    });

    if (!storedToken) {
      throw withCode(new UnauthorizedException('Invalid or expired refresh token'), AUTH_ERROR_CODES.SESSION_EXPIRED);
    }

    if (storedToken.expiresAt <= new Date()) {
      throw withCode(new UnauthorizedException('Invalid or expired refresh token'), AUTH_ERROR_CODES.SESSION_EXPIRED);
    }

    if (storedToken.isRevoked) {
      /**
       * A revoked token was presented. Two innocent-vs-hostile cases, told apart by time.
       *
       * INNOCENT (a race): two tabs or a retry redeem the same token within moments of each
       * other. The first rotates it; the second arrives just after and finds it revoked. This is
       * ordinary and must not punish anyone, so within a short grace window we simply refuse this
       * one request and leave every other session alone.
       *
       * HOSTILE (replay): a token revoked a while ago is being redeemed again — the classic
       * stolen-refresh-token replay, where the thief and the victim now both hold a chain
       * descending from the same token. We cannot tell which of them is which, so the only safe
       * move is to revoke the ENTIRE family for that user: both the thief's chain and the
       * victim's die, the victim simply logs in again, and the thief's persistent access is cut.
       * An audit event is raised so a human can see it happened.
       */
      const revokedMsAgo = Date.now() - (storedToken.revokedAt?.getTime() ?? 0);
      const graceMs = Number(process.env.REFRESH_REUSE_GRACE_MS) || 30_000;
      if (revokedMsAgo > graceMs) {
        await this.handleRefreshTokenReuse(storedToken, ipAddress, userAgent);
      }
      throw withCode(new UnauthorizedException('Invalid or expired refresh token'), AUTH_ERROR_CODES.SESSION_EXPIRED);
    }

    // Load user with roles
    const user = await this.userRepository.findOne({
      where: { id: storedToken.userId },
      relations: ['roles', 'roles.permissions', 'roles.responsibilities', 'roles.responsibilities.capabilities', 'roles.responsibilities.capabilities.permissions'],
    });

    if (user) {
      if (user.status !== UserStatus.ACTIVE) {
        throw withCode(
          new UnauthorizedException('User account is not active'),
          AUTH_ERROR_CODES.ACCOUNT_INACTIVE,
        );
      }

      storedToken.isRevoked = true;
      storedToken.revokedAt = new Date();
      await this.refreshTokenRepository.save(storedToken);

      const { tokens, refreshRowId } = await this.generateTokenPairWithRow(user, ipAddress, userAgent);

      // Point at the successor ROW, never store its secret. See generateTokenPairWithRow.
      storedToken.replacedBy = refreshRowId;
      await this.refreshTokenRepository.save(storedToken);

      return {
        tokens,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          displayName: user.displayName,
          roles: user.roles,
          // The biometric path resumes a session without a password ever being typed, so the
          // client learns about a pending forced change ONLY from this response — omit it and
          // the app walks straight into a wall of 403s with no screen telling it why.
          mustChangePassword: !!user.mustChangePassword,
        },
      };
    }

    const assayer = await this.assayerRepository.findOne({
      where: { id: storedToken.userId },
    });
    if (!assayer) {
      throw withCode(
        new UnauthorizedException('Account is not active'),
        AUTH_ERROR_CODES.ACCOUNT_INACTIVE,
      );
    }
    // The same rule as sign-in, deliberately. A refresh that refuses a principal the login
    // accepts does not keep anybody out — it lets them in and then ejects them, because the
    // mobile client treats a failed refresh as session death and clears the stored session. So a
    // narrower rule here would have signed somebody on leave in and logged them out again at the
    // first token expiry, which reads as the app being broken rather than as a policy.
    if (!maySignIn(assayer.lifecycleStatus as AssayerLifecycleStatus)) {
      throw signInRefusal(assayer.lifecycleStatus as AssayerLifecycleStatus);
    }

    const assayerPayload: JwtPayload = {
      sub: assayer.id,
      username: assayer.assayerCode,
      email: assayer.email || `${assayer.assayerCode.toLowerCase()}@fapoms.com`,
      roles: ['ASSAYER'],
      permissions: ['assignment:read:organization', 'assignment:update:organization'],
      organizationId: assayer.organizationId,
    };

    storedToken.isRevoked = true;
    storedToken.revokedAt = new Date();
    await this.refreshTokenRepository.save(storedToken);

    const { tokens, refreshRowId } = await this.generateTokenPairWithRow(assayerPayload);

    // Point at the successor ROW, never store its secret. See generateTokenPairWithRow.
    storedToken.replacedBy = refreshRowId;
    await this.refreshTokenRepository.save(storedToken);

    return {
      tokens,
      user: {
        id: assayer.id,
        username: assayer.assayerCode,
        name: assayer.displayName,
        email: assayer.email,
        phone: assayer.phone,
        status: assayer.lifecycleStatus,
        // Same reason as the staff branch above: biometric login redeems a token with no
        // password step, so this response is the client's only cue to open the change-password
        // screen instead of the schedule. The guard enforces either way; this keeps the app
        // able to explain it.
        mustChangePassword: !!assayer.mustChangePassword,
      },
    };
  }

  /**
   * Delete refresh tokens that can no longer authenticate anything.
   *
   * ## Why this exists
   *
   * `redeemRefreshToken` rotates on every use: it revokes the presented row and inserts a new one.
   * With a ~15-minute access token and a 7-day refresh TTL that is roughly 96 rows per device per
   * day, and until now **nothing ever deleted one**. Every refresh reads this table by
   * `token_hash`, so the cost of a login session was being paid, forever, by every future login
   * session. The audit of 2026-08-16 found 465 rows on a development database that has had a
   * handful of real users.
   *
   * ## Why `expires_at` is the whole predicate
   *
   * "Expired or long-revoked" collapses into one condition here, and deliberately so. A revoked
   * token still carries the `expires_at` it was issued with, which is at most one refresh TTL in
   * the future — so sweeping on expiry reclaims every revoked row within a week of its revocation
   * anyway, using the index that already exists (`IDX_ba3bd69c8ad1e799c0256e9e50`), with no second
   * predicate and no second index on `revoked_at` to maintain on the token-issue path.
   *
   * Keeping a revoked-but-unexpired row for those few days is not a cost, it is the point: it is
   * the only record that a session existed on that device with that IP and user-agent, and it is
   * what "when did this account last authenticate, and from where?" is answered from after a
   * logout. Deleting it the moment it is revoked would erase that.
   *
   * ## Why it is batched
   *
   * `LIMIT` inside the subquery so each call is one bounded statement — the first sweep after this
   * ships has the entire history of the deployment behind it, and a single unbounded DELETE over
   * that would take a lock and accumulate WAL for as long as it ran. The caller
   * (`RetentionService`) loops until a short batch tells it the table is drained.
   *
   * @param graceDays how long past expiry to keep a token. 0 deletes the moment it expires.
   * @param batchSize maximum rows to delete in this one statement.
   * @returns how many rows this call removed.
   */
  async pruneRefreshTokens(graceDays = 2, batchSize = 5_000): Promise<number> {
    const cutoff = new Date(Date.now() - Math.max(0, graceDays) * 86_400_000);

    /**
     * `ORDER BY expires_at` is not cosmetic — it is what makes the planner walk the `expires_at`
     * index for exactly `batchSize` entries instead of sequentially scanning the table and
     * top-N sorting it. Measured against 1,000,000 tokens on a scratch clone: 131 buffers.
     */
    const result = await this.refreshTokenRepository.query(
      `DELETE FROM refresh_tokens WHERE id IN (
         SELECT id FROM refresh_tokens
          WHERE expires_at < $1
          ORDER BY expires_at
          LIMIT $2
       )`,
      [cutoff, batchSize],
    );

    // node-postgres reports the row count on the command result; TypeORM surfaces it as the
    // second element of the tuple for a raw DELETE.
    return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
  }

  /**
   * Revoke every live refresh token for a user and drop their cached principal.
   *
   * The single place that ends all of a user's sessions at once. Logout uses its own inline
   * version for the ordinary case (and records a logout audit event); reuse-detection and the
   * `user:password-changed` handler use this one for the security case, where the point is
   * precisely that a session the user no longer controls must stop working. Dropping the
   * principal cache matters just as much as revoking the tokens: a stale cached principal would
   * let the old access token keep resolving its permissions — including a stale
   * `mustChangePassword: false` — until the cache TTL expired.
   */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date() },
    );
    await this.cache.del(this.principalKey(userId));
  }

  /**
   * A refresh token that was already rotated has been presented again outside the race window.
   *
   * Treated as theft: kill the whole family so neither the legitimate holder's chain nor the
   * attacker's survives, and record it so a human can see it happened. The victim is signed out
   * of everything and logs in again — a small, one-time cost that is the correct response to
   * "someone else is holding your token".
   */
  private async handleRefreshTokenReuse(
    storedToken: RefreshTokenEntity,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    await this.revokeAllSessions(storedToken.userId);
    await this.auditService.recordEvent({
      // USER rather than a new SECURITY category: the audit_events.category column documents
      // exactly four values and downstream readers switch on them, so this rides the existing
      // set. The eventType is what makes it findable as a security event.
      category: EventCategory.USER,
      eventType: 'REFRESH_TOKEN_REUSE_DETECTED',
      entityType: 'USER',
      entityId: storedToken.userId,
      userId: storedToken.userId,
      ipAddress: ipAddress ?? undefined,
      metadata: { userAgent: userAgent ?? undefined, revokedTokenId: storedToken.id },
    });
  }

  /**
   * Logout — revoke all refresh tokens for the user.
   */
  async logout(userId: string, ipAddress?: string): Promise<void> {
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date() },
    );

    // Drop the cached principal so a re-auth after logout re-reads fresh state.
    await this.cache.del(this.principalKey(userId));

    await this.auditService.recordEvent({
      category: EventCategory.USER,
      eventType: 'USER_LOGOUT',
      entityType: 'USER',
      entityId: userId,
      userId,
      ipAddress: ipAddress ?? undefined,
    });
  }

  /**
   * Validate a JWT payload and return the user.
   */
  /**
   * Exact-identifier existence check for the pre-login screen. Returns only the
   * display name — never contact details, banking data or the password hash.
   */
  async verifyAssayerIdentifier(
    identifier: string,
  ): Promise<{ displayName: string; assayerCode: string; needsAppAccess?: boolean } | null> {
    const key = (identifier || '').trim();
    if (!key) return null;
    const assayer = await this.assayerRepository.findOne({
      where: [{ assayerCode: ILike(key) }, { phone: key }, { email: ILike(key) }],
      select: { id: true, displayName: true, assayerCode: true, lifecycleStatus: true },
    });
    // Also the sign-in rule, and this one gates the step BEFORE the password: the app confirms an
    // identifier and shows the person's name, then asks for their password. Answering null here
    // for somebody the login would accept makes the account look non-existent and they never
    // reach the password field at all — so a wider rule at the login itself would have been
    // unreachable for exactly the people it was widened for.
    if (!assayer || !maySignIn(assayer.lifecycleStatus as AssayerLifecycleStatus)) return null;

    /**
     * Recognised, but with no credential to check — say so rather than waving them onward.
     *
     * Counted over exactly the population `maySignIn` above admits — ACTIVE and ON_LEAVE plus the
     * four onboarding stages, 627 of the 1,163 imported assayers — 619 of them have no
     * `password_hash` at all: they arrived on a roster sheet and have never had app access
     * issued (the INVITED lifecycle is an onboarding stage, not a credential — eight accounts in
     * the entire table hold one). This step confirmed the identifier and returned their real name
     * for every one of them, and the password step then always answered "Invalid credentials" —
     * so the app greeted somebody by name and then told them their password was wrong, for an
     * account that has never had one. They have nothing to correct and no way to learn that from
     * the screen; the honest answer is that access has not been issued yet.
     *
     * The figure is stated against that rule because it moves with it: while only ACTIVE and
     * ON_LEAVE could sign in it was 540 of 548, and widening the rule added the 79 INVITED
     * people — every one of them credential-less, and precisely the population this branch
     * exists for, since before the widening they were told no such account existed.
     *
     * `password_hash` is `select: false` on the entity, so it takes an explicit count rather than
     * riding along on the query above — and deliberately not `addSelect`, which would pull the
     * hash into a response that is served to an unauthenticated caller.
     */
    const hasCredential = await this.assayerRepository.count({
      where: { id: assayer.id, passwordHash: Not(IsNull()) },
    });
    if (!hasCredential) {
      return { displayName: assayer.displayName, assayerCode: assayer.assayerCode, needsAppAccess: true };
    }

    return { displayName: assayer.displayName, assayerCode: assayer.assayerCode };
  }

  async validateJwtPayload(payload: JwtPayload): Promise<any> {
    // Hot path: this runs on every authenticated request. The underlying query
    // eager-loads roles → permissions → responsibilities → capabilities →
    // permissions (a five-way join), so serving it from a short-lived Redis cache
    // is the single biggest per-request saving in the system. A cache MISS (or Redis
    // being down) simply falls through to the database, so correctness never depends
    // on the cache being available.
    const cacheKey = this.principalKey(payload.sub);
    const cached = await this.cache.getJson<any>(cacheKey);
    if (cached) return cached;

    const user = await this.userRepository.findOne({
      where: { id: payload.sub, status: UserStatus.ACTIVE },
      relations: ['roles', 'roles.permissions', 'roles.responsibilities', 'roles.responsibilities.capabilities', 'roles.responsibilities.capabilities.permissions'],
    });
    if (user) {
      await this.cache.setJson(cacheKey, user, this.principalCacheTtl);
      return user;
    }

    const assayer = await this.assayerRepository.findOne({
      where: { id: payload.sub },
    });
    if (assayer) {
      const principal = {
        id: assayer.id,
        username: assayer.assayerCode,
        displayName: assayer.displayName,
        /**
         * Carried so `JwtAuthGuard` can enforce forced rotation on assayer principals too.
         *
         * This principal did not carry the flag, so the guard's check never fired for field
         * accounts — an assayer still holding an HR-issued temporary password (the bulk import
         * seeded `assayer123` across the workforce, and every staff reset sets the flag) could
         * use the whole API from a curl script or a stale session while only the app's UI asked
         * them to change it. Staff principals were already enforced; the field workforce is now
         * held to the same rule. Fresh on every cache MISS, and both password-change paths
         * (`changeOwnPassword`, `resetPasswordByStaff`) delete the cached principal, so the flag
         * clears — or raises — within one request of the change rather than one cache TTL.
         */
        mustChangePassword: !!assayer.mustChangePassword,
        /**
         * Marks a session that exists only to finish this person's own registration.
         *
         * `JwtAuthGuard` refuses an onboarding principal on every route not marked
         * `@OnboardingAllowed()`, so the restriction is enforced once here rather than per
         * controller. Read from the row on every cache miss, so HR activating somebody clears it
         * within the principal cache's TTL (`RBAC_CACHE_TTL_SECONDS`, 30s by default) without
         * anyone signing out — worth knowing, because the failure it bounds is a newly activated
         * assayer briefly still being told to finish registering.
         */
        onboarding: isOnboardingStage(assayer.lifecycleStatus),
        roles: [{
          name: 'ASSAYER',
          permissions: (payload.permissions || []).map(p => {
            const [resource, action, scope] = p.split(':');
            return { resource, action, scope };
          }),
        }],
      };
      await this.cache.setJson(cacheKey, principal, this.principalCacheTtl);
      return principal;
    }

    return null;
  }

  /**
   * Verify an access token and return its payload.
   */
  async verifyJwtToken(token: string): Promise<JwtPayload | null> {
    try {
      return this.jwtService.verify<JwtPayload>(token);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async generateTokenPair(
    userOrPayload: UserEntity | JwtPayload,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenPair> {
    const { tokens } = await this.generateTokenPairWithRow(userOrPayload, ipAddress, userAgent);
    return tokens;
  }

  /**
   * As `generateTokenPair`, but also returns the id of the `refresh_tokens` row it just wrote.
   *
   * The rotation path needs that id so it can record the SUCCESSOR of the token it is retiring
   * in `replaced_by` — a pointer to a row, which is what that column has always been typed as
   * (`uuid`). It must not put the successor's raw secret there: the raw refresh token is a
   * bearer credential, and writing the *current, still-valid* one in cleartext into the
   * predecessor row defeats the hashing on every other write — anyone who could read the table
   * (a DB backup, a read replica, a support export) could lift the newest `replaced_by` per user
   * and redeem it with no password. The secret now exists only as its sha256 hash in
   * `token_hash`, exactly like every other row.
   */
  private async generateTokenPairWithRow(
    userOrPayload: UserEntity | JwtPayload,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{ tokens: TokenPair; refreshRowId: string }> {
    let payload: JwtPayload;
    let userId: string;

    if ('sub' in userOrPayload) {
      payload = userOrPayload;
      userId = userOrPayload.sub;
    } else {
      const user = userOrPayload;
      userId = user.id;
      const roles = user.roles ? user.roles.map((r) => r.name) : [];
      const directPerms = user.roles ? user.roles.flatMap((r) => r.permissions || []) : [];
      const responsibilityPerms = user.roles
        ? user.roles.flatMap((r) =>
            (r.responsibilities || []).flatMap((resp) =>
              (resp.capabilities || []).flatMap((cap) => cap.permissions || []),
            ),
          )
        : [];
      const allPerms = [...directPerms, ...responsibilityPerms];
      const permissions = allPerms.map((p) => `${p.resource}:${p.action}:${p.scope}`);

      payload = {
        sub: user.id,
        username: user.username,
        email: user.email,
        roles,
        permissions: [...new Set(permissions)],
        organizationId: user.organizationId ?? null,
      };
    }

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.accessExpiration,
    });

    // Generate refresh token
    const refreshToken = uuidv4();
    const tokenHash = this.hashToken(refreshToken);

    // Store refresh token
    const refreshTokenEntity = this.refreshTokenRepository.create({
      userId: userId,
      tokenHash,
      expiresAt: new Date(Date.now() + this.refreshExpiration * 1000),
      ipAddress: ipAddress ?? null,
      userAgent: userAgent ?? null,
    });
    await this.refreshTokenRepository.save(refreshTokenEntity);

    return {
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: this.accessExpiration,
      },
      refreshRowId: refreshTokenEntity.id,
    };
  }

  /**
   * Token lifetime in SECONDS, from either a plain number of seconds or a `15m`/`7d` timespan.
   *
   * This used to be a bare `Number(...)`, and `Number('15m')` is NaN. Nothing checked, so the NaN
   * travelled all the way to `jwtService.sign({ expiresIn: NaN })` and surfaced as a 500 on every
   * single login: `"expiresIn" should be a number of seconds or string representing a timespan`.
   * The refresh side failed even more quietly — `NaN * 1000` made every `expiresAt` an Invalid Date.
   *
   * What made it costly is that `.env.production.example` shipped `JWT_ACCESS_EXPIRATION=15m` and
   * `JWT_REFRESH_EXPIRATION=7d`. A deployment configured exactly as documented could authenticate
   * nobody, while a developer machine using the raw seconds worked perfectly — so it could only
   * ever be found on a real deploy, and it looked like a code bug rather than a config one.
   *
   * Both spellings are accepted now, and the value can no longer be NaN: anything unusable falls
   * back to the default and says so at boot, instead of being discovered one failed login later.
   */
  private static expirationSeconds(raw: unknown, fallback: number, name: string): number {
    if (raw === undefined || raw === null || raw === '') return fallback;

    const text = String(raw).trim();

    // Plain seconds: "900". Also the shape ConfigService returns for a numeric default.
    if (/^\d+$/.test(text)) {
      const seconds = Number(text);
      if (seconds > 0) return seconds;
    }

    // Timespan: "30s", "15m", "2h", "7d", "1w" — the format the env template documents.
    const units: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
    const match = /^(\d+)\s*([smhdw])$/i.exec(text);
    if (match) {
      const value = Number(match[1]) * units[match[2].toLowerCase()];
      if (value > 0) return value;
    }

    new Logger(AuthService.name).warn(
      `${name}="${text}" is not a number of seconds or a timespan like 15m / 7d. ` +
        `Falling back to ${fallback}s. Fix it in .env.docker.`,
    );
    return fallback;
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Tells the admins an account just locked itself out.
   *
   * Lockouts used to be completely silent — the account flipped and the first anyone heard
   * was the owner phoning in. One notification per account per business day: a brute-force
   * run relocks the same account every 15 minutes, and thirty copies of the same fact teach
   * people to stop reading it. Fire-and-forget, because failing to notify must never change
   * the login path's behaviour.
   */
  private notifyAccountLocked(accountLabel: string, accountId: string, attempts: number): void {
    this.notificationDispatch.emitSafe({
      type: 'ACCOUNT_LOCKED',
      entityType: 'ACCOUNT',
      entityId: accountId,
      dedupeKey: `ACCOUNT_LOCKED:${accountId}:${businessTodayDateKey()}`,
      payload: { accountLabel, attempts },
    });
  }
}
