import { Entity, Column, ManyToOne, JoinColumn, Index, Unique } from 'typeorm';
import { BaseEntity } from '../../core/entities/base.entity';
import { OnboardingDocument } from '@fapoms/shared';
import { AssayerApplicationEntity } from './assayer-application.entity';

/**
 * A document a candidate uploaded before they were a real assayer.
 *
 * Deliberately its OWN table, not a nullable-`assayerId` reuse of `AssayerDocumentEntity`. That
 * entity's real write path (`RosterRecordsService.setDocument`) assumes a live, tenant-owned
 * assayer — it writes PAN/Aadhaar straight onto `assayers.pan_number`/`aadhaar_number`, runs
 * Verhoeff/PAN format checks, and carries a `UNIQUE(assayerId, requirement)` that a second,
 * mutually-exclusive nullable FK would only complicate. This table is deliberately thin: it just
 * holds scans until an application is approved, at which point each row is replayed through
 * `RosterRecordsService`'s attach/`setDocument` path onto the newly-promoted assayer (see
 * `AssayerApplicationEntity` for why that re-homing step is explicit, not automatic).
 */
@Entity('assayer_application_documents')
@Index(['applicationId'])
@Unique('UQ_application_document_requirement', ['applicationId', 'requirement'])
export class AssayerApplicationDocumentEntity extends BaseEntity {
  @Column({ name: 'application_id', type: 'uuid' })
  applicationId: string;

  @ManyToOne(() => AssayerApplicationEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'application_id' })
  application: AssayerApplicationEntity;

  @Column({ type: 'varchar', length: 40 })
  requirement: OnboardingDocument;

  @Column({ name: 'file_paths', type: 'jsonb', default: () => "'[]'::jsonb" })
  filePaths: string[];
}
