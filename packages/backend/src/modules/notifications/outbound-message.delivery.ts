import type { Job } from 'bull';
import type { OpenedEmail, OpenedSms, OutboundMessageJobData, OutboundMessageService } from './outbound-message.service';

/**
 * What a channel's transport answers for one send. `EmailProvider.send` already has this shape;
 * `SmsProvider.send` returns it too.
 */
export interface TransportResult {
  success: boolean;
  error?: string;
  /** True when retrying cannot help THIS message: a refused address or number, a missing template. */
  permanent?: boolean;
  /**
   * The channel is broken (credentials refused, server unreachable), not this message. Retried on
   * Bull's normal backoff while attempts remain; after that it goes back to QUEUED on a long
   * backoff (`deferForTransport`) instead of being settled FAILED, so fixing the credential
   * delivers the backlog rather than leaving it permanently failed.
   */
  transportFault?: boolean;
}

/** One channel's way of sending, as the delivery routine needs it. */
export interface MessageTransport<M> {
  isEnabled(): boolean;
  send(message: M): Promise<TransportResult>;
}

/** The words a clerk sees for a channel's failures. */
export interface ChannelWording {
  notSetUp: string;
  refused: (error: string) => string;
  noAnswer: string;
}

/**
 * THE one delivery routine for every channel: claim the row, open the message, hand it to the
 * transport, and settle — sent, refused (never retried), transient (released for Bull's backoff),
 * or out of attempts (settled FAILED rather than thrown, so it never reads as "still sending").
 *
 * Email and SMS each have a thin `@Processor` on their own queue that calls this with their transport.
 * Before SMS joined, this lived inside `OutboundEmailWorker`; copying it into an SMS worker would have
 * been the second implementation of every rule here.
 */
export async function deliverOutboundMessage<M extends OpenedEmail | OpenedSms>(
  job: Job<OutboundMessageJobData>,
  channel: M['channel'],
  outbound: OutboundMessageService,
  transport: MessageTransport<M>,
  wording: ChannelWording,
): Promise<void> {
  const id = job.data.outboundMessageId;
  const claimed = await outbound.claim(id);
  if (!claimed) return; // already sent, already failed, or another job has it

  const message = claimed.message;
  if (!message || message.channel !== channel) {
    await outbound.markFailed(id, 'The message could not be read back, so it was not sent. Send it again.');
    return;
  }

  const result = await transport.send(message as M);
  if (result.success) {
    await outbound.markSent(id);
    return;
  }

  if (result.permanent) {
    /*
      "Not set up" is permanent too, but it deserves words a clerk can act on rather than a transport
      error: the fix is to hand the details over another way, or to ask an administrator to set the
      channel up — not to try again. A notification's leg records it as SUPPRESSED.
    */
    if (!transport.isEnabled()) {
      await outbound.markFailed(id, wording.notSetUp, { notSetUp: true });
      return;
    }
    await outbound.markFailed(id, wording.refused(result.error ?? 'no reason given'));
    return;
  }

  const attemptsAllowed = Number(job.opts?.attempts ?? 1);
  const error = result.error ?? wording.noAnswer;
  if (result.transportFault && job.attemptsMade + 1 >= attemptsAllowed) {
    // Out of quick retries, and the fault is the channel's: wait for it, do not give up on the
    // message. The sweep re-queues it once the backoff passes; a day without success still ends in
    // the sweep's give-up, so this cannot wait for ever.
    await outbound.deferForTransport(id, error);
    return;
  }
  if (job.attemptsMade + 1 >= attemptsAllowed) {
    // Settled here rather than by throwing: a throw on the last attempt would leave the row
    // SENDING until the sweep gave up on it, reading as "still going" for fifteen minutes.
    await outbound.markFailed(id, `${error} (tried ${attemptsAllowed} times)`);
    return;
  }
  await outbound.release(id, error);
  throw new Error(error);
}
