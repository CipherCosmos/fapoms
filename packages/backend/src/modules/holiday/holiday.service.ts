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
import { EventCategory } from '@fapoms/shared';

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

  async update(id: string, dto: CreateHolidayDto, userId: string): Promise<HolidayEntity> {
    const holiday = await this.findOne(id);
    const holidayDate = new Date(dto.date);

    holiday.name = dto.name;
    holiday.date = holidayDate;
    holiday.type = dto.type;
    holiday.applicableStates = dto.applicableStates ?? null;
    holiday.clientId = dto.clientId ?? null;
    holiday.year = holidayDate.getFullYear();
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

  /**
   * Helper: checks if a given date is a holiday in the specified state and client.
   * Enforces standard rules:
   * 1. Every Sunday (day 0) is a holiday.
   * 2. 2nd & 4th Saturday of every month (bank holiday rule) is a holiday.
   * 3. Specific registered holidays in database.
   */
  async isHoliday(date: Date, stateCode?: string, clientId?: string): Promise<boolean> {
    const dayOfWeek = date.getDay(); // 0 = Sunday, 6 = Saturday
    const dayOfMonth = date.getDate();

    // 1. Every Sunday
    if (dayOfWeek === 0) return true;

    // 2. 2nd and 4th Saturday (Bank / Public Holiday)
    if (dayOfWeek === 6) {
      const weekIndex = Math.ceil(dayOfMonth / 7);
      if (weekIndex === 2 || weekIndex === 4) return true;
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

    // If a state is specified, check if any holiday applies to it
    if (stateCode) {
      return holidays.some(
        h => !h.applicableStates || h.applicableStates.length === 0 || h.applicableStates.includes(stateCode)
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
