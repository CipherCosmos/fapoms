import { Injectable, Logger } from '@nestjs/common';
import type { OutboundMessageReceipt } from '@fapoms/shared';
import { SmsProvider } from '../../infrastructure/notifications/sms-provider';
import { MessageTokensService } from '../../infrastructure/notifications/message-tokens';
import type { SmsTemplateKey } from '../../infrastructure/notifications/sms-template-registry';
import { OutboundMessageService } from './outbound-message.service';
import type { OutboundMessageKind } from './outbound-message.entity';
import { RenderedSms, SmsTemplateService } from './sms-template.service';

/**
 * THE ONE WAY THIS APPLICATION SENDS A TEXT MESSAGE — the SMS twin of `EmailService`.
 *
 * Same ledger (`outbound_messages`, channel SMS), same lifecycle (claim, retries, sweep, erase on
 * settle), same receipts; only the transport and the wording differ:
 *
 *   `queue(...)`   the default. Recorded, sent by `OutboundSmsWorker` with retries; the caller gets a
 *                  receipt it can watch.
 *   `sendNow(...)` only when the caller's answer depends on the text having gone — a one-time code the
 *                  person is standing there waiting for, or an administrator's delivery test. Still
 *                  recorded (without the body).
 *
 * Content is always a registered template (`sms-template-registry.ts`): under DLT a text that does not
 * match a registered template is refused by the operator, so there is no free-text shape here.
 */

export interface SmsContent {
  template: SmsTemplateKey;
  data: Record<string, unknown>;
}

export interface SmsRequest {
  kind: OutboundMessageKind;
  /** Any Indian mobile format; the transport normalises it. */
  to: string;
  content: SmsContent;
  /** Who it is for, so `{{name}}` says their name; the wording may or may not use it. */
  recipientName?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  requestedBy?: string | null;
}

export interface SmsSendNowResult {
  sent: boolean;
  error?: string;
  permanent?: boolean;
  receipt: OutboundMessageReceipt;
}

/** Why a text failed when no SMS gateway is configured, in words a clerk can act on. */
export const SMS_NOT_SET_UP_REASON = 'SMS is not set up on this system, so no text was sent.';

@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(
    private readonly transport: SmsProvider,
    private readonly templates: SmsTemplateService,
    private readonly outbound: OutboundMessageService,
    private readonly tokens: MessageTokensService,
  ) {}

  /** Whether an SMS gateway is configured at all. */
  isEnabled(): boolean {
    return this.transport.isEnabled();
  }

  /**
   * The exact text that would be sent, with its DLT template id.
   *
   * The values every message gets ({{name}}, {{phone}}, {{companyName}}, {{time}}…) are filled here,
   * under the same names as in email, and anything the caller passes wins over them.
   */
  async compose(content: SmsContent, recipient: { name?: string | null; phone?: string | null } = {}): Promise<RenderedSms> {
    const common = await this.tokens.common({ name: recipient.name, phone: recipient.phone });
    return this.templates.render(content.template, { ...common, ...content.data });
  }

  /** Record it and hand it to the worker. Never throws; a failure comes back as `NOT_QUEUED`. */
  async queue(request: SmsRequest): Promise<OutboundMessageReceipt> {
    let rendered: RenderedSms;
    try {
      rendered = await this.compose(request.content, { name: request.recipientName, phone: request.to });
    } catch (err: any) {
      this.logger.error(`Could not compose a ${request.kind} text: ${err?.message ?? err}`);
      return {
        id: null, channel: 'SMS', status: 'NOT_QUEUED', to: request.to ?? '',
        error: 'The text could not be prepared. Hand the details over another way.',
      };
    }
    return this.outbound.enqueue({
      channel: 'SMS',
      kind: request.kind,
      to: request.to,
      text: rendered.text,
      label: rendered.label,
      dltTemplateId: rendered.dltTemplateId,
      entityType: request.entityType,
      entityId: request.entityId,
      requestedBy: request.requestedBy,
    });
  }

  /** Send while the caller waits, and record the outcome without the body. Never throws. */
  async sendNow(request: SmsRequest): Promise<SmsSendNowResult> {
    const to = (request.to ?? '').trim();
    let rendered: RenderedSms;
    try {
      rendered = await this.compose(request.content, { name: request.recipientName, phone: to });
    } catch (err: any) {
      const error = `The text could not be prepared: ${err?.message ?? 'unknown error'}`;
      return { sent: false, error, permanent: true, receipt: { id: null, channel: 'SMS', status: 'NOT_QUEUED', to, error } };
    }

    const result = await this.transport.send({ to, text: rendered.text, dltTemplateId: rendered.dltTemplateId });
    const error = result.success
      ? undefined
      : this.transport.isEnabled()
        ? (result.error ?? 'The SMS gateway did not accept it.')
        : SMS_NOT_SET_UP_REASON;

    const receipt = await this.outbound.recordImmediate({
      channel: 'SMS',
      kind: request.kind,
      to,
      subject: rendered.label,
      entityType: request.entityType,
      entityId: request.entityId,
      requestedBy: request.requestedBy,
      sent: result.success,
      error,
    });
    return { sent: result.success, error, permanent: result.permanent, receipt };
  }
}
