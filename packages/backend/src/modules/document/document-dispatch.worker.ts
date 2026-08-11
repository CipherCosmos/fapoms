import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentEntity } from './document.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { DocumentService } from './document.service';
import { DocumentStatus, DocumentType, AssignmentStatus, DispatchMethod, businessDateKey } from '@fapoms/shared';

@Injectable()
@Processor('document-dispatch')
export class DocumentDispatchWorker {
  private readonly logger = new Logger(DocumentDispatchWorker.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    private readonly documentService: DocumentService,
  ) {}

  @Process('auto-dispatch')
  async autoDispatch(job: Job) {
    this.logger.log('Running auto-dispatch scan...');

    const docs = await this.documentRepository.find({
      where: {
        type: DocumentType.PRE_FIELD_AUDIT_PDF,
        status: DocumentStatus.UPLOADED,
        isActive: true,
      },
      relations: ['assessment', 'assessment.project', 'assessment.branch'],
    });

    let dispatchedCount = 0;
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    // Business-timezone dates so the "one day before the audit" window lines up with the IST audit
    // date, not the UTC calendar day (which flips 5.5h early).
    const tomorrowStr = businessDateKey(tomorrow);

    // The audit date is owned by project_branches.scheduled_date — that is what
    // scheduling writes and what a reschedule updates. `assessments.audit_date` is
    // a copy made by syncAssessmentStatus, and only when the status *changes*, so
    // it is absent for branches whose assignment has not transitioned yet and goes
    // stale whenever a branch is rescheduled without a status change. Keying
    // auto-dispatch off that copy meant packets for those branches were never sent
    // at all, or sent against an out-of-date date.
    const scheduledRows: Array<{ project_id: string; branch_id: string; scheduled_date: string | null }> =
      await this.documentRepository.manager.query(
        `SELECT project_id, branch_id, scheduled_date
           FROM project_branches
          WHERE is_active = true AND scheduled_date IS NOT NULL`,
      );
    const scheduledByBranch = new Map(
      scheduledRows.map((r) => [`${r.project_id}:${r.branch_id}`, r.scheduled_date]),
    );

    for (const doc of docs) {
      if (!doc.assessment) continue;

      const scheduled = scheduledByBranch.get(`${doc.assessment.projectId}:${doc.assessment.branchId}`);
      const auditDate = scheduled ? businessDateKey(scheduled) : null;
      if (!auditDate) {
        // No confirmed date yet — nothing to dispatch against.
        continue;
      }

      // Spec §12.6: release the packet one day before the audit. `<= tomorrow` also
      // catches anything already due, so a packet uploaded late still goes out
      // immediately rather than waiting for a date that has passed.
      const isDueTomorrow = auditDate === tomorrowStr || new Date(auditDate) <= tomorrow;

      const assignment = await this.assignmentRepository.findOne({
        where: {
          assessmentId: doc.assessment.id,
          status: AssignmentStatus.ACCEPTED,
          isActive: true,
        },
      });

      if (assignment && isDueTomorrow) {
        try {
          await this.documentService.dispatchDocument(doc.id, 'SYSTEM', DispatchMethod.AUTO);
          dispatchedCount++;
          this.logger.log(`Auto-dispatched document ${doc.id} for assessment ${doc.assessment.id} (Scheduled: ${auditDate})`);
        } catch (err) {
          this.logger.error(`Failed to auto-dispatch document ${doc.id}:`, err);
        }
      }
    }

    this.logger.log(`Auto-dispatch complete: ${dispatchedCount} documents dispatched.`);
    return { dispatchedCount };
  }
}
