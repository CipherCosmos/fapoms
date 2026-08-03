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
export declare class UserController {
    private readonly userService;
    constructor(userService: UserService);
    getMe(req: any): Promise<{
        success: boolean;
        data: any;
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
