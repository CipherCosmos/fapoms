import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DocumentEntity } from './document.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { DocumentService } from './document.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
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
    private readonly settings: PlatformSettingsService,
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

    // The audit date is owned by project_branches.scheduled_date — that is what scheduling
    // writes and what a reschedule updates. This worker used to key off `assessments.audit_date`,
    // a copy written only when the assessment's status *changed*: absent for branches whose
    // assignment had not transitioned yet, and stale whenever a branch was rescheduled without
    // one. Packets for those branches were never sent, or sent against an out-of-date date.
    // That column is gone now, along with the rest of the assessment's write-only copy of the
    // pipeline; this is the one place the date lives.
    const scheduledRows: Array<{ project_id: string; branch_id: string; scheduled_date: string | null }> =
      await this.documentRepository.manager.query(
        `SELECT project_id, branch_id, scheduled_date
           FROM project_branches
          WHERE is_active = true AND scheduled_date IS NOT NULL`,
      );
    const scheduledByBranch = new Map(
      scheduledRows.map((r) => [`${r.project_id}:${r.branch_id}`, r.scheduled_date]),
    );

    /**
     * Two passes, and the split is the point.
     *
     * The date test is free — a map lookup and a string compare — and the assignment lookup is a
     * database round trip. This loop used to run the round trip *first*, for every candidate
     * document, and only then consult `isDueTomorrow`. The candidate query above has no `take`,
     * and a document only leaves UPLOADED when it dispatches, so a branch that never gets a
     * confirmed date is in this set forever: its packet cost one wasted query on this nightly
     * scan, and would have gone on costing one every night for the life of the deployment.
     *
     * The remaining lookups are then batched into a single `In(...)` instead of one per document.
     * Behaviour is unchanged: the old code only ever tested the result for truthiness, so a set
     * of "assessment ids that have an ACCEPTED, active assignment" answers exactly the same
     * question, and the dispatch pass still walks `docs` in its original order.
     */
    // `assessmentId` is carried rather than re-read off `doc.assessment` in the second pass: the
    // `if (!doc.assessment) continue;` narrowing does not survive being stored in an array.
    const due: Array<{ doc: DocumentEntity; assessmentId: string; auditDate: string }> = [];
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
      if (!isDueTomorrow) continue;

      due.push({ doc, assessmentId: doc.assessment.id, auditDate });
    }

    // `In([])` is not a harmless empty filter in TypeORM — skip the query outright on a night
    // where nothing is due, which is most nights.
    const acceptedAssessmentIds = new Set<string>();
    if (due.length > 0) {
      const accepted = await this.assignmentRepository.find({
        where: {
          assessmentId: In([...new Set(due.map((d) => d.assessmentId))]),
          status: AssignmentStatus.ACCEPTED,
          isActive: true,
        },
        select: { id: true, assessmentId: true },
      });
      for (const a of accepted) {
        if (a.assessmentId) acceptedAssessmentIds.add(a.assessmentId);
      }
    }

    for (const { doc, assessmentId, auditDate } of due) {
      if (!acceptedAssessmentIds.has(assessmentId)) continue;

      try {
        await this.documentService.dispatchDocument(doc.id, 'SYSTEM', DispatchMethod.AUTO);
        dispatchedCount++;
        this.logger.log(`Auto-dispatched document ${doc.id} for assessment ${assessmentId} (Scheduled: ${auditDate})`);
      } catch (err) {
        this.logger.error(`Failed to auto-dispatch document ${doc.id}:`, err);
      }
    }

    this.logger.log(`Auto-dispatch complete: ${dispatchedCount} documents dispatched.`);

    const ocrSentCount = await this.autoSendToOcr();
    return { dispatchedCount, ocrSentCount };
  }

  /**
   * Push returned audit packets onward to the external OCR application without a person
   * pressing "Send to OCR" per document — but only where an operator has asked for it.
   *
   * **Why this is opt-in and not simply automatic.** The obvious trigger exists: `receiveDocument`
   * already publishes `document:received` the moment an assayer's return lands, and hanging the
   * hand-off off that event would remove the manual step entirely. It is the wrong thing to do by
   * default, because `markSentToExternalOcr` does not send anything. The OCR application is out of
   * scope (spec §1) and unintegrated; the endpoint is a *chain-of-custody stamp* recording that a
   * human carried the packet across. Firing it on receipt would write "sent to external OCR, by
   * SYSTEM" into the audit trail of a bank collateral audit for a hand-off nobody made, and — worse
   * operationally — empty the SEND_TO_OCR queue that is the only thing telling the desk there is
   * carrying to do. The packets would sit in nobody's inbox while every screen showed them in
   * progress. So the behaviour lives behind `document.autoSendToExternalOcr`, default off, for the
   * deployment that puts a real integration behind that endpoint.
   *
   * **Why the hourly sweep rather than the event.** Receipt is not the only way a document reaches
   * RECEIVED, and an event handler only sees the documents that happen to pass through while it is
   * listening — anything received during a restart, or moved by an operator, would be missed
   * forever. A sweep over "documents that are RECEIVED right now" is idempotent by construction and
   * self-healing: it converges on the correct set whatever route a document took to get there, and
   * a document already SENT_TO_EXTERNAL_OCR (or beyond) simply is not in the query.
   *
   * The manual button is untouched and remains the recovery path — which is also why failures here
   * need no new surface: a document this fails on stays at RECEIVED, so it reappears in the desk's
   * SEND_TO_OCR queue on the next refresh, exactly where an operator is already looking.
   */
  private async autoSendToOcr(): Promise<number> {
    const enabled = await this.settings
      .get<boolean>('document.autoSendToExternalOcr')
      .catch(() => false); // A settings lookup that cannot answer must not start acting on its own.
    if (!enabled) return 0;

    // The eligibility filter *is* the idempotency guard: only RECEIVED packets are picked up, and
    // markSentToExternalOcr moves them to SENT_TO_EXTERNAL_OCR, so a document already sent, in
    // progress or processed can never be selected a second time. (markSentToExternalOcr re-checks
    // the source status itself, so even two overlapping sweeps cannot double-stamp one document.)
    const received = await this.documentRepository.find({
      where: {
        type: DocumentType.AUDITED_RETURN_PDF,
        status: DocumentStatus.RECEIVED,
        isActive: true,
      },
    });

    let sentCount = 0;
    for (const doc of received) {
      try {
        await this.documentService.markSentToExternalOcr(doc.id, 'SYSTEM');
        sentCount++;
      } catch (err) {
        // Not swallowed, and not fatal to the rest of the batch: the document stays at RECEIVED and
        // so remains in the operator's "Send to OCR" queue, which is the visible symptom.
        this.logger.error(`Failed to auto-send document ${doc.id} to external OCR:`, err);
      }
    }

    if (sentCount > 0) {
      this.logger.log(`Auto-OCR complete: ${sentCount} returned packets marked sent to external OCR.`);
    }
    return sentCount;
  }
}
