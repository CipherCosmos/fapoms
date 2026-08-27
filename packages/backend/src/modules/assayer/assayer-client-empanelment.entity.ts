import { Entity, Column, ManyToOne, JoinColumn, Index, Unique } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { EmpanelmentStatus } from '@fapoms/shared';
import { AssayerEntity } from './assayer.entity';
import { ClientEntity } from '../client/client.entity';

/**
 * Where one assayer stands with one client.
 *
 * In the spreadsheet this is a column per client — `ICICI Status`, `ICICI Documents required`,
 * `Available documents` — with AU Small and RBL appearing only in free-text remarks. Every new
 * client means new columns, and the answer for one client tells you nothing about another: the
 * same person is `Active` for Axis and `Not recommended` for ICICI on the same row.
 *
 * It is a fact about the pair, so it is stored as one. That also makes the questions operations
 * actually ask answerable: who may I send to this client's branches, and who is stuck waiting
 * on that client's paperwork.
 */
@Entity('assayer_client_empanelments')
@Index(['assayerId'])
@Index(['clientId'])
@Index(['status'])
// One standing per pair. Two rows would mean two answers to "may we send them", and nothing
// would say which one counts.
@Unique('UQ_assayer_client_empanelment', ['assayerId', 'clientId'])
export class AssayerClientEmpanelmentEntity extends BaseEntity {
  @Column({ name: 'assayer_id', type: 'uuid' })
  assayerId: string;

  @ManyToOne(() => AssayerEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'assayer_id' })
  assayer: AssayerEntity;

  @Column({ name: 'client_id', type: 'uuid' })
  clientId: string;

  @ManyToOne(() => ClientEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'client_id' })
  client: ClientEntity;

  @Column({ type: 'varchar', length: 30, default: EmpanelmentStatus.RECOMMENDED })
  status: EmpanelmentStatus;

  /**
   * Why the client decided as they did, in their words.
   *
   * "Terminated / Fake not identified" and "Terminated / Process not followed" are the same
   * status and very different facts; the status is what queries filter on and this is what a
   * person needs to read before putting somebody forward again.
   */
  @Column({ name: 'status_reason', type: 'text', nullable: true })
  statusReason: string | null;

  /** What this client still wants before they will empanel — their list, not ours. */
  @Column({ name: 'documents_outstanding', type: 'text', nullable: true })
  documentsOutstanding: string | null;

  /** The client's own identifier for this assayer, where they issue one. */
  @Column({ name: 'client_reference_code', type: 'varchar', length: 60, nullable: true })
  clientReferenceCode: string | null;

  @Column({ name: 'decided_at', type: 'timestamptz', nullable: true })
  decidedAt: Date | null;

  @Column({ type: 'text', nullable: true })
  remarks: string | null;
}
