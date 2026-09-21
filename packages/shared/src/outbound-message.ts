/**
 * FAPOMS — a message (an email or a text) the system has promised to send, and where it has got to.
 *
 * Email and SMS share one ledger (`outbound_messages`), one queue mechanism and one receipt: the
 * `channel` says which it is. What follows was first written for email, and is equally true of SMS.
 *
 * Emails used to be sent inside the request that asked for them: the desk pressed "Record" on an
 * interview and waited while the server opened a connection to Gmail, authenticated and handed the
 * message over — 5 seconds for one invite, and a bulk credential run for 540 people held one request
 * for half an hour, long after the browser had given up on it at 30 seconds.
 *
 * Now the request records the email and returns at once, and a background worker sends it. What a
 * screen gets back is this receipt, and it can ask where the email has got to until it is `SENT` or
 * `FAILED` — so "the invite was emailed" is still something the screen knows, not something it
 * assumes because an address was on file.
 */

/** Which way a message travels. */
export type MessageChannel = 'EMAIL' | 'SMS';

export type OutboundMessageStatus =
  /** Recorded and waiting for a worker. */
  | 'QUEUED'
  /** A worker has it and is talking to the mail server. */
  | 'SENDING'
  /** The mail server accepted it. */
  | 'SENT'
  /** It will not be sent: refused, retried out, or email is not set up. `error` says which. */
  | 'FAILED'
  /**
   * It could not even be recorded, so nothing will ever send it. Only ever on a receipt, never on
   * a stored row — there is no row.
   */
  | 'NOT_QUEUED';

export interface OutboundMessageReceipt {
  /** Null only for `NOT_QUEUED`. */
  id: string | null;
  /** Always present on receipts from the server; optional only so older fixtures still type-check. */
  channel?: MessageChannel;
  status: OutboundMessageStatus;
  /** The address or phone number it is going to — shown so the person can spot a typo before waiting on it. */
  to: string;
  /** Why it failed, in words a clerk can act on. Only on `FAILED` / `NOT_QUEUED`. */
  error?: string | null;
  sentAt?: string | null;
}

/** Whether a receipt has reached an answer that will not change. */
export function isSettledMessageStatus(status: OutboundMessageStatus | null | undefined): boolean {
  return status === 'SENT' || status === 'FAILED' || status === 'NOT_QUEUED';
}
