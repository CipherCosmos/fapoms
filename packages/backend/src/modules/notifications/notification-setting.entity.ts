import { Entity, Column, Index } from 'typeorm';
import { NotificationChannel, NotificationPriority } from '@fapoms/shared';
import { BaseEntity } from '../../core/entities/base.entity';

/**
 * A desk-managed override of one notification type.
 *
 * `NOTIFICATION_CATALOG` in code stays the source of the *defaults* — what every event is,
 * who it reaches, and how it reads, written down where it can be reviewed in a diff. This
 * table is what lets those defaults be changed without a deploy: which channels an event
 * travels on, whether it fires at all, and the exact words it uses.
 *
 * Every column except `type` is nullable, and null means "use the code default". That is the
 * whole design: an override row records only the deltas an operator deliberately made, so a
 * catalog improvement in a later release still reaches every event nobody has customised,
 * and "reset to default" is a DELETE rather than a guess at what the original was.
 */
@Entity('notification_settings')
// Declared here as well as in the migration — this environment runs synchronize=true, which
// rebuilds tables from the entity and drops indexes that exist only in migration SQL.
@Index('uq_notification_settings_type', ['type'], { unique: true })
export class NotificationSettingEntity extends BaseEntity {
  /** The catalog key this overrides, e.g. `ASSIGNMENT_SLA_BREACHED`. */
  @Column({ type: 'varchar', length: 64 })
  type: string;

  /**
   * Master switch. False stops the event being raised at all — no row, no bell, no email.
   * Kept separate from clearing `channels` so "off for now" and "delivered differently" are
   * distinguishable later.
   */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /** Overrides the catalog's channel list. Null = code default. */
  @Column({ type: 'jsonb', nullable: true })
  channels: NotificationChannel[] | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  priority: NotificationPriority | null;

  /** Overrides which roles receive this. Null = code default. */
  @Column({ type: 'jsonb', nullable: true })
  roles: string[] | null;

  // ── Templates ───────────────────────────────────────────────────────────
  /** `${placeholder}` syntax, same as the catalog. Null = code default. */
  @Column({ name: 'title_template', type: 'text', nullable: true })
  titleTemplate: string | null;

  @Column({ name: 'body_template', type: 'text', nullable: true })
  bodyTemplate: string | null;

  /** Click-through route. Null = code default. */
  @Column({ name: 'link_template', type: 'varchar', length: 255, nullable: true })
  linkTemplate: string | null;

  /**
   * Email-specific wording. Null falls back to the in-app title/body — an email that says the
   * same thing is right far more often than it is wrong, and this exists for the cases where
   * an inbox deserves more context than a phone's lock screen.
   */
  @Column({ name: 'email_subject_template', type: 'text', nullable: true })
  emailSubjectTemplate: string | null;

  /**
   * Plain text. Line breaks become paragraphs in the sent email.
   *
   * Not HTML: the mail shell escapes what it renders, so tags typed here would arrive as
   * visible angle brackets. That is deliberate — these templates are editable from a web
   * screen, and a field that accepted markup would be a way to put arbitrary HTML into mail
   * sent under the company's name.
   */
  @Column({ name: 'email_body_template', type: 'text', nullable: true })
  emailBodyTemplate: string | null;

  /** Seconds; 0 disables burst collapse for this type. Null = code default. */
  @Column({ name: 'collapse_window_seconds', type: 'integer', nullable: true })
  collapseWindowSeconds: number | null;

  /** Why this was changed — shown beside the override so a surprising setting has a reason. */
  @Column({ type: 'text', nullable: true })
  notes: string | null;
}
