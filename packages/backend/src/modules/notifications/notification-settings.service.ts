import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotificationChannel, NotificationPriority, SystemRole } from '@fapoms/shared';

import { NotificationSettingEntity } from './notification-setting.entity';
import { NOTIFICATION_CATALOG, NotificationTypeDef, renderTemplate } from './notification-catalog';
import { CacheService } from '../../infrastructure/cache/cache.service';

/**
 * Resolves what a notification type actually is, right now.
 *
 * The catalog in code is the default; `notification_settings` rows are the operator's
 * deliberate departures from it. Everything that raises or delivers a notification asks this
 * service rather than reading `NOTIFICATION_CATALOG` directly, so a channel switched off in
 * the admin screen takes effect on the next event instead of the next deploy.
 *
 * Resolution is cached as a whole (the set is ~48 small objects read on every emit) and the
 * cache is dropped on every write. A cache failure resolves from the database; a database
 * failure resolves from the code defaults — the pipeline must degrade towards *delivering*
 * something, never towards silence.
 */

const CACHE_KEY = 'ref:notification:settings';
const CACHE_TTL_SECONDS = 300;

/** A catalog entry plus where each part of it came from, for the admin screen. */
export interface EffectiveNotificationType extends NotificationTypeDef {
  type: string;
  enabled: boolean;
  /** Field names carrying an operator override rather than the code default. */
  overridden: string[];
  notes: string | null;
  /** The email wording, when it has been customised away from title/body. */
  emailSubject?: string | null;
  emailBody?: string | null;
}

export interface UpdateNotificationSettingDto {
  enabled?: boolean;
  channels?: string[] | null;
  priority?: string | null;
  roles?: string[] | null;
  titleTemplate?: string | null;
  bodyTemplate?: string | null;
  linkTemplate?: string | null;
  emailSubjectTemplate?: string | null;
  emailBodyTemplate?: string | null;
  collapseWindowSeconds?: number | null;
  notes?: string | null;
}

const VALID_CHANNELS = new Set(Object.values(NotificationChannel) as string[]);
const VALID_PRIORITIES = new Set(Object.values(NotificationPriority) as string[]);

@Injectable()
export class NotificationSettingsService {
  private readonly logger = new Logger(NotificationSettingsService.name);

  constructor(
    @InjectRepository(NotificationSettingEntity)
    private readonly settingRepository: Repository<NotificationSettingEntity>,
    private readonly cache: CacheService,
  ) {}

  /**
   * The live definition of one type, or null when the type is unknown or switched off.
   *
   * Callers treat null as "raise nothing", which is what makes the admin screen's disable
   * switch real rather than cosmetic.
   */
  async defFor(type: string): Promise<EffectiveNotificationType | null> {
    const all = await this.effectiveCatalog();
    const def = all[type];
    if (!def || !def.enabled) return null;
    return def;
  }

  /** Every type, merged. Includes disabled ones — the admin screen must show them. */
  async effectiveCatalog(): Promise<Record<string, EffectiveNotificationType>> {
    const overrides = await this.loadOverrides();
    const merged: Record<string, EffectiveNotificationType> = {};
    for (const [type, base] of Object.entries(NOTIFICATION_CATALOG)) {
      merged[type] = this.merge(type, base, overrides[type] ?? null);
    }
    return merged;
  }

  private async loadOverrides(): Promise<Record<string, NotificationSettingEntity>> {
    const rows = await this.cache
      .wrap(CACHE_KEY, CACHE_TTL_SECONDS, async () => this.settingRepository.find())
      .catch((err: any) => {
        // Defaults are always a safe answer; silence is not.
        this.logger.warn(`Could not read notification settings, using code defaults: ${err?.message}`);
        return [] as NotificationSettingEntity[];
      });

    const byType: Record<string, NotificationSettingEntity> = {};
    for (const row of rows) byType[row.type] = row;
    return byType;
  }

  private merge(
    type: string,
    base: NotificationTypeDef,
    override: NotificationSettingEntity | null,
  ): EffectiveNotificationType {
    if (!override) {
      return { ...base, type, enabled: true, overridden: [], notes: null };
    }

    const overridden: string[] = [];
    const take = <T>(field: string, value: T | null | undefined, fallback: T): T => {
      if (value === null || value === undefined) return fallback;
      overridden.push(field);
      return value;
    };

    const collapseWindow = override.collapseWindowSeconds;
    let collapse = base.collapse;
    if (collapseWindow !== null && collapseWindow !== undefined) {
      overridden.push('collapseWindowSeconds');
      // 0 turns collapsing off entirely; any other value re-times the existing summary. A
      // summary cannot be invented here — its wording lives in the catalog.
      collapse = collapseWindow > 0 && base.collapse
        ? { ...base.collapse, windowSeconds: collapseWindow }
        : undefined;
    }

    if (override.enabled === false) overridden.push('enabled');

    return {
      ...base,
      type,
      enabled: override.enabled !== false,
      channels: take('channels', override.channels, base.channels),
      priority: take('priority', override.priority, base.priority),
      roles: take('roles', override.roles, base.roles),
      title: take('titleTemplate', override.titleTemplate, base.title),
      body: take('bodyTemplate', override.bodyTemplate, base.body),
      link: take('linkTemplate', override.linkTemplate, base.link),
      emailSubject: override.emailSubjectTemplate,
      emailBody: override.emailBodyTemplate,
      collapse,
      overridden: [
        ...overridden,
        ...(override.emailSubjectTemplate ? ['emailSubjectTemplate'] : []),
        ...(override.emailBodyTemplate ? ['emailBodyTemplate'] : []),
      ],
      notes: override.notes,
    };
  }

  // ---------------------------------------------------------------- writes

  async update(
    type: string,
    dto: UpdateNotificationSettingDto,
    userId?: string,
  ): Promise<EffectiveNotificationType> {
    // `Object.prototype.hasOwnProperty` rather than truthiness: 'constructor' and 'toString'
    // are truthy on any plain object, so a bare lookup would accept them as valid types.
    if (!Object.prototype.hasOwnProperty.call(NOTIFICATION_CATALOG, type)) {
      throw new NotFoundException(`Unknown notification type "${type}"`);
    }
    this.validate(type, dto);

    const existing = await this.settingRepository.findOne({ where: { type } });
    const row = existing ?? this.settingRepository.create({ type, enabled: true, createdBy: userId });

    // `undefined` means "not supplied, leave as-is"; null means "clear this override".
    const assign = <K extends keyof NotificationSettingEntity>(key: K, value: any) => {
      if (value !== undefined) (row as any)[key] = value;
    };
    assign('enabled', dto.enabled);
    assign('channels', dto.channels);
    assign('priority', dto.priority);
    assign('roles', dto.roles);
    assign('titleTemplate', dto.titleTemplate);
    assign('bodyTemplate', dto.bodyTemplate);
    assign('linkTemplate', dto.linkTemplate);
    assign('emailSubjectTemplate', dto.emailSubjectTemplate);
    assign('emailBodyTemplate', dto.emailBodyTemplate);
    assign('collapseWindowSeconds', dto.collapseWindowSeconds);
    assign('notes', dto.notes);
    row.updatedBy = userId as any;

    await this.settingRepository.save(row);
    await this.invalidate();

    const all = await this.effectiveCatalog();
    return all[type];
  }

  /** Reset to the code default: the override row is removed, not blanked. */
  async reset(type: string): Promise<EffectiveNotificationType> {
    if (!Object.prototype.hasOwnProperty.call(NOTIFICATION_CATALOG, type)) {
      throw new NotFoundException(`Unknown notification type "${type}"`);
    }
    await this.settingRepository.delete({ type });
    await this.invalidate();
    const all = await this.effectiveCatalog();
    return all[type];
  }

  private async invalidate(): Promise<void> {
    await this.cache.del(CACHE_KEY).catch(() => undefined);
  }

  private validate(type: string, dto: UpdateNotificationSettingDto): void {
    if (dto.channels !== undefined && dto.channels !== null) {
      if (!Array.isArray(dto.channels) || dto.channels.length === 0) {
        throw new BadRequestException(
          'Give at least one channel, or disable the event — a notification with no channel reaches nobody while still being generated.',
        );
      }
      for (const c of dto.channels) {
        if (!VALID_CHANNELS.has(c)) throw new BadRequestException(`Unknown channel "${c}"`);
      }
    }
    if (dto.priority !== undefined && dto.priority !== null && !VALID_PRIORITIES.has(dto.priority)) {
      throw new BadRequestException(`Unknown priority "${dto.priority}"`);
    }
    if (dto.roles !== undefined && dto.roles !== null) {
      if (!Array.isArray(dto.roles)) {
        throw new BadRequestException('Roles must be a list of role names.');
      }
      /**
       * An empty list is the quietest way to break a CRITICAL alert: the type stays enabled,
       * the channels stay on, and it reaches nobody. If the intent is silence, the enabled
       * switch says so honestly and can be seen at a glance in the events table.
       */
      const known = new Set(Object.values(SystemRole) as string[]);
      const unknown = dto.roles.filter((r) => !known.has(r));
      if (unknown.length) {
        throw new BadRequestException(`Unknown role(s): ${unknown.join(', ')}.`);
      }
      const def = NOTIFICATION_CATALOG[type];
      // A type addressed to a special recipient (the assigned assayer, the record owner) is
      // legitimately role-less; one without is not.
      if (dto.roles.length === 0 && !def?.special?.length) {
        throw new BadRequestException(
          'Choose at least one recipient role, or switch the event off — an event with no recipients is generated and delivered to nobody.',
        );
      }
    }
    if (
      dto.collapseWindowSeconds !== undefined &&
      dto.collapseWindowSeconds !== null &&
      (!Number.isInteger(dto.collapseWindowSeconds) || dto.collapseWindowSeconds < 0 || dto.collapseWindowSeconds > 86_400)
    ) {
      throw new BadRequestException('Collapse window must be between 0 seconds and 24 hours.');
    }
    /**
     * Limits track the COLUMNS these render into, not a round number.
     *
     * `notifications.title` and `.link` are varchar(255): a longer rendered value is a
     * database error at emit time, or a silent truncation — either way discovered by the
     * recipient rather than by the author. The rendered text is usually longer than the
     * template once placeholders are filled, so the cap is deliberately below the column.
     */
    for (const [field, tpl, limit] of [
      ['titleTemplate', dto.titleTemplate, 200],
      ['bodyTemplate', dto.bodyTemplate, 4000],
      ['emailSubjectTemplate', dto.emailSubjectTemplate, 200],
      ['emailBodyTemplate', dto.emailBodyTemplate, 4000],
      ['linkTemplate', dto.linkTemplate, 200],
    ] as const) {
      if (tpl === undefined || tpl === null) continue;
      if (typeof tpl !== 'string') throw new BadRequestException(`${field} must be text.`);
      if (tpl.length > limit) throw new BadRequestException(`${field} is too long (${limit} characters max).`);
      // An unterminated `${` renders as literal text in someone's inbox. Catch it at save
      // time, where the author can still see what they meant.
      const opens = (tpl.match(/\$\{/g) ?? []).length;
      const closes = (tpl.match(/\}/g) ?? []).length;
      if (opens > closes) {
        throw new BadRequestException(`${field} has an unclosed \${placeholder}.`);
      }
    }
  }

  /**
   * Render a definition against sample values, for the template editor's preview.
   *
   * Uses the same `renderTemplate` the pipeline uses — including its habit of removing
   * sentence fragments left by missing values — so the preview is the real output, not an
   * approximation of it.
   */
  preview(def: {
    title: string;
    body: string;
    link?: string | null;
    emailSubject?: string | null;
    emailBody?: string | null;
  }, payload: Record<string, any>) {
    return {
      title: renderTemplate(def.title, payload),
      body: renderTemplate(def.body, payload),
      link: def.link ? renderTemplate(def.link, payload) : null,
      emailSubject: renderTemplate(def.emailSubject || def.title, payload),
      emailBody: renderTemplate(def.emailBody || def.body, payload),
    };
  }

  /**
   * The placeholders a type's own templates already use — the vocabulary an author can rely
   * on, derived from the shipped defaults rather than maintained as a second list that would
   * drift out of agreement with them.
   */
  placeholdersFor(type: string): string[] {
    const base = NOTIFICATION_CATALOG[type];
    if (!base) return [];
    const found = new Set<string>();
    for (const tpl of [base.title, base.body, base.link, base.collapse?.title, base.collapse?.body]) {
      for (const m of String(tpl ?? '').matchAll(/\$\{(\w+)\}/g)) found.add(m[1]);
    }
    return [...found].sort();
  }
}
