import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { BackgroundCheckVerdict, RiskGrade, CibilBand } from '@fapoms/shared';
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
}
