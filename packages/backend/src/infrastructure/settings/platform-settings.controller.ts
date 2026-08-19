/**
 * FAPOMS — Platform Settings
 *
 * The configuration an operator owns, exposed for the settings screen. Reading is staff-wide
 * (knowing what the platform believes an audit is worth is not a secret, and a support
 * conversation goes faster when both sides can see it); writing is administrators only, because
 * these values price work and address mail for the whole organisation.
 *
 * Secrets are never returned by any route here — `describeAll` reports only whether one is set.
 */

import { Controller, Get, Put, Delete, Param, Body, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Allow } from 'class-validator';
import { SystemRole } from '@fapoms/shared';

import { JwtAuthGuard, RolesGuard, PermissionsGuard, Roles } from '../../modules/auth/guards';
import { PlatformSettingsService, ResolvedSetting } from './platform-settings.service';
import { SETTINGS_GROUPS } from './settings.registry';
import { AuditService } from '../../core/audit/audit.service';
import { NOT_A_RECORD_ENTITY_ID } from '../../core/audit/audit-event';
import { EventCategory } from '@fapoms/shared';

export class SetSettingRequestDto {
  /**
   * `@Allow` rather than a type decorator: the value is legitimately a string, number or
   * boolean depending on the key, and the registry does the real typing at the service edge
   * where it knows which key this is. Without a decorator the global whitelisting pipe strips
   * the property and then rejects the request for carrying an unknown one.
   */
  @Allow()
  value: any;
}

/**
 * Super administrators only — reading and writing alike.
 *
 * Until 2026-08-17 every staff role could read the resolved configuration (the thinking being
 * that a support conversation goes faster when both sides can see it) and two roles could
 * write. The platform owner asked for platform settings, notification rules and feedback to be
 * visible to the super administrator and nobody else, and a boundary the page enforces while
 * the API does not is not a boundary — so the class gate narrows to match, with one deliberate
 * exception (`limits`, below), which is not configuration but the operating rules every client
 * is already subject to. The web app's `/admin/settings` route permission mirrors this list.
 */
const SETTINGS_ADMIN_ROLES = [SystemRole.SUPER_ADMINISTRATOR] as const;

@ApiTags('Platform Settings')
@ApiBearerAuth()
@Controller('platform-settings')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
@Roles(...SETTINGS_ADMIN_ROLES)
export class PlatformSettingsController {
  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * The handful of limits a client has to know to render honestly.
   *
   * Making a limit configurable creates a new way to be wrong: the server now enforces a number
   * the apps had hardcoded. The negotiation cap is the sharp case — mobile disables the
   * counter-offer button at its own copy, and exceeding the server's cap does not merely refuse
   * the counter, it **auto-declines the whole offer**. Raise the cap and the assayer is locked
   * out of a negotiation the platform would allow; lower it and they lose the job by pressing a
   * button the app said was live.
   *
   * Deliberately open to any authenticated user, unlike the rest of this controller (which is
   * super-administrator only): the field app is not staff, and these are the operating rules
   * its user is already subject to — not configuration. Values only, no provenance, no secrets.
   */
  @Get('limits')
  @Roles(...Object.values(SystemRole))
  @ApiOperation({ summary: 'Operational limits the web and mobile clients must render' })
  async limits(): Promise<{ success: boolean; data: { maxNegotiationRounds: number; checkInGeofenceMeters: number; maxSingleExpenseClaim: number } }> {
    const [maxNegotiationRounds, checkInGeofenceMeters, maxSingleExpenseClaim] = await Promise.all([
      this.settings.getNumber('field.maxNegotiationRounds', 3),
      this.settings.getNumber('field.checkInGeofenceMeters', 2000),
      this.settings.getNumber('expense.maxSingleClaim', 50_000),
    ]);
    return { success: true, data: { maxNegotiationRounds, checkInGeofenceMeters, maxSingleExpenseClaim } };
  }

  @Get()
  @ApiOperation({ summary: 'Every platform setting, its value in force, and where that value came from' })
  async findAll(): Promise<{ success: boolean; data: { groups: typeof SETTINGS_GROUPS; settings: ResolvedSetting[] } }> {
    return {
      success: true,
      data: { groups: SETTINGS_GROUPS, settings: await this.settings.describeAll() },
    };
  }

  @Put(':key')
  @Roles(...SETTINGS_ADMIN_ROLES)
  @ApiOperation({ summary: 'Save one setting' })
  async set(
    @Param('key') key: string,
    @Body() dto: SetSettingRequestDto,
    @Req() req: any,
  ): Promise<{ success: boolean; data: ResolvedSetting[] }> {
    await this.settings.set(key, dto.value, req.user?.id);

    /**
     * Audited without the value.
     *
     * Who changed which setting and when is exactly the question asked after a surprise, and
     * some of these keys are credentials — recording the new value would put a mail password
     * in the audit log, which is a worse place for it than the encrypted column it came from.
     *
     * The key goes in `metadata` (and reads in `remarks`), never in `entityId`. A setting is
     * not a row in a table and has no uuid; passing the key there is what made this write fail
     * against a `uuid NOT NULL` column on every settings change since it was written, and the
     * bare `.catch(() => undefined)` it used to carry meant the trail was empty for months
     * with nothing to say so. `recordEventSafe` keeps the same promise — a failed audit must
     * not undo a setting the operator has already saved — but logs at error level, so the next
     * time this breaks it is discoverable rather than merely absent.
     */
    await this.audit.recordEventSafe({
      category: EventCategory.SYSTEM,
      eventType: 'PLATFORM_SETTING_CHANGED',
      entityType: 'PLATFORM_SETTING',
      entityId: NOT_A_RECORD_ENTITY_ID,
      userId: req.user?.id,
      remarks: `Changed platform setting "${key}".`,
      metadata: { settingKey: key },
    });

    return { success: true, data: await this.settings.describeAll() };
  }

  @Delete(':key')
  @Roles(...SETTINGS_ADMIN_ROLES)
  @ApiOperation({ summary: 'Clear a saved setting so it follows the environment or shipped default again' })
  async reset(@Param('key') key: string, @Req() req: any): Promise<{ success: boolean; data: ResolvedSetting[] }> {
    await this.settings.reset(key, req.user?.id);
    await this.audit.recordEventSafe({
      category: EventCategory.SYSTEM,
      eventType: 'PLATFORM_SETTING_RESET',
      entityType: 'PLATFORM_SETTING',
      entityId: NOT_A_RECORD_ENTITY_ID,
      userId: req.user?.id,
      remarks: `Reset platform setting "${key}" to its default.`,
      metadata: { settingKey: key },
    });
    return { success: true, data: await this.settings.describeAll() };
  }
}
