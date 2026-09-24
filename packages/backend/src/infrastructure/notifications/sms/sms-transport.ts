/**
 * FAPOMS — what an SMS gateway adapter must do, whichever vendor it is.
 *
 * The provider is not chosen yet; the company holds DLT registration (India's TRAI regime, under which
 * every commercial SMS must name a registered Principal Entity, a registered sender header and a
 * registered content template). So DLT fields are part of the contract, not a vendor extra: every
 * adapter receives them, and switching vendor means writing one more implementation of this interface.
 */

export interface SmsMessage {
  /** E.164, e.g. `+919876543210` (see `toE164IndianMobile` in @fapoms/shared). */
  to: string;
  /** The final text, exactly as registered on DLT with the variables filled in. */
  text: string;
  /** The DLT content template id this text was registered under. */
  dltTemplateId?: string | null;
}

export interface SmsSendSettings {
  /** The DLT-registered sender header (6 characters). */
  senderId: string;
  /** The DLT Principal Entity id. */
  dltEntityId?: string | null;
}

export interface SmsSendResult {
  success: boolean;
  error?: string;
  /** True when retrying cannot help: a refused number, bad credentials, an unregistered template. */
  permanent?: boolean;
  /**
   * The gateway itself is unusable — unreachable, down (5xx), or refusing our key (401/403) — so
   * every text would get the same answer and each becomes sendable once that is fixed. The message
   * is re-queued on a long backoff rather than settled FAILED (see `deliverOutboundMessage`).
   */
  transportFault?: boolean;
  providerMessageId?: string;
}

export interface SmsTransport {
  /** Short vendor name for logs and the settings screen, e.g. 'MSG91'. */
  readonly name: string;
  send(message: SmsMessage, settings: SmsSendSettings): Promise<SmsSendResult>;
}

/** Long enough for a slow gateway on a bad day; short enough that a hung one is a failure. */
export const SMS_SEND_TIMEOUT_MS = 10_000;

/**
 * A 4xx other than a timeout or a throttle is the gateway refusing this message: the same request
 * gets the same answer, so it is settled rather than retried.
 */
export function isPermanentHttpStatus(status: number): boolean {
  if (isTransportHttpStatus(status)) return false;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** The gateway refusing our credentials, or being down — a fault of the channel, not of one text. */
export function isTransportHttpStatus(status: number): boolean {
  return status === 401 || status === 403 || status >= 500;
}
