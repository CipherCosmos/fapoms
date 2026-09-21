import { Logger } from '@nestjs/common';
import { countSmsSegments } from '@fapoms/shared';
import {
  SMS_SEND_TIMEOUT_MS, isPermanentHttpStatus,
  type SmsMessage, type SmsSendResult, type SmsSendSettings, type SmsTransport,
} from './sms-transport';

/**
 * FAPOMS — Pinnacle (api.pinnacle.in), as one implementation of `SmsTransport`.
 *
 * Written against the request the operations team supplied on 2026-09-19:
 *
 *   POST https://api.pinnacle.in/index.php/sms/json
 *   apikey: <key>                       (header; never the URL, so it stays out of access logs)
 *   { "sender": "SUMGLB",
 *     "message": [ { "number": "919113066745", "text": "…" } ],
 *     "messagetype": "TXT",
 *     "dlttempid": "1777178971152755392" }
 *
 * That shape carries everything this platform needs: the approved sender header, the recipient in
 * country-code digits, the text, and the DLT content template id per message. The DLT Principal
 * Entity id is NOT in the request — Pinnacle maps it to the header on their side, which is also what
 * MSG91 does, so `settings.dltEntityId` stays a platform-side rule (a text without its template id is
 * refused before a gateway is called) rather than a field.
 *
 * Two things in here are assumptions until the account is live, and both are called out in the
 * constants below: what `messagetype` a non-GSM (Hindi, ₹) text takes, and what a refusal looks like
 * in a 200 reply. Both are read from the reply defensively, and neither can turn a refusal into a
 * silent success: anything that is not recognisably an acceptance is reported as a failure.
 */

export const PINNACLE_SEND_URL = 'https://api.pinnacle.in/index.php/sms/json';

/**
 * `messagetype` for an ordinary GSM-7 text, exactly as the supplied request uses it.
 *
 * UNCONFIRMED: the value for a text carrying characters GSM-7 has no room for (Hindi, ₹, emoji).
 * `UNI` is the usual spelling in this family of Indian gateways; until Pinnacle confirms it, such a
 * text is refused here rather than sent, because the alternative — sending it as `TXT` — delivers a
 * line of question marks to somebody waiting for a one-time code.
 */
export const PINNACLE_TEXT_TYPE = 'TXT';
export const PINNACLE_UNICODE_TYPE = 'UNI';
export const PINNACLE_UNICODE_CONFIRMED = false;

/** Fields a Pinnacle reply may name its message id under; the first present one is recorded. */
const MESSAGE_ID_FIELDS = ['msgid', 'messageid', 'message_id', 'id', 'jobid'] as const;

/** Values in a reply's status-ish field that mean the gateway took the message. */
const ACCEPTED_VALUES = new Set(['success', 'ok', 'sent', 'submitted', 'accepted', 'true', '1', '200']);

export interface PinnacleCredentials {
  apiKey: string;
}

export class PinnacleTransport implements SmsTransport {
  readonly name = 'Pinnacle';
  private readonly logger = new Logger('PinnacleTransport');

  constructor(private readonly credentials: PinnacleCredentials) {}

  /**
   * One send. Never throws, and never logs the key or the text — the text of a credentials message
   * IS the temporary password, and the log is read by far more people than the ledger.
   */
  async send(message: SmsMessage, settings: SmsSendSettings): Promise<SmsSendResult> {
    const unicode = countSmsSegments(message.text).encoding === 'UCS-2';
    if (unicode && !PINNACLE_UNICODE_CONFIRMED) {
      this.logger.warn('Refused a non-GSM text: the Pinnacle message type for unicode is not confirmed yet.');
      return {
        success: false,
        permanent: true,
        error: 'This text contains characters (Hindi, ₹ or similar) that need Pinnacle\'s unicode message '
          + 'type, which is not confirmed for this account yet. Ask Pinnacle for the value, or keep the '
          + 'wording to plain English.',
      };
    }

    const body = {
      sender: settings.senderId,
      // Country code and digits, no plus — as in the supplied request.
      message: [{ number: message.to.replace(/^\+/, ''), text: message.text }],
      messagetype: unicode ? PINNACLE_UNICODE_TYPE : PINNACLE_TEXT_TYPE,
      ...(message.dltTemplateId ? { dlttempid: message.dltTemplateId } : {}),
    };

    let res: Response;
    try {
      res = await fetch(PINNACLE_SEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: this.credentials.apiKey },
        body: JSON.stringify(body),
        // `fetch` has no timeout of its own; a gateway that accepts the connection and never answers
        // would otherwise hold the caller until the socket died. A timeout is a retryable failure.
        signal: AbortSignal.timeout(SMS_SEND_TIMEOUT_MS),
      });
    } catch (err: any) {
      const timedOut = err?.name === 'TimeoutError';
      this.logger.warn(`Pinnacle SMS send failed: ${timedOut ? 'no answer in time' : (err?.message ?? 'network error')}.`);
      return {
        success: false,
        error: timedOut ? 'The SMS gateway did not answer in time.' : (err?.message ?? 'The SMS gateway could not be reached.'),
      };
    }

    const reply = await readPinnacleReply(res);
    if (!res.ok) {
      this.logger.warn(`Pinnacle SMS send failed with HTTP ${res.status}.`);
      return {
        success: false,
        error: reply.reason ? `Pinnacle answered HTTP ${res.status}: ${reply.reason}` : `The SMS gateway answered HTTP ${res.status}.`,
        permanent: isPermanentHttpStatus(res.status),
      };
    }

    /*
      A 200 does not by itself mean the message was taken: gateways in this family answer 200 with an
      error for an unregistered template or a header not mapped to the entity, and the same request
      would be refused again. So acceptance has to be positively recognised; anything else is a
      refusal, reported with whatever the gateway said.
    */
    if (reply.accepted) {
      return { success: true, providerMessageId: reply.messageId };
    }
    this.logger.warn('Pinnacle did not confirm an SMS send.');
    return {
      success: false,
      permanent: true,
      error: reply.reason
        ? `Pinnacle refused it: ${reply.reason}`
        : 'Pinnacle answered without confirming the message was accepted.',
    };
  }
}

interface PinnacleReply {
  accepted: boolean;
  reason?: string;
  messageId?: string;
}

/**
 * Reads the gateway's reply without trusting its shape.
 *
 * The exact body is not documented to us yet, so this looks for an explicit refusal first (an error
 * field, or a status that is not an acceptance), then for a message id, and treats a bare `[]`/`{}`
 * as unconfirmed rather than as success. Bounded, so a long HTML error page never reaches the ledger.
 */
export async function readPinnacleReply(res: Response): Promise<PinnacleReply> {
  let parsed: any = null;
  try {
    if (typeof (res as any).text !== 'function') return { accepted: false };
    const raw = (await res.text()).slice(0, 2000);
    parsed = JSON.parse(raw);
  } catch {
    return { accepted: false };
  }
  if (!parsed || typeof parsed !== 'object') return { accepted: false };

  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || typeof first !== 'object') return { accepted: false };
  const record = first as Record<string, unknown>;

  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, 200)
      : typeof value === 'number' ? String(value) : undefined;

  const error = text(record.error) ?? text(record.errormessage) ?? text(record.error_message) ?? text(record.reason);
  const status = text(record.status) ?? text(record.type) ?? text(record.response) ?? text(record.result);
  const messageId = MESSAGE_ID_FIELDS.map((f) => text(record[f])).find(Boolean);

  if (error && !ACCEPTED_VALUES.has(error.toLowerCase())) return { accepted: false, reason: error, messageId };
  if (status) {
    return ACCEPTED_VALUES.has(status.toLowerCase())
      ? { accepted: true, messageId }
      : { accepted: false, reason: text(record.message) ?? status, messageId };
  }
  // No status field at all: a message id is the only other thing that means "taken".
  return messageId ? { accepted: true, messageId } : { accepted: false, reason: text(record.message) };
}
