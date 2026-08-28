import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { PlatformSettingsService } from '../settings/platform-settings.service';

/**
 * Outbound email, finally.
 *
 * The platform has promised email for a long time without being able to send it: the EMAIL
 * channel exists in the shared enum, the preference table has an `email` column, the settings
 * screen renders a working Email toggle — and nothing behind any of it could deliver a message.
 * nodemailer was even installed once and never imported. This provider is the missing last inch.
 *
 * Configuration is resolved the way everything else is — **saved settings first, environment
 * second**:
 *
 *   Administration → Platform Settings → Email delivery   the primary place. Takes effect
 *                                       immediately via `reconfigure()`; the password is stored
 *                                       encrypted.
 *   GMAIL_USER + GMAIL_APP_PASSWORD     bootstrap fallback: a Google Workspace account with
 *                                       2-step verification on and an App Password for "Mail".
 *   SMTP_HOST (+ SMTP_PORT/SMTP_USER/SMTP_PASSWORD/SMTP_SECURE)
 *                                       any other provider, same envelope.
 *
 * Unconfigured follows the house degradation pattern (FcmProvider, FileScanService): warn once
 * at boot, stay disabled, and answer every send with a failure result instead of throwing. Email
 * being unconfigured must never break the business action that wanted to send one — the
 * notification still reaches the bell, and its row records that the email was suppressed.
 */

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface EmailPayload {
  to: string;
  subject: string;
  /** Plain-text body. Always provided — text is the part that must never be wrong. */
  text: string;
  /** Optional HTML alternative rendered by the caller. */
  html?: string;
  /**
   * Files carried by the message itself.
   *
   * Deliberately an attachment rather than a download link. The one thing this is used for is
   * sending an audit packet to a bank branch, and a link to bank customer paperwork that keeps
   * working after the mail is forwarded is a bearer credential for it — which is the reason
   * `DocumentAccessTokenService` makes its own tokens die in five minutes. A branch officer
   * expects the file, not a login.
   *
   * The caller is responsible for the size: most mail providers reject above ~25 MB, and the
   * refusal comes back as a permanent SMTP failure rather than anything this can retry.
   */
  attachments?: EmailAttachment[];
}

export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
  /**
   * True when retrying cannot help: bad credentials, a rejected recipient address. Everything
   * else — timeouts, greylisting, connection refused — is transient and belongs in the retry
   * backoff, the same discipline the push provider applies to FCM error codes.
   */
  permanent?: boolean;
}

/** SMTP situations where a retry will produce the same answer. */
const PERMANENT_CODES = new Set(['EAUTH', 'EENVELOPE', 'EMESSAGE']);
const PERMANENT_RESPONSE_CODES = new Set([530, 535, 550, 551, 553]);

@Injectable()
export class EmailProvider implements OnModuleInit {
  private readonly logger = new Logger(EmailProvider.name);
  private transporter: any | null = null;
  private from = '';

  constructor(
    /**
     * Optional so the provider still works in tests and in any context assembled without the
     * settings module — it simply falls back to reading the environment, which is what it did
     * before settings existed.
     */
    @Optional() private readonly settings?: PlatformSettingsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reconfigure();
    // Rebuild whenever an operator saves anything under `email.` or changes the public URL.
    // Without this the settings screen would accept a new mailbox and keep sending from the
    // old one until somebody restarted the process — a settings screen that lies.
    this.settings?.onChange('email.', () => this.reconfigure());
  }

  /**
   * (Re)build the mail transport from whatever configuration is in force right now.
   *
   * Saved settings win over environment variables, matching every other consumer, so an
   * operator can take over a mailbox that was originally configured by deployment without
   * anyone having to remove the old variable first.
   */
  async reconfigure(): Promise<void> {
    const cfg = await this.resolveConfig();
    this.transporter = null;
    this.from = '';

    const gmailUser = cfg.gmailUser;
    const gmailAppPassword = cfg.gmailAppPassword;
    const smtpHost = cfg.smtpHost;

    if (cfg.transport === 'NONE') {
      this.logger.log('Email transport is switched off in platform settings — no email will be sent.');
      return;
    }

    // Optional require, like firebase-admin in FcmProvider: a missing module must degrade to
    // "email disabled", not prevent the application from starting.
    let nodemailer: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      nodemailer = require('nodemailer');
    } catch {
      this.logger.warn('nodemailer is not installed — email delivery disabled.');
      return;
    }

    if (cfg.transport === 'GMAIL' && gmailUser && gmailAppPassword) {
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: gmailUser, pass: gmailAppPassword },
      });
      this.from = cfg.from || `FAPOMS <${gmailUser}>`;
      this.logger.log(`Email enabled via Gmail as ${gmailUser}.`);
      return;
    }

    if (cfg.transport === 'SMTP' && smtpHost) {
      const port = Number(cfg.smtpPort) || 587;
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port,
        secure: cfg.smtpSecure === true || port === 465,
        auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPassword } : undefined,
      });
      this.from = cfg.from || cfg.smtpUser || 'fapoms@localhost';
      this.logger.log(`Email enabled via SMTP host ${smtpHost}:${port}.`);
      return;
    }

    this.logger.warn(
      'Email is not configured — set it up under Administration → Platform Settings → Email delivery, or via GMAIL_USER + ' +
      'GMAIL_APP_PASSWORD / SMTP_HOST. Email notifications will be suppressed until then.',
    );
  }

  /**
   * Saved settings first, environment second — the same order everything else resolves in.
   * Falls back to reading the environment directly when no settings service is present.
   */
  private async resolveConfig(): Promise<{
    transport: string | null;
    gmailUser?: string; gmailAppPassword?: string;
    smtpHost?: string; smtpPort?: number; smtpUser?: string; smtpPassword?: string;
    smtpSecure?: boolean;
    from?: string;
  }> {
    if (!this.settings) {
      return {
        transport: process.env.GMAIL_USER ? 'GMAIL' : process.env.SMTP_HOST ? 'SMTP' : null,
        gmailUser: process.env.GMAIL_USER,
        gmailAppPassword: process.env.GMAIL_APP_PASSWORD,
        smtpHost: process.env.SMTP_HOST,
        smtpPort: Number(process.env.SMTP_PORT) || 587,
        smtpUser: process.env.SMTP_USER,
        smtpPassword: process.env.SMTP_PASSWORD,
        smtpSecure: process.env.SMTP_SECURE === 'true',
        from: process.env.EMAIL_FROM,
      };
    }

    const v = await this.settings.getMany([
      'email.transport', 'email.gmailUser', 'email.gmailAppPassword',
      'email.smtpHost', 'email.smtpPort', 'email.smtpUser', 'email.smtpPassword',
      'email.smtpSecure', 'email.from',
    ]).catch(() => ({} as Record<string, any>));

    /**
     * "Off" must mean off — but only when somebody chose it.
     *
     * The inference below exists for a deployment configured before this screen existed: its
     * transport has never been saved, so it reads as the shipped default 'NONE', and refusing
     * to send would break working email on upgrade. Applying that inference unconditionally had
     * the opposite failure — an administrator selecting "Off — send no email" was silently
     * overruled by the environment variables still sitting in the deployment, and the screen
     * showed a switch that did nothing. Provenance is what separates the two cases.
     */
    const chosen = await this.settings.getWithSource<string>('email.transport').catch(() => null);
    let transport = v['email.transport'] ?? 'NONE';
    if (transport === 'NONE' && chosen?.source !== 'saved') {
      if (v['email.gmailUser']) transport = 'GMAIL';
      else if (v['email.smtpHost']) transport = 'SMTP';
    }

    return {
      transport,
      gmailUser: v['email.gmailUser'] ?? undefined,
      gmailAppPassword: v['email.gmailAppPassword'] ?? undefined,
      smtpHost: v['email.smtpHost'] ?? undefined,
      smtpPort: v['email.smtpPort'] ?? undefined,
      smtpUser: v['email.smtpUser'] ?? undefined,
      smtpPassword: v['email.smtpPassword'] ?? undefined,
      smtpSecure: v['email.smtpSecure'] === true,
      from: v['email.from'] ?? undefined,
    };
  }

  isEnabled(): boolean {
    return this.transporter !== null;
  }

  async send(payload: EmailPayload): Promise<EmailResult> {
    if (!this.transporter) {
      return { success: false, error: 'Email is not configured.', permanent: true };
    }

    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
        attachments: payload.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
        })),
      });
      return { success: true, messageId: info?.messageId };
    } catch (err: any) {
      const permanent =
        PERMANENT_CODES.has(err?.code) || PERMANENT_RESPONSE_CODES.has(Number(err?.responseCode));
      return {
        success: false,
        error: err?.message ?? 'Email send failed.',
        permanent,
      };
    }
  }
}

/**
 * Base URL for links inside emails; the in-app `link` values are relative frontend routes.
 *
 * Kept as a module function rather than a service method because it is called from render
 * helpers that have no injector. The settings module pushes the operator's value in whenever it
 * changes, so a saved address takes effect without a restart; until then it reads the
 * environment exactly as before.
 */
let publicUrlOverride: string | null = null;

export function setAppPublicUrl(url: string | null): void {
  publicUrlOverride = url && url.trim() ? url.trim() : null;
}

export function appPublicUrl(): string {
  const raw = publicUrlOverride || process.env.APP_PUBLIC_URL || 'http://localhost:5173';
  return raw.replace(/\/+$/, '');
}

/**
 * The one HTML shell every notification email uses.
 *
 * Deliberately plain: inline styles only (mail clients strip stylesheets), a readable dark-on-
 * light body regardless of the app's theme, one button. The plain-text part carries the same
 * content, so nothing depends on HTML rendering.
 */
export function renderEmailHtml(opts: {
  title: string;
  bodyLines: string[];
  linkUrl?: string | null;
  linkLabel?: string;
  footer?: string;
}): string {
  // Quotes included: this output lands inside attribute values as well as text nodes, and an
  // unescaped `"` there closes the attribute and starts a new one.
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  /**
   * Only http(s) reaches an href.
   *
   * Link values are assembled from `APP_PUBLIC_URL` plus a route an administrator can now edit
   * in the template screen, so `javascript:` is reachable by configuration rather than only by
   * compromise. Anything else is dropped: an email with no button beats an email carrying a
   * hostile one.
   */
  const safeUrl = (url: string | null | undefined): string | null => {
    if (!url) return null;
    try {
      const parsed = new URL(url, 'http://localhost');
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? esc(url) : null;
    } catch {
      return null;
    }
  };
  const href = safeUrl(opts.linkUrl);

  const paragraphs = opts.bodyLines
    .map((line) => `<p style="margin:0 0 12px 0;font-size:14px;line-height:1.6;color:#333333;">${esc(line)}</p>`)
    .join('\n');

  const button = href
    ? `<a href="${href}" style="display:inline-block;margin-top:8px;padding:10px 22px;background:#b8860b;color:#ffffff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">${esc(opts.linkLabel ?? 'Open in FAPOMS')}</a>`
    : '';

  const footer = esc(
    opts.footer ??
      'You are receiving this because of your role in FAPOMS. Manage which emails you get under Notifications → Preferences.',
  );

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f4;">
  <div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;font-family:Arial,Helvetica,sans-serif;">
    <div style="background:#1a1a1a;padding:16px 24px;">
      <span style="color:#d8ae47;font-size:16px;font-weight:700;">Sumeru Audit Suite</span>
    </div>
    <div style="padding:24px;">
      <h2 style="margin:0 0 16px 0;font-size:17px;color:#111111;">${esc(opts.title)}</h2>
      ${paragraphs}
      ${button}
    </div>
    <div style="padding:14px 24px;border-top:1px solid #eeeeee;">
      <span style="font-size:11px;color:#999999;">${footer}</span>
    </div>
  </div>
</body></html>`;
}
