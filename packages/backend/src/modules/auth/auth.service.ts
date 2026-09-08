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
  BadRequestException,
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
import { SessionService } from './session.service';
import { MfaService } from './mfa.service';
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
  /**
   * The durable session id (a `user_sessions` row) this token belongs to.
   *
   * Minted at login and carried forward through every refresh, so a request can be attributed to a
   * specific session/device — which is what the per-session activity history and per-device revoke
   * need. Optional so a token issued before the session store still validates; a principal without
   * it simply has no session dimension.
   */
  sid?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** Returned by `login` when the account has a confirmed second factor: no session yet, prove MFA. */
export interface MfaChallengeResult {
  mfaRequired: true;
  challengeId: string;
  factors: string[];
}

/** Login either signs the user in (tokens + user) or demands a second factor first. */
export type LoginResult = (TokenPair & { user: any }) | MfaChallengeResult;

/**
 * Constant-time check of an entered delivered code against the SHA-256 hex hash stashed on the
 * challenge. Must match `MfaService.hashCode` (sha256 of the trimmed code); the code itself is
 * never stored, so this is the only thing to compare against.
 */
function deliveredCodeMatches(expectedHashHex: string, code: string): boolean {
  const got = crypto.createHash('sha256').update((code || '').trim()).digest('hex');
  if (!expectedHashHex || got.length !== expectedHashHex.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(got, 'hex'), Buffer.from(expectedHashHex, 'hex'));
  } catch {
    return false;
  }
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
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
    private readonly sessionService: SessionService,
    private readonly mfaService: MfaService,
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
    // Raised from 30s to 600s (10 minutes). The short TTL was there because a suspension or
    // role change must take effect quickly, but that is already guaranteed a different way:
    // every path that changes what a principal holds explicitly deletes this cache entry
    // synchronously, before its own response returns:
    //   - role edit / permission change -> invalidateRoleHolders -> user:role-changed -> here
    //   - user update (status, regions) -> UserService.updateUser -> user:updated -> here
    //   - password change / admin reset -> UserService deletes the key directly, and also
    //     revokes every refresh token so a stale session cannot even reach this cache
    //   - app-access lifecycle changes on the assayer side -> the same invalidation path
    // With that in place the TTL only bounds the worst case if an invalidation is ever missed,
    // not the normal case, so it can be sized for hit rate instead of for that worst case.
    this.principalCacheTtl = Number(this.configService.get<any>('RBAC_CACHE_TTL_SECONDS', 600));

    // Session containment (read at boot from the environment; the per-request hot path must not
    // couple to the live settings store). Idle = minutes since the last authenticated request;
    // absolute = the hard ceiling on a single sign-in, set when the session is minted and never
    // extended. Defaults match settings.registry.ts (`security.session.*`).
    // Idle defaults to 0 (OFF) so an active or merely-open session is NEVER force-logged-out
    // mid-work; an operator can raise it to expire abandoned-but-open devices. Absolute defaults to
    // 7 days — a weekly re-login at a natural boundary, not a mid-session interruption — and is the
    // ceiling that bounds an actively-used stolen session (idle cannot, since activity resets it).
    const idleMinutes = Number(this.configService.get<any>('SESSION_IDLE_TIMEOUT_MINUTES', 0));
    this.sessionIdleMs = Number.isFinite(idleMinutes) && idleMinutes > 0 ? idleMinutes * 60_000 : 0;
    const absoluteHours = Number(this.configService.get<any>('SESSION_ABSOLUTE_HOURS', 168));
    this.sessionAbsoluteMs =
      Number.isFinite(absoluteHours) && absoluteHours > 0 ? absoluteHours * 3_600_000 : 168 * 3_600_000;

    // Per-SOURCE (IP) brute-force brake — "lock the attacker, not the account". Failed sign-ins
    // from one address are counted in Redis; past a threshold that ADDRESS is refused for an
    // escalating back-off, so a flood of guesses (against any username, incl. a known one like
    // `admin`) throttles the attacker's device instead of locking the victim's account. The
    // account owner signing in from any other address is unaffected. Deliberately high enough not
    // to trip a shared office NAT under normal fumbling: a real brute-force does far more.
    this.loginIpMaxFailures = Math.max(5, Number(this.configService.get<any>('LOGIN_IP_MAX_FAILURES', 20)) || 20);
    this.loginIpFailWindowMs = Math.max(60, Number(this.configService.get<any>('LOGIN_IP_FAIL_WINDOW_SECONDS', 900)) || 900) * 1000;
    this.loginIpBlockBaseMs = Math.max(15, Number(this.configService.get<any>('LOGIN_IP_BLOCK_BASE_SECONDS', 60)) || 60) * 1000;
    this.loginIpBlockMaxMs = Math.max(60, Number(this.configService.get<any>('LOGIN_IP_BLOCK_MAX_SECONDS', 1800)) || 1800) * 1000;
  }

  /** Failed sign-ins from one IP within the window before that IP is thrown into back-off. */
  private readonly loginIpMaxFailures: number;
  private readonly loginIpFailWindowMs: number;
  private readonly loginIpBlockBaseMs: number;
  private readonly loginIpBlockMaxMs: number;

  /** Milliseconds of inactivity after which a session is refused on the next request. 0 = disabled. */
  private readonly sessionIdleMs: number;
  /** The absolute lifetime of a session in ms, stamped as `expires_at` at login and never extended. */
  private readonly sessionAbsoluteMs: number;

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

    // Fire-and-forget: boot checks that never block or fail startup.
    void this.runRbacDriftCheck();
    void this.runSystemPermissionIntegrityCheck();
  }

  /**
   * Warn on boot if the capability path (role_responsibilities -> responsibility_capabilities
   * -> capability_permissions) has ever granted something role_permissions does not also grant
   * directly.
   *
   * Both `permissionKeysHeldBy` (guards.ts) and the JWT claim built at login read ONLY
   * role.permissions — the capability path is documentation, describing why a role holds a
   * grant, not a second source of authorization (see the docblocks on ResponsibilityEntity and
   * CapabilityEntity). That is true today (verified: the capability-only count is 0 across every
   * role), but nothing stops the seed data or a future admin-UI feature from adding a
   * responsibility/capability grant without also adding the matching direct one, at which point
   * the two would silently disagree about what a role holds and nobody enforcing access would
   * ever notice, because nothing enforcing access reads that path. This just watches for that
   * and logs loudly if it ever happens; it does not change behaviour or block boot.
   */
  private async runRbacDriftCheck(): Promise<void> {
    try {
      const rows: Array<{ role_name: string; resource: string; action: string; scope: string }> =
        await this.userRepository.manager.query(`
          SELECT DISTINCT r.name AS role_name, p.resource, p.action, p.scope
          FROM roles r
          JOIN role_responsibilities rr ON rr.role_id = r.id
          JOIN responsibility_capabilities rc ON rc.responsibility_id = rr.responsibility_id
          JOIN capability_permissions cp ON cp.capability_id = rc.capability_id
          JOIN permissions p ON p.id = cp.permission_id
          WHERE NOT EXISTS (
            SELECT 1 FROM role_permissions rp
            WHERE rp.role_id = r.id AND rp.permission_id = p.id
          )
        `);
      if (rows.length > 0) {
        for (const row of rows) {
          this.logger.warn(
            `RBAC drift: role ${row.role_name} reaches ${row.resource}:${row.action}:${row.scope} ` +
            `only via the responsibility/capability path, with no matching direct role_permissions ` +
            `grant. Guards and the JWT claim ignore that path, so this role does NOT actually hold ` +
            `the permission the seed data implies it should.`,
          );
        }
      }
    } catch (err) {
      // Never let a diagnostic query prevent the service from starting.
      this.logger.warn(`RBAC drift check failed to run: ${(err as Error).message}`);
    }
  }

  /**
   * Startup integrity check: detect if any custom or non-platform role holds a SYSTEM:* permission.
   *
   * Only built-in platform system roles (ADMIN, DEVELOPER) are permitted to hold SYSTEM:*
   * permissions under any circumstances. Custom roles created in the role editor or imported
   * from external data must NEVER possess SYSTEM-level capabilities.
   * If a violation is detected, alert loudly and fail safely.
   */
  async runSystemPermissionIntegrityCheck(): Promise<void> {
    try {
      const rows: Array<{ role_name: string; resource: string; action: string; scope: string }> =
        await this.userRepository.manager.query(`
          SELECT DISTINCT r.name AS role_name, p.resource, p.action, p.scope
          FROM roles r
          JOIN role_permissions rp ON rp.role_id = r.id
          JOIN permissions p ON p.id = rp.permission_id
          WHERE UPPER(p.resource) = 'SYSTEM'
            AND r.name NOT IN ('ADMIN', 'DEVELOPER')
        `);
      if (rows.length > 0) {
        for (const row of rows) {
          this.logger.error(
            `CRITICAL SECURITY VIOLATION: Role "${row.role_name}" possesses privileged system permission ` +
            `"${row.resource}:${row.action}:${row.scope}". SYSTEM:* permissions must NEVER be granted to non-platform roles!`,
          );
        }
      }
    } catch (err) {
      this.logger.warn(`System permission integrity check failed to run: ${(err as Error).message}`);
    }
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
  ): Promise<LoginResult> {
    // Per-source brake FIRST — before any lookup or bcrypt — so a flood of guesses is refused
    // cheaply and cannot lock out the account it is aimed at. See recordSourceFailure below.
    await this.assertSourceNotBlocked(ipAddress);

    // 1. Find user by username or email in UserEntity
    const user = await this.userRepository.findOne({
      where: [
        { username: usernameOrEmail },
        { email: usernameOrEmail },
      ],
      relations: ['roles', 'roles.permissions'],
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
          tempPasswordExpiresAt: true, isActive: true,
        },
      });

      if (!assayer) {
        // Spend the same work a real password check would, so "no such account" and "wrong
        // password" take about the same time. Without this, an unknown identifier returned
        // immediately while a known one paid a full bcrypt compare (~250ms) — a timing oracle
        // that lets an attacker enumerate which usernames/assayer codes exist before guessing
        // passwords. The hash is a fixed dummy; the result is discarded.
        await bcrypt.compare(password, DUMMY_BCRYPT_HASH).catch(() => undefined);
        await this.recordSourceFailure(ipAddress);
        throw withCode(new UnauthorizedException('Invalid credentials'), AUTH_ERROR_CODES.INVALID_CREDENTIALS);
      }

      // No per-account hard lock here on purpose: it let anyone lock a known assayer code out by
      // guessing wrong a few times. Brute force is now braked per-SOURCE (assertSourceNotBlocked
      // ran at the top of login); the account's own counter below is kept only as a signal.

      // An assayer with no password set has never completed onboarding — deny access
      // rather than silently skipping verification.
      if (!assayer.passwordHash) {
        throw withCode(new UnauthorizedException('Invalid credentials'), AUTH_ERROR_CODES.INVALID_CREDENTIALS);
      }

      const isPasswordValid = await bcrypt.compare(password, assayer.passwordHash);
      if (!isPasswordValid) {
        const attempts = (assayer.failedLoginAttempts ?? 0) + 1;
        // Count it on the account as a SIGNAL (audit + the alert at the threshold), but never set
        // lockedUntil — the account must not be lockable by someone else's wrong guesses. The
        // per-source brake (recordSourceFailure) is what actually throttles the attacker.
        await this.assayerRepository
          .update(assayer.id, { failedLoginAttempts: attempts, lockedUntil: null })
          .catch(() => undefined);
        if (attempts >= 5) this.notifyAccountLocked(`Assayer ${assayer.displayName ?? assayer.assayerCode ?? assayer.id}`, assayer.id, attempts);
        await this.recordSourceFailure(ipAddress);
        throw withCode(new UnauthorizedException('Invalid credentials'), AUTH_ERROR_CODES.INVALID_CREDENTIALS);
      }

      if (!maySignIn(assayer.lifecycleStatus as AssayerLifecycleStatus)) {
        throw signInRefusal(assayer.lifecycleStatus as AssayerLifecycleStatus);
      }

      /**
       * `maySignIn` only looks at the lifecycle status, and a soft-deleted assayer's status is
       * not necessarily changed by the delete itself (a soft-deleted assayer can still sit at
       * ACTIVE in the lifecycle column while `isActive` is what the delete actually flips). This
       * check refuses a soft-deleted account even though its password and lifecycle status would
       * otherwise pass, using the same coded refusal shape as `signInRefusal` so the client
       * handles it identically to an ordinary closed account.
       */
      if (assayer.isActive === false) {
        await this.cache.del(this.principalKey(assayer.id));
        throw withCode(
          new ForbiddenException('This account is closed. If you think that is wrong, please speak to your HR contact.'),
          AUTH_ERROR_CODES.ACCOUNT_CLOSED,
        );
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
      await this.clearSourceFailures(ipAddress);

      const payload: JwtPayload = {
        sub: assayer.id,
        username: assayer.assayerCode,
        email: assayer.email || `${assayer.assayerCode.toLowerCase()}@fapoms.com`,
        roles: ['ASSAYER'],
        permissions: ['assignment:read:organization', 'assignment:update:organization'],
        organizationId: assayer.organizationId,
      };

      // MFA GATE (assayer path) — see the staff branch below. No session before the second factor.
      if (await this.mfaService.isChallengeRequired(assayer.id)) {
        return this.createMfaChallenge(assayer.id, 'ASSAYER', ipAddress, userAgent);
      }

      const session = await this.sessionService.create({
        userId: assayer.id,
        principalType: 'ASSAYER',
        ipAddress,
        userAgent,
        loginMethod: 'PASSWORD',
        // The session's ABSOLUTE lifetime — the hard ceiling, never extended by a refresh, so an
        // actively-used stolen session still dies here. Separate from (and shorter than) the
        // refresh token's own expiry.
        expiresAt: new Date(Date.now() + this.sessionAbsoluteMs),
      });
      const tokens = await this.generateTokenPair(payload, ipAddress, userAgent, session.id);

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

    // No per-account hard lock here on purpose (it let anyone lock out a known username like
    // `admin`). Brute force is braked per-SOURCE at the top of login; user.failedLoginAttempts
    // below is kept only as a signal. A genuinely SUSPENDED/DISABLED account is still refused by
    // the status check above — that path no longer fires for mere failed passwords.

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      // Count the failure on the account as a SIGNAL only — the alert at the threshold, and a
      // visible counter for incident response. Deliberately NO lockedUntil and NO status=LOCKED:
      // hard-locking the account is exactly the denial-of-service (lock out `admin` by guessing
      // wrong five times) the per-source brake replaces. recordSourceFailure throttles the IP.
      user.failedLoginAttempts += 1;
      if (user.failedLoginAttempts >= 5) {
        this.notifyAccountLocked(
          `${user.displayName ?? user.username} (${user.email})`,
          user.id,
          user.failedLoginAttempts,
        );
      }
      await this.userRepository.save(user);
      await this.recordSourceFailure(ipAddress);
      throw withCode(new UnauthorizedException('Invalid credentials'), AUTH_ERROR_CODES.INVALID_CREDENTIALS);
    }

    // Reset failed attempts on success
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    user.lastLoginAt = new Date();
    await this.userRepository.save(user);
    await this.clearSourceFailures(ipAddress);

    // MFA GATE: password is proven, but if this account has a confirmed second factor we must NOT
    // issue a session yet. Return a short-lived, single-use challenge instead; the real session is
    // minted only by `verifyMfaChallenge` after the code checks out. A no-op for everyone until they
    // enrol, so un-enrolled login is byte-identical to before.
    if (await this.mfaService.isChallengeRequired(user.id)) {
      return this.createMfaChallenge(user.id, 'USER', ipAddress, userAgent);
    }

    // Mint the durable session this sign-in belongs to; its id rides every token as `sid`.
    const session = await this.sessionService.create({
      userId: user.id,
      principalType: 'USER',
      ipAddress,
      userAgent,
      loginMethod: 'PASSWORD',
      // Absolute session ceiling — see the assayer login path above. Never extended by refresh.
      expiresAt: new Date(Date.now() + this.sessionAbsoluteMs),
    });

    // Generate tokens
    const tokens = await this.generateTokenPair(user, ipAddress, userAgent, session.id);

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
      relations: ['roles', 'roles.permissions'],
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

      // Carry the session forward — one sign-in keeps one session id across every rotation. Before
      // minting a new pair, confirm the SESSION itself is still alive (not revoked, not past its
      // absolute lifetime, not idle) — the refresh token being valid is not enough, or an
      // absolute/idle-expired session could renew forever. `touchIfUsable` checks and moves
      // last-seen forward in one atomic statement.
      const sessionId = storedToken.sessionId ?? undefined;
      if (sessionId && !(await this.sessionService.touchIfUsable(sessionId, this.sessionIdleMs))) {
        throw new UnauthorizedException('Your session has ended. Please sign in again.');
      }
      const { tokens, refreshRowId } = await this.generateTokenPairWithRow(user, ipAddress, userAgent, sessionId);

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

    // Same soft-delete check as login (see the comment there) — a refresh must not admit a
    // principal the login path would refuse. Also drop the cached principal on this path: a
    // still-valid access token issued before the delete would otherwise keep validating against
    // the cached copy for up to the cache TTL even after every refresh/login is shut.
    if (assayer.isActive === false) {
      await this.cache.del(this.principalKey(assayer.id));
      throw withCode(
        new ForbiddenException('This account is closed. If you think that is wrong, please speak to your HR contact.'),
        AUTH_ERROR_CODES.ACCOUNT_CLOSED,
      );
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

    // Carry the session forward across the rotation, as on the staff path above, and refresh its
    // last-seen. (This path also now records the refresh request's IP/UA on the new token row,
    // which the assayer branch previously left null.)
    const sessionId = storedToken.sessionId ?? undefined;
    // Refuse to renew a dead session (revoked / absolute-expired / idle) — same rule as the staff
    // path; checks and touches atomically.
    if (sessionId && !(await this.sessionService.touchIfUsable(sessionId, this.sessionIdleMs))) {
      throw new UnauthorizedException('Your session has ended. Please sign in again.');
    }
    const { tokens, refreshRowId } = await this.generateTokenPairWithRow(assayerPayload, ipAddress, userAgent, sessionId);

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
  // ---------------------------------------------------------------------------------------------
  // Per-SOURCE brute-force brake ("lock the attacker, not the account").
  //
  // Counts failed sign-ins per client IP (real client, via trust-proxy) in Redis. Past a
  // threshold the ADDRESS is refused for an escalating back-off, so a flood of guesses — against
  // any username, including a known one like `admin` — throttles the attacker's device rather than
  // hard-locking the victim's account. The account owner signing in from any other address is
  // unaffected. Fail-open: if Redis is down these are no-ops and the login path is unchanged.
  // ---------------------------------------------------------------------------------------------
  private ipFailKey(ip: string): string { return `authfail:ip:${ip}`; }
  private ipBlockKey(ip: string): string { return `authblock:ip:${ip}`; }

  /** Refuse early (before any lookup or bcrypt) if this address is currently in back-off. */
  private async assertSourceNotBlocked(ip?: string): Promise<void> {
    if (!ip) return;
    const until = await this.cache.getJson<number>(this.ipBlockKey(ip));
    if (until && until > Date.now()) {
      const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
      throw withCode(
        new ForbiddenException(
          `Too many failed sign-in attempts from this network. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        ),
        AUTH_ERROR_CODES.ACCOUNT_LOCKED,
      );
    }
  }

  /** Count a failed sign-in from this address; once over the threshold, apply escalating back-off. */
  private async recordSourceFailure(ip?: string): Promise<void> {
    if (!ip) return;
    const count = await this.cache.incrWithTtl(this.ipFailKey(ip), Math.ceil(this.loginIpFailWindowMs / 1000));
    if (count >= this.loginIpMaxFailures) {
      const overBy = count - this.loginIpMaxFailures; // 0 on the first trip, then grows
      const blockMs = Math.min(this.loginIpBlockBaseMs * 2 ** overBy, this.loginIpBlockMaxMs);
      await this.cache.setJson(this.ipBlockKey(ip), Date.now() + blockMs, Math.ceil(blockMs / 1000));
    }
  }

  /** A clean sign-in wipes this address's failure history and any back-off. */
  private async clearSourceFailures(ip?: string): Promise<void> {
    if (!ip) return;
    await this.cache.del(this.ipFailKey(ip), this.ipBlockKey(ip));
  }

  /**
   * Mint a single-use MFA challenge after a correct password. Stored in Redis (5-min TTL), keyed by
   * a random id; NO session or token exists yet. The client presents `challengeId` + a code to
   * `verifyMfaChallenge`. Nothing here identifies the account to the client beyond the opaque id.
   */
  private async createMfaChallenge(
    userId: string,
    principalType: 'USER' | 'ASSAYER',
    ipAddress?: string,
    userAgent?: string,
  ): Promise<MfaChallengeResult> {
    const challengeId = crypto.randomUUID();
    const factors = await this.mfaService.factorsFor(userId);
    await this.cache.setJson(
      `mfa:challenge:${challengeId}`,
      { userId, principalType, ip: ipAddress ?? null, ua: userAgent ?? null, attempts: 0, sends: 0, factors },
      300,
    );
    // The factors the account can satisfy. A TOTP or recovery code is entered straight into
    // /auth/mfa/verify; a delivered factor (EMAIL/SMS) needs /auth/mfa/send first to receive a code.
    return { mfaRequired: true, challengeId, factors };
  }

  /**
   * Send a login code for a DELIVERED factor (email or SMS) against an existing challenge. Kept off
   * the password step so a code is only ever sent when the user actually asks for one. Anti-abuse:
   * at most 3 sends per challenge and a 30-second cooldown between them; the code itself is bounded
   * by its own 5-minute expiry and the challenge's 5-attempt verify cap. The code's hash — never
   * the code — is stashed on the challenge for verifyMfaChallenge to check.
   */
  async sendMfaChallengeCode(challengeId: string, factor: 'EMAIL' | 'SMS'): Promise<{ sent: true; to: string }> {
    const key = `mfa:challenge:${challengeId}`;
    const chal = await this.cache.getJson<any>(key);
    if (!chal) throw withCode(new UnauthorizedException('This sign-in step has expired. Please sign in again.'), AUTH_ERROR_CODES.INVALID_CREDENTIALS);
    if (!Array.isArray(chal.factors) || !chal.factors.includes(factor)) {
      throw new BadRequestException('That verification method is not available for this account.');
    }
    const sends = (chal.sends ?? 0);
    if (sends >= 3) throw new BadRequestException('Too many codes requested. Please sign in again.');
    if (chal.lastSentAt && Date.now() - chal.lastSentAt < 30_000) {
      throw new BadRequestException('A code was just sent. Please wait a few seconds before requesting another.');
    }

    const { codeHash, expiresAt, sentTo } = await this.mfaService.sendLoginCode(chal.userId, factor);
    // Preserve the remaining TTL as best we can (challenges live 5 min); re-set at the full window
    // is acceptable because the code's own expiresAt is the real bound on the delivered code.
    await this.cache.setJson(key, {
      ...chal, sends: sends + 1, lastSentAt: Date.now(),
      deliveredFactor: factor, deliveredHash: codeHash, deliveredExpiresAt: expiresAt,
    }, 300);
    return { sent: true, to: sentTo };
  }

  /**
   * Second step of an MFA login: verify the code against the challenge and, only then, issue the
   * real session. The challenge is SINGLE-USE (deleted on success, so it cannot be replayed),
   * short-lived (5-min TTL), and attempt-capped (5) — layered over MfaService's own per-account
   * lockout. A wrong code never yields a session. Bound to the challenge's own user; the client
   * cannot substitute another account.
   */
  async verifyMfaChallenge(
    challengeId: string,
    code: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenPair & { user: any }> {
    const key = `mfa:challenge:${challengeId}`;
    const chal = await this.cache.getJson<{
      userId: string; principalType: 'USER' | 'ASSAYER'; attempts: number;
      deliveredHash?: string; deliveredExpiresAt?: number;
    }>(key);
    if (!chal) {
      throw withCode(new UnauthorizedException('This sign-in step has expired. Please sign in again.'), AUTH_ERROR_CODES.INVALID_CREDENTIALS);
    }
    const attempts = (chal.attempts ?? 0) + 1;
    if (attempts > 5) {
      await this.cache.del(key);
      throw withCode(new UnauthorizedException('Too many attempts. Please sign in again.'), AUTH_ERROR_CODES.INVALID_CREDENTIALS);
    }

    // TOTP or a recovery code goes through MfaService (with its own lockout). If that does not
    // match, and a delivered email/SMS code was sent for this challenge and has not expired, check
    // the entered code against that code's hash in constant time. Either path is a valid factor.
    let ok = await this.mfaService.verify(chal.userId, code);
    if (!ok && chal.deliveredHash && chal.deliveredExpiresAt && Date.now() < chal.deliveredExpiresAt) {
      ok = deliveredCodeMatches(chal.deliveredHash, code);
    }
    if (!ok) {
      // Record the attempt on the challenge (do NOT reset it — that would defeat the cap); the code
      // was wrong, so no session is issued and the challenge is NOT consumed until it succeeds or expires.
      await this.cache.setJson(key, { ...chal, attempts }, 300);
      throw withCode(new UnauthorizedException('That code is not valid.'), AUTH_ERROR_CODES.INVALID_CREDENTIALS);
    }

    // Correct code: single-use — consume the challenge so it can never be replayed — then issue.
    await this.cache.del(key);
    if (chal.principalType === 'ASSAYER') {
      const assayer = await this.assayerRepository.findOne({ where: { id: chal.userId } });
      if (!assayer) throw new UnauthorizedException('Account not found.');
      return this.issueAssayerSession(assayer, ipAddress, userAgent);
    }
    const user = await this.userRepository.findOne({ where: { id: chal.userId, status: UserStatus.ACTIVE }, relations: ['roles', 'roles.permissions'] });
    if (!user) throw new UnauthorizedException('Account not found or inactive.');
    return this.issueUserSession(user, ipAddress, userAgent);
  }

  /**
   * Issue a staff session + tokens after authentication has fully succeeded (password AND, where
   * enrolled, MFA). Used by the MFA-verify path. NOTE: the password-only login path still issues
   * inline above; this deliberately mirrors that shape. The web app re-reads /users/me after login,
   * so the user object here carries the essentials the client needs to route.
   */
  private async issueUserSession(user: UserEntity, ipAddress?: string, userAgent?: string): Promise<TokenPair & { user: any }> {
    const session = await this.sessionService.create({
      userId: user.id, principalType: 'USER', ipAddress, userAgent, loginMethod: 'PASSWORD',
      expiresAt: new Date(Date.now() + this.sessionAbsoluteMs),
    });
    const tokens = await this.generateTokenPair(user, ipAddress, userAgent, session.id);
    await this.auditService.recordEventSafe({
      category: EventCategory.USER, eventType: 'USER_LOGIN', entityType: 'USER',
      entityId: user.id, userId: user.id, userDisplayName: user.displayName, ipAddress: ipAddress ?? undefined,
      remarks: 'Signed in (MFA verified)',
    });
    return {
      ...tokens,
      user: {
        id: user.id, username: user.username, email: user.email, displayName: user.displayName,
        roles: user.roles, permissions: [...permissionKeysHeldBy(user)], mustChangePassword: !!user.mustChangePassword,
      },
    };
  }

  /** Issue an assayer session + tokens after password + MFA. Mirrors the assayer login return shape. */
  private async issueAssayerSession(assayer: AssayerEntity, ipAddress?: string, userAgent?: string): Promise<TokenPair & { user: any }> {
    const payload: JwtPayload = {
      sub: assayer.id, username: assayer.assayerCode,
      email: assayer.email || `${assayer.assayerCode.toLowerCase()}@fapoms.com`,
      roles: ['ASSAYER'], permissions: ['assignment:read:organization', 'assignment:update:organization'],
      organizationId: assayer.organizationId,
    };
    const session = await this.sessionService.create({
      userId: assayer.id, principalType: 'ASSAYER', ipAddress, userAgent, loginMethod: 'PASSWORD',
      expiresAt: new Date(Date.now() + this.sessionAbsoluteMs),
    });
    const tokens = await this.generateTokenPair(payload, ipAddress, userAgent, session.id);
    await this.auditService.recordEventSafe({
      category: EventCategory.USER, eventType: 'USER_LOGIN', entityType: 'ASSAYER',
      entityId: assayer.id, userId: assayer.id, userDisplayName: assayer.displayName, ipAddress: ipAddress ?? undefined,
      remarks: 'Signed in (MFA verified)',
    });
    return {
      ...tokens,
      user: {
        id: assayer.id, username: assayer.assayerCode, name: assayer.displayName, email: assayer.email,
        phone: assayer.phone, status: assayer.lifecycleStatus, mustChangePassword: !!assayer.mustChangePassword,
      },
    };
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date() },
    );
    // Drop the cached principal first (a stale access token must re-read fresh state promptly),
    // then close the durable session rows to match the tokens so the sessions/devices view and the
    // audit trail agree the sessions ended. The order between these two is not significant.
    await this.cache.del(this.principalKey(userId));
    await this.sessionService.revokeAllForUser(userId, null, 'BULK_REVOKE');
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

    // Close this user's session rows too — self-initiated, so the actor is the user themselves.
    await this.sessionService.revokeAllForUser(userId, userId, 'LOGOUT');

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
    // Hot path: this runs on every authenticated request. The underlying query joins
    // roles -> permissions, so serving it from a short-lived Redis cache is the single
    // biggest per-request saving in the system. `cache.wrap` also single-flights concurrent
    // misses of the same key into one load, so a stampede of requests for the same principal
    // right after the cache expires runs the query once, not once per request. A cache MISS (or
    // Redis being down) simply falls through to `loadPrincipal`, so correctness never depends on
    // the cache being available.
    /**
     * The per-request SESSION GATE — enforced here, before the principal cache, so it runs on
     * EVERY authenticated request rather than only on refresh. One atomic statement both checks
     * (not revoked / not past absolute expiry / not idle) and moves last-seen forward; a dead
     * session returns false and the request is refused (null principal -> 401).
     *
     * This is what makes "log out everywhere" and idle/absolute limits bite on a live access
     * token, not merely stop it renewing. Stolen-token window, stated explicitly: after a
     * revoke/logout the very next request on that session matches zero rows and fails (≈ one
     * request, not the access-token TTL); an idle session dies once activity stops; an
     * actively-used session is bounded by the absolute lifetime. Tokens minted before the session
     * store carry no `sid` and are not gated here — they expire on the short access clock.
     *
     * Deliberately NOT cached: caching this check would reintroduce the very stale-authorization
     * window it exists to remove. It is one indexed single-row UPDATE per request — the accepted
     * cost of crisp revocation.
     */
    const sessionUsable = await this.sessionService.touchIfUsable(payload.sid, this.sessionIdleMs);
    if (!sessionUsable) return null;

    const cacheKey = this.principalKey(payload.sub);
    return this.cache.wrap(cacheKey, this.principalCacheTtl, () => this.loadPrincipal(payload));
  }

  /** The database load behind `validateJwtPayload`, run on every cache miss. */
  private async loadPrincipal(payload: JwtPayload): Promise<any> {
    const user = await this.userRepository.findOne({
      where: { id: payload.sub, status: UserStatus.ACTIVE },
      relations: ['roles', 'roles.permissions'],
    });
    if (user) return user;

    const assayer = await this.assayerRepository.findOne({
      where: { id: payload.sub },
    });
    if (assayer) {
      /**
       * The per-request status gate the staff branch already has (`status: UserStatus.ACTIVE` in
       * the query above) — the assayer branch was missing it entirely.
       *
       * Login (`login`) and refresh (`refreshToken`) both refuse an assayer who is terminated,
       * resigned, suspended, inactive, archived or soft-deleted (`maySignIn` + `isActive`), and
       * the refresh path even deletes the cached principal on a soft-delete "so a still-valid
       * access token stops validating against the cached copy". But that only works if the
       * RE-LOAD then also rejects — and it did not: `loadPrincipal` returned a full ASSAYER
       * principal for ANY existing row, so a fired assayer's held access token kept returning 200
       * on every route until it expired, and clearing the cache achieved nothing. Confirmed
       * 2026-09-04: AS-01 set TERMINATED + SUSPENDED + is_active=false, cache cleared, held token
       * still 200 (re-login correctly 403). Gating here cuts the session on the very next request,
       * matching how a suspended STAFF account is already cut immediately. Onboarding stages stay
       * admitted (`maySignIn` includes them) — `JwtAuthGuard` confines those separately.
       */
      if (!maySignIn(assayer.lifecycleStatus as AssayerLifecycleStatus) || assayer.isActive === false) {
        return null;
      }
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
         * within the principal cache's TTL (`RBAC_CACHE_TTL_SECONDS`) without
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
    sessionId?: string,
  ): Promise<TokenPair> {
    const { tokens } = await this.generateTokenPairWithRow(userOrPayload, ipAddress, userAgent, sessionId);
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
    sessionId?: string,
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
      // One vocabulary: this used to compute permissions itself by walking
      // roles -> permissions AND roles -> responsibilities -> capabilities -> permissions,
      // a second copy of the rule `permissionKeysHeldBy` (guards.ts) already implements for the
      // guards themselves. Every capability-path permission is also a direct role_permissions
      // grant (verified: capability-only count is 0 across every role), so the two copies never
      // actually disagreed today. Still, a token built by one rule and checked by another is a
      // vocabulary the guard and the JWT claim could silently drift apart on, and the scope
      // widening in `permissionKeysHeldBy` (a PLATFORM grant implies every narrower scope) was
      // duplicated nowhere here at all. Delegating to the same helper the guards call means the
      // token can only ever claim what the guard would also grant.
      const permissions = [...permissionKeysHeldBy(user)];

      payload = {
        sub: user.id,
        username: user.username,
        email: user.email,
        roles,
        permissions: [...new Set(permissions)],
        organizationId: user.organizationId ?? null,
      };
    }

    // The session this token belongs to: on login the caller mints a fresh one and passes its id;
    // on refresh the caller passes the retiring token's session id, so the whole rotation chain of
    // one sign-in shares a session. A token built from a passed-in payload that already carries a
    // sid keeps it if no override is given (defence for any future caller).
    if (sessionId !== undefined) payload.sid = sessionId;

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
      sessionId: payload.sid ?? null,
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
