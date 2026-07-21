/**
 * FAPOMS — User Service
 *
 * Manages the lifecycle of Users (Part 2 §11, Part 8 §5).
 */

import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { UserEntity } from './user.entity';
import { RoleEntity } from './role.entity';
import { AuditService } from '../../core/audit/audit.service';
import { EventCategory, UserStatus } from '@fapoms/shared';

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

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(RoleEntity)
    private readonly roleRepository: Repository<RoleEntity>,
    private readonly auditService: AuditService,
  ) {}

  async createUser(
    dto: CreateUserDto,
    createdById: string,
  ): Promise<UserEntity> {
    // Check for duplicates
    const existing = await this.userRepository.findOne({
      where: [{ username: dto.username }, { email: dto.email }],
    });
    if (existing) {
      throw new ConflictException('Username or email already exists');
    }

    // Hash password
    const passwordHash = await bcrypt.hash(dto.password, 12);

    // Load roles if specified
    let roles: RoleEntity[] = [];
    if (dto.roleIds && dto.roleIds.length > 0) {
      roles = await this.roleRepository.find({
        where: { id: In(dto.roleIds) }
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
      status: UserStatus.ACTIVE,
      createdBy: createdById,
      updatedBy: createdById,
      roles,
    });

    const savedUser = await this.userRepository.save(user);

    await this.auditService.recordEvent({
      category: EventCategory.USER,
      eventType: 'USER_CREATED',
      entityType: 'USER',
      entityId: savedUser.id,
      newState: UserStatus.ACTIVE,
      userId: createdById,
    });

    return savedUser;
  }

  async findById(id: string): Promise<UserEntity> {
    const user = await this.userRepository.findOne({
      where: { id },
      relations: ['roles', 'roles.permissions'],
    });
    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  async findAll(
    page = 1,
    limit = 20,
  ): Promise<{ users: UserEntity[]; total: number }> {
    const [users, total] = await this.userRepository.findAndCount({
      relations: ['roles'],
      order: { createdAt: 'DESC' },
      take: limit,
      skip: (page - 1) * limit,
    });
    return { users, total };
  }

  async updateUser(
    id: string,
    dto: UpdateUserDto,
    updatedById: string,
  ): Promise<UserEntity> {
    const user = await this.findById(id);
    const previousStatus = user.status;

    if (dto.firstName !== undefined) user.firstName = dto.firstName;
    if (dto.lastName !== undefined) user.lastName = dto.lastName;
    if (dto.firstName || dto.lastName) {
      user.displayName = `${user.firstName} ${user.lastName}`;
    }
    if (dto.phone !== undefined) user.phone = dto.phone ?? null;
    if (dto.departmentId !== undefined) user.departmentId = dto.departmentId ?? null;
    if (dto.status !== undefined) {
      user.status = dto.status;
      user.isActive = dto.status === UserStatus.ACTIVE;
    }

    user.updatedBy = updatedById;

    const saved = await this.userRepository.save(user);

    await this.auditService.recordEvent({
      category: EventCategory.USER,
      eventType: 'USER_UPDATED',
      entityType: 'USER',
      entityId: id,
      previousState: previousStatus,
      newState: user.status,
      userId: updatedById,
    });

    return saved;
  }

  async assignRoles(
    userId: string,
    roleIds: string[],
    assignedById: string,
  ): Promise<UserEntity> {
    const user = await this.findById(userId);
    const roles = await this.roleRepository.find({
      where: { id: In(roleIds) }
    });
    user.roles = roles;
    user.updatedBy = assignedById;
    const saved = await this.userRepository.save(user);

    await this.auditService.recordEvent({
      category: EventCategory.USER,
      eventType: 'USER_ROLES_UPDATED',
      entityType: 'USER',
      entityId: userId,
      userId: assignedById,
      metadata: { roleIds },
    });

    return saved;
  }

  async findAllRoles(): Promise<RoleEntity[]> {
    return this.roleRepository.find();
  }
}
