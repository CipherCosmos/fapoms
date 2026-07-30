import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DocumentEntity } from './document.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { DocumentService } from './document.service';
import { DocumentStatus, DocumentType, AssignmentStatus, DispatchMethod } from '@fapoms/shared';

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
    const tomorrowStr = tomorrow.toISOString().split('T')[0];

    for (const doc of docs) {
      if (!doc.assessment) continue;

      // Section 12.6 rule: Automatically dispatch documents 1 day before the scheduled audit date
      const auditDate = doc.assessment.auditDate ? new Date(doc.assessment.auditDate).toISOString().split('T')[0] : null;
      const isDueTomorrow = auditDate === tomorrowStr || (auditDate && new Date(auditDate) <= tomorrow);

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
