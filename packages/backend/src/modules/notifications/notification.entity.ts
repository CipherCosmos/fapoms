import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { UserEntity } from '../user/user.entity';
import { AssayerEntity } from '../assayer/assayer.entity';

/**
 * A notification is addressed to exactly one recipient, which may be either an internal
 * **user** or an **assayer** — two separate identity spaces (assayers authenticate directly
 * from the `assayers` table and have no `users` row).
 *
 * `user_id` was previously non-null with a hard FK to `users`, which made notifying an assayer
 * impossible: every attempt threw a foreign-key violation that callers swallowed in try/catch,
 * so dispatch and clarification notifications silently never reached the field. Meanwhile the
 * read path already assumed otherwise — an assayer's JWT carries `sub: assayer.id`, and
 * `findMyNotifications` looks up notifications by that id.
 *
 * Both columns are therefore nullable with their own FK, and exactly one is set per row.
 * Integrity is preserved for each recipient type rather than dropping the constraint.
 */
@Entity('notifications')
@Index(['userId'])
@Index(['assayerId'])
@Index(['isRead'])
export class NotificationEntity extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  /** Set instead of `userId` when the recipient is a field assayer. */
  @Column({ name: 'assayer_id', type: 'uuid', nullable: true })
  assayerId: string | null;

  @Column({ length: 255 })
  title: string;

  @Column({ type: 'text' })
  message: string;

  @Column({ name: 'is_read', type: 'boolean', default: false })
  isRead: boolean;

  @Column({ name: 'link', type: 'varchar', length: 255, nullable: true })
  link: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'user_id' })
  user: UserEntity | null;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity | null;
}
