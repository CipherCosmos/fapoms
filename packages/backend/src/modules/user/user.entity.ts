/**
 * FAPOMS — User Entity
 *
 * Represents an internal platform user (Part 2 §11, Part 8).
 * Users have roles, permissions, and organizational scope.
 */

import { Entity, Column, ManyToMany, JoinTable, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { RoleEntity } from './role.entity';

@Entity('users')
export class UserEntity extends BaseEntity {
  @Column({ unique: true, length: 100 })
  username: string;

  @Index()
  @Column({ unique: true, length: 255 })
  email: string;

  @Column({ name: 'password_hash', length: 255 })
  passwordHash: string;

  @Column({ name: 'first_name', length: 100 })
  firstName: string;

  @Column({ name: 'last_name', length: 100 })
  lastName: string;

  @Column({ name: 'display_name', length: 200 })
  displayName: string;

  @Column({
    type: 'varchar',
    length: 20,
    default: 'ACTIVE',
    comment: 'User status: INVITED, ACTIVE, SUSPENDED, LOCKED, DISABLED, ARCHIVED',
  })
  status: string;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ name: 'department_id', type: 'uuid', nullable: true })
  departmentId: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string | null;

  @Column({ name: 'last_login_at', type: 'timestamptz', nullable: true })
  lastLoginAt: Date | null;

  @Column({ name: 'failed_login_attempts', type: 'int', default: 0 })
  failedLoginAttempts: number;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  /**
   * Forces a password change at next sign-in.
   *
   * Set on any account whose password was issued by someone else — seeded accounts and
   * staff-initiated resets — so a credential the account holder did not choose cannot remain
   * in use indefinitely. This deployment needs it: every seeded account currently shares one
   * of two well-known passwords.
   */
  @Column({ name: 'must_change_password', type: 'boolean', default: false })
  mustChangePassword: boolean;


  @ManyToMany(() => RoleEntity, { eager: true })
  @JoinTable({
    name: 'user_roles',
    joinColumn: { name: 'user_id' },
    inverseJoinColumn: { name: 'role_id' },
  })
  roles: RoleEntity[];
}
