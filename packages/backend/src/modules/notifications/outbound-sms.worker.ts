import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { SmsProvider } from '../../infrastructure/notifications/sms-provider';
import { OUTBOUND_SMS_QUEUE } from './notification.constants';
import { OUTBOUND_MESSAGE_JOB, OpenedSms, OutboundMessageJobData, OutboundMessageService } from './outbound-message.service';
import { ChannelWording, deliverOutboundMessage } from './outbound-message.delivery';
import { SMS_NOT_SET_UP_REASON } from './sms.service';

/**
 * Sends the texts that actions have recorded (`SmsService.queue`), from their own queue so a slow
 * SMS gateway cannot hold the loops emails need. The sending rules are the one shared routine,
 * `deliverOutboundMessage`; this only supplies the SMS transport and its wording. The ledger's single
 * sweep (on the email queue) re-queues stranded texts onto this queue.
 */
@Processor(OUTBOUND_SMS_QUEUE)
export class OutboundSmsWorker {
  constructor(
    private readonly outbound: OutboundMessageService,
    private readonly sms: SmsProvider,
  ) {}

  /** Two slots: a gateway answers in well under a second, and texts are rarely bursty; the worker pool is near its budget. */
  @Process({ name: OUTBOUND_MESSAGE_JOB, concurrency: 2 })
  async send(job: Job<OutboundMessageJobData>): Promise<void> {
    await deliverOutboundMessage<OpenedSms>(job, 'SMS', this.outbound, this.sms, SMS_WORDING);
  }
}

export const SMS_WORDING: ChannelWording = {
  notSetUp: SMS_NOT_SET_UP_REASON,
  refused: (error) => `The SMS gateway refused it: ${error}.`,
  noAnswer: 'The SMS gateway did not accept it.',
};
