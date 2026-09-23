import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { BackgroundCheckVerdict, RiskGrade, CibilBand, CheckType } from '@fapoms/shared';
import { AssayerEntity } from './assayer.entity';

/**
 * What a background or credit check found, and when.
 *
 * The roster keeps this as four columns holding one moment in time — the latest check
 * overwrites the last. A row per check keeps the history, which matters because these are the
 * grounds on which somebody is sent into a bank vault: "cleared in 2022, civil case found in
 * 2026" is a different fact from either check alone, and the column version can only ever show
 * the second.
 *
 * The verdict and the risk grade are separate because the spreadsheet writes them together —
 * "Criminal Case / Civil Case / Very High risk" — and they answer different questions. A civil
 * matter graded low risk and a criminal one graded very high are both "not clear", and nobody
 * would treat them the same.
 */
@Entity('assayer_background_checks')
@Index(['assayerId'])
@Index(['verdict'])
export class AssayerBackgroundCheckEntity extends BaseEntity {
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;

  /**
   * Which check this was — background verification, police verification, a credit check or an
   * identity-documents re-check (2026-09-23). They repeat over time on their own schedules; see
   * `periodic-checks.ts` in shared.
   */
  @Column({ name: 'check_type', type: 'varchar', length: 20, default: CheckType.BGV })
  checkType: CheckType;

  @Column({ type: 'varchar', length: 30, default: BackgroundCheckVerdict.NOT_CHECKED })
  verdict: BackgroundCheckVerdict;

  @Column({ name: 'risk_grade', type: 'varchar', length: 20, nullable: true })
  riskGrade: RiskGrade | null;

  /** The bureau score itself, kept alongside the band so a threshold can be changed later. */
  @Column({ name: 'cibil_score', type: 'int', nullable: true })
  cibilScore: number | null;

  @Column({ name: 'cibil_band', type: 'varchar', length: 30, nullable: true })
  cibilBand: CibilBand | null;

  @Column({ name: 'checked_on', type: 'date', nullable: true })
  checkedOn: Date | null;

  /** The agency or person who ran it. */
  @Column({ name: 'checked_by_name', type: 'varchar', length: 200, nullable: true })
  checkedByName: string | null;

  @Column({ type: 'text', nullable: true })
  findings: string | null;

  /**
   * The report files this check was read from — the evidence for its result, kept per check so a
   * "not passed" and the later "passed" each point at their own report. Filled when the check is
   * recorded, from the report files no earlier check has claimed; never changed afterwards, and a
   * file listed here cannot be removed from the record.
   */
  @Column({ name: 'report_files', type: 'jsonb', default: () => "'[]'::jsonb" })
  reportFiles: BackgroundCheckReportFile[];

  /**
   * An adverse re-check on somebody already working goes to a senior: PENDING until they decide,
   * then KEPT or SUSPENDED. Null for everything else — a check at joining is decided by onboarding.
   */
  @Column({ name: 'review_status', type: 'varchar', length: 20, nullable: true })
  reviewStatus: 'PENDING' | 'KEPT' | 'SUSPENDED' | null;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedBy: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  @Column({ name: 'review_reason', type: 'text', nullable: true })
  reviewReason: string | null;
}

/** One file of a check's report: where it sits on the BGV_REPORT document, and which upload it was. */
export interface BackgroundCheckReportFile {
  documentId: string;
  /** The upload's version row — what the retained-file route serves. Null only without versioning. */
  versionId: string | null;
  path: string;
  uploadedAt: string | null;
}
