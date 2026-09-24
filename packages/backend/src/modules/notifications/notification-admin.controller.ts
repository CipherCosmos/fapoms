/**
 * FAPOMS — Notification & Email Administration
 *
 * Everything about how the platform speaks to people, made changeable without a deploy: which
 * events fire, on which channels, in whose words, and whether the mail path works at all.
 *
 * Held to administrators — and, for the two transport-plumbing routes (email/test, digest/run),
 * to the developer alone. These settings decide what reaches whose inbox and phone across the
 * whole organisation — a mistake here is not one person's preference, it is everyone's.
 */

import {
  Controller, Get, Put, Post, Delete, Param, Body, Req, UseGuards, BadRequestException, Optional,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsArray, IsInt, IsEmail, Min, Max, IsObject } from 'class-validator';
import { IsNotEmpty, MaxLength } from 'class-validator';
import { SystemRole, NotificationChannel, NotificationPriority, NotificationCategory } from '@fapoms/shared';
import { toE164IndianMobile } from '@fapoms/shared';

import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions, RoleOnly } from '../auth/guards';
import { NotificationSettingsService, EffectiveNotificationType } from './notification-settings.service';
import { NOTIFICATION_CATALOG } from './notification-catalog';
import { appPublicUrl, renderEmailHtml } from '../../infrastructure/notifications/email-provider';
import { EmailService } from './email.service';
import { AuditService } from '../../core/audit/audit.service';
import { NOT_A_RECORD_ENTITY_ID } from '../../core/audit/audit-event';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { EventCategory } from '@fapoms/shared';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { FAILED_JOB_RETENTION } from '../../infrastructure/queue/queued-job';

import {
  EMAIL_TEMPLATE_REGISTRY,
  EmailTemplateKey,
} from '../../infrastructure/notifications/email-template-registry';
import { validateTemplateContract } from '../../infrastructure/notifications/email-template-validator';
import {
  EmailTemplateLoader,
  EmailTemplateVersion,
  TemplateSource,
} from '../../infrastructure/notifications/email-template-loader';
import { EmailTemplateRenderer } from '../../infrastructure/notifications/email-template-renderer';
import { plainTextFor } from '../../infrastructure/notifications/html-to-text';
import { SmsProvider } from '../../infrastructure/notifications/sms-provider';
import { OutboundMessageService } from './outbound-message.service';
import { MessageTokensService, SAMPLE_RECIPIENT } from '../../infrastructure/notifications/message-tokens';
import { SmsService } from './sms.service';
import { SmsTemplateService, SmsTemplateView } from './sms-template.service';

export class UpdateNotificationSettingRequestDto {
  @IsOptional() @IsBoolean()
  enabled?: boolean;

  @IsOptional() @IsArray()
  channels?: string[] | null;

  @IsOptional() @IsString()
  priority?: string | null;

  @IsOptional() @IsArray()
  roles?: string[] | null;

  @IsOptional() @IsString()
  titleTemplate?: string | null;

  @IsOptional() @IsString()
  bodyTemplate?: string | null;

  @IsOptional() @IsString()
  linkTemplate?: string | null;

  @IsOptional() @IsString()
  emailSubjectTemplate?: string | null;

  /** Plain text; the mail shell escapes it and turns line breaks into paragraphs. */
  @IsOptional() @IsString()
  emailBodyTemplate?: string | null;

  @IsOptional() @IsInt() @Min(0) @Max(86_400)
  collapseWindowSeconds?: number | null;

  @IsOptional() @IsString()
  notes?: string | null;
}

export class PreviewTemplateRequestDto {
  @IsString()
  title: string;

  @IsString()
  body: string;

  @IsOptional() @IsString()
  link?: string;

  @IsOptional() @IsString()
  emailSubject?: string;

  @IsOptional() @IsString()
  emailBody?: string;

  /** Sample values for the `${placeholders}`. */
  @IsOptional() @IsObject()
  payload?: Record<string, any>;
}

export class TestEmailRequestDto {
  @IsEmail({}, { message: 'Give a valid email address to send the test to.' })
  to: string;
}

export class ValidateEmailTemplateDto {
  @IsString()
  html: string;

  @IsOptional() @IsString()
  subjectTemplate?: string;
}

export class PreviewEmailTemplateDto {
  @IsOptional() @IsString()
  html?: string;

  @IsOptional() @IsString()
  subjectTemplate?: string;

  @IsOptional() @IsObject()
  payload?: Record<string, any>;
}

export class SaveEmailTemplateDraftDto {
  @IsString()
  html: string;

  @IsOptional() @IsString()
  subjectTemplate?: string;
}

export class PublishEmailTemplateDto {
  @IsOptional() @IsString()
  html?: string;

  @IsOptional() @IsString()
  subjectTemplate?: string;

  @IsOptional() @IsString()
  changeNotes?: string;
}

export class RollbackEmailTemplateDto {
  @IsInt() @Min(1)
  version: number;
}

export class SetTemplateSourceDto {
  @IsString()
  source: TemplateSource;
}

export class TestEmailTemplateDto {
  @IsEmail({}, { message: 'Give a valid email address to send the test to.' })
  to: string;

  @IsOptional() @IsString()
  html?: string;

  @IsOptional() @IsString()
  subjectTemplate?: string;

  @IsOptional() @IsObject()
  payload?: Record<string, any>;
}

export class TestSmsRequestDto {
  /** Any way an Indian mobile is typed; checked with the one phone rule in the handler. */
  @IsString() @IsNotEmpty({ message: 'Give a mobile number to send the test text to.' })
  to: string;
}

export class TestSmsTemplateDto {
  /** Any way an Indian mobile is typed; checked with the one phone rule in the handler. */
  @IsString() @IsNotEmpty({ message: 'Give a mobile number to send the test text to.' })
  to: string;

  /** Values to put in the text. Left out, the template's own example values are used. */
  @IsOptional() @IsObject()
  data?: Record<string, string>;
}

export class SaveSmsTemplateDto {
  /** Left out = unchanged; empty or null = back to the standard wording. */
  @IsOptional() @IsString() @MaxLength(2000)
  text?: string | null;

  /** Left out = unchanged; empty or null = cleared. */
  @IsOptional() @IsString() @MaxLength(64)
  dltTemplateId?: string | null;
}

/**
 * Super administrators only — reads and writes alike.
 */
const NOTIFICATION_ADMIN_ROLES = [SystemRole.ADMIN] as const;
const NOTIFICATION_ADMIN_READ_ROLES = [...NOTIFICATION_ADMIN_ROLES];

@ApiTags('Notification Administration')
@ApiBearerAuth()
@Controller('notification-admin')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles(...NOTIFICATION_ADMIN_READ_ROLES)
export class NotificationAdminController {
  constructor(
    private readonly settings: NotificationSettingsService,
    private readonly email: EmailService,
    @InjectQueue('sla-scanner') private readonly scannerQueue: Queue,
    private readonly audit: AuditService,
    private readonly platformSettings: PlatformSettingsService,
    private readonly templateLoader: EmailTemplateLoader,
    private readonly templateRenderer: EmailTemplateRenderer,
    private readonly sms: SmsService,
    private readonly smsProvider: SmsProvider,
    private readonly smsTemplates: SmsTemplateService,
    /** Only for previews: the values every message carries, so a preview shows what is really sent. */
    private readonly tokens: MessageTokensService,
    /** Delivery health per channel, for the settings screen's "every send is failing" banner. */
    @Optional() private readonly outbound?: OutboundMessageService,
  ) {}

  /**
   * Records a configuration change against the platform's audit trail.
   *
   * These writes decide who gets told what across the whole organisation, and `reset` DELETES
   * the override row — so without this the only record of "somebody switched the SLA alert off
   * last month" was the row itself, and resetting destroyed it. Never allowed to fail the
   * change it describes.
   */
  private async record(eventType: string, type: string, userId: string | undefined, remarks: string, metadata?: any) {
    /**
     * The notification type goes in `metadata`, not `entityId`. It reads like an identifier
     * but it is a catalog key ('SLA_BREACH'), and `entity_id` is `uuid NOT NULL` — so every
     * write here was rejected by Postgres and then swallowed by `.catch(() => undefined)`.
     * The trail this comment promises did not exist: `NOTIFICATION_SETTING` had zero rows.
     * `recordEventSafe` still cannot fail the change it describes, but it says so in the log.
     */
    await this.audit.recordEventSafe({
      category: EventCategory.SYSTEM,
      eventType,
      entityType: 'NOTIFICATION_SETTING',
      entityId: NOT_A_RECORD_ENTITY_ID,
      userId,
      remarks,
      metadata: { ...(metadata ?? {}), notificationType: type },
    });
  }

  /**
   * Every event the platform can raise, as it is configured right now, beside the shipped
   * default it was derived from — so an operator can always see what they changed and what
   * "reset" would restore.
   */
  @Get('catalog')
  @ApiOperation({ summary: 'Every notification type, effective settings plus shipped defaults' })
  async catalog(): Promise<{
    types: Array<EffectiveNotificationType & {
      defaults: { channels: string[]; priority: string; roles: string[]; title: string; body: string; link?: string };
      placeholders: string[];
    }>;
    channels: string[];
    priorities: string[];
    categories: string[];
    roles: string[];
  }> {
    const effective = await this.settings.effectiveCatalog();
    const types = Object.entries(effective)
      .map(([type, def]) => {
        const base = NOTIFICATION_CATALOG[type];
        return {
          ...def,
          defaults: {
            channels: base.channels as string[],
            priority: base.priority as string,
            roles: base.roles,
            title: base.title,
            body: base.body,
            link: base.link,
          },
          placeholders: this.settings.placeholdersFor(type),
        };
      })
      .sort((a, b) => a.category.localeCompare(b.category) || a.type.localeCompare(b.type));

    return {
      types,
      channels: Object.values(NotificationChannel),
      priorities: Object.values(NotificationPriority),
      categories: Object.values(NotificationCategory),
      roles: Object.values(SystemRole),
    };
  }

  @Put('catalog/:type')
  @Roles(...NOTIFICATION_ADMIN_ROLES)
  @RoleOnly()
  @RequirePermissions('configuration:edit:platform')
  @ApiOperation({ summary: 'Override one notification type — channels, roles, wording, on/off' })
  async update(
    @Param('type') type: string,
    @Body() dto: UpdateNotificationSettingRequestDto,
    @Req() req: any,
  ): Promise<{ success: boolean; data: EffectiveNotificationType }> {
    const data = await this.settings.update(type, dto, req.user?.id);
    await this.record(
      'NOTIFICATION_SETTING_CHANGED',
      type,
      req.user?.id,
      `Changed notification "${type}": ${Object.keys(dto).join(', ') || 'no fields'}.`,
      { fields: Object.keys(dto), enabled: data.enabled, channels: data.channels, roles: data.roles },
    );
    return { success: true, data };
  }

  /** Drops the override row entirely, so the type follows the shipped default again. */
  @Delete('catalog/:type')
  @Roles(...NOTIFICATION_ADMIN_ROLES)
  @RoleOnly()
  @RequirePermissions('configuration:edit:platform')
  @ApiOperation({ summary: 'Reset one notification type to its shipped default' })
  async reset(@Param('type') type: string, @Req() req: any): Promise<EffectiveNotificationType> {
    const data = await this.settings.reset(type);
    await this.record('NOTIFICATION_SETTING_RESET', type, req.user?.id, `Reset notification "${type}" to its shipped default.`);
    return data;
  }

  /**
   * Renders a draft template through the real renderer, so what the editor shows is exactly
   * what would be sent — including the cleanup pass that removes fragments left by missing
   * values, which is the part authors most often do not expect.
   */
  @Post('preview')
  @ApiOperation({ summary: 'Render a draft template against sample values' })
  async preview(@Body() dto: PreviewTemplateRequestDto): Promise<any> {
    const rendered = this.settings.preview(
      {
        title: dto.title,
        body: dto.body,
        link: dto.link ?? null,
        emailSubject: dto.emailSubject ?? null,
        emailBody: dto.emailBody ?? null,
      },
      dto.payload ?? {},
    );
    return {
      ...rendered,
      // The exact HTML the mail shell would wrap it in, so the editor can show a true preview.
      emailHtml: renderEmailHtml({
        title: rendered.emailSubject,
        bodyLines: rendered.emailBody.split('\n').filter(Boolean),
        linkUrl: rendered.link ? `${appPublicUrl()}${rendered.link}` : null,
        linkLabel: 'Open in FAPOMS',
      }),
    };
  }

  /** Whether mail can actually leave the building, and how it is configured. */
  @Get('email/status')
  @ApiOperation({ summary: 'Is outbound email configured, and by which transport' })
  async emailStatus(): Promise<any> {
    /**
     * Resolved exactly the way the provider resolves it — saved settings, then environment.
     *
     * This read `process.env` directly, which was correct only until configuration moved into
     * the app. After that, an administrator who entered a mailbox in Platform Settings saw
     * `enabled: true` (the provider is settings-aware) beside `transport: null` and "Sending as
     * undefined" — the status contradicting the very field they had just filled in, on the same
     * screen. One resolver, one answer.
     */
    const v = await this.platformSettings
      .getMany([
        'email.transport', 'email.gmailUser', 'email.smtpHost', 'email.from', 'digest.cron',
      ])
      .catch(() => ({} as Record<string, any>));

    const gmailUser = v['email.gmailUser'] ?? process.env.GMAIL_USER ?? null;
    const smtpHost = v['email.smtpHost'] ?? process.env.SMTP_HOST ?? null;
    const chosen = await this.platformSettings.getWithSource<string>('email.transport').catch(() => null);

    // Same precedence as EmailProvider.resolveConfig: an explicit "Off" wins, an untouched
    // default defers to whatever credentials a pre-settings deployment left in place.
    let transport: string | null = v['email.transport'] ?? 'NONE';
    if (transport === 'NONE' && chosen?.source !== 'saved') {
      transport = gmailUser ? 'GMAIL' : smtpHost ? 'SMTP' : null;
    } else if (transport === 'NONE') {
      transport = null;
    }

    const account = transport === 'GMAIL' ? gmailUser : transport === 'SMTP' ? smtpHost : null;

    return {
      enabled: this.email.isEnabled(),
      transport,
      // The account, never the credential.
      account,
      from: v['email.from'] ?? process.env.EMAIL_FROM ?? (transport === 'GMAIL' ? gmailUser : null),
      appPublicUrl: appPublicUrl(),
      digestCron: v['digest.cron'] ?? process.env.EMAIL_DIGEST_CRON ?? '30 8 * * 1-6',
      digestTimeZone: 'Asia/Kolkata',
      // What to do about it, in the response, so the screen never has to guess.
      hint: this.email.isEnabled()
        ? null
        : 'Configure it under Administration → Platform Settings → Email delivery. It takes effect immediately; no restart.',
      /*
        Per channel (email and SMS), the last half hour: sends, failures, and `down` when there were
        failures and not one send — the settings screen shows a banner then. Null when unreadable.
      */
      delivery: this.outbound ? await this.outbound.channelHealth().catch(() => null) : null,
    };
  }

  /**
   * Sends a real email through the real provider.
   *
   * The only way to know a mail configuration works is to use it — a green "configured" badge
   * proves the variables are set, not that Gmail accepts them. Sent while the administrator waits
   * (`EmailService.sendNow`), because the answer IS whether it went; still recorded in
   * `outbound_emails` like every other email.
   */
  @Post('email/test')
  // Method-level override of the class @Roles(ADMIN) — see the 2026-09-05 amendment in the
  // class comment: exercising the mail transport is the developer's, and one-way implication
  // means an administrator does not pass this route.
  @Roles(SystemRole.DEVELOPER)
  // `edit` rather than `view`, on both this and the digest run below: neither changes a setting,
  // but both send real mail to real people, which is not something a read-only holder should fire.
  // `system:` rather than `configuration:` — transport plumbing is the technical estate's grant.
  @RequirePermissions('system:edit:platform')
  // See the class comment: without this, a custom role holding only the matching permission
  // can send real email through the platform's own transport to any address it names. Confirmed
  // live — this is the one that actually matters most to close.
  @RoleOnly()
  @ApiOperation({ summary: 'Send a test email through the configured transport' })
  async testEmail(@Body() dto: TestEmailRequestDto, @Req() req: any): Promise<{ success: boolean; data: any }> {
    if (!this.email.isEnabled()) {
      throw new BadRequestException(
        'Email is not configured — set it up under Administration → Platform Settings → Email delivery. It takes effect immediately.',
      );
    }
    const who = req.user?.displayName ?? req.user?.username ?? 'an administrator';
    const result = await this.email.sendNow({
      kind: 'TRANSPORT_TEST',
      to: dto.to,
      requestedBy: req.user?.id ?? null,
      content: {
        subject: 'FAPOMS test email',
        text: `This is a test email from FAPOMS, sent by ${who}.\n\nIf you are reading it, outbound email works.`,
        layout: {
          title: 'Email Delivery Test',
          bodyLines: [
            `This test email was sent by ${who} to verify outbound email delivery for FAPOMS.`,
            'If you received this message, outbound email delivery is working properly.',
          ],
          kvTable: [
            { label: 'Initiated By', value: who },
            { label: 'Timestamp (UTC)', value: new Date().toUTCString() },
            { label: 'Transport Status', value: 'Active & Verified' },
          ],
          linkUrl: appPublicUrl(),
          linkLabel: 'Open FAPOMS Portal',
          securityNotice: 'This is an automated system verification test. No user action is required.',
        },
      },
    });
    // The provider's own words, not a generic failure: an SMTP rejection usually says exactly
    // what is wrong with the credential. `success`/`error` are the fields the settings screen reads.
    return {
      success: result.sent,
      data: { success: result.sent, error: result.error, permanent: result.permanent, receipt: result.receipt },
    };
  }

  /**
   * Runs the morning digest now, against live data.
   *
   * Waiting until 08:30 tomorrow to find out whether a change worked is not a way to
   * configure anything.
   */
  @Post('digest/run')
  // Developer-only transport plumbing, same as email/test above — see the class comment.
  @Roles(SystemRole.DEVELOPER)
  @RequirePermissions('system:edit:platform')
  // See the class comment. Confirmed live without this: a role holding only the matching
  // permission fired a real, unscheduled digest at every real candidate recipient — not a drill.
  @RoleOnly()
  @ApiOperation({ summary: 'Assemble and send the morning digest immediately' })
  async runDigest(): Promise<{ queued: boolean }> {
    try {
      /**
       * A fixed job id, so an impatient second click cannot send every recipient a second
       * copy. Bull refuses a duplicate id while a job of that id is waiting or active; the
       * minute-stamped suffix lets a genuine re-run happen shortly afterwards without needing
       * the queue cleaned out by hand.
       *
       * `attempts: 1` for the same reason: the digest only queues its emails, and a retry would
       * run the whole brief again and queue everyone a second copy.
       */
      const minute = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '');
      await this.scannerQueue.add('digest', {}, {
        jobId: `digest-manual-${minute}`,
        removeOnComplete: true,
        removeOnFail: FAILED_JOB_RETENTION,
        attempts: 1,
      });
      return { queued: true };
    } catch (err: any) {
      throw new BadRequestException(
        `Could not queue the digest — the job queue is unreachable (${err?.message ?? 'unknown error'}).`,
      );
    }
  }

  // =========================================================================
  // Configurable Email Template Management Endpoints
  // =========================================================================

  @Get('email-templates')
  @ApiOperation({ summary: 'List all registered email templates with active state and contracts' })
  async listEmailTemplates(): Promise<any[]> {
    const list = await Promise.all(
      Object.keys(EMAIL_TEMPLATE_REGISTRY).map(async (k) => {
        const key = k as EmailTemplateKey;
        const def = EMAIL_TEMPLATE_REGISTRY[key];
        const active = await this.templateLoader.loadActiveTemplate(key);
        const stored = await this.templateLoader.getStoredSettings(key);
        const fsTemplate = this.templateLoader.readFilesystemTemplate(key);

        return {
          key,
          name: def.name,
          description: def.description,
          category: def.category,
          requiredTokens: def.requiredTokens,
          optionalTokens: def.optionalTokens,
          rawTokens: def.rawTokens,
          allowRawHtmlTokens: def.allowRawHtmlTokens,
          defaultSubjectTemplate: def.defaultSubjectTemplate,
          sampleData: def.sampleData,
          activeState: {
            source: active.source,
            version: active.version,
            checksum: active.checksum,
            isFallback: active.isFallback,
          },
          settings: {
            sourcePreference: stored?.sourcePreference || 'platform',
            activeVersion: stored?.activeVersion,
            hasDraft: !!stored?.draft,
            versionCount: stored?.versions?.length || 0,
            hasFilesystemTemplate: !!fsTemplate,
          },
        };
      }),
    );
    return list;
  }

  @Get('email-templates/:key')
  @ApiOperation({ summary: 'Get detailed configuration and versions for a specific email template' })
  async getEmailTemplate(@Param('key') key: string, @Req() req?: any): Promise<any> {
    const templateKey = key as EmailTemplateKey;
    const def = EMAIL_TEMPLATE_REGISTRY[templateKey];
    if (!def) {
      throw new BadRequestException(`Unknown email template key: "${key}"`);
    }

    const host = req?.get ? (req.get('x-forwarded-host') || req.get('host')) : null;
    const proto = req?.get ? (req.get('x-forwarded-proto') || req.protocol || 'http') : 'http';
    const computedPublicUrl = host ? `${proto}://${host}` : appPublicUrl();
    const effectiveLogoUrl = `${computedPublicUrl}/sumeru-logo@2x.png`;

    const active = await this.templateLoader.loadActiveTemplate(templateKey);
    const stored = await this.templateLoader.getStoredSettings(templateKey);
    const fsTemplate = this.templateLoader.readFilesystemTemplate(templateKey);

    return {
      definition: {
        ...def,
        sampleData: {
          ...def.sampleData,
          logoUrl: effectiveLogoUrl,
        },
      },
      activeTemplate: active,
      storedSettings: stored,
      filesystemTemplate: fsTemplate ? { exists: true, html: fsTemplate.html, checksum: fsTemplate.checksum } : { exists: false },
      /*
        What the publish gate needs, answered here rather than guessed at in the browser: whether a
        test of the CURRENT draft has actually been delivered. The editor cannot work this out for
        itself — the comparison is a checksum of the exact HTML that was sent — and a screen that
        guesses would either block a publish that should be allowed or promise one the server will
        refuse.

        `required` is false when email delivery is not configured at all: there is no way to send a
        test then, and demanding one would leave the feature unusable rather than safe.
      */
      testStatus: {
        required: this.email.isEnabled(),
        lastTestSend: stored?.lastTestSend
          ? { to: stored.lastTestSend.to, at: stored.lastTestSend.at, by: stored.lastTestSend.by }
          : null,
        matchesDraft: !!stored?.draft?.html
          && (await this.templateLoader.hasTestedDraft(templateKey, stored.draft.html)),
      },
    };
  }

  @Post('email-templates/:key/validate')
  @ApiOperation({ summary: 'Validate HTML and subject against template contract and security rules' })
  async validateEmailTemplate(
    @Param('key') key: string,
    @Body() dto: ValidateEmailTemplateDto,
  ): Promise<any> {
    const templateKey = key as EmailTemplateKey;
    const def = EMAIL_TEMPLATE_REGISTRY[templateKey];
    if (!def) {
      throw new BadRequestException(`Unknown email template key: "${key}"`);
    }

    const result = validateTemplateContract(def, dto.html, dto.subjectTemplate);
    return result;
  }

  @Post('email-templates/:key/preview')
  @ApiOperation({ summary: 'Render a preview of an email template with sample or custom payload' })
  async previewEmailTemplate(
    @Param('key') key: string,
    @Body() dto: PreviewEmailTemplateDto,
    @Req() req?: any,
  ): Promise<any> {
    const templateKey = key as EmailTemplateKey;
    const def = EMAIL_TEMPLATE_REGISTRY[templateKey];
    if (!def) {
      throw new BadRequestException(`Unknown email template key: "${key}"`);
    }

    const host = req?.get ? (req.get('x-forwarded-host') || req.get('host')) : null;
    const proto = req?.get ? (req.get('x-forwarded-proto') || req.protocol || 'http') : 'http';
    const computedPublicUrl = host ? `${proto}://${host}` : appPublicUrl();
    const effectiveLogoUrl = `${computedPublicUrl}/sumeru-logo@2x.png`;

    /*
      The values every message carries, filled here too — otherwise a draft using {{name}} or
      {{time}} previews as a blank where a real send fills it in, and the administrator takes a
      working placeholder back out of the wording. Addressed to an obviously-sample recipient,
      like the rest of a preview's sample data.
    */
    const common = await this.tokens.common(SAMPLE_RECIPIENT);
    const payload = {
      ...common,
      ...def.sampleData,
      logoUrl: dto.payload?.logoUrl || effectiveLogoUrl,
      ...(dto.payload || {}),
    };

    if (dto.html) {
      const validation = validateTemplateContract(def, dto.html, dto.subjectTemplate);
      try {
        let renderedHtml = this.templateRenderer.interpolate(dto.html, payload, def);
        renderedHtml = renderedHtml.replace(/src=["']cid:sumeru-logo["']/gi, `src="${effectiveLogoUrl}"`);
        const subjectTpl = dto.subjectTemplate || def.defaultSubjectTemplate;
        const renderedSubject = this.templateRenderer.interpolate(subjectTpl, payload, def);
        const fallback = def.fallbackRenderer(payload);

        return {
          html: renderedHtml,
          // The text the RECIPIENT would get for this draft, not the built-in wording — the
          // editor's "Text" tab was showing a body that had nothing to do with what was on screen.
          text: plainTextFor(renderedHtml, fallback.text),
          subject: renderedSubject,
          validation,
        };
      } catch (err: any) {
        return {
          html: null,
          text: null,
          subject: null,
          error: err.message,
          validation,
        };
      }
    }

    const rendered = await this.templateRenderer.render(templateKey, payload, SAMPLE_RECIPIENT);
    return {
      ...rendered,
      html: rendered.html ? rendered.html.replace(/src=["']cid:sumeru-logo["']/gi, `src="${effectiveLogoUrl}"`) : rendered.html,
    };
  }

  @Post('email-templates/:key/draft')
  @Roles(...NOTIFICATION_ADMIN_ROLES)
  @RoleOnly()
  @RequirePermissions('configuration:edit:platform')
  @ApiOperation({ summary: 'Save draft HTML for an email template' })
  async saveEmailTemplateDraft(
    @Param('key') key: string,
    @Body() dto: SaveEmailTemplateDraftDto,
    @Req() req: any,
  ): Promise<{ message: string }> {
    const templateKey = key as EmailTemplateKey;
    const def = EMAIL_TEMPLATE_REGISTRY[templateKey];
    if (!def) {
      throw new BadRequestException(`Unknown email template key: "${key}"`);
    }

    const author = req.user?.displayName || req.user?.username || 'admin';
    await this.templateLoader.saveDraft(templateKey, dto, author);
    await this.record(
      'EMAIL_TEMPLATE_DRAFT_SAVED',
      templateKey,
      req.user?.id,
      `Saved draft for email template "${templateKey}".`,
    );

    // `ResponseInterceptor` puts the `{ success, data }` envelope on; a controller that builds
    // one by hand ends up double-enveloped or, worse, half-enveloped.
    return { message: 'Draft saved successfully.' };
  }

  @Post('email-templates/:key/publish')
  @Roles(...NOTIFICATION_ADMIN_ROLES)
  @RoleOnly()
  @RequirePermissions('configuration:edit:platform')
  @ApiOperation({ summary: 'Validate and publish a new version of an email template' })
  async publishEmailTemplate(
    @Param('key') key: string,
    @Body() dto: PublishEmailTemplateDto,
    @Req() req: any,
  ): Promise<{ version: EmailTemplateVersion }> {
    const templateKey = key as EmailTemplateKey;
    const def = EMAIL_TEMPLATE_REGISTRY[templateKey];
    if (!def) {
      throw new BadRequestException(`Unknown email template key: "${key}"`);
    }

    const author = req.user?.displayName || req.user?.username || 'admin';
    if (dto.html) {
      await this.templateLoader.saveDraft(templateKey, { html: dto.html, subjectTemplate: dto.subjectTemplate }, author);
    }

    /*
      SEEN IN AN INBOX, NOT TICKED IN A BOX.

      Publishing used to be gated by a checkbox the administrator ticked themselves, which meant an
      email nobody had ever received could go live to candidates. A browser preview is not a test:
      a real inbox is a different rendering engine, on a different screen, usually with images
      switched off. So the draft's own checksum must match a test that was actually delivered.

      The requirement lifts when email delivery is not configured at all — there is no way to send
      a test then, and refusing to publish would leave the whole feature unusable rather than safe.
    */
    const stored = await this.templateLoader.getStoredSettings(templateKey);
    const draftHtml = dto.html ?? stored?.draft?.html;
    if (this.email.isEnabled() && draftHtml && !(await this.templateLoader.hasTestedDraft(templateKey, draftHtml))) {
      throw new BadRequestException(
        'Send yourself a test of this exact version first — then publish. '
        + (stored?.lastTestSend
          ? 'The last test was of an earlier version of this email.'
          : 'No test of this email has been sent yet.'),
      );
    }

    try {
      const version = await this.templateLoader.publishDraft(templateKey, author);
      await this.record(
        'EMAIL_TEMPLATE_PUBLISHED',
        templateKey,
        req.user?.id,
        `Published version v${version.version} for email template "${templateKey}".`,
        { version: version.version, checksum: version.checksum, changeNotes: dto.changeNotes },
      );
      return { version };
    } catch (err: any) {
      throw new BadRequestException(err.message || 'Failed to publish email template.');
    }
  }

  @Post('email-templates/:key/rollback')
  @Roles(...NOTIFICATION_ADMIN_ROLES)
  @RoleOnly()
  @RequirePermissions('configuration:edit:platform')
  @ApiOperation({ summary: 'Roll back an email template to a previous version' })
  async rollbackEmailTemplate(
    @Param('key') key: string,
    @Body() dto: RollbackEmailTemplateDto,
    @Req() req: any,
  ): Promise<{ version: EmailTemplateVersion }> {
    const templateKey = key as EmailTemplateKey;
    const def = EMAIL_TEMPLATE_REGISTRY[templateKey];
    if (!def) {
      throw new BadRequestException(`Unknown email template key: "${key}"`);
    }

    const author = req.user?.displayName || req.user?.username || 'admin';
    try {
      const version = await this.templateLoader.rollbackVersion(templateKey, dto.version, author);
      await this.record(
        'EMAIL_TEMPLATE_ROLLED_BACK',
        templateKey,
        req.user?.id,
        `Rolled back email template "${templateKey}" to version v${dto.version}.`,
        { version: dto.version },
      );
      return { version };
    } catch (err: any) {
      throw new BadRequestException(err.message || 'Failed to rollback email template.');
    }
  }

  @Post('email-templates/:key/source')
  @Roles(...NOTIFICATION_ADMIN_ROLES)
  @RoleOnly()
  @RequirePermissions('configuration:edit:platform')
  @ApiOperation({ summary: 'Switch active source preference (platform, filesystem, fallback)' })
  async setTemplateSource(
    @Param('key') key: string,
    @Body() dto: SetTemplateSourceDto,
    @Req() req: any,
  ): Promise<{ source: TemplateSource }> {
    const templateKey = key as EmailTemplateKey;
    const def = EMAIL_TEMPLATE_REGISTRY[templateKey];
    if (!def) {
      throw new BadRequestException(`Unknown email template key: "${key}"`);
    }

    if (!['platform', 'filesystem', 'fallback'].includes(dto.source)) {
      throw new BadRequestException(`Invalid source: "${dto.source}". Must be 'platform', 'filesystem', or 'fallback'.`);
    }

    await this.templateLoader.setSourcePreference(templateKey, dto.source);
    await this.record(
      'EMAIL_TEMPLATE_SOURCE_CHANGED',
      templateKey,
      req.user?.id,
      `Changed template source for "${templateKey}" to "${dto.source}".`,
      { source: dto.source },
    );
    return { source: dto.source };
  }

  @Post('email-templates/:key/test')
  @Roles(...NOTIFICATION_ADMIN_ROLES, SystemRole.DEVELOPER)
  @RoleOnly()
  @RequirePermissions('configuration:edit:platform')
  @ApiOperation({ summary: 'Send a live test email rendered with the specified template' })
  async sendTestEmail(
    @Param('key') key: string,
    @Body() dto: TestEmailTemplateDto,
    @Req() req: any,
  ): Promise<{ message: string; metadata?: any }> {
    if (!this.email.isEnabled()) {
      throw new BadRequestException(
        'Email delivery is not configured — please configure SMTP or Gmail transport in Platform Settings first.',
      );
    }

    const templateKey = key as EmailTemplateKey;
    const def = EMAIL_TEMPLATE_REGISTRY[templateKey];
    if (!def) {
      throw new BadRequestException(`Unknown email template key: "${key}"`);
    }

    const payload = { ...def.sampleData, ...(dto.payload || {}) };
    let renderedHtml: string;
    let renderedSubject: string;
    let renderedText: string;
    let metadata: any;

    if (dto.html) {
      const val = validateTemplateContract(def, dto.html, dto.subjectTemplate);
      if (!val.valid) {
        throw new BadRequestException(`Cannot send test email: template validation failed (${val.errors.join('; ')})`);
      }
      renderedHtml = this.templateRenderer.interpolate(dto.html, payload, def);
      renderedSubject = this.templateRenderer.interpolate(
        dto.subjectTemplate || def.defaultSubjectTemplate,
        payload,
        def,
      );
      // The same text half the recipient of a published version would get, so the test is a test
      // of both bodies rather than of the HTML with somebody else's words underneath it.
      renderedText = plainTextFor(renderedHtml, def.fallbackRenderer(payload).text);
      metadata = { source: 'custom_test_payload' };
    } else {
      const rendered = await this.templateRenderer.render(templateKey, payload);
      renderedHtml = rendered.html;
      renderedSubject = rendered.subject;
      renderedText = rendered.text;
      metadata = rendered.metadata;
    }

    const who = req.user?.displayName ?? req.user?.username ?? 'an administrator';
    // Composed above because a test of a DRAFT is template authoring — the draft is not what
    // `EmailService` would render — but sent the one way everything is sent.
    const result = await this.email.sendNow({
      kind: 'TEMPLATE_TEST',
      to: dto.to,
      entityType: 'EMAIL_TEMPLATE',
      entityId: templateKey,
      requestedBy: req.user?.id ?? null,
      content: { rendered: { subject: `[TEST] ${renderedSubject}`, text: renderedText, html: renderedHtml } },
    });

    if (!result.sent) {
      throw new BadRequestException(`Failed to send test email: ${result.error || 'Delivery failed'}`);
    }

    /*
      Remembered against the checksum of what was actually sent, which is what lets publishing
      require it. A test of a previous draft proves nothing about the one about to go live.
    */
    if (dto.html) {
      await this.templateLoader.recordTestSend(templateKey, dto.html, dto.to, who);
    }

    await this.record(
      'EMAIL_TEMPLATE_TEST_SENT',
      templateKey,
      req.user?.id,
      `Sent test email for template "${templateKey}" to "${dto.to}" by ${who}.`,
      { to: dto.to },
    );

    return { message: `Test email successfully sent to ${dto.to}`, metadata };
  }

  // =========================================================================
  // SMS — the twin of email/status, email/test and the email templates
  // =========================================================================

  /** Whether texts can actually leave, and how the gateway is configured — never the key. */
  @Get('sms/status')
  @ApiOperation({ summary: 'Is outbound SMS configured, by which provider, and under DLT' })
  async smsStatus(): Promise<{ enabled: boolean; provider: string | null; senderId: string | null; dltEntityIdSet: boolean; hint: string | null }> {
    // The provider's own resolved state, not a second reading of the settings: one resolver, one
    // answer (the email status learned that the hard way — see `emailStatus`).
    const state = this.smsProvider.describe();
    const hint = !state.enabled
      ? state.problem
      : !state.dltEntityIdSet
        ? 'No DLT Principal Entity ID is saved. Phone companies in India block business texts that are not registered on DLT — add it below once you have it.'
        : null;
    return { enabled: state.enabled, provider: state.provider, senderId: state.senderId, dltEntityIdSet: state.dltEntityIdSet, hint };
  }

  /**
   * Sends a real text through the real gateway, while the developer waits.
   *
   * The twin of `testEmail`, under the same fence for the same reason: it spends real money sending
   * to a real phone, and a configured-looking gateway proves nothing until a text arrives. Sent as
   * the registered `transport-test` template, because under DLT a free-text test would be blocked.
   */
  @Post('sms/test')
  // Developer-only transport plumbing, exactly as email/test — see the class comment.
  @Roles(SystemRole.DEVELOPER)
  @RequirePermissions('system:edit:platform')
  @RoleOnly()
  @ApiOperation({ summary: 'Send a test text through the configured SMS gateway' })
  async testSms(@Body() dto: TestSmsRequestDto, @Req() req: any): Promise<{ success: boolean; data: any }> {
    if (!this.sms.isEnabled()) {
      throw new BadRequestException(
        'SMS is not configured — set it up under Administration → Platform Settings → SMS delivery. It takes effect immediately.',
      );
    }
    if (!toE164IndianMobile(dto.to)) {
      throw new BadRequestException('Give an Indian mobile number (10 digits, starting 6–9) to send the test text to.');
    }
    /*
      No values: the test wording has none, so that it is the simplest thing a DLT reviewer can
      approve. Who pressed the button is recorded against the send in the ledger and the audit
      trail, which is where it belongs — it was never something a stranger's handset needed.
    */
    const result = await this.sms.sendNow({
      kind: 'TRANSPORT_TEST',
      to: dto.to,
      requestedBy: req.user?.id ?? null,
      content: { template: 'transport-test', data: {} },
    });
    return {
      success: result.sent,
      data: { success: result.sent, error: result.error, permanent: result.permanent, receipt: result.receipt },
    };
  }

  /** Every text the platform sends: its standard wording, the saved override, DLT form and cost. */
  @Get('sms-templates')
  @ApiOperation({ summary: 'List SMS templates with their wording, DLT form, DLT template id and segment count' })
  async listSmsTemplates(): Promise<SmsTemplateView[]> {
    return this.smsTemplates.describeAll();
  }

  /** Saves one text's wording and DLT template id — checked first, audited like the email template writes. */
  @Put('sms-templates/:key')
  @Roles(...NOTIFICATION_ADMIN_ROLES)
  @RoleOnly()
  @RequirePermissions('configuration:edit:platform')
  @ApiOperation({ summary: 'Save the wording and DLT template id of one SMS template' })
  async saveSmsTemplate(
    @Param('key') key: string,
    @Body() dto: SaveSmsTemplateDto,
    @Req() req: any,
  ): Promise<SmsTemplateView> {
    const view = await this.smsTemplates.saveOverride(key, { text: dto.text, dltTemplateId: dto.dltTemplateId }, req.user?.id);
    // Which fields changed, not their contents: the wording is the business's, but the audit trail
    // is not where a template's text should be copied to.
    await this.record(
      'SMS_TEMPLATE_SAVED',
      key,
      req.user?.id,
      `Saved SMS template "${key}".`,
      { textChanged: dto.text !== undefined, dltTemplateIdChanged: dto.dltTemplateId !== undefined, dltTemplateIdSet: !!view.dltTemplateId },
    );
    return view;
  }

  /**
   * Sends a test of ONE template to a phone — the SMS twin of `email-templates/:key/test`.
   *
   * `sms/test` proves the gateway works; this proves a particular text works, which is a different
   * question and the one that actually goes wrong: the gateway is fine and this template's DLT
   * Template ID is missing or registered against older wording, so every operator drops it. The
   * only way to find that out is to send it.
   *
   * The wording sent is the wording SAVED for this template, not whatever is on screen — unlike
   * email, where the draft travels in the request, an SMS is rendered from the stored template so
   * the operator's registration matches. So the screen tells the administrator to save first.
   *
   * Under the same fence as `sms/test`, for the same reason: it spends real money on a real phone.
   * The kind stays TRANSPORT_TEST — it is a test, and the outbound ledger's list of SMS kinds is a
   * decision somebody makes on purpose (`messaging-single-path.spec.ts`), not a side effect of a
   * button being added.
   */
  @Post('sms-templates/:key/test')
  @Roles(SystemRole.DEVELOPER)
  @RequirePermissions('system:edit:platform')
  @RoleOnly()
  @ApiOperation({ summary: 'Send a test of one SMS template to a mobile number' })
  async testSmsTemplate(
    @Param('key') key: string,
    @Body() dto: TestSmsTemplateDto,
    @Req() req: any,
  ): Promise<{ success: boolean; data: any }> {
    if (!this.sms.isEnabled()) {
      throw new BadRequestException(
        'SMS is not configured — set it up under Administration → Platform Settings → SMS delivery. It takes effect immediately.',
      );
    }
    if (!toE164IndianMobile(dto.to)) {
      throw new BadRequestException('Give an Indian mobile number (10 digits, starting 6–9) to send the test text to.');
    }
    // Also what rejects an unknown key, before anything is sent or audited.
    const view = await this.smsTemplates.describe(key);
    // The template's own example values, with anything the administrator typed over the top; a
    // missing value would otherwise be refused by the renderer rather than delivered half-written.
    const data: Record<string, string> = { ...view.sampleData };
    for (const [token, value] of Object.entries(dto.data ?? {})) {
      if (value === undefined || value === null || String(value).trim() === '') continue;
      data[token] = String(value);
    }

    const result = await this.sms.sendNow({
      kind: 'TRANSPORT_TEST',
      to: dto.to,
      requestedBy: req.user?.id ?? null,
      content: { template: view.key, data },
    });

    const who = String(req.user?.displayName ?? req.user?.username ?? 'an administrator');
    // Where it went and whether it arrived — never the wording, like every other write here.
    await this.record(
      'SMS_TEMPLATE_TEST_SENT',
      view.key,
      req.user?.id,
      `Sent a test of SMS template "${view.key}" to "${dto.to}" by ${who}.`,
      { to: dto.to, sent: result.sent },
    );

    return {
      success: result.sent,
      data: { success: result.sent, error: result.error, permanent: result.permanent, receipt: result.receipt },
    };
  }
}
