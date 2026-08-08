/**
 * FAPOMS — Holiday Service
 *
 * Handles holiday calendar management (Part 2 §10, Part 5 §11).
 * Avoids audits scheduling on holiday dates.
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { HolidayEntity } from './holiday.entity';
import { AuditService } from '../../core/audit/audit.service';
import { DomainEventPublisher } from '../../core/events/domain-event.publisher';
import { EventCategory, canonicalState } from '@fapoms/shared';
import { ClientConfigurationEntity } from '../client/client-configuration.entity';

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
  ) {}

  async create(dto: CreateHolidayDto, userId: string): Promise<HolidayEntity> {
    const holidayDate = new Date(dto.date);
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
    const query = this.holidayRepository.createQueryBuilder('holiday')
      .where('holiday.is_active = :isActive', { isActive: true })
      .andWhere('holiday.date = :date', { date: formattedDate });

    if (clientId) {
      query.andWhere('(holiday.client_id = :clientId OR holiday.client_id IS NULL)', { clientId });
    }

    const holidays = await query.getMany();

    if (holidays.length === 0) return false;

    // If a state is specified, check if any holiday applies to it. Branch and
    // holiday state names come from different sources and disagree on casing and
    // abbreviation ("MAHARASHTRA" vs "Maharashtra" vs "MH") — comparing raw
    // strings meant a state-scoped holiday could never match a real branch, so
    // every STATE-type holiday was silently inert for conflict checking.
    if (stateCode) {
      const target = canonicalState(stateCode);
      return holidays.some(
        h => !h.applicableStates || h.applicableStates.length === 0
          || h.applicableStates.some(s => canonicalState(s) === target)
      );
    }

    // Otherwise, if any national/universal holiday exists on that date, it's a holiday
    return holidays.some(h => !h.applicableStates || h.applicableStates.length === 0);
  }

  async remove(id: string, userId: string): Promise<void> {
    const holiday = await this.findOne(id);
    holiday.isActive = false;
    holiday.updatedBy = userId;
    await this.holidayRepository.save(holiday);

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
