import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import { DEFAULT_EMAIL_BRAND, renderEmailLayout, type EmailLayoutTone } from '@fapoms/shared';

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

import { getSumeruLogoBuffer, SUMERU_LOGO_CID } from './sumeru-logo.asset';

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  cid?: string;
  contentDisposition?: string;
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
  /**
   * True when the fault is the CHANNEL, not this message: the mail server refused our login
   * (EAUTH / 535 / 530), or could not be reached at all. Every message would get the same answer,
   * and every one of them becomes deliverable the moment the credential or the network is fixed —
   * so the message goes back to the queue on a long backoff instead of being settled FAILED.
   */
  transportFault?: boolean;
}

/** SMTP situations where a retry will produce the same answer FOR THIS MESSAGE. */
const PERMANENT_CODES = new Set(['EENVELOPE', 'EMESSAGE']);
const PERMANENT_RESPONSE_CODES = new Set([550, 551, 553]);

/**
 * The mail channel itself is broken: our credentials were refused, or the server is unreachable.
 *
 * EAUTH/535 used to be in the permanent set above, so a rotated Gmail app password marked every
 * message FAILED for good — a whole morning of invitations lost, none of them retried once the
 * password was fixed, and nothing told anyone that every send was failing.
 */
const TRANSPORT_CODES = new Set(['EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND']);
const TRANSPORT_RESPONSE_CODES = new Set([421, 454, 530, 534, 535]);

/** Classifies an SMTP failure. Exported for its spec. */
export function classifyMailError(err: { code?: string; responseCode?: number | string } | null | undefined): {
  permanent: boolean;
  transportFault: boolean;
} {
  const code = err?.code ?? '';
  const response = Number(err?.responseCode);
  const transportFault = TRANSPORT_CODES.has(code) || TRANSPORT_RESPONSE_CODES.has(response);
  const permanent = !transportFault && (PERMANENT_CODES.has(code) || PERMANENT_RESPONSE_CODES.has(response));
  return { permanent, transportFault };
}

/**
 * How the mail connection is held, for every transport.
 *
 * ## Pooled, because a fresh connection per message was most of the wait
 *
 * Every `sendMail` used to open its own connection: DNS, TCP, TLS, EHLO, AUTH, then the message,
 * then QUIT. Against Gmail that handshake is the bulk of a send — measured on this deployment,
 * scheduling an interview (one invite) took 4.95 s and sending a colleague a setup link took
 * 2.82 s, while ordinary requests answered in well under 0.1 s. A pool keeps a few authenticated
 * connections open and reuses them, so only the first message after an idle spell pays for the
 * handshake.
 *
 * ## Bounded, because nodemailer's defaults are minutes
 *
 * Out of the box nodemailer waits 2 minutes to connect, 30 s for the greeting and **10 minutes**
 * on an idle socket. Whatever holds the send waits that long too — before this change, a person's
 * HTTP request. A mail server that stops answering must become a quick, retryable failure, not a
 * page that spins until the browser gives up while the server carries on.
 *
 * The socket limit is the generous one on purpose: a branch audit packet goes out as an
 * attachment of up to several megabytes, and a slow upload of a real message is not a hang.
 */
export const MAIL_CONNECTION_OPTIONS = {
  pool: true,
  /** Gmail allows a handful of concurrent sessions per account; three is well inside that. */
  maxConnections: 3,
  /** Recycle a connection after this many messages, before a provider does it for us mid-send. */
  maxMessages: 100,
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 60_000,
} as const;

@Injectable()
export class EmailProvider implements OnModuleInit, OnModuleDestroy {
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
    // A pooled transport holds open connections, so replacing it without closing it would leave
    // the old mailbox's sessions logged in until the server dropped them.
    this.closeTransport();
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
        ...MAIL_CONNECTION_OPTIONS,
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
        ...MAIL_CONNECTION_OPTIONS,
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

  /** Releases the pooled connections on shutdown, so a rolling deploy does not strand sessions. */
  onModuleDestroy(): void {
    this.closeTransport();
  }

  private closeTransport(): void {
    const previous = this.transporter;
    this.transporter = null;
    try {
      previous?.close?.();
    } catch {
      // Closing is courtesy to the mail server; failing to do it must never break a reconfigure.
    }
  }

  async send(payload: EmailPayload): Promise<EmailResult> {
    if (!this.transporter) {
      return { success: false, error: 'Email is not configured.', permanent: true };
    }

    let html = payload.html;
    const attachments: EmailAttachment[] = payload.attachments ? [...payload.attachments] : [];

    if (html && (html.includes('sumeru-logo') || html.includes('{{logoUrl}}') || html.includes(`cid:${SUMERU_LOGO_CID}`))) {
      // Normalize any HTTP/relative sumeru-logo references or {{logoUrl}} tokens to cid:sumeru-logo
      html = html
        .replace(/src=["'][^"']*sumeru-logo[^"']*["']/gi, `src="cid:${SUMERU_LOGO_CID}"`)
        .replace(/src=["']\{\{\s*logoUrl\s*\}\}["']/gi, `src="cid:${SUMERU_LOGO_CID}"`)
        .replace(/\{\{\s*logoUrl\s*\}\}/gi, `cid:${SUMERU_LOGO_CID}`);

      if (!attachments.some((a) => a.cid === SUMERU_LOGO_CID)) {
        attachments.push({
          filename: 'sumeru-logo.png',
          content: getSumeruLogoBuffer(),
          contentType: 'image/png',
          cid: SUMERU_LOGO_CID,
          contentDisposition: 'inline',
        });
      }
    }

    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: payload.to,
        subject: payload.subject,
        text: payload.text,
        html,
        attachments: attachments.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
          cid: a.cid,
          contentDisposition: a.contentDisposition ?? (a.cid ? 'inline' : 'attachment'),
        })),
      });
      return { success: true, messageId: info?.messageId };
    } catch (err: any) {
      const { permanent, transportFault } = classifyMailError(err);
      return {
        success: false,
        error: err?.message ?? 'Email send failed.',
        permanent,
        transportFault,
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

export type EmailTone = EmailLayoutTone;

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

const DEFAULT_EMAIL_FOOTER =
  'You are receiving this communication regarding your role in FAPOMS. Update preferences under Notifications → Preferences.';

/**
 * A Sumeru Global & FAPOMS system email, drawn by the one shared layout.
 *
 * The shell itself — header, code box, table, callout, button, footer, and the escaping and
 * safe-link rules — lives in `renderEmailLayout` in `@fapoms/shared`, which the administrators'
 * template editor also draws through, so a built-in email and an edited template are the same
 * design. This is only the server's default brand and its option names. Every string is escaped;
 * a link that is not http(s) or relative is dropped along with its button.
 */
export function renderEmailHtml(opts: EmailRenderOptions): string {
  return renderEmailLayout({
    brand: { ...DEFAULT_EMAIL_BRAND, logoUrl: `${appPublicUrl()}/sumeru-logo@2x.png` },
    title: opts.title,
    subtitle: opts.subtitle,
    badge: opts.badge,
    bodyLines: opts.bodyLines,
    // The expiry is the caller's to state (in the security notice): the box used to promise
    // "10 minutes" whatever the code's real lifetime was, and registration codes last five.
    codeBox: opts.otpCode
      ? { code: opts.otpCode, label: 'One-Time Verification Code', note: 'Strictly confidential' }
      : undefined,
    kvTable: opts.kvTable,
    callout: opts.callout,
    button: opts.linkUrl ? { href: opts.linkUrl, label: opts.linkLabel ?? 'Open in FAPOMS' } : undefined,
    securityNotice: opts.securityNotice,
    footer: opts.footer ?? DEFAULT_EMAIL_FOOTER,
  });
}

