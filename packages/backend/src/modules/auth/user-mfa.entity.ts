import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { encryptedColumn } from '../../infrastructure/security/field-encryption';

/**
 * A user's enrolled MFA factor. `secretEncrypted` rides the same at-rest encryption transformer as
 * the other sensitive columns, so the TOTP shared secret is never stored or logged in plaintext.
 * `confirmedAt` null => enrolled but not yet activated (a code has not been proven), which never
 * gates login.
 */
@Entity('user_mfa')
@Index('UQ_user_mfa_user_type', ['userId', 'type'], { unique: true })
export class UserMfaEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'type', type: 'varchar', length: 16, default: 'TOTP' })
  type: string;

  @Column({ name: 'secret_encrypted', type: 'text', transformer: encryptedColumn })
  secret: string;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt: Date | null;

  @Column({ name: 'failed_attempts', type: 'int', default: 0 })
  failedAttempts: number;

  @Column({ name: 'locked_until', type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
