import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerEntity } from './assayer.entity';

/**
 * A staff remark about an assayer — the one place a human observation about a field worker is
 * written down so that it can be read back later, and so that it can move a recommendation.
 *
 * The table predates the scored version of this feature (it was free text with an optional
 * 0–5 rating no screen ever set). Rather than add a second remarks table, the recommendation
 * signal was built on this one — see migration AssayerRemarkRatings1791430000000 and
 * modules/assayer-remarks for the service, the permission model and the scorer.
 *
 * All reads and writes go through AssayerRemarksService and `/assayer-remarks`; it is the single
 * writer to this table. AssayerService keeps only `recomputeAverageRating`, which derives the
 * profile's cached 1–5 figure from these rows.
 */
@Entity('assayer_remarks')
@Index(['assayerId'])
@Index(['category'])
// What the drawer lists and the scorer loads: one assayer (or a pool of them), newest first,
// live rows only. Partial so it stays proportional to what is actually shown.
@Index('idx_assayer_remarks_assayer_recent', ['assayerId', 'createdAt'], { where: '"is_active" = true' })
export class AssayerRemarkEntity extends BaseEntity {
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;

  @Column({ name: 'author_id', type: 'uuid' })
  authorId: string;

  @Column({ name: 'author_name', length: 200 })
  authorName: string;

  /**
   * The role the author held when they wrote this — a snapshot, not a join to the live user.
   * A remark reads differently coming from the validation desk than from operations, and the
   * author may hold neither role by the time it is read.
   */
  @Column({ name: 'author_role', type: 'varchar', length: 50, nullable: true })
  authorRole: string | null;

  @Column({ type: 'text' })
  content: string;

  /** One of AssayerRemarkCategory. Free string at the column so older 'GENERAL' rows still load. */
  @Column({ length: 50, default: 'GENERAL' })
  category: string;

  @Column({ length: 50, default: 'PUBLIC' })
  visibility: string;

  @Column({ name: 'attachment_paths', type: 'jsonb', default: [] })
  attachmentPaths: string[];

  /**
   * −2 (serious concern) … 0 (neutral note) … +2 (exemplary). Bounded by a CHECK constraint so
   * the remarks score, `50 + 25 × weighted mean`, is bounded to 0–100 by construction. NULL is
   * a note that carries no score.
   */
  @Column({ type: 'smallint', nullable: true })
  rating: number | null;

  /** The job this remark is about, when it is about one job. Null for a general observation. */
  @Column({ name: 'assignment_id', type: 'uuid', nullable: true })
  assignmentId: string | null;
}
