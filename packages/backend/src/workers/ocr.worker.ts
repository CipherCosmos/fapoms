import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OcrJobEntity, OcrJobStatus } from '../infrastructure/ocr/ocr-job.entity';

/**
 * Hands a registered OCR job to the OUTSIDE engine — which, in this product, a person does.
 *
 * There is no OCR here and there is not meant to be. Reading the whole path: the desk marks an
 * audited return "sent for scanning" (`POST /documents/:id/send-external-ocr`, a status
 * transition that transmits nothing), somebody runs the file through the external application,
 * and the result returns either as an uploaded Generated Excel or through the callback at
 * `POST /ocr-boundary/.../results`, which is what moves the job to COMPLETED. The one piece of
 * automation that would submit a file is deliberately off (`document.autoSendToExternalOcr`,
 * default false, for "the deployment that does wire a real OCR integration").
 *
 * So this worker's honest job is small: record that the job is now with the external engine, and
 * say so in terms an operator can act on. What it must NOT do is imitate progress.
 *
 * ── What was wrong ────────────────────────────────────────────────────────────────────────────
 * It used to claim the job, set PROCESSING, and return — under a comment saying OCR "will be
 * implemented in Wave 3". Nothing in the success path ever reached a terminal state, so every
 * job sat at PROCESSING indefinitely and the queue looked like work in flight that no one was
 * doing. Worse, it did `retryCount = retryCount + 1` on every claim, so the column that exists
 * to count RETRIES counted successful claims instead: a job handled once and correctly showed
 * `retryCount: 1`, and an operator reading the table could not tell a healthy job from one that
 * had failed and been re-attempted. Bull is configured with `attempts: 5`, so a job that really
 * did fail five times was indistinguishable from five ordinary claims.
 *
 * Two rules now, and they are the whole of it: the state written is the state that is true, and
 * `retryCount` moves only when Bull is actually retrying.
 */
@Processor('ocr')
export class OcrWorker {
  private readonly logger = new Logger(OcrWorker.name);

  constructor(
    @InjectRepository(OcrJobEntity)
    private readonly ocrJobRepository: Repository<OcrJobEntity>,
  ) {}

  /**
   * The handler name MUST match the name the producer enqueues.
   *
   * `OcrProcessingService.createJob` calls `ocrQueue.add('process', ...)`, but this was
   * `@Process({ concurrency: 3 })` with no name — which `@nestjs/bull` binds to Bull's
   * `__default__` job type. Bull dispatches by `handlers[job.name] || handlers['*']`, so a job
   * named `'process'` found no handler and failed instantly with "Missing process handler for job
   * type process", burning all 5 attempts and dead-lettering. Confirmed live 2026-09-04 by
   * enqueuing both names: `'process'` → "Missing process handler"; the unnamed job → the handler
   * ran. The entire OCR pipeline was silently dead — every uploaded packet's OCR job failed and
   * the `OcrJobEntity` row never left its initial status. Naming it `'process'` (the pattern every
   * other worker here already follows) fixes it.
   */
  @Process({ name: 'process', concurrency: 3 })
  async processOcr(job: Job<{ documentId: string; userId: string; fileName: string }>) {
    const ocrJob = await this.ocrJobRepository.findOne({
      where: { documentId: job.data.documentId },
    });
    if (!ocrJob) {
      this.logger.warn(`No OCR job row for document ${job.data.documentId} — nothing to hand over.`);
      return;
    }

    /**
     * A finished job is left alone.
     *
     * Bull can deliver the same job again — a stalled-job recovery, or an operator re-queueing —
     * and the callback may well have landed in the meantime. Writing PROCESSING over a COMPLETED
     * row would take a job the reviewer has already seen results for and put it back into the
     * "waiting on the scanner" pile.
     */
    if (ocrJob.status === OcrJobStatus.COMPLETED || ocrJob.status === OcrJobStatus.DEAD_LETTER) {
      this.logger.log(`OCR job for ${job.data.fileName} is already ${ocrJob.status} — left as it is.`);
      return;
    }

    try {
      /**
       * `attemptsMade` is Bull's own count of deliveries BEFORE this one, so it is 0 on a first
       * run and 1+ only when this really is a retry. Taken from Bull rather than incremented
       * here, because a counter the worker owns drifts from the queue it is supposed to describe.
       */
      ocrJob.retryCount = job.attemptsMade ?? 0;
      ocrJob.status = OcrJobStatus.PROCESSING;
      await this.ocrJobRepository.save(ocrJob);

      this.logger.log(
        `OCR job for "${job.data.fileName}" is now with the external scanning application. `
        + 'Nothing is submitted automatically: it completes when the engine posts results back to '
        + '/ocr-boundary, or when the Generated Excel is uploaded against the assessment.'
        + (ocrJob.retryCount > 0 ? ` (retry ${ocrJob.retryCount})` : ''),
      );
    } catch (err: any) {
      this.logger.error(`Could not record the OCR hand-over for ${job.data.fileName}:`, err);
      ocrJob.status = OcrJobStatus.FAILED;
      ocrJob.failureReason = err?.message || 'Worker processing exception';
      await this.ocrJobRepository.save(ocrJob).catch(() => {});
      throw err;
    }
  }
}
