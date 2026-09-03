/**
 * FAPOMS — Notification & Email Administration
 *
 * Everything about how the platform speaks to people, made changeable without a deploy: which
 * events fire, on which channels, in whose words, and whether the mail path works at all.
 *
 * Held to administrators. These settings decide what reaches whose inbox and phone across the
 * whole organisation — a mistake here is not one person's preference, it is everyone's.
 */

import {
  Controller, Get, Put, Post, Delete, Param, Body, Req, UseGuards, BadRequestException,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsArray, IsInt, IsEmail, Min, Max, IsObject } from 'class-validator';
import { SystemRole, NotificationChannel, NotificationPriority, NotificationCategory } from '@fapoms/shared';

import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles, RequirePermissions } from '../auth/guards';
import { STAFF_ROLES } from '../auth/staff-roles';
import { NotificationSettingsService, EffectiveNotificationType } from './notification-settings.service';
import { NOTIFICATION_CATALOG } from './notification-catalog';
import { EmailProvider, appPublicUrl, renderEmailHtml } from '../../infrastructure/notifications/email-provider';
import { AuditService } from '../../core/audit/audit.service';
import { NOT_A_RECORD_ENTITY_ID } from '../../core/audit/audit-event';
import { PlatformSettingsService } from '../../infrastructure/settings/platform-settings.service';
import { EventCategory } from '@fapoms/shared';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';

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

/**
 * Super administrators only — reads and writes alike.
 *
 * This was narrowed once already, from all eleven staff roles to the four the web app admitted
 * to `/admin/notifications`, on the principle that a boundary the UI enforces and the API does
 * not is not a boundary. On 2026-08-17 the platform owner asked for notification rules (with
 * platform settings and feedback) to be visible to the super administrator and nobody else, so
 * both lists collapse to that one role. Kept as two names because the read/write split is a
 * real seam — if the desk is ever widened again, it is the read list that widens first.
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
    private readonly email: EmailProvider,
    /**
     * The digest runs on the SLA scanner's queue. Triggering it by enqueuing the same job the
     * cron enqueues — rather than injecting the service — keeps this module independent of the
     * scheduler (which imports this one, so the reverse would be a cycle) and means the manual
     * run exercises the identical path, not a parallel one that could drift.
     */
    @InjectQueue('sla-scanner') private readonly scannerQueue: Queue,
    private readonly audit: AuditService,
    private readonly platformSettings: PlatformSettingsService,
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
    success: boolean;
    data: {
      types: Array<EffectiveNotificationType & {
        defaults: { channels: string[]; priority: string; roles: string[]; title: string; body: string; link?: string };
        placeholders: string[];
      }>;
      channels: string[];
      priorities: string[];
      categories: string[];
      roles: string[];
    };
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
      success: true,
      data: {
        types,
        channels: Object.values(NotificationChannel),
        priorities: Object.values(NotificationPriority),
        categories: Object.values(NotificationCategory),
        roles: Object.values(SystemRole),
      },
    };
  }

  @Put('catalog/:type')
  @Roles(...NOTIFICATION_ADMIN_ROLES)
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
  @RequirePermissions('configuration:edit:platform')
  @ApiOperation({ summary: 'Reset one notification type to its shipped default' })
  async reset(@Param('type') type: string, @Req() req: any): Promise<{ success: boolean; data: EffectiveNotificationType }> {
    const data = await this.settings.reset(type);
    await this.record('NOTIFICATION_SETTING_RESET', type, req.user?.id, `Reset notification "${type}" to its shipped default.`);
    return { success: true, data };
  }

  /**
   * Renders a draft template through the real renderer, so what the editor shows is exactly
   * what would be sent — including the cleanup pass that removes fragments left by missing
   * values, which is the part authors most often do not expect.
   */
  @Post('preview')
  @ApiOperation({ summary: 'Render a draft template against sample values' })
  async preview(@Body() dto: PreviewTemplateRequestDto): Promise<{ success: boolean; data: any }> {
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
      success: true,
      data: {
        ...rendered,
        // The exact HTML the mail shell would wrap it in, so the editor can show a true preview.
        emailHtml: renderEmailHtml({
          title: rendered.emailSubject,
          bodyLines: rendered.emailBody.split('\n').filter(Boolean),
          linkUrl: rendered.link ? `${appPublicUrl()}${rendered.link}` : null,
        }),
      },
    };
  }

  /** Whether mail can actually leave the building, and how it is configured. */
  @Get('email/status')
  @ApiOperation({ summary: 'Is outbound email configured, and by which transport' })
  async emailStatus(): Promise<{ success: boolean; data: any }> {
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
      success: true,
      data: {
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
      },
    };
  }

  /**
   * Sends a real email through the real provider.
   *
   * The only way to know a mail configuration works is to use it — a green "configured" badge
   * proves the variables are set, not that Gmail accepts them.
   */
  @Post('email/test')
  @Roles(...NOTIFICATION_ADMIN_ROLES)
  // `edit` rather than `view`, on both this and the digest run below: neither changes a setting,
  // but both send real mail to real people, which is not something a read-only holder should fire.
  @RequirePermissions('configuration:edit:platform')
  @ApiOperation({ summary: 'Send a test email through the configured transport' })
  async testEmail(@Body() dto: TestEmailRequestDto, @Req() req: any): Promise<{ success: boolean; data: any }> {
    if (!this.email.isEnabled()) {
      throw new BadRequestException(
        'Email is not configured — set it up under Administration → Platform Settings → Email delivery. It takes effect immediately.',
      );
    }
    const who = req.user?.displayName ?? req.user?.username ?? 'an administrator';
    const result = await this.email.send({
      to: dto.to,
      subject: 'FAPOMS test email',
      text: `This is a test email from FAPOMS, sent by ${who}.\n\nIf you are reading it, outbound email works.`,
      html: renderEmailHtml({
        title: 'FAPOMS test email',
        bodyLines: [
          `This is a test email from FAPOMS, sent by ${who}.`,
          'If you are reading it, outbound email works.',
        ],
        linkUrl: appPublicUrl(),
        linkLabel: 'Open FAPOMS',
      }),
    });
    // The provider's own words, not a generic failure: an SMTP rejection usually says exactly
    // what is wrong with the credential.
    return { success: result.success, data: result };
  }

  /**
   * Runs the morning digest now, against live data.
   *
   * Waiting until 08:30 tomorrow to find out whether a change worked is not a way to
   * configure anything.
   */
  @Post('digest/run')
  @Roles(...NOTIFICATION_ADMIN_ROLES)
  @RequirePermissions('configuration:edit:platform')
  @ApiOperation({ summary: 'Assemble and send the morning digest immediately' })
  async runDigest(): Promise<{ success: boolean; data: { queued: boolean } }> {
    try {
      /**
       * A fixed job id, so an impatient second click cannot send every recipient a second
       * copy. Bull refuses a duplicate id while a job of that id is waiting or active; the
       * minute-stamped suffix lets a genuine re-run happen shortly afterwards without needing
       * the queue cleaned out by hand.
       */
      const minute = new Date().toISOString().slice(0, 16).replace(/[:T-]/g, '');
      await this.scannerQueue.add('digest', {}, {
        jobId: `digest-manual-${minute}`,
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 1,
      });
      return { success: true, data: { queued: true } };
    } catch (err: any) {
      throw new BadRequestException(
        `Could not queue the digest — the job queue is unreachable (${err?.message ?? 'unknown error'}).`,
      );
    }
  }
}
