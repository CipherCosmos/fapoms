/**
 * FAPOMS — Holiday Service
 *
 * Handles holiday calendar management (Part 2 §10, Part 5 §11).
 * Avoids audits scheduling on holiday dates.
 */

import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { HolidayEntity } from './holiday.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { EventCategory, canonicalState } from '@fapoms/shared';
import { ClientConfigurationEntity } from '../client/client-configuration.entity';
import { CacheService } from '../../infrastructure/cache/cache.service';

/** Holidays change rarely; a modest TTL keeps scheduling checks fast while bounding staleness. */
const HOLIDAY_CACHE_TTL_SECONDS = 600;

export interface CreateHolidayDto {
  name: string;
  date: string | Date;
  type: string;
  applicableStates?: string[];
  clientId?: string | null;
}

@Injectable()
export class HolidayService {
  constructor(
    @InjectRepository(HolidayEntity)
    private readonly holidayRepository: Repository<HolidayEntity>,
    @InjectRepository(ClientConfigurationEntity)
    private readonly clientConfigRepository: Repository<ClientConfigurationEntity>,
    private readonly auditService: AuditService,
    private readonly eventPublisher: DomainEventPublisher,
    private readonly cache: CacheService,
  ) {}

  /** Drop every cached holiday lookup after any write, so scheduling never reads a stale calendar. */
  private async invalidateHolidayCache(): Promise<void> {
    await this.cache.delByPattern('ref:holidays:*');
  }

  /**
   * Refuse the same holiday twice — same name, same date, same client scope.
   *
   * Nothing stopped this before: a double-click on "Save", or two people running "Copy last
   * year's holidays" at once (`Holidays.tsx`'s bulk action loops one `POST` per row client-side,
   * with no server-side lock between them), silently produced two identical active rows for the
   * one date. `isHoliday()` only cares whether at least one match exists, so scheduling itself
   * was never wrong — but the admin calendar screen then showed the same holiday listed twice,
   * each independently editable and deletable, with nothing to say they were the same day.
   *
   * Scoped narrowly to an exact match, the same way `ZoneService.assertNameIsFree` scopes to
   * name-within-client: two holidays with genuinely different names landing on the same date
   * (a state event alongside a bank-specific one, say) are not duplicates and stay unblocked.
   */
  private async assertNotDuplicate(dto: CreateHolidayDto, holidayDate: Date, excludeId?: string): Promise<void> {
    const formattedDate = holidayDate.toISOString().split('T')[0];
    const clash = await this.holidayRepository
      .createQueryBuilder('holiday')
      .where('holiday.is_active = :isActive', { isActive: true })
      .andWhere('holiday.name ILIKE :name', { name: dto.name.trim() })
      .andWhere('holiday.date = :date', { date: formattedDate })
      .andWhere(dto.clientId ? 'holiday.client_id = :clientId' : 'holiday.client_id IS NULL', dto.clientId ? { clientId: dto.clientId } : {})
      .andWhere(excludeId ? 'holiday.id != :excludeId' : '1=1', excludeId ? { excludeId } : {})
      .getOne();
    if (clash) {
      throw new ConflictException(
        `"${clash.name}" is already registered for this date${dto.clientId ? ' and client' : ''}. Edit that entry instead of adding a duplicate.`,
      );
    }
  }

  async create(dto: CreateHolidayDto, userId: string): Promise<HolidayEntity> {
    const holidayDate = new Date(dto.date);
    await this.assertNotDuplicate(dto, holidayDate);
    const holiday = this.holidayRepository.create({
      name: dto.name,
      date: holidayDate,
      type: dto.type,
      applicableStates: dto.applicableStates ?? null,
      clientId: dto.clientId ?? null,
      year: holidayDate.getFullYear(),
      createdBy: userId,
      updatedBy: userId,
    });

    const saved = await this.holidayRepository.save(holiday);
    await this.invalidateHolidayCache();

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'HOLIDAY_CREATED',
      entityType: 'HOLIDAY',
      entityId: saved.id,
      userId,
      remarks: `Created holiday ${saved.name} for ${dto.date}`,
    });

    this.eventPublisher.publish('holiday:created', {
      eventType: 'holiday:created',
      aggregateId: saved.id,
      userId,
      payload: { id: saved.id, name: saved.name, date: dto.date, type: dto.type },
    });

    return saved;
  }

  async findOne(id: string): Promise<HolidayEntity> {
    const holiday = await this.holidayRepository.findOne({ where: { id, isActive: true } });
    if (!holiday) {
      throw new NotFoundException(`Holiday ${id} not found.`);
    }
    return holiday;
  }

  async update(id: string, dto: Partial<CreateHolidayDto>, userId: string): Promise<HolidayEntity> {
    const holiday = await this.findOne(id);

    if (dto.name !== undefined) holiday.name = dto.name;
    if (dto.type !== undefined) holiday.type = dto.type;
    if (dto.applicableStates !== undefined) holiday.applicableStates = dto.applicableStates ?? null;
    if (dto.clientId !== undefined) holiday.clientId = dto.clientId ?? null;
    if (dto.date !== undefined) {
      const holidayDate = new Date(dto.date);
      holiday.date = holidayDate;
      holiday.year = holidayDate.getFullYear();
    }
    holiday.updatedBy = userId;

    const saved = await this.holidayRepository.save(holiday);
    await this.invalidateHolidayCache();

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'HOLIDAY_UPDATED',
      entityType: 'HOLIDAY',
      entityId: saved.id,
      userId,
      remarks: `Updated holiday ${saved.name} for ${dto.date}`,
    });

    this.eventPublisher.publish('holiday:updated', {
      eventType: 'holiday:updated',
      aggregateId: id,
      userId,
      payload: { id, name: saved.name, date: dto.date, type: dto.type },
    });

    return saved;
  }

  async findAll(page = 1, limit = 50, year?: number, clientId?: string): Promise<{ holidays: HolidayEntity[]; total: number }> {
    const cacheKey = `ref:holidays:list:${clientId ?? 'all'}:${year ?? 'all'}:${page}:${limit}`;
    return this.cache.wrap(cacheKey, HOLIDAY_CACHE_TTL_SECONDS, async () => {
      const query = this.holidayRepository.createQueryBuilder('holiday')
        .where('holiday.is_active = :isActive', { isActive: true });

      if (year) {
        query.andWhere('holiday.year = :year', { year });
      }

      if (clientId) {
        query.andWhere('(holiday.client_id = :clientId OR holiday.client_id IS NULL)', { clientId });
      }

      const [holidays, total] = await query
        .orderBy('holiday.date', 'ASC')
        .take(limit)
        .skip((page - 1) * limit)
        .getManyAndCount();

      return { holidays, total };
    });
  }

  private readonly workingDaysCache = new Map<string, number[] | null>();

  /** The client's configured working days (0 = Sunday), or null when they have set none. */
  private async workingDaysFor(clientId: string): Promise<number[] | null> {
    if (this.workingDaysCache.has(clientId)) return this.workingDaysCache.get(clientId) ?? null;
    const config = await this.clientConfigRepository
      .findOne({ where: { clientId } })
      .catch(() => null);
    const days = Array.isArray(config?.workingDays) && config!.workingDays.length > 0
      ? config!.workingDays.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      : null;
    this.workingDaysCache.set(clientId, days);
    return days;
  }

  /**
   * Whether a date cannot be worked, for a given state and client.
   *
   * Rules, in order:
   * 1. The client's own configured working days, when they have set any. This is stored on
   *    client_configurations.working_days and settable through the client API, but until now
   *    nothing read it — a client who worked Saturdays, or who did not work Mondays, was
   *    scheduled against the platform default regardless of what they had configured.
   * 2. Every Sunday, and the 2nd and 4th Saturday, per the Indian bank calendar. These apply
   *    when the client has expressed no preference of their own.
   * 3. Specific registered holidays, national or state-scoped.
   */
  async isHoliday(date: Date, stateCode?: string, clientId?: string): Promise<boolean> {
    const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday
    const dayOfMonth = date.getDate();

    const workingDays = clientId ? await this.workingDaysFor(clientId) : null;
    if (workingDays && workingDays.length > 0) {
      // The client's own calendar wins: it is a contract term, not a default to be overridden.
      if (!workingDays.includes(dayOfWeek)) return true;
    } else {
      // 1. Every Sunday
      if (dayOfWeek === 0) return true;

      // 2. 2nd and 4th Saturday (Bank / Public Holiday)
      if (dayOfWeek === 6) {
        const weekIndex = Math.ceil(dayOfMonth / 7);
        if (weekIndex === 2 || weekIndex === 4) return true;
      }
    }

    const formattedDate = date.toISOString().split('T')[0];
    // Scheduling checks the same dates repeatedly; cache the registered-holiday lookup for
    // this exact date + client. .length, .applicableStates and .clientId are read below, all of
    // which survive a JSON round-trip, so a cache hit behaves identically to a fresh query.
    const holidaysCacheKey = `ref:holidays:${clientId ?? 'all'}:${formattedDate}`;
    const holidays = await this.cache.wrap(holidaysCacheKey, HOLIDAY_CACHE_TTL_SECONDS, () => {
      const query = this.holidayRepository.createQueryBuilder('holiday')
        .where('holiday.is_active = :isActive', { isActive: true })
        .andWhere('holiday.date = :date', { date: formattedDate });

      if (clientId) {
        query.andWhere('(holiday.client_id = :clientId OR holiday.client_id IS NULL)', { clientId });
      }

      return query.getMany();
    });

    if (holidays.length === 0) return false;

    /**
     * A holiday applies to this caller only if it is either genuinely global (`clientId` null on
     * the row) or scoped to the client actually asking.
     *
     * The SQL `WHERE` above already enforces this — but only when a `clientId` was passed in the
     * first place. Omit it (as `GET /holidays/check` legitimately allows — nothing requires a
     * caller to know which bank it is asking about) and the query drops that clause entirely,
     * returning every client's holidays for the date mixed together with genuinely global ones.
     * The two checks below never looked at `clientId` at all, so a bank-specific holiday with no
     * `applicableStates` (the ordinary case — most client holidays are not also state-restricted)
     * read as "no state restriction" and was treated as nationwide: querying without a `clientId`
     * reported every OTHER bank's private holiday as a holiday for everyone, everywhere. Applying
     * the same rule here as the SQL — global-or-mine — makes this correct regardless of whether
     * the DB filter ran, rather than depending on it.
     */
    const appliesToCaller = (h: HolidayEntity): boolean => h.clientId == null || h.clientId === clientId;

    // If a state is specified, check if any holiday applies to it. Branch and
    // holiday state names come from different sources and disagree on casing and
    // abbreviation ("MAHARASHTRA" vs "Maharashtra" vs "MH") — comparing raw
    // strings meant a state-scoped holiday could never match a real branch, so
    // every STATE-type holiday was silently inert for conflict checking.
    if (stateCode) {
      const target = canonicalState(stateCode);
      return holidays.some(
        h => appliesToCaller(h) && (
          !h.applicableStates || h.applicableStates.length === 0
          || h.applicableStates.some(s => canonicalState(s) === target)
        )
      );
    }

    // Otherwise, if any national/universal holiday exists on that date, it's a holiday
    return holidays.some(h => appliesToCaller(h) && (!h.applicableStates || h.applicableStates.length === 0));
  }

  async remove(id: string, userId: string): Promise<void> {
    const holiday = await this.findOne(id);
    holiday.isActive = false;
    holiday.updatedBy = userId;
    await this.holidayRepository.save(holiday);
    await this.invalidateHolidayCache();

    await this.auditService.recordEvent({
      category: EventCategory.OPERATIONAL,
      eventType: 'HOLIDAY_DELETED',
      entityType: 'HOLIDAY',
      entityId: id,
      userId,
      remarks: `Soft deleted holiday ${holiday.name}`,
    });

    this.eventPublisher.publish('holiday:deleted', {
      eventType: 'holiday:deleted',
      aggregateId: id,
      userId,
      payload: { id, name: holiday.name },
    });
  }
}
