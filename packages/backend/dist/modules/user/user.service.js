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
exports.UserService = void 0;
const common_1 = require("@nestjs/common");
const typeorm_1 = require("@nestjs/typeorm");
const typeorm_2 = require("typeorm");
const bcrypt = require("bcrypt");
const user_entity_1 = require("./user.entity");
const role_entity_1 = require("./role.entity");
const audit_service_1 = require("../../core/audit/audit.service");
const shared_1 = require("@fapoms/shared");
let UserService = class UserService {
    userRepository;
    roleRepository;
    auditService;
    constructor(userRepository, roleRepository, auditService) {
        this.userRepository = userRepository;
        this.roleRepository = roleRepository;
        this.auditService = auditService;
    }
    async createUser(dto, createdById) {
        const existing = await this.userRepository.findOne({
            where: [{ username: dto.username }, { email: dto.email }],
        });
        if (existing) {
            throw new common_1.ConflictException('Username or email already exists');
        }
        const passwordHash = await bcrypt.hash(dto.password, 12);
        let roles = [];
        if (dto.roleIds && dto.roleIds.length > 0) {
            roles = await this.roleRepository.find({
                where: { id: (0, typeorm_2.In)(dto.roleIds) }
            });
        }
        const user = this.userRepository.create({
            username: dto.username,
            email: dto.email,
            passwordHash,
            firstName: dto.firstName,
            lastName: dto.lastName,
            displayName: `${dto.firstName} ${dto.lastName}`,
            phone: dto.phone ?? null,
            departmentId: dto.departmentId ?? null,
            status: shared_1.UserStatus.ACTIVE,
            createdBy: createdById,
            updatedBy: createdById,
            roles,
        });
        const savedUser = await this.userRepository.save(user);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.USER,
            eventType: 'USER_CREATED',
            entityType: 'USER',
            entityId: savedUser.id,
            newState: shared_1.UserStatus.ACTIVE,
            userId: createdById,
        });
        return savedUser;
    }
    async findById(id) {
        const user = await this.userRepository.findOne({
            where: { id },
            relations: ['roles', 'roles.permissions'],
        });
        if (!user) {
            throw new common_1.NotFoundException(`User ${id} not found`);
        }
        return user;
    }
    async findAll(page = 1, limit = 20) {
        const [users, total] = await this.userRepository.findAndCount({
            relations: ['roles'],
            order: { createdAt: 'DESC' },
            take: limit,
            skip: (page - 1) * limit,
        });
        return { users, total };
    }
    async updateUser(id, dto, updatedById) {
        const user = await this.findById(id);
        const previousStatus = user.status;
        if (dto.firstName !== undefined)
            user.firstName = dto.firstName;
        if (dto.lastName !== undefined)
            user.lastName = dto.lastName;
        if (dto.firstName || dto.lastName) {
            user.displayName = `${user.firstName} ${user.lastName}`;
        }
        if (dto.phone !== undefined)
            user.phone = dto.phone ?? null;
        if (dto.departmentId !== undefined)
            user.departmentId = dto.departmentId ?? null;
        if (dto.status !== undefined) {
            user.status = dto.status;
            user.isActive = dto.status === shared_1.UserStatus.ACTIVE;
        }
        user.updatedBy = updatedById;
        const saved = await this.userRepository.save(user);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.USER,
            eventType: 'USER_UPDATED',
            entityType: 'USER',
            entityId: id,
            previousState: previousStatus,
            newState: user.status,
            userId: updatedById,
        });
        return saved;
    }
    async assignRoles(userId, roleIds, assignedById) {
        const user = await this.findById(userId);
        const roles = await this.roleRepository.find({
            where: { id: (0, typeorm_2.In)(roleIds) }
        });
        user.roles = roles;
        user.updatedBy = assignedById;
        const saved = await this.userRepository.save(user);
        await this.auditService.recordEvent({
            category: shared_1.EventCategory.USER,
            eventType: 'USER_ROLES_UPDATED',
            entityType: 'USER',
            entityId: userId,
            userId: assignedById,
            metadata: { roleIds },
        });
        return saved;
    }
    async findAllRoles() {
        return this.roleRepository.find();
    }
};
exports.UserService = UserService;
exports.UserService = UserService = __decorate([
    (0, common_1.Injectable)(),
    __param(0, (0, typeorm_1.InjectRepository)(user_entity_1.UserEntity)),
    __param(1, (0, typeorm_1.InjectRepository)(role_entity_1.RoleEntity)),
    __metadata("design:paramtypes", [typeorm_2.Repository,
        typeorm_2.Repository,
        audit_service_1.AuditService])
], UserService);
//# sourceMappingURL=user.service.js.map