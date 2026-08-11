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

  @Process({ concurrency: 3 })
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
