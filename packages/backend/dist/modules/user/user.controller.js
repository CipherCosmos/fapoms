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
exports.UserController = void 0;
const common_1 = require("@nestjs/common");
const swagger_1 = require("@nestjs/swagger");
const class_validator_1 = require("class-validator");
const user_service_1 = require("./user.service");
const guards_1 = require("../auth/guards");
const shared_1 = require("@fapoms/shared");
class CreateUserRequestDto {
    username;
    email;
    password;
    firstName;
    lastName;
    phone;
    departmentId;
    roleIds;
}
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateUserRequestDto.prototype, "username", void 0);
__decorate([
    (0, class_validator_1.IsEmail)(),
    __metadata("design:type", String)
], CreateUserRequestDto.prototype, "email", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.MinLength)(8),
    __metadata("design:type", String)
], CreateUserRequestDto.prototype, "password", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateUserRequestDto.prototype, "firstName", void 0);
__decorate([
    (0, class_validator_1.IsString)(),
    (0, class_validator_1.IsNotEmpty)(),
    __metadata("design:type", String)
], CreateUserRequestDto.prototype, "lastName", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateUserRequestDto.prototype, "phone", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsString)(),
    __metadata("design:type", String)
], CreateUserRequestDto.prototype, "departmentId", void 0);
__decorate([
    (0, class_validator_1.IsOptional)(),
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], CreateUserRequestDto.prototype, "roleIds", void 0);
class AssignRolesDto {
    roleIds;
}
__decorate([
    (0, class_validator_1.IsArray)(),
    __metadata("design:type", Array)
], AssignRolesDto.prototype, "roleIds", void 0);
let UserController = class UserController {
    userService;
    constructor(userService) {
        this.userService = userService;
    }
    async getMe(req) {
        return {
            success: true,
            data: this.sanitizeUser(req.user),
        };
    }
    async create(dto, req) {
        const user = await this.userService.createUser(dto, req.user.id);
        return {
            success: true,
            data: this.sanitizeUser(user),
        };
    }
    async findAll(page = 1, limit = 20) {
        const { users, total } = await this.userService.findAll(page, limit);
        return {
            success: true,
            data: users.map(this.sanitizeUser),
            meta: {
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit),
                    hasNext: page * limit < total,
                    hasPrevious: page > 1,
                },
            },
        };
    }
    async findOne(id) {
        const user = await this.userService.findById(id);
        return {
            success: true,
            data: this.sanitizeUser(user),
        };
    }
    async update(id, dto, req) {
        const user = await this.userService.updateUser(id, dto, req.user.id);
        return {
            success: true,
            data: this.sanitizeUser(user),
        };
    }
    async assignRoles(id, dto, req) {
        const user = await this.userService.assignRoles(id, dto.roleIds, req.user.id);
        return {
            success: true,
            data: this.sanitizeUser(user),
        };
    }
    async findAllRoles() {
        const roles = await this.userService.findAllRoles();
        return {
            success: true,
            data: roles,
        };
    }
    sanitizeUser(user) {
        const { passwordHash, failedLoginAttempts, lockedUntil, ...safe } = user;
        return safe;
    }
};
exports.UserController = UserController;
__decorate([
    (0, common_1.Get)('me'),
    (0, swagger_1.ApiOperation)({ summary: 'Get current user profile' }),
    __param(0, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object]),
    __metadata("design:returntype", Promise)
], UserController.prototype, "getMe", null);
__decorate([
    (0, common_1.Post)(),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR),
    (0, swagger_1.ApiOperation)({ summary: 'Create a new user' }),
    __param(0, (0, common_1.Body)()),
    __param(1, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [CreateUserRequestDto, Object]),
    __metadata("design:returntype", Promise)
], UserController.prototype, "create", null);
__decorate([
    (0, common_1.Get)(),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR),
    (0, swagger_1.ApiOperation)({ summary: 'List all users' }),
    __param(0, (0, common_1.Query)('page')),
    __param(1, (0, common_1.Query)('limit')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, Object]),
    __metadata("design:returntype", Promise)
], UserController.prototype, "findAll", null);
__decorate([
    (0, common_1.Get)(':id'),
    (0, swagger_1.ApiOperation)({ summary: 'Get user by ID' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], UserController.prototype, "findOne", null);
__decorate([
    (0, common_1.Put)(':id'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR),
    (0, swagger_1.ApiOperation)({ summary: 'Update user' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, Object, Object]),
    __metadata("design:returntype", Promise)
], UserController.prototype, "update", null);
__decorate([
    (0, common_1.Put)(':id/roles'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR),
    (0, swagger_1.ApiOperation)({ summary: 'Assign roles to user' }),
    __param(0, (0, common_1.Param)('id', common_1.ParseUUIDPipe)),
    __param(1, (0, common_1.Body)()),
    __param(2, (0, common_1.Req)()),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String, AssignRolesDto, Object]),
    __metadata("design:returntype", Promise)
], UserController.prototype, "assignRoles", null);
__decorate([
    (0, common_1.Get)('roles'),
    (0, guards_1.Roles)(shared_1.SystemRole.SUPER_ADMINISTRATOR, shared_1.SystemRole.ADMINISTRATOR),
    (0, swagger_1.ApiOperation)({ summary: 'List all available roles' }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", []),
    __metadata("design:returntype", Promise)
], UserController.prototype, "findAllRoles", null);
exports.UserController = UserController = __decorate([
    (0, swagger_1.ApiTags)('Users'),
    (0, swagger_1.ApiBearerAuth)(),
    (0, common_1.Controller)('users'),
    (0, common_1.UseGuards)(guards_1.JwtAuthGuard, guards_1.RolesGuard),
    __metadata("design:paramtypes", [user_service_1.UserService])
], UserController);
//# sourceMappingURL=user.controller.js.map