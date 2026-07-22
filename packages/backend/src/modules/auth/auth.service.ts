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
import { Repository, MoreThan } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { ConfigService } from '@nestjs/config';

import { UserEntity } from '../user/user.entity';
import { RefreshTokenEntity } from './refresh-token.entity';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory, UserStatus } from '@fapoms/shared';

export interface JwtPayload {
  sub: string;           // User ID
  username: string;
  email: string;
  roles: string[];
  permissions: string[];
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
  ): Promise<TokenPair & { user: Partial<UserEntity> }> {
    // Find user by username or email
    const user = await this.userRepository.findOne({
      where: [
        { username: usernameOrEmail },
        { email: usernameOrEmail },
      ],
      relations: ['roles', 'roles.permissions', 'roles.responsibilities', 'roles.responsibilities.capabilities', 'roles.responsibilities.capabilities.permissions'],
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
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
   * Refresh an access token using a refresh token.
   * Implements token rotation — old refresh token is revoked.
   */
  async refreshAccessToken(
    refreshToken: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenPair> {
    const tokenHash = await this.hashToken(refreshToken);

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

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('User account is not active');
    }

    // Revoke old token (rotation)
    storedToken.isRevoked = true;
    storedToken.revokedAt = new Date();
    await this.refreshTokenRepository.save(storedToken);

    // Generate new token pair
    const tokens = await this.generateTokenPair(user, ipAddress, userAgent);

    // Link old token to new one
    storedToken.replacedBy = tokens.refreshToken;
    await this.refreshTokenRepository.save(storedToken);

    return tokens;
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
  async validateJwtPayload(payload: JwtPayload): Promise<UserEntity | null> {
    const user = await this.userRepository.findOne({
      where: { id: payload.sub, status: UserStatus.ACTIVE },
      relations: ['roles', 'roles.permissions', 'roles.responsibilities', 'roles.responsibilities.capabilities', 'roles.responsibilities.capabilities.permissions'],
    });
    return user ?? null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async generateTokenPair(
    user: UserEntity,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<TokenPair> {
    // Build JWT payload
    const roles = user.roles.map((r) => r.name);

    // Flatten permissions from both direct role permissions and responsibilities
    const directPerms = user.roles.flatMap((r) => r.permissions || []);
    const responsibilityPerms = user.roles.flatMap((r) =>
      (r.responsibilities || []).flatMap((resp) =>
        (resp.capabilities || []).flatMap((cap) => cap.permissions || []),
      ),
    );
    const allPerms = [...directPerms, ...responsibilityPerms];
    const permissions = allPerms.map((p) => `${p.resource}:${p.action}:${p.scope}`);

    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      email: user.email,
      roles,
      permissions: [...new Set(permissions)], // Deduplicate
    };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: this.accessExpiration,
    });

    // Generate refresh token
    const refreshToken = uuidv4();
    const tokenHash = await this.hashToken(refreshToken);

    // Store refresh token
    const refreshTokenEntity = this.refreshTokenRepository.create({
      userId: user.id,
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

  private async hashToken(token: string): Promise<string> {
    return bcrypt.hash(token, 10);
  }
}
