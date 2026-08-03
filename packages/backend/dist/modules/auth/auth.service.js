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
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const uuid_1 = require("uuid");
const config_1 = require("@nestjs/config");
const user_entity_1 = require("../user/user.entity");
const refresh_token_entity_1 = require("./refresh-token.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const assayer_entity_1 = require("../assayer/assayer.entity");
const shared_1 = require("@fapoms/shared");
let AuthService = class AuthService {
    userRepository;
    refreshTokenRepository;
    assayerRepository;
    jwtService;
    configService;
    auditService;
    accessExpiration;
    refreshExpiration;
    constructor(userRepository, refreshTokenRepository, assayerRepository, jwtService, configService, auditService) {
        this.userRepository = userRepository;
        this.refreshTokenRepository = refreshTokenRepository;
        this.assayerRepository = assayerRepository;
        this.jwtService = jwtService;
        this.configService = configService;
        this.auditService = auditService;
        this.accessExpiration = Number(this.configService.get('JWT_ACCESS_EXPIRATION', 900));
        this.refreshExpiration = Number(this.configService.get('JWT_REFRESH_EXPIRATION', 604800));
    }
    async login(usernameOrEmail, password, ipAddress, userAgent) {
        let user = await this.userRepository.findOne({
            where: [
                { username: usernameOrEmail },
                { email: usernameOrEmail },
            ],
            relations: ['roles', 'roles.permissions', 'roles.responsibilities', 'roles.responsibilities.capabilities', 'roles.responsibilities.capabilities.permissions'],
        });
        if (!user) {
            const cleanKey = usernameOrEmail.trim();
            const assayer = await this.assayerRepository.findOne({
                where: [
                    { assayerCode: (0, typeorm_2.ILike)(cleanKey) },
                    { phone: cleanKey },
                    { email: (0, typeorm_2.ILike)(cleanKey) },
                ],
                select: {
                    id: true, assayerCode: true, displayName: true, email: true, phone: true,
                    organizationId: true, lifecycleStatus: true, passwordHash: true,
                },
            });
            if (!assayer) {
                throw new common_1.UnauthorizedException('Invalid credentials');
            }
            if (!assayer.passwordHash) {
                throw new common_1.UnauthorizedException('Invalid credentials');
            }
            const isPasswordValid = await bcrypt.compare(password, assayer.passwordHash);
            if (!isPasswordValid) {
                throw new common_1.UnauthorizedException('Invalid credentials');
            }
            if (assayer.lifecycleStatus !== 'ACTIVE') {
                throw new common_1.ForbiddenException(`Account is ${String(assayer.lifecycleStatus).toLowerCase()}`);
            }
            const payload = {
                sub: assayer.id,
                username: assayer.assayerCode,
                email: assayer.email || `${assayer.assayerCode.toLowerCase()}@fapoms.com`,
                roles: ['ASSAYER'],
                permissions: ['assignment:read:organization', 'assignment:update:organization'],
                organizationId: assayer.organizationId,
            };
            const tokens = await this.generateTokenPair(payload, ipAddress, userAgent);
            await this.auditService.recordEvent({
                category: shared_1.EventCategory.USER,
                eventType: 'USER_LOGIN',
                entityType: 'ASSAYER',
                entityId: assayer.id,
                userId: assayer.id,
                userDisplayName: assayer.displayName,
                ipAddress: ipAddress ?? undefined,
            }).catch(() => { });
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
    async biometricLogin(refreshToken, ipAddress, userAgent) {
        const { tokens, user } = await this.redeemRefreshToken(refreshToken, ipAddress, userAgent);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.USER,
            eventType: 'BIOMETRIC_LOGIN',
            entityType: user.roles ? 'USER' : 'ASSAYER',
            entityId: user.id,
            userId: user.id,
            ipAddress: ipAddress ?? undefined,
        }).catch(() => { });
        return { ...tokens, user };
    }
    async refreshAccessToken(refreshToken, ipAddress, userAgent) {
        const { tokens } = await this.redeemRefreshToken(refreshToken, ipAddress, userAgent);
        return tokens;
    }
    async redeemRefreshToken(refreshToken, ipAddress, userAgent) {
        const tokenHash = this.hashToken(refreshToken);
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
            relations: ['roles', 'roles.permissions', 'roles.responsibilities', 'roles.responsibilities.capabilities', 'roles.responsibilities.capabilities.permissions'],
        });
        if (user) {
            if (user.status !== shared_1.UserStatus.ACTIVE) {
                throw new common_1.UnauthorizedException('User account is not active');
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
            throw new common_1.UnauthorizedException('Account is not active');
        }
        if (assayer.lifecycleStatus !== 'ACTIVE') {
            throw new common_1.ForbiddenException('Assayer account is not active');
        }
        const assayerPayload = {
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
    async verifyAssayerIdentifier(identifier) {
        const key = (identifier || '').trim();
        if (!key)
            return null;
        const assayer = await this.assayerRepository.findOne({
            where: [{ assayerCode: (0, typeorm_2.ILike)(key) }, { phone: key }, { email: (0, typeorm_2.ILike)(key) }],
            select: { id: true, displayName: true, assayerCode: true, lifecycleStatus: true },
        });
        if (!assayer || assayer.lifecycleStatus !== 'ACTIVE')
            return null;
        return { displayName: assayer.displayName, assayerCode: assayer.assayerCode };
    }
    async validateJwtPayload(payload) {
        const user = await this.userRepository.findOne({
            where: { id: payload.sub, status: shared_1.UserStatus.ACTIVE },
            relations: ['roles', 'roles.permissions', 'roles.responsibilities', 'roles.responsibilities.capabilities', 'roles.responsibilities.capabilities.permissions'],
        });
        if (user)
            return user;
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
    async generateTokenPair(userOrPayload, ipAddress, userAgent) {
        let payload;
        let userId;
        if ('sub' in userOrPayload) {
            payload = userOrPayload;
            userId = userOrPayload.sub;
        }
        else {
            const user = userOrPayload;
            userId = user.id;
            const roles = user.roles ? user.roles.map((r) => r.name) : [];
            const directPerms = user.roles ? user.roles.flatMap((r) => r.permissions || []) : [];
            const responsibilityPerms = user.roles
                ? user.roles.flatMap((r) => (r.responsibilities || []).flatMap((resp) => (resp.capabilities || []).flatMap((cap) => cap.permissions || [])))
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
        const refreshToken = (0, uuid_1.v4)();
        const tokenHash = this.hashToken(refreshToken);
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
    hashToken(token) {
        return crypto.createHash('sha256').update(token).digest('hex');
    }
};
exports.AuthService = AuthService;
exports.AuthService = AuthService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(user_entity_1.UserEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(refresh_token_entity_1.RefreshTokenEntity)),
    __param(2, (0, typeorm_1.InjectRepository)(assayer_entity_1.AssayerEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        typeorm_2.Repository,
        jwt_1.JwtService,
        config_1.ConfigService,
        audit_service_1.AuditService])
], AuthService);
//# sourceMappingURL=auth.service.js.map