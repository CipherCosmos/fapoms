import { Column, Entity, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { ValidationQueryEntity } from './validation-query.entity';

/** Who wrote a clarification message. */
export enum QueryMessageAuthor {
  STAFF = 'STAFF',
  ASSAYER = 'ASSAYER',
}

/**
 * One message in a clarification thread.
 *
 * A clarification used to be a single question and a single answer, which does not
 * survive contact with real audit paperwork — the desk asks, the assayer replies
 * with a photo, the desk asks about a second field, and so on.
 *
 * `pageNumber` + `region` optionally pin a message to a rectangle on the returned
 * PDF, so "this weight looks wrong" points at the actual cell rather than being
 * described in prose. Coordinates are normalised 0..1 against the page box, so
 * they hold at any zoom or render width.
 */
@Entity('validation_query_messages')
@Index(['validationQueryId', 'createdAt'])
export class ValidationQueryMessageEntity extends BaseEntity {
  @Column({ name: 'validation_query_id', type: 'uuid' })
  validationQueryId: string;

  @ManyToOne(() => ValidationQueryEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'validation_query_id' })
  query?: ValidationQueryEntity;

  @Column({ name: 'author_type', type: 'enum', enum: QueryMessageAuthor })
  authorType: QueryMessageAuthor;

  @Column({ name: 'author_id', type: 'uuid' })
  authorId: string;

  @Column({ name: 'author_name', type: 'varchar', length: 200, nullable: true })
  authorName: string | null;

  @Column({ name: 'body', type: 'text', nullable: true })
  body: string | null;

  @Column({ name: 'attachments', type: 'jsonb', nullable: true })
  attachments: { url: string; fileName: string; fileType: string }[] | null;

  /** 1-based page of the returned PDF this message refers to. */
  @Column({ name: 'page_number', type: 'int', nullable: true })
  pageNumber: number | null;

  /** Normalised rectangle on that page: { x, y, w, h } each 0..1. */
  @Column({ name: 'region', type: 'jsonb', nullable: true })
  region: { x: number; y: number; w: number; h: number } | null;

  /** Cropped image of `region`, captured in the browser and uploaded. */
  @Column({ name: 'snapshot_path', type: 'varchar', length: 500, nullable: true })
  snapshotPath: string | null;

  /** Quoted message ID for WhatsApp-style reply threads. */
  @Column({ name: 'reply_to_message_id', type: 'uuid', nullable: true })
  replyToMessageId: string | null;

  /** Preview of quoted message: { authorName, body }. */
  @Column({ name: 'reply_to_summary', type: 'jsonb', nullable: true })
  replyToSummary: { authorName: string; body: string } | null;

  /** Emoji reactions: [{ emoji, userId, userName, timestamp }]. */
  @Column({ name: 'reactions', type: 'jsonb', nullable: true })
  reactions: { emoji: string; userId: string; userName: string; timestamp: string }[] | null;

  /** Image annotation overlays (drawing paths, highlight boxes, callout text). */
  @Column({ name: 'annotations', type: 'jsonb', nullable: true })
  annotations: { type: string; color: string; coords: any; text?: string }[] | null;

  /** Voice note recording metadata: { url, durationSeconds, mimeType }. */
  @Column({ name: 'voice_note', type: 'jsonb', nullable: true })
  voiceNote: { url: string; durationSeconds: number; mimeType?: string } | null;

  /** Read receipt flag. */
  @Column({ name: 'is_read', type: 'boolean', default: false })
  isRead: boolean;

  /** Timestamp when message was marked read. */
  @Column({ name: 'read_at', type: 'timestamptz', nullable: true })
  readAt: Date | null;

  /** Starred/pinned message flag for key evidence snippets. */
  @Column({ name: 'is_starred', type: 'boolean', default: false })
  isStarred: boolean;
}
