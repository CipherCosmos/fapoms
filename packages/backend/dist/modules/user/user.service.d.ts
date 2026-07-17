import { Repository } from 'typeorm';
import { UserEntity } from './user.entity';
import { RoleEntity } from './role.entity';
import { AuditService } from '../../core/audit/audit.service';
import { UserStatus } from '@fapoms/shared';
export interface CreateUserDto {
    username: string;
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phone?: string;
    departmentId?: string;
    roleIds?: string[];
}
export interface UpdateUserDto {
    firstName?: string;
    lastName?: string;
    phone?: string;
    departmentId?: string;
    status?: UserStatus;
}
export declare class UserService {
    private readonly userRepository;
    private readonly roleRepository;
    private readonly auditService;
    constructor(userRepository: Repository<UserEntity>, roleRepository: Repository<RoleEntity>, auditService: AuditService);
    createUser(dto: CreateUserDto, createdById: string): Promise<UserEntity>;
    findById(id: string): Promise<UserEntity>;
    findAll(page?: number, limit?: number): Promise<{
        users: UserEntity[];
        total: number;
    }>;
    updateUser(id: string, dto: UpdateUserDto, updatedById: string): Promise<UserEntity>;
    assignRoles(userId: string, roleIds: string[], assignedById: string): Promise<UserEntity>;
}
