"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AuthService = void 0;
const common_1 = require("@nestjs/common");
const jwt_1 = require("@nestjs/jwt");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const bcrypt = require("bcrypt");
const uuid_1 = require("uuid");
const config_1 = require("@nestjs/config");
const user_entity_1 = require("../user/user.entity");
const refresh_token_entity_1 = require("./refresh-token.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
let AuthService = class AuthService {
    userRepository;
    refreshTokenRepository;
    jwtService;
    configService;
    auditService;
    accessExpiration;
    refreshExpiration;
    constructor(userRepository, refreshTokenRepository, jwtService, configService, auditService) {
        this.userRepository = userRepository;
        this.refreshTokenRepository = refreshTokenRepository;
        this.jwtService = jwtService;
        this.configService = configService;
        this.auditService = auditService;
        this.accessExpiration = Number(this.configService.get('JWT_ACCESS_EXPIRATION', 900));
        this.refreshExpiration = Number(this.configService.get('JWT_REFRESH_EXPIRATION', 604800));
    }
    async login(usernameOrEmail, password, ipAddress, userAgent) {
        const user = await this.userRepository.findOne({
            where: [
                { username: usernameOrEmail },
                { email: usernameOrEmail },
            ],
            relations: ['roles', 'roles.permissions'],
        });
        if (!user) {
            throw new common_1.UnauthorizedException('Invalid credentials');
        }
        if (user.status !== shared_1.UserStatus.ACTIVE) {
            throw new common_1.ForbiddenException(`Account is ${user.status.toLowerCase()}`);
        }
        if (user.lockedUntil && user.lockedUntil > new Date()) {
            throw new common_1.ForbiddenException('Account is temporarily locked');
        }
        const isPasswordValid = await bcrypt.compare(password, user.passwordHash);
        if (!isPasswordValid) {
            user.failedLoginAttempts += 1;
            if (user.failedLoginAttempts >= 5) {
                user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
                user.status = shared_1.UserStatus.LOCKED;
            }
            await this.userRepository.save(user);
            throw new common_1.UnauthorizedException('Invalid credentials');
        }
        user.failedLoginAttempts = 0;
        user.lockedUntil = null;
        user.lastLoginAt = new Date();
        await this.userRepository.save(user);
        const tokens = await this.generateTokenPair(user, ipAddress, userAgent);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.USER,
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
    async refreshAccessToken(refreshToken, ipAddress, userAgent) {
        const tokenHash = await this.hashToken(refreshToken);
        const storedToken = await this.refreshTokenRepository.findOne({
            where: {
                tokenHash,
                isRevoked: false,
                expiresAt: (0, typeorm_2.MoreThan)(new Date()),
            },
        });
        if (!storedToken) {
            throw new common_1.UnauthorizedException('Invalid or expired refresh token');
        }
        const user = await this.userRepository.findOne({
            where: { id: storedToken.userId },
            relations: ['roles', 'roles.permissions'],
        });
        if (!user || user.status !== shared_1.UserStatus.ACTIVE) {
            throw new common_1.UnauthorizedException('User account is not active');
        }
        storedToken.isRevoked = true;
        storedToken.revokedAt = new Date();
        await this.refreshTokenRepository.save(storedToken);
        const tokens = await this.generateTokenPair(user, ipAddress, userAgent);
        storedToken.replacedBy = tokens.refreshToken;
        await this.refreshTokenRepository.save(storedToken);
        return tokens;
    }
    async logout(userId, ipAddress) {
        await this.refreshTokenRepository.update({ userId, isRevoked: false }, { isRevoked: true, revokedAt: new Date() });
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.USER,
            eventType: 'USER_LOGOUT',
            entityType: 'USER',
            entityId: userId,
            userId,
            ipAddress: ipAddress ?? undefined,
        });
    }
    async validateJwtPayload(payload) {
        const user = await this.userRepository.findOne({
            where: { id: payload.sub, status: shared_1.UserStatus.ACTIVE },
            relations: ['roles', 'roles.permissions'],
        });
        return user ?? null;
    }
    async generateTokenPair(user, ipAddress, userAgent) {
        const roles = user.roles.map((r) => r.name);
        const permissions = user.roles
            .flatMap((r) => r.permissions)
            .map((p) => `${p.resource}:${p.action}:${p.scope}`);
        const payload = {
            sub: user.id,
            username: user.username,
            email: user.email,
            roles,
            permissions: [...new Set(permissions)],
        };
        const accessToken = this.jwtService.sign(payload, {
            expiresIn: this.accessExpiration,
        });
        const refreshToken = (0, uuid_1.v4)();
        const tokenHash = await this.hashToken(refreshToken);
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
    async hashToken(token) {
        return bcrypt.hash(token, 10);
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(user_entity_1.UserEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(refresh_token_entity_1.RefreshTokenEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        jwt_1.JwtService,
        config_1.ConfigService,
        audit_service_1.AuditService])
], AuthService);
//# sourceMappingURL=auth.service.js.map