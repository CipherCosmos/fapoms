import { JwtService } from '@nestjs/jwt';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { UserEntity } from '../user/user.entity';
import { RefreshTokenEntity } from './refresh-token.entity';
import { AuditService } from '../../core/audit/audit.service';
import { AssayerEntity } from '../assayer/assayer.entity';
export interface JwtPayload {
    sub: string;
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
export declare class AuthService {
    private readonly userRepository;
    private readonly refreshTokenRepository;
    private readonly assayerRepository;
    private readonly jwtService;
    private readonly configService;
    private readonly auditService;
    private readonly accessExpiration;
    private readonly refreshExpiration;
    constructor(userRepository: Repository<UserEntity>, refreshTokenRepository: Repository<RefreshTokenEntity>, assayerRepository: Repository<AssayerEntity>, jwtService: JwtService, configService: ConfigService, auditService: AuditService);
    login(usernameOrEmail: string, password: string, ipAddress?: string, userAgent?: string): Promise<TokenPair & {
        user: any;
    }>;
    biometricLogin(assayerCode: string, ipAddress?: string, userAgent?: string): Promise<TokenPair & {
        user: any;
    }>;
    refreshAccessToken(refreshToken: string, ipAddress?: string, userAgent?: string): Promise<TokenPair>;
    logout(userId: string, ipAddress?: string): Promise<void>;
    validateJwtPayload(payload: JwtPayload): Promise<any>;
    private generateTokenPair;
    private hashToken;
}
