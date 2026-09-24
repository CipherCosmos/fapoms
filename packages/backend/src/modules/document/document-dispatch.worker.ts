import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { DocumentEntity } from './document.entity';
import { AssignmentEntity } from '../assignment/assignment.entity';
import { COMMITTED_ASSIGNMENT_STATUSES } from '../assignment/assignment-workload';
import { DocumentService } from './document.service';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { DocumentStatus, DocumentType, DispatchMethod, businessDateKey } from '@fapoms/shared';
import { BackgroundJobTracker } from '../../infrastructure/background-jobs/background-job.tracker';
import { runAsJobActor } from '../../infrastructure/queue/job-actor';
import {
  DOCUMENT_DISPATCH_JOB,
  DOCUMENT_DISPATCH_QUEUE,
  DispatchBatchJobData,
  DispatchBatchResult,
} from './document-dispatch-jobs.contract';

/**
 * The `document-dispatch` queue's one worker: the hourly auto-dispatch scan, and a desk's batch
 * dispatch (see `document-dispatch-jobs.contract.ts` for why the batch left the request).
 *
 * ONE loop for the whole queue, dispatching on the job name — not a `@Process` per job.
 *
 * Bull does not reserve slots per job name: each `@Process({ name })` adds a loop to the queue, and
 * every loop takes the next job of any name. A batch handler beside the auto-dispatch handler would
 * have been two loops, so an operator's batch and the hourly scan — or two operators' batches over
 * the same documents — could dispatch the same packet at the same moment. `dispatchDocument` checks
 * the status and then sends before it writes the new one, so two concurrent calls can both pass the
 * check and both email the branch. A single `'*'` loop makes "one dispatch at a time" true on a
 * worker, and with it that status check becomes a real guard against a batch sending twice. (The
 * synchronous single-document route runs in the API process and is outside this loop, as it always
 * was.)
 */
@Injectable()
@Processor(DOCUMENT_DISPATCH_QUEUE)
export class DocumentDispatchWorker {
  private readonly logger = new Logger(DocumentDispatchWorker.name);

  constructor(
    @InjectRepository(DocumentEntity)
    private readonly documentRepository: Repository<DocumentEntity>,
    @InjectRepository(AssignmentEntity)
    private readonly assignmentRepository: Repository<AssignmentEntity>,
    private readonly documentService: DocumentService,
    private readonly settings: PlatformSettingsService,
    private readonly tracker: BackgroundJobTracker,
  ) {}

  @Process({ name: '*', concurrency: 1 })
  async run(job: Job) {
    switch (job.name) {
      case DOCUMENT_DISPATCH_JOB.AUTO_DISPATCH:
        return this.autoDispatch(job);
      case DOCUMENT_DISPATCH_JOB.DISPATCH_BATCH:
        return this.dispatchBatch(job as Job<DispatchBatchJobData>);
      default:
        // A name nothing here knows would otherwise complete silently with no result.
        throw new Error(`No handler for document dispatch job "${job.name}".`);
    }
  }

  /**
   * A desk's "Send N documents", one document at a time through the same `dispatchDocument` the
   * single route uses — so a document is marked DISPATCHED only once its own email went, and one
   * refused address or unreadable file is a line in `failed`, not the end of the batch.
   *
   * Runs as the person who pressed Send (see `JobActor`), and reports progress per
   * document so the page can say "Emailing documents to the branch (12/40)" rather than spin.
   *
   * Tracked (`BackgroundJobTracker`): the batch's `background_jobs` row goes RUNNING, carries the
   * same progress, and ends with a one-line summary, so the Jobs tray shows it after a refresh. The
   * return value, Bull's progress and a rethrown error are unchanged, so the page's poll of
   * `GET /documents/dispatch-batch/:jobId` answers exactly as before. The hourly auto-dispatch is
   * system work nobody started and stays untracked.
   */
  async dispatchBatch(job: Job<DispatchBatchJobData>): Promise<DispatchBatchResult> {
    const { documentIds, branchEmail, actor } = job.data;
    this.logger.log(`Dispatch batch ${job.id}: ${documentIds.length} document(s)${branchEmail ? ', by email to a branch' : ''}.`);
    return this.tracker.run(
      job,
      (t) => runAsJobActor(
        actor,
        () => this.documentService.dispatchMany(documentIds, actor.userId, branchEmail ?? undefined, t.progress),
      ),
      { describe: describeDispatchBatch },
    );
  }

  async autoDispatch(_job: Job) {
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
          // Accepted and not yet finished. ACCEPTED alone missed a packet still unsent when the
          // assayer had already checked in (or started): the scan skipped it every night, so the
          // assayer stood at the branch with no paperwork unless someone sent it by hand.
          status: In(COMMITTED_ASSIGNMENT_STATUSES),
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

/** The line the Jobs tray keeps for a finished batch: a sentence and two counts, never the ids. */
export function describeDispatchBatch(result: DispatchBatchResult) {
  const sent = result?.dispatched?.length ?? 0;
  const failed = result?.failed?.length ?? 0;
  return {
    summary: `Sent ${sent} document${sent === 1 ? '' : 's'}${failed ? `; ${failed} did not go.` : '.'}`,
    counts: { dispatched: sent, failed },
  };
}
