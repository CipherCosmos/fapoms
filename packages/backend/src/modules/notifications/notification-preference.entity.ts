import { Entity, Column, Index } from 'typeorm';
import { NotificationCategory } from '@fapoms/shared';
import { BaseEntity } from '../../core/entities/base.entity';

/**
 * Per-recipient, per-category channel preferences.
 *
 * Deliberately opt-out: a missing row means "send everything". Modelling it the
 * other way would mute every existing user the moment this shipped, since none
 * of them have ever visited a preferences screen. The delivery worker therefore
 * treats absence as consent and only suppresses on an explicit `false`.
 *
 * Recipients are either a staff user or an assayer, never both — the same split
 * identity model the notifications table uses, enforced by a check constraint.
 *
 * The two indexes are unique and partial on purpose, not just for lookup speed:
 * without the uniqueness, a race between two toggles on the same category could
 * leave two preference rows for one recipient, and `setPreference`'s find-then-save
 * would silently start editing whichever one it happened to read.
 */
@Entity('notification_preferences')
@Index('UQ_notif_pref_user_cat', ['userId', 'category'], { unique: true, where: '"user_id" IS NOT NULL' })
@Index('UQ_notif_pref_assayer_cat', ['assayerId', 'category'], { unique: true, where: '"assayer_id" IS NOT NULL' })
export class NotificationPreferenceEntity extends BaseEntity {
  @Column({ name: 'user_id', type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ name: 'assayer_id', type: 'uuid', nullable: true })
  assayerId: string | null;

  @Column({ type: 'varchar', length: 32 })
  category: NotificationCategory;

  @Column({ name: 'in_app', type: 'boolean', default: true })
  inApp: boolean;

  @Column({ type: 'boolean', default: true })
  push: boolean;

  @Column({ type: 'boolean', default: false })
  email: boolean;
}
