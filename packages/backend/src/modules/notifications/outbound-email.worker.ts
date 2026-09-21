import { Process, Processor } from '@nestjs/bull';
import type { Job } from 'bull';
import { EmailProvider } from '../../infrastructure/notifications/email-provider';
import { OUTBOUND_EMAIL_QUEUE } from './notification.constants';
import {
  EMAIL_NOT_SET_UP_REASON, OUTBOUND_MESSAGE_JOB, OpenedEmail, OutboundMessageJobData, OutboundMessageService,
} from './outbound-message.service';
import { ChannelWording, deliverOutboundMessage } from './outbound-message.delivery';

/** The sweep's job name. Registered as a repeatable schedule by `NotificationsModule`. */
export const OUTBOUND_MESSAGE_SWEEP_JOB = 'sweep-outbound-messages';

/**
 * Sends the emails that actions have recorded (`OutboundMessageService.enqueue` with channel EMAIL).
 *
 * On its own queue (`OUTBOUND_EMAIL_QUEUE`), not as a job name on notification-delivery: Bull's
 * worker loops are per queue and take jobs of any name, so sharing that queue would let a burst of
 * 540 credential emails hold every loop and sit in front of push offers and SLA-breach alert emails.
 * Here a slow mail server can only slow these emails down. The sending rules themselves are the one
 * shared routine, `deliverOutboundMessage`.
 */
@Processor(OUTBOUND_EMAIL_QUEUE)
export class OutboundEmailWorker {
  constructor(
    private readonly outbound: OutboundMessageService,
    private readonly email: EmailProvider,
  ) {}

  @Process({ name: OUTBOUND_MESSAGE_JOB, concurrency: 3 })
  async send(job: Job<OutboundMessageJobData>): Promise<void> {
    await deliverOutboundMessage<OpenedEmail>(job, 'EMAIL', this.outbound, this.email, EMAIL_WORDING);
  }

  /** One sweep for the whole ledger, both channels; it re-queues each row onto its own channel's queue. */
  @Process(OUTBOUND_MESSAGE_SWEEP_JOB)
  async sweep(): Promise<void> {
    await this.outbound.sweep();
  }
}

export const EMAIL_WORDING: ChannelWording = {
  notSetUp: EMAIL_NOT_SET_UP_REASON,
  refused: (error) => `The mail server refused it: ${error}.`,
  noAnswer: 'The mail server did not accept it.',
};
