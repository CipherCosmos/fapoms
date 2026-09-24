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

  // `select: false`: the hash never loads on an ordinary read, so it cannot ride out in a raw
  // entity return and — the real exposure — it is no longer pulled into the Redis principal cache
  // by validateJwtPayload. The two places that legitimately need it (login, change-password) opt
  // back in explicitly.
  @Column({ name: 'password_hash', length: 255, select: false })
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

  /**
   * The client (bank) this account is confined to — set on CLIENT_USER accounts, `null` for
   * every staff account. `null` means unrestricted, the same convention `regions` uses, so
   * this column being absent on every pre-existing account changes nothing until an admin
   * deliberately assigns one. Enforced by `resolveClientScope` in `global-scope.ts`.
   */
  @Column({ name: 'client_id', type: 'uuid', nullable: true })
  clientId: string | null;

  /**
   * Operational regions this account may read.
   *
   * `null` or `[]` means every region — the pre-existing behaviour, so accounts that predate
   * region scoping keep full visibility until someone deliberately narrows them. A non-empty
   * array is a hard ceiling enforced in `resolveGlobalScope`, not a UI default: an operator
   * assigned `['WEST']` cannot widen back to all regions by editing the query string.
   */
  @Column({ type: 'text', array: true, nullable: true })
  regions: string[] | null;

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

  /**
   * THE LINK THAT LETS SOMEBODY CHOOSE THEIR OWN PASSWORD.
   *
   * Only the hash is stored, the same discipline the candidate invite uses: a token readable in
   * the database is a password readable in the database. Set when an account is created or when an
   * administrator sends a reset; cleared the moment it is used, so a link works exactly once.
   *
   * This exists so that nobody ever types a password on somebody else's behalf — the old flow had
   * an administrator inventing one and passing it on by WhatsApp.
   */
  // `select: false`, like the password hash: until spent, the link this hashes IS a password, so
  // the hash must not ride along on ordinary reads (the principal cache, GET /users). The one
  // lookup that needs it filters on it in the WHERE, which select:false does not affect.
  @Column({ name: 'password_setup_token_hash', type: 'varchar', length: 64, nullable: true, select: false })
  passwordSetupTokenHash: string | null;

  @Column({ name: 'password_setup_expires_at', type: 'timestamptz', nullable: true })
  passwordSetupExpiresAt: Date | null;

  /** When the link was last sent, so the screen can say "sent 2 minutes ago" and rate-limit resends. */
  @Column({ name: 'password_setup_sent_at', type: 'timestamptz', nullable: true })
  passwordSetupSentAt: Date | null;


  @ManyToMany(() => RoleEntity)
  @JoinTable({
    name: 'user_roles',
    joinColumn: { name: 'user_id' },
    inverseJoinColumn: { name: 'role_id' },
  })
  roles: RoleEntity[];
}
