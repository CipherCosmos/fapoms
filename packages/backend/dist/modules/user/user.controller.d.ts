import { UserService, CreateUserDto, UpdateUserDto } from './user.service';
import { UserStatus } from '@fapoms/shared';
declare class CreateUserRequestDto implements CreateUserDto {
    username: string;
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    phone?: string;
    departmentId?: string;
    roleIds?: string[];
}
declare class AssignRolesDto {
    roleIds: string[];
}
declare class BulkSetStatusDto {
    ids: string[];
    status: UserStatus;
}
declare class UpdateUserRequestDto implements UpdateUserDto {
    firstName?: string;
    lastName?: string;
    phone?: string;
    departmentId?: string;
    status?: UserStatus;
}
declare class ResetPasswordRequestDto {
    newPassword: string;
}
declare class SelfUpdateProfileDto {
    firstName?: string;
    lastName?: string;
    phone?: string;
}
declare class SelfChangePasswordDto {
    currentPassword: string;
    newPassword: string;
}
export declare class UserController {
    private readonly userService;
    constructor(userService: UserService);
    getMe(req: any): Promise<{
        success: boolean;
        data: any;
    }>;
    updateMe(dto: SelfUpdateProfileDto, req: any): Promise<{
        success: boolean;
        data: any;
    }>;
    changePassword(dto: SelfChangePasswordDto, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
    bulkSetStatus(dto: BulkSetStatusDto, req: any): Promise<{
        success: boolean;
        data: {
            succeeded: {
                id: string;
                from: UserStatus;
                to: UserStatus;
            }[];
            skipped: {
                id: string;
                current: UserStatus;
                reason: string;
            }[];
            failed: {
                id: string;
                reason: string;
            }[];
        };
    }>;
    create(dto: CreateUserRequestDto, req: any): Promise<{
        success: boolean;
        data: any;
    }>;
    findAll(page?: number, limit?: number): Promise<{
        success: boolean;
        data: any[];
        meta: {
            pagination: {
                page: number;
                limit: number;
                total: number;
                totalPages: number;
                hasNext: boolean;
                hasPrevious: boolean;
            };
        };
    }>;
    findAllRoles(): Promise<{
        success: boolean;
        data: import("./role.entity").RoleEntity[];
    }>;
    findOne(id: string): Promise<{
        success: boolean;
        data: any;
    }>;
    update(id: string, dto: UpdateUserRequestDto, req: any): Promise<{
        success: boolean;
        data: any;
    }>;
    assignRoles(id: string, dto: AssignRolesDto, req: any): Promise<{
        success: boolean;
        data: any;
    }>;
    unlockAccount(id: string, req: any): Promise<{
        success: boolean;
        data: any;
    }>;
    resetPassword(id: string, dto: ResetPasswordRequestDto, req: any): Promise<{
        success: boolean;
        data: {
            message: string;
        };
    }>;
    private sanitizeUser;
}
export {};
