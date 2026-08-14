import { Entity, Column, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';

/**
 * One operator-saved value for a key in `SETTINGS_REGISTRY`.
 *
 * Only saved values live here. A key nobody has touched has no row, and resolves from the
 * environment or the shipped default instead — the same override-not-copy model the
 * notification catalog uses, and for the same reason: a table pre-filled with today's defaults
 * would freeze them into every environment and quietly stop later releases from improving them.
 */
@Entity('platform_settings')
// Declared on the entity as well as in the migration: this environment runs synchronize=true,
// which rebuilds tables from the entity class and drops migration-only indexes.
@Index('uq_platform_settings_key', ['key'], { unique: true })
export class PlatformSettingEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 100 })
  key: string;

  /**
   * Stored as JSON so a number stays a number and a boolean stays a boolean — a settings table
   * of stringly-typed values is where "false" starts meaning true.
   *
   * For a secret, this holds the ciphertext produced by `encryptField`, and the plaintext never
   * leaves the server after it is written.
   */
  @Column({ type: 'jsonb', nullable: true })
  value: any;

  /** Mirrors the registry, so a row can be recognised as sensitive without consulting it. */
  @Column({ name: 'is_secret', type: 'boolean', default: false })
  isSecret: boolean;
}
