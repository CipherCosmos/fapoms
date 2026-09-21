import { Injectable, Logger } from '@nestjs/common';
import type { OutboundMessageReceipt } from '@fapoms/shared';
import {
  EmailAttachment, EmailProvider, EmailRenderOptions, renderEmailHtml,
} from '../../infrastructure/notifications/email-provider';
import { EmailTemplateRenderer } from '../../infrastructure/notifications/email-template-renderer';
import type { MessageRecipientContext } from '../../infrastructure/notifications/message-tokens';
import type { EmailTemplateKey } from '../../infrastructure/notifications/email-template-registry';
import { htmlToPlainText } from '../../infrastructure/notifications/html-to-text';
import { OutboundMessageService } from './outbound-message.service';
import type { OutboundMessageKind } from './outbound-message.entity';

/**
 * THE ONE WAY THIS APPLICATION SENDS EMAIL.
 *
 * Before this, email had grown seven ways of reaching the mail server and three ways of deciding
 * what a message said: feature services called `EmailProvider.send` directly (the registration OTP,
 * the MFA code, the branch audit packet, two admin test sends, the morning digest, the notification
 * worker), two separate queue-and-retry pipelines existed (the notification `deliver-email` job and
 * the outbound-email queue), and most templated emails were built twice — once as a hand-written
 * `renderEmailHtml` fallback at the call site, and again by `EmailTemplateRenderer`, whose registry
 * already carries a fallback of its own. Two copies of an email's wording drift; the one an
 * administrator edits is not always the one that goes out.
 *
 * Every feature now says WHAT to send and HOW URGENTLY, and this decides everything else:
 *
 *   `queue(...)`   the default. Recorded in `outbound_messages`, sent by the worker with retries, and
 *                  the caller gets a receipt the screen can watch. Nothing waits on the mail server.
 *   `sendNow(...)` only when the caller's answer depends on the send having happened — a one-time
 *                  code the person is waiting for, a packet whose dispatch status IS the email, an
 *                  administrator's transport test. Still recorded in `outbound_messages` (without the
 *                  body), so every email the system sent is in one place.
 *
 * And WHAT is one of three shapes (`EmailContent`): a registered template (admin-editable, with the
 * registry's built-in fallback — the only place an email's default wording lives), a branded layout
 * for system messages that are not templates, or an already-rendered message.
 *
 * `messaging-single-path.spec.ts` keeps it this way: nothing outside the messaging module may call the
 * transport, the template renderer or the HTML layout directly.
 */

export type EmailContent =
  /** A registered template. Admin overrides apply; the registry's fallback covers everything else. */
  | { template: EmailTemplateKey; data: Record<string, unknown> }
  /** A branded one-off system message. The plain-text half is derived from the HTML when omitted. */
  | { layout: EmailRenderOptions; subject: string; text?: string }
  /** Already rendered. For the notification pipeline, whose wording comes from the catalog. */
  | { rendered: { subject: string; text: string; html?: string } };

export interface EmailRequest {
  kind: OutboundMessageKind;
  to: string;
  content: EmailContent;
  /** Who it is for, so `{{name}}` says their name; the wording may or may not use it. */
  recipientName?: string | null;
  /** What the email is about, so a record can find the emails sent for it. */
  entityType?: string | null;
  entityId?: string | null;
  /** Whose action asked for it — the person allowed to watch its receipt. */
  requestedBy?: string | null;
}

export interface ComposedEmail {
  subject: string;
  text: string;
  html?: string;
}

export interface SendNowResult {
  sent: boolean;
  error?: string;
  /** True when retrying cannot help (refused address, bad credentials, email switched off). */
  permanent?: boolean;
  receipt: OutboundMessageReceipt;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly transport: EmailProvider,
    private readonly templates: EmailTemplateRenderer,
    private readonly outbound: OutboundMessageService,
  ) {}

  /** Whether a mail transport is configured at all. */
  isEnabled(): boolean {
    return this.transport.isEnabled();
  }

  /**
   * What the message says, from whichever shape the caller gave.
   *
   * `recipient` fills the values every message shares — {{name}}, {{email}}, {{companyName}},
   * {{time}} — the same way a text does, so one vocabulary covers both channels. It applies to
   * templates only: the other two shapes arrive already written.
   */
  async compose(content: EmailContent, recipient: MessageRecipientContext = {}): Promise<ComposedEmail> {
    if ('template' in content) {
      const rendered = await this.templates.render(content.template, content.data as Record<string, any>, recipient);
      return { subject: rendered.subject, text: rendered.text, html: rendered.html };
    }
    if ('layout' in content) {
      const html = renderEmailHtml(content.layout);
      return { subject: content.subject, text: content.text ?? htmlToPlainText(html), html };
    }
    return { ...content.rendered };
  }

  /** Record it and hand it to the worker. Never throws; a failure comes back as `NOT_QUEUED`. */
  async queue(request: EmailRequest): Promise<OutboundMessageReceipt> {
    let message: ComposedEmail;
    try {
      message = await this.compose(request.content, { name: request.recipientName, email: request.to });
    } catch (err: any) {
      this.logger.error(`Could not compose a ${request.kind} email: ${err?.message ?? err}`);
      return {
        id: null,
        channel: 'EMAIL',
        status: 'NOT_QUEUED',
        to: request.to ?? '',
        error: 'The email could not be prepared. Hand the details over another way.',
      };
    }
    return this.outbound.enqueue({
      channel: 'EMAIL',
      kind: request.kind,
      to: request.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      entityType: request.entityType,
      entityId: request.entityId,
      requestedBy: request.requestedBy,
    });
  }

  /**
   * Send while the caller waits, and record the outcome. Never throws.
   *
   * Attachments go to the transport only; they are not stored anywhere.
   */
  async sendNow(request: EmailRequest & { attachments?: EmailAttachment[] }): Promise<SendNowResult> {
    const to = (request.to ?? '').trim();
    let message: ComposedEmail;
    try {
      message = await this.compose(request.content, { name: request.recipientName, email: to });
    } catch (err: any) {
      const error = `The email could not be prepared: ${err?.message ?? 'unknown error'}`;
      return { sent: false, error, permanent: true, receipt: { id: null, channel: 'EMAIL', status: 'NOT_QUEUED', to, error } };
    }

    const result = await this.transport.send({
      to,
      subject: message.subject,
      text: message.text,
      html: message.html,
      attachments: request.attachments,
    });
    const error = result.success
      ? undefined
      : this.transport.isEnabled()
        ? (result.error ?? 'The mail server did not accept it.')
        : 'Email is not set up on this system, so it was not sent.';

    const receipt = await this.outbound.recordImmediate({
      channel: 'EMAIL',
      kind: request.kind,
      to,
      subject: message.subject,
      entityType: request.entityType,
      entityId: request.entityId,
      requestedBy: request.requestedBy,
      sent: result.success,
      error,
    });
    return { sent: result.success, error, permanent: result.permanent, receipt };
  }
}
