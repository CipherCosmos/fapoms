export declare class RefreshTokenEntity {
    id: string;
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    isRevoked: boolean;
    revokedAt: Date | null;
    replacedBy: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    createdAt: Date;
}
