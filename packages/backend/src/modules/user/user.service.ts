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
import { randomInt } from 'crypto';
import { UserEntity } from './user.entity';
import { RoleEntity } from './role.entity';
import { PermissionEntity } from './permission.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { EventCategory, UserStatus, SystemRole, Region, isRegion } from '@fapoms/shared';

export interface CreateUserDto {
  username: string;
  email: string;
  /**
   * Optional. When omitted the server mints the initial credential and returns it once —
   * see `createUser`. Kept optional rather than removed so any existing caller that already
   * supplies a chosen password (imports, fixtures, tests) keeps working unchanged.
   */
  password?: string;
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
  /**
   * Assigned operational regions. `null`/`[]` = unrestricted (national desks — HR, data
   * entry, validation, finance). A non-empty array confines an operations account to its
   * territory; enforced server-side by `resolveRegionScope` on every scoped endpoint.
   */
  regions?: string[] | null;
}

@Injectable()
export class UserService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(RoleEntity)
    private readonly roleRepository: Repository<RoleEntity>,
    @InjectRepository(PermissionEntity)
    private readonly permissionRepository: Repository<PermissionEntity>,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
  ) {}

  /**
   * Creates a user and, when no password was supplied, issues the initial one.
   *
   * Generation belongs here rather than in the browser: the admin's tab is not a trustworthy
   * place to mint a credential (extensions and devtools see it, and nothing stops a stale or
   * tampered page from sending a weak one), and only the server can guarantee the password
   * that is hashed is the password that was generated. The generated value is returned to the
   * caller exactly once, in the creation response, and is never persisted in readable form,
   * never logged, and never recoverable afterwards — a lost one is replaced by a reset.
   */
  async createUser(
    dto: CreateUserDto,
    createdById: string,
  ): Promise<{ user: UserEntity; generatedPassword?: string }> {
    // Check for duplicates
    const existing = await this.userRepository.findOne({
      where: [{ username: dto.username }, { email: dto.email }],
    });
    if (existing) {
      throw new ConflictException('Username or email already exists');
    }

    // An explicitly supplied password wins; otherwise the server issues one.
    const suppliedPassword = dto.password?.trim();
    const generatedPassword = suppliedPassword ? undefined : this.generateInitialPassword();
    const passwordHash = await bcrypt.hash(suppliedPassword ?? generatedPassword!, 12);

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
      /**
       * Whoever set this password, the account holder did not choose it — an admin typed it or
       * the server generated it, and either way it has travelled through a chat message or a
       * piece of paper by the time it is first used. The web app already implements the forced
       * change (App.tsx routes anyone with this flag to ForcePasswordChange before any screen,
       * and /users/me/change-password clears it), so setting it here locks nobody out.
       */
      mustChangePassword: true,
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

    return { user: savedUser, generatedPassword };
  }

  /**
   * The initial password for a web account: 16 characters from an alphabet with no l/I/1/O/0,
   * because this gets read off a screen or dictated over a phone and a misread character costs
   * a support call. `randomInt` is Node's CSPRNG and is rejection-sampled internally, so unlike
   * a `% alphabet.length` fold over raw bytes it draws each character uniformly.
   *
   * Note this is deliberately not the assayer module's short sayable form: web users type on
   * keyboards and only ever need this password once, so strength costs them nothing.
   */
  private generateInitialPassword(): string {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789@#%+=?';
    let out = '';
    for (let i = 0; i < 16; i++) out += alphabet[randomInt(alphabet.length)];
    return out;
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
    let regionsChanged = false;
    if (dto.regions !== undefined) {
      // Canonicalise and reject junk here, not in the DB: a typo'd region stored on a user
      // would silently widen or narrow what they can see.
      const cleaned = (dto.regions ?? []).filter(isRegion);
      if ((dto.regions ?? []).length !== cleaned.length) {
        throw new BadRequestException(
          `Regions must be canonical values: ${Object.values(Region).join(', ')}.`,
        );
      }
      const next = cleaned.length > 0 ? [...new Set(cleaned)] : null;
      regionsChanged = JSON.stringify(next) !== JSON.stringify(user.regions ?? null);
      user.regions = next;
    }

    user.updatedBy = updatedById;

    const saved = await this.userRepository.save(user);

    // The principal (roles + regions) is cached in Redis for the JWT hot path. A region
    // change must take effect on the next request, not when the TTL happens to expire —
    // `user:role-changed` is the invalidation the auth service already listens for.
    if (regionsChanged) {
      this.eventPublisher.publish('user:role-changed', { userId: saved.id });
    }

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

  /** The whole permission catalogue, for the role editor's matrix. */
  async findAllPermissions(): Promise<PermissionEntity[]> {
    return this.permissionRepository.find({
      order: { resource: 'ASC', action: 'ASC', scope: 'ASC' },
    });
  }

  /**
   * Whether a role name is one the code itself checks.
   *
   * `@Roles(SystemRole.X)` decorators compare against these names in 256 places, and the web
   * app's route table lists them too. Renaming or deleting one would silently revoke access
   * everywhere it is referenced, so built-in roles are edit-restricted: their permissions and
   * description can change, their identity cannot.
   */
  private isSystemRole(name: string): boolean {
    return (Object.values(SystemRole) as string[]).includes(name);
  }

  /**
   * Invalidate the cached RBAC principal of everyone holding this role.
   *
   * Permission changes must take effect without waiting out `RBAC_CACHE_TTL_SECONDS` or asking
   * people to sign out. `user:role-changed` is the event the auth service already listens for,
   * and because the cache is shared Redis, publishing once clears it across every replica.
   */
  private async invalidateRoleHolders(roleId: string): Promise<void> {
    const holders = await this.userRepository
      .createQueryBuilder('u')
      .select('u.id', 'id')
      .innerJoin('user_roles', 'ur', 'ur.user_id = u.id')
      .where('ur.role_id = :roleId', { roleId })
      .getRawMany();

    for (const h of holders) {
      this.eventPublisher.publish('user:role-changed', { userId: h.id });
    }
  }

  async createRole(
    dto: { name: string; displayName: string; description?: string; permissionIds?: string[] },
    actorId: string,
  ): Promise<RoleEntity> {
    const name = dto.name.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!name) throw new BadRequestException('A role name is required.');

    const existing = await this.roleRepository.findOne({ where: { name } });
    if (existing) throw new ConflictException(`A role named ${name} already exists.`);

    const permissions = dto.permissionIds?.length
      ? await this.permissionRepository.find({ where: { id: In(dto.permissionIds) } })
      : [];

    const role = await this.roleRepository.save(
      this.roleRepository.create({
        name,
        displayName: dto.displayName?.trim() || name,
        description: dto.description ?? null,
        permissions,
        createdBy: actorId,
        updatedBy: actorId,
      } as any),
    );

    await this.auditService.recordEventSafe({
      category: EventCategory.USER,
      eventType: 'ROLE_CREATED',
      entityType: 'ROLE',
      entityId: (role as any).id,
      userId: actorId,
      remarks: `Role ${name} created with ${permissions.length} permission(s).`,
    });

    return role as any;
  }

  async updateRole(
    id: string,
    dto: { displayName?: string; description?: string },
    actorId: string,
  ): Promise<RoleEntity> {
    const role = await this.roleRepository.findOne({ where: { id }, relations: ['permissions'] });
    if (!role) throw new NotFoundException('Role not found.');

    // `name` is deliberately not updatable for anyone — it is the identifier the guards compare.
    if (dto.displayName !== undefined) role.displayName = dto.displayName.trim() || role.displayName;
    if (dto.description !== undefined) role.description = dto.description as any;
    role.updatedBy = actorId;

    const saved = await this.roleRepository.save(role);

    await this.auditService.recordEventSafe({
      category: EventCategory.USER,
      eventType: 'ROLE_UPDATED',
      entityType: 'ROLE',
      entityId: id,
      userId: actorId,
      remarks: `Role ${role.name} details updated.`,
    });

    return saved;
  }

  /**
   * Replace a role's permission set. This is the control that actually changes what people can
   * do — the PermissionsGuard builds its allow-set from these rows on every request.
   */
  async setRolePermissions(id: string, permissionIds: string[], actorId: string): Promise<RoleEntity> {
    const role = await this.roleRepository.findOne({ where: { id }, relations: ['permissions'] });
    if (!role) throw new NotFoundException('Role not found.');

    const permissions = permissionIds.length
      ? await this.permissionRepository.find({ where: { id: In(permissionIds) } })
      : [];

    if (permissions.length !== permissionIds.length) {
      throw new BadRequestException('One or more permissions do not exist.');
    }

    /**
     * A super administrator that can no longer administer is an unrecoverable lockout: nobody
     * left in the system could grant the permission back. Refused rather than trusted to a
     * confirmation dialog.
     */
    if (role.name === SystemRole.SUPER_ADMINISTRATOR && permissions.length === 0) {
      throw new BadRequestException(
        'The Super Administrator role cannot be stripped of every permission — no one would be able to restore access.',
      );
    }

    const before = role.permissions?.length ?? 0;
    role.permissions = permissions;
    role.updatedBy = actorId;
    const saved = await this.roleRepository.save(role);

    await this.auditService.recordEventSafe({
      category: EventCategory.USER,
      eventType: 'ROLE_PERMISSIONS_CHANGED',
      entityType: 'ROLE',
      entityId: id,
      userId: actorId,
      remarks: `Role ${role.name} permissions changed: ${before} → ${permissions.length}.`,
      metadata: { roleName: role.name, permissionCount: permissions.length },
    });

    await this.invalidateRoleHolders(id);
    return saved;
  }

  async deleteRole(id: string, actorId: string): Promise<void> {
    const role = await this.roleRepository.findOne({ where: { id } });
    if (!role) throw new NotFoundException('Role not found.');

    if (this.isSystemRole(role.name)) {
      throw new BadRequestException(
        `${role.name} is a built-in role the application's access rules refer to by name. It cannot be deleted — edit its permissions instead.`,
      );
    }

    // Deleting a role out from under its holders would silently strip their access.
    const holders = await this.userRepository
      .createQueryBuilder('u')
      .innerJoin('user_roles', 'ur', 'ur.user_id = u.id')
      .where('ur.role_id = :id', { id })
      .getCount();

    if (holders > 0) {
      throw new ConflictException(
        `${holders} user(s) still hold this role. Reassign them before deleting it.`,
      );
    }

    await this.roleRepository.remove(role);

    await this.auditService.recordEventSafe({
      category: EventCategory.USER,
      eventType: 'ROLE_DELETED',
      entityType: 'ROLE',
      entityId: id,
      userId: actorId,
      remarks: `Role ${role.name} deleted.`,
    });
  }
}
