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
      // An optional dependency, deliberately resolved at runtime: a missing nodemailer must
      // disable email, not stop the application from booting. A static import throws at load and
      // cannot be caught here.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
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

export type EmailTone = 'gold' | 'flame' | 'emerald' | 'crimson' | 'slate';

export interface EmailBadge {
  text: string;
  tone?: EmailTone;
}

export interface EmailCallout {
  title?: string;
  text: string;
  tone?: EmailTone;
}

export interface EmailKeyValueItem {
  label: string;
  value: string;
}

export interface EmailRenderOptions {
  title: string;
  subtitle?: string;
  badge?: EmailBadge;
  bodyLines: string[];
  otpCode?: string;
  kvTable?: EmailKeyValueItem[];
  callout?: EmailCallout;
  linkUrl?: string | null;
  linkLabel?: string;
  footer?: string;
  securityNotice?: string;
}

const TONE_STYLES: Record<
  EmailTone,
  {
    badgeBg: string;
    badgeText: string;
    badgeBorder: string;
    calloutBg: string;
    calloutBorder: string;
    calloutText: string;
  }
> = {
  gold: {
    badgeBg: '#FEF9E7',
    badgeText: '#8D6809',
    badgeBorder: '#F8E7A2',
    calloutBg: '#FFFDF5',
    calloutBorder: '#D8AE47',
    calloutText: '#382F26',
  },
  flame: {
    badgeBg: '#FFF3EB',
    badgeText: '#B8460D',
    badgeBorder: '#FFD0B5',
    calloutBg: '#FFF8F5',
    calloutBorder: '#ED6714',
    calloutText: '#382F26',
  },
  emerald: {
    badgeBg: '#EBF8F2',
    badgeText: '#136C45',
    badgeBorder: '#BCE6D2',
    calloutBg: '#F4FBF7',
    calloutBorder: '#10B981',
    calloutText: '#382F26',
  },
  crimson: {
    badgeBg: '#FDF2F2',
    badgeText: '#A82222',
    badgeBorder: '#F9C8C8',
    calloutBg: '#FEF7F7',
    calloutBorder: '#EF4444',
    calloutText: '#382F26',
  },
  slate: {
    badgeBg: '#F1F5F9',
    badgeText: '#475569',
    badgeBorder: '#CBD5E1',
    calloutBg: '#F8FAFC',
    calloutBorder: '#64748B',
    calloutText: '#382F26',
  },
};

/**
 * The clean, authoritative HTML shell for all Sumeru Global & FAPOMS emails.
 *
 * Implements an executive, uncluttered aesthetic:
 *  - Authentic corporate mark (sumeru-logo@2x.png) with flame tips and wordmark
 *  - Spacious white card on a subtle neutral ground (#F8F9FA)
 *  - Clear typographic hierarchy with high contrast readability
 *  - Minimal, context-specific components without visual clutter
 *  - Full compatibility across email clients (Gmail, Apple Mail, Outlook)
 */
export function renderEmailHtml(opts: EmailRenderOptions): string {
  const esc = (s: string) =>
    s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

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
  const logoUrl = `${appPublicUrl()}/sumeru-logo@2x.png`;

  // Badge HTML (only rendered if badge is explicitly provided)
  let badgeHtml = '';
  if (opts.badge?.text) {
    const tone = opts.badge.tone && TONE_STYLES[opts.badge.tone] ? opts.badge.tone : 'gold';
    const style = TONE_STYLES[tone];
    badgeHtml = `
      <div style="margin-bottom:12px;">
        <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:10.5px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;background-color:${style.badgeBg};color:${style.badgeText};border:1px solid ${style.badgeBorder};">
          ${esc(opts.badge.text)}
        </span>
      </div>`;
  }

  // Subtitle HTML
  const subtitleHtml = opts.subtitle
    ? `<p style="margin:0 0 16px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13.5px;color:#6B7280;line-height:1.5;">${esc(opts.subtitle)}</p>`
    : '';

  // Body paragraphs
  const paragraphs = opts.bodyLines
    .map(
      (line) =>
        `<p style="margin:0 0 12px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14.5px;line-height:1.65;color:#374151;">${esc(line)}</p>`,
    )
    .join('\n');

  // Key-Value Table HTML
  let kvTableHtml = '';
  if (opts.kvTable && opts.kvTable.length > 0) {
    const rows = opts.kvTable
      .map(
        (item, idx) => `
        <tr>
          <td valign="top" style="padding:10px 14px;border-bottom:${idx === opts.kvTable!.length - 1 ? 'none' : '1px solid #E5E7EB'};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;font-weight:500;color:#6B7280;width:38%;">
            ${esc(item.label)}
          </td>
          <td valign="top" style="padding:10px 14px;border-bottom:${idx === opts.kvTable!.length - 1 ? 'none' : '1px solid #E5E7EB'};font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:13px;font-weight:600;color:#111827;">
            ${esc(item.value)}
          </td>
        </tr>`,
      )
      .join('\n');

    kvTableHtml = `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:18px 0 20px 0;border:1px solid #E5E7EB;border-radius:8px;overflow:hidden;background-color:#F9FAFB;">
        ${rows}
      </table>`;
  }

  // OTP Code Box HTML (sleek, warm, clean)
  let otpCodeHtml = '';
  if (opts.otpCode) {
    otpCodeHtml = `
      <div style="margin:20px 0 22px 0;padding:20px 16px;background-color:#FFF7ED;border:1px solid #FED7AA;border-radius:8px;text-align:center;">
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:1px;color:#C2410C;text-transform:uppercase;margin-bottom:6px;">
          One-Time Verification Code
        </div>
        <div style="font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,'Liberation Mono',monospace;font-size:34px;font-weight:700;letter-spacing:8px;color:#9A3412;padding:2px 0;">
          ${esc(opts.otpCode)}
        </div>
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11.5px;color:#9A3412;opacity:0.85;margin-top:6px;">
          Valid for 10 minutes &bull; Strictly confidential
        </div>
      </div>`;
  }

  // Callout HTML (light alert box with left accent)
  let calloutHtml = '';
  if (opts.callout?.text) {
    const tone = opts.callout.tone && TONE_STYLES[opts.callout.tone] ? opts.callout.tone : 'flame';
    const style = TONE_STYLES[tone];
    const calloutTitle = opts.callout.title
      ? `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12.5px;font-weight:600;color:#111827;margin-bottom:3px;">${esc(opts.callout.title)}</div>`
      : '';
    calloutHtml = `
      <div style="margin:16px 0 18px 0;padding:12px 14px;background-color:${style.calloutBg};border-left:3px solid ${style.calloutBorder};border-radius:0 6px 6px 0;">
        ${calloutTitle}
        <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.5;color:${style.calloutText};">
          ${esc(opts.callout.text)}
        </div>
      </div>`;
  }

  // Action Button HTML (solid Sumeru flame orange)
  let buttonHtml = '';
  if (href) {
    buttonHtml = `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0 8px 0;">
        <tr>
          <td align="center" style="border-radius:6px;background-color:#ED6714;">
            <a href="${href}" target="_blank" style="display:inline-block;padding:11px 26px;background-color:#ED6714;color:#FFFFFF;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;font-weight:600;letter-spacing:0.2px;text-decoration:none;border-radius:6px;">
              ${esc(opts.linkLabel ?? 'Open in FAPOMS')}
            </a>
          </td>
        </tr>
      </table>
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11px;color:#9CA3AF;margin-top:8px;word-break:break-all;line-height:1.4;">
        Direct link: <a href="${href}" style="color:#ED6714;text-decoration:underline;">${href}</a>
      </div>`;
  }

  // Security Notice HTML
  const securityNoticeHtml = opts.securityNotice
    ? `<div style="margin-top:16px;padding-top:12px;border-top:1px solid #F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11.5px;color:#6B7280;line-height:1.45;">
        <strong style="color:#374151;">Note:</strong> ${esc(opts.securityNotice)}
      </div>`
    : '';

  // Footer HTML
  const footerText = esc(
    opts.footer ??
      'You are receiving this communication regarding your role in FAPOMS. Update preferences under Notifications → Preferences.',
  );

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(opts.title)}</title>
</head>
<body style="margin:0;padding:0;background-color:#F8F9FA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#F8F9FA;padding:32px 12px;">
    <tr>
      <td align="center">
        <!--[if (gte mso 9)|(IE)]>
        <table role="presentation" width="560" align="center" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td>
        <![endif]-->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;background-color:#FFFFFF;border-radius:10px;overflow:hidden;border:1px solid #E5E7EB;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
          <!-- Header with Authentic Logo -->
          <tr>
            <td align="center" style="padding:28px 32px 20px 32px;border-bottom:1px solid #F3F4F6;">
              <img src="${esc(logoUrl)}" alt="Sumeru Global" width="65" height="50" style="display:block;margin:0 auto;border:0;outline:none;" />
            </td>
          </tr>
          <!-- Content Body -->
          <tr>
            <td style="padding:28px 32px 24px 32px;background-color:#FFFFFF;">
              ${badgeHtml}
              <h1 style="margin:0 0 ${opts.subtitle ? '6px' : '14px'} 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;color:#111827;line-height:1.35;letter-spacing:-0.2px;">
                ${esc(opts.title)}
              </h1>
              ${subtitleHtml}
              ${paragraphs}
              ${otpCodeHtml}
              ${kvTableHtml}
              ${calloutHtml}
              ${buttonHtml}
              ${securityNoticeHtml}
            </td>
          </tr>
          <!-- Clean Footer -->
          <tr>
            <td align="center" style="padding:20px 32px;background-color:#F9FAFB;border-top:1px solid #F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
              <div style="font-size:12px;font-weight:600;color:#4B5563;">
                Sumeru Global &bull; Field Audit Operations Management
              </div>
              <div style="font-size:11.5px;color:#9CA3AF;margin-top:4px;line-height:1.5;">
                ${footerText}
              </div>
            </td>
          </tr>
        </table>
        <!--[if (gte mso 9)|(IE)]>
            </td>
          </tr>
        </table>
        <![endif]-->
      </td>
    </tr>
  </table>
</body>
</html>`;
}

