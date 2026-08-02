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
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, ILike } from 'typeorm';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { ConfigService } from '@nestjs/config';

import { UserEntity } from '../user/user.entity';
import { RefreshTokenEntity } from './refresh-token.entity';
import { AuditService } from '../../core/audit/audit.service';
import { AssayerEntity } from '../assayer/assayer.entity';
import { EventCategory, UserStatus } from '@fapoms/shared';

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
export class AuthService {
  private readonly accessExpiration: number;
  private readonly refreshExpiration: number;

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
  ) {
    this.accessExpiration = Number(this.configService.get<any>(
      'JWT_ACCESS_EXPIRATION',
      900, // 15 minutes
    ));
    this.refreshExpiration = Number(this.configService.get<any>(
      'JWT_REFRESH_EXPIRATION',
      604800, // 7 days
    ));
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
    let user = await this.userRepository.findOne({
      where: [
        { username: usernameOrEmail },
        { email: usernameOrEmail },
      ],
      relations: ['roles', 'roles.permissions', 'roles.responsibilities', 'roles.responsibilities.capabilities', 'roles.responsibilities.capabilities.permissions'],
    });

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
        },
      });

      if (!assayer) {
        throw new UnauthorizedException('Invalid credentials');
      }

      // An assayer with no password set has never completed onboarding — deny access
      // rather than silently skipping verification.
      if (!assayer.passwordHash) {
        throw new UnauthorizedException('Invalid credentials');
      }

      const isPasswordValid = await bcrypt.compare(password, assayer.passwordHash);
      if (!isPasswordValid) {
        throw new UnauthorizedException('Invalid credentials');
      }

      if (assayer.lifecycleStatus !== 'ACTIVE') {
        throw new ForbiddenException(`Account is ${String(assayer.lifecycleStatus).toLowerCase()}`);
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

      await this.auditService.recordEvent({
        category: EventCategory.USER,
        eventType: 'USER_LOGIN',
        entityType: 'ASSAYER',
        entityId: assayer.id,
        userId: assayer.id,
        userDisplayName: assayer.displayName,
        ipAddress: ipAddress ?? undefined,
      }).catch(() => {});

      return {
        ...tokens,
        user: {
          id: assayer.id,
          username: assayer.assayerCode,
          name: assayer.displayName,
          email: assayer.email,
          phone: assayer.phone,
          status: assayer.lifecycleStatus,
        },
      };
    }

    // Check user status — only ACTIVE users may access the platform (Part 8 §5)
    if (user.status !== UserStatus.ACTIVE) {
      throw new ForbiddenException(`Account is ${user.status.toLowerCase()}`);
    }

    // Check if account is locked
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new ForbiddenException('Account is temporarily locked');
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
    if (!isPasswordValid) {
      // Track failed attempts
      user.failedLoginAttempts += 1;
      if (user.failedLoginAttempts >= 5) {
        user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000); // Lock for 15 min
        user.status = UserStatus.LOCKED;
      }
      await this.userRepository.save(user);
      throw new UnauthorizedException('Invalid credentials');
    }

    // Reset failed attempts on success
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    user.lastLoginAt = new Date();
    await this.userRepository.save(user);

    // Generate tokens
    const tokens = await this.generateTokenPair(user, ipAddress, userAgent);

    // Record audit event
    await this.auditService.recordEvent({
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
    }).catch(() => {});

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

    const storedToken = await this.refreshTokenRepository.findOne({
      where: {
        tokenHash,
        isRevoked: false,
        expiresAt: MoreThan(new Date()),
      },
    });

    if (!storedToken) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // Load user with roles
    const user = await this.userRepository.findOne({
      where: { id: storedToken.userId },
      relations: ['roles', 'roles.permissions', 'roles.responsibilities', 'roles.responsibilities.capabilities', 'roles.responsibilities.capabilities.permissions'],
    });

    if (user) {
      if (user.status !== UserStatus.ACTIVE) {
        throw new UnauthorizedException('User account is not active');
      }

      storedToken.isRevoked = true;
      storedToken.revokedAt = new Date();
      await this.refreshTokenRepository.save(storedToken);

      const tokens = await this.generateTokenPair(user, ipAddress, userAgent);

      storedToken.replacedBy = tokens.refreshToken;
      await this.refreshTokenRepository.save(storedToken);

      return {
        tokens,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          displayName: user.displayName,
          roles: user.roles,
        },
      };
    }

    const assayer = await this.assayerRepository.findOne({
      where: { id: storedToken.userId },
    });
    if (!assayer) {
      throw new UnauthorizedException('Account is not active');
    }
    if (assayer.lifecycleStatus !== 'ACTIVE') {
      throw new ForbiddenException('Assayer account is not active');
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

    const tokens = await this.generateTokenPair(assayerPayload);

    storedToken.replacedBy = tokens.refreshToken;
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
      },
    };
  }

  /**
   * Logout — revoke all refresh tokens for the user.
   */
  async logout(userId: string, ipAddress?: string): Promise<void> {
    await this.refreshTokenRepository.update(
      { userId, isRevoked: false },
      { isRevoked: true, revokedAt: new Date() },
    );

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
  async verifyAssayerIdentifier(identifier: string): Promise<{ displayName: string; assayerCode: string } | null> {
    const key = (identifier || '').trim();
    if (!key) return null;
    const assayer = await this.assayerRepository.findOne({
      where: [{ assayerCode: ILike(key) }, { phone: key }, { email: ILike(key) }],
      select: { id: true, displayName: true, assayerCode: true, lifecycleStatus: true },
    });
    if (!assayer || assayer.lifecycleStatus !== 'ACTIVE') return null;
    return { displayName: assayer.displayName, assayerCode: assayer.assayerCode };
  }

  async validateJwtPayload(payload: JwtPayload): Promise<any> {
    const user = await this.userRepository.findOne({
      where: { id: payload.sub, status: UserStatus.ACTIVE },
      relations: ['roles', 'roles.permissions', 'roles.responsibilities', 'roles.responsibilities.capabilities', 'roles.responsibilities.capabilities.permissions'],
    });
    if (user) return user;

    const assayer = await this.assayerRepository.findOne({
      where: { id: payload.sub },
    });
    if (assayer) {
      return {
        id: assayer.id,
        username: assayer.assayerCode,
        displayName: assayer.displayName,
        roles: [{
          name: 'ASSAYER',
          permissions: (payload.permissions || []).map(p => {
            const [resource, action, scope] = p.split(':');
            return { resource, action, scope };
          }),
        }],
      };
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async generateTokenPair(
    userOrPayload: UserEntity | JwtPayload,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenPair> {
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
      accessToken,
      refreshToken,
      expiresIn: this.accessExpiration,
    };
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }
}
