import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { AssayerEntity } from './assayer.entity';

/**
 * A cell the importer could not read, kept until a person decides what it meant.
 *
 * The roster is a spreadsheet kept by hand for years, and most of its inconsistency is case
 * rather than meaning — that is folded away silently and correctly. What is left is genuinely
 * ambiguous: the availability vocabulary appearing in the background-check column, a CIBIL
 * status of "Rejected", an empanelment of "ICICI Appraisor". Nine such values across 1,155
 * rows.
 *
 * The alternative to this table is one of two worse things. Refusing the row loses a real
 * appraiser over one bad cell. Guessing writes a fact nobody asserted into the record that
 * decides whether somebody may enter a bank vault. So the row imports, the readable part is
 * kept, and the unreadable part waits here with the original text attached.
 *
 * Rows are resolved, never deleted: what the spreadsheet said and what somebody decided it
 * meant are both worth being able to look up afterwards.
 */
@Entity('assayer_import_issues')
@Index(['assayerId'])
@Index(['resolvedAt'])
export class AssayerImportIssueEntity extends BaseEntity {
  /**
   * Nullable on purpose. A row whose assayer code was missing or unusable has no assayer to
   * hang off, and that is exactly the case most worth surfacing.
   */
  @Column({ name: 'assayer_id', type: 'uuid', nullable: true })
  assayerId: string | null;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity | null;

  /** The code as the sheet wrote it, so an unmatched row can still be found by eye. */
  @Column({ name: 'source_assayer_code', type: 'varchar', length: 60, nullable: true })
  sourceAssayerCode: string | null;

  /** Which sheet and row it came from, so somebody can go and look at it. */
  @Column({ name: 'source_sheet', type: 'varchar', length: 60 })
  sourceSheet: string;

  @Column({ name: 'source_row', type: 'int' })
  sourceRow: number;

  @Column({ name: 'source_column', type: 'varchar', length: 120 })
  sourceColumn: string;

  /** Exactly what the cell held. Never normalised — the point is to show it as written. */
  @Column({ name: 'raw_value', type: 'text' })
  rawValue: string;

  /** Why it could not be read, in words the person resolving it can act on. */
  @Column({ type: 'text' })
  reason: string;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ name: 'resolved_by', type: 'uuid', nullable: true })
  resolvedBy: string | null;

  /** What it was decided to mean, and what was done about it. */
  @Column({ name: 'resolution', type: 'text', nullable: true })
  resolution: string | null;
}
