import { BaseEntity } from '../../core/entities/base.entity';
import { RoleEntity } from './role.entity';
export declare class UserEntity extends BaseEntity {
    username: string;
    email: string;
    passwordHash: string;
    firstName: string;
    lastName: string;
    displayName: string;
    status: string;
    departmentId: string | null;
    phone: string | null;
    lastLoginAt: Date | null;
    failedLoginAttempts: number;
    lockedUntil: Date | null;
    roles: RoleEntity[];
}
