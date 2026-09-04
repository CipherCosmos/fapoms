import {
  Entity, PrimaryGeneratedColumn, Column, Index, CreateDateColumn, UpdateDateColumn,
} from 'typeorm';

/**
 * A security incident, and the two statutory clocks a bank vendor in India must answer to.
 *
 * The point of this register is not to report FOR the operator — reporting is a human judgement call
 * made to external bodies — but to make the deadlines impossible to miss:
 *   - CERT-In Directions 2022: report a cyber incident within 6 HOURS of noticing it.
 *   - DPDP Rules 2025: on a personal-data breach, notify the Data Protection Board without delay and
 *     the affected Data Principals within 72 HOURS.
 *
 * So each row carries when the incident was detected, and the milestones as they are reached
 * (CERT-In reported, Board notified, principals notified). The service computes the deadlines and
 * how much time is left from `detectedAt`, so "which incidents are about to breach a statutory
 * clock" is answerable at a glance rather than reconstructed from memory during an actual incident.
 */
@Entity('security_incidents')
@Index('IDX_security_incidents_status', ['status'])
@Index('IDX_security_incidents_detected', ['detectedAt'])
export class SecurityIncidentEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 200 })
  title: string;

  @Column({
    type: 'varchar',
    length: 32,
    comment: 'CERT-In Annexure I category, e.g. UNAUTHORISED_ACCESS, DATA_BREACH, MALWARE, DOS.',
  })
  category: string;

  @Column({ type: 'varchar', length: 16, comment: 'LOW | MEDIUM | HIGH | CRITICAL' })
  severity: string;

  @Column({
    type: 'varchar',
    length: 24,
    default: 'OPEN',
    comment: 'OPEN | CONTAINED | RESOLVED | CLOSED — the lifecycle; reporting milestones are separate timestamps.',
  })
  status: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** When the incident was NOTICED — the moment both statutory clocks start from. */
  @Column({ name: 'detected_at', type: 'timestamptz' })
  detectedAt: Date;

  /**
   * Whether personal data was (or may have been) involved. This is what turns on the DPDP
   * obligations — the Board and Data-Principal clocks only apply to a PERSONAL-DATA breach.
   */
  @Column({ name: 'personal_data_involved', type: 'boolean', default: false })
  personalDataInvolved: boolean;

  @Column({ name: 'affected_data_principals', type: 'integer', nullable: true })
  affectedDataPrincipals: number | null;

  // ── Reporting milestones (null until reached) ──────────────────────────────
  @Column({ name: 'cert_in_reported_at', type: 'timestamptz', nullable: true })
  certInReportedAt: Date | null;

  @Column({ name: 'board_notified_at', type: 'timestamptz', nullable: true })
  boardNotifiedAt: Date | null;

  @Column({ name: 'principals_notified_at', type: 'timestamptz', nullable: true })
  principalsNotifiedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  remediation: string | null;

  @Column({ name: 'created_by', type: 'uuid', nullable: true })
  createdBy: string | null;

  @Column({ name: 'resolved_at', type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
