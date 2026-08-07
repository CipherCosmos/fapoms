/**
 * FAPOMS — User Service
 *
 * Manages the lifecycle of Users (Part 2 §11, Part 8 §5).
 */

import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { UserEntity } from './user.entity';
import { RoleEntity } from './role.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
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
    private readonly eventPublisher: DomainEventPublisher,
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

    try {
      this.eventPublisher.publish('user:created', {
        eventType: 'user:created',
        userId: savedUser.id,
        username: savedUser.username,
        email: savedUser.email,
        displayName: savedUser.displayName,
        roleIds: dto.roleIds || [],
        createdBy: createdById,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish user:created event:', err);
    }

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

    // Deactivating yourself, or the last active SUPER_ADMINISTRATOR, leaves the
    // system with nobody who can undo it through the API — the only way back
    // would be a direct database edit. Neither check existed before this.
    if (dto.status && dto.status !== UserStatus.ACTIVE && previousStatus === UserStatus.ACTIVE) {
      if (id === updatedById) {
        throw new ForbiddenException('You cannot deactivate your own account.');
      }
      await this.assertNotLastActiveSuperAdmin(id);
    }

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

    try {
      this.eventPublisher.publish('user:updated', {
        eventType: 'user:updated',
        userId: saved.id,
        status: saved.status,
        previousStatus,
        updatedBy: updatedById,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish user:updated event:', err);
    }

    return saved;
  }

  /** Refuses the action if `excludingUserId` is the only active SUPER_ADMINISTRATOR left. */
  private async assertNotLastActiveSuperAdmin(excludingUserId: string): Promise<void> {
    const count = await this.userRepository
      .createQueryBuilder('u')
      .innerJoin('u.roles', 'r')
      .where('r.name = :name', { name: 'SUPER_ADMINISTRATOR' })
      .andWhere('u.status = :status', { status: UserStatus.ACTIVE })
      .andWhere('u.id != :id', { id: excludingUserId })
      .getCount();
    if (count === 0) {
      throw new BadRequestException('At least one active SUPER_ADMINISTRATOR must remain.');
    }
  }

  /**
   * Activate or suspend a batch of users as one operation. Each row runs the same
   * guards as a single update (no self-deactivation, keep at least one active
   * SUPER_ADMINISTRATOR) and is audited individually; per-row errors are isolated
   * so one bad row never aborts the rest.
   */
  async bulkSetStatus(
    ids: string[],
    status: UserStatus,
    actorId: string,
  ): Promise<{
    succeeded: { id: string; from: UserStatus; to: UserStatus }[];
    skipped: { id: string; current: UserStatus; reason: string }[];
    failed: { id: string; reason: string }[];
  }> {
    const succeeded: { id: string; from: UserStatus; to: UserStatus }[] = [];
    const skipped: { id: string; current: UserStatus; reason: string }[] = [];
    const failed: { id: string; reason: string }[] = [];

    for (const id of ids) {
      try {
        const user = await this.findById(id);
        const previousStatus = user.status as UserStatus;
        if (previousStatus === status) {
          skipped.push({ id, current: previousStatus, reason: `Already ${status}` });
          continue;
        }
        if (status !== UserStatus.ACTIVE && previousStatus === UserStatus.ACTIVE) {
          if (id === actorId) {
            failed.push({ id, reason: 'You cannot deactivate your own account.' });
            continue;
          }
          await this.assertNotLastActiveSuperAdmin(id);
        }

        user.status = status;
        user.isActive = status === UserStatus.ACTIVE;
        user.updatedBy = actorId;
        const saved = await this.userRepository.save(user);

        await this.auditService.recordEvent({
          category: EventCategory.USER,
          eventType: 'USER_UPDATED',
          entityType: 'USER',
          entityId: id,
          previousState: previousStatus,
          newState: user.status,
          userId: actorId,
          remarks: `Bulk status change: ${previousStatus} → ${status}`,
        });

        try {
          this.eventPublisher.publish('user:updated', {
            eventType: 'user:updated',
            userId: saved.id,
            status: saved.status,
            previousStatus,
            updatedBy: actorId,
            timestamp: new Date(),
          });
        } catch (err) {
          console.error('Failed to publish user:updated event:', err);
        }

        succeeded.push({ id, from: previousStatus, to: status });
      } catch (e) {
        failed.push({ id, reason: (e as Error).message });
      }
    }

    return { succeeded, skipped, failed };
  }

  /** Admin-initiated reset — there was no way to help a locked-out staff member. */
  /**
   * Clears a lockout without touching the password — the standard IAM split
   * between "unlock" and "reset password". Only meaningful when the account is
   * actually LOCKED; a deliberately SUSPENDED account stays suspended.
   */
  async unlockAccount(id: string, actorId: string): Promise<UserEntity> {
    const user = await this.findById(id);
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    if (user.status === UserStatus.LOCKED) {
      user.status = UserStatus.ACTIVE;
    }
    user.updatedBy = actorId;
    const saved = await this.userRepository.save(user);

    await this.auditService.recordEvent({
      category: EventCategory.USER,
      eventType: 'USER_UNLOCKED',
      entityType: 'USER',
      entityId: id,
      userId: actorId,
      remarks: `${user.username} unlocked by an administrator`,
    });

    return saved;
  }

  async resetPassword(id: string, newPassword: string, actorId: string): Promise<void> {
    const user = await this.findById(id);
    user.passwordHash = await bcrypt.hash(newPassword, 12);
    // An admin resetting a password is, in practice, always trying to get someone
    // back in — including someone the login flow auto-locked after 5 failed
    // attempts. Without this the reset silently did not work: the account would
    // still fail lockedUntil / status !== ACTIVE checks on the very next login.
    user.failedLoginAttempts = 0;
    user.lockedUntil = null;
    if (user.status === UserStatus.LOCKED) {
      user.status = UserStatus.ACTIVE;
    }
    user.updatedBy = actorId;
    await this.userRepository.save(user);

    await this.auditService.recordEvent({
      category: EventCategory.USER,
      eventType: 'USER_PASSWORD_RESET',
      entityType: 'USER',
      entityId: id,
      userId: actorId,
      remarks: `Password reset for ${user.username} by an administrator`,
    });
  }

  async changePassword(id: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.userRepository.createQueryBuilder('u')
      .addSelect('u.passwordHash')
      .where('u.id = :id', { id })
      .getOne();

    if (!user) {
      throw new NotFoundException(`User ${id} not found.`);
    }

    const match = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!match) {
      throw new BadRequestException('Current password is incorrect.');
    }

    // Matches the rule already enforced on the assayer path. Without it, a user forced to
    // rotate off a seeded credential could satisfy the requirement with a single character.
    if (!newPassword || newPassword.trim().length < 8) {
      throw new BadRequestException('Your new password must be at least 8 characters.');
    }
    if (newPassword === currentPassword) {
      throw new BadRequestException('Your new password must be different from your current one.');
    }

    user.passwordHash = await bcrypt.hash(newPassword, 12);
    // The holder has now chosen their own credential, so forced rotation is satisfied.
    user.mustChangePassword = false;
    user.updatedBy = id;
    await this.userRepository.save(user);

    await this.auditService.recordEvent({
      category: EventCategory.USER,
      eventType: 'USER_PASSWORD_CHANGED',
      entityType: 'USER',
      entityId: id,
      userId: id,
      remarks: `Self-service password update for ${user.username}`,
    });
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

    const hadSuperAdmin = user.roles?.some((r) => r.name === 'SUPER_ADMINISTRATOR');
    const keepsSuperAdmin = roles.some((r) => r.name === 'SUPER_ADMINISTRATOR');
    if (hadSuperAdmin && !keepsSuperAdmin) {
      if (userId === assignedById) {
        throw new ForbiddenException('You cannot remove your own SUPER_ADMINISTRATOR role.');
      }
      await this.assertNotLastActiveSuperAdmin(userId);
    }

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

    try {
      this.eventPublisher.publish('user:role-changed', {
        eventType: 'user:role-changed',
        userId: saved.id,
        roleIds,
        assignedBy: assignedById,
        timestamp: new Date(),
      });
    } catch (err) {
      console.error('Failed to publish user:role-changed event:', err);
    }

    return saved;
  }

  /**
   * Every role with its full permission set. The frontend previously assigned
   * whole roles to a user with no visibility into what each one actually
   * grants — this is what makes a real permission matrix possible instead of a
   * list of opaque role-name checkboxes.
   */
  async findAllRoles(): Promise<RoleEntity[]> {
    return this.roleRepository.find({
      relations: ['permissions'],
      order: { name: 'ASC' },
    });
  }
}
