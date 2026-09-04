import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { OcrJobEntity, OcrJobStatus } from '../infrastructure/ocr/ocr-job.entity';

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
   * `OcrProcessingService.enqueue` calls `ocrQueue.add('process', ...)`, but this was
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
    this.logger.log(`Processing OCR job ${job.id} for document ${job.data.documentId}`);

    const ocrJob = await this.ocrJobRepository.findOne({
      where: { documentId: job.data.documentId },
    });
    if (!ocrJob) {
      this.logger.warn(`No OCR job found for document ${job.data.documentId}`);
      return;
    }

    try {
      ocrJob.status = OcrJobStatus.PROCESSING;
      ocrJob.retryCount = (ocrJob.retryCount || 0) + 1;
      await this.ocrJobRepository.save(ocrJob);

      // OCR processing will be implemented in Wave 3.
      // For now, the job is claimed and moved to PROCESSING state,
      // and the actual OCR call will happen via the callback endpoint.
      this.logger.log(`OCR job ${job.id} claimed (attempt ${ocrJob.retryCount})`);
    } catch (err: any) {
      this.logger.error(`Error processing OCR job ${job.id}:`, err);
      ocrJob.status = OcrJobStatus.FAILED;
      ocrJob.failureReason = err.message || 'Worker processing exception';
      await this.ocrJobRepository.save(ocrJob).catch(() => {});
      throw err;
    }
  }
}
