import { Injectable, Logger } from '@nestjs/common';
import { Processor, Process } from '@nestjs/bull';
import { Job } from 'bull';
import { OutboxRelay } from './outbox.relay';

@Injectable()
@Processor('outbox')
export class OutboxWorker {
  private readonly logger = new Logger(OutboxWorker.name);

  constructor(private readonly relay: OutboxRelay) {}

  @Process('drain')
  async drain(_job: Job) {
    try {
      await this.relay.drain();
    } catch (err) {
      this.logger.error('Outbox relay pass failed:', err);
      throw err;
    }
  }
}
