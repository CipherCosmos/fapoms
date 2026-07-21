import { UserService, CreateUserDto, UpdateUserDto } from './user.service';
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
    update(id: string, dto: UpdateUserDto, req: any): Promise<{
        success: boolean;
        data: any;
    }>;
    assignRoles(id: string, dto: AssignRolesDto, req: any): Promise<{
        success: boolean;
        data: any;
    }>;
    private sanitizeUser;
}
export {};
