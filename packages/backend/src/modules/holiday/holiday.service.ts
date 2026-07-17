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
import { EventCategory } from '@fapoms/shared';

export interface CreateHolidayDto {
  name: string;
  date: Date;
  type: string;
  applicableStates?: string[];
}

@Injectable()
export class HolidayService {
  constructor(
    @InjectRepository(HolidayEntity)
    private readonly holidayRepository: Repository<HolidayEntity>,
    private readonly auditService: AuditService,
  ) {}

  async create(dto: CreateHolidayDto, userId: string): Promise<HolidayEntity> {
    const holidayDate = new Date(dto.date);
    const holiday = this.holidayRepository.create({
      name: dto.name,
      date: holidayDate,
      type: dto.type,
      applicableStates: dto.applicableStates ?? null,
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

    return saved;
  }

  async findOne(id: string): Promise<HolidayEntity> {
    const holiday = await this.holidayRepository.findOne({ where: { id, isActive: true } });
    if (!holiday) {
      throw new NotFoundException(`Holiday ${id} not found.`);
    }
    return holiday;
  }

  async findAll(page = 1, limit = 50, year?: number): Promise<{ holidays: HolidayEntity[]; total: number }> {
    const query = this.holidayRepository.createQueryBuilder('holiday')
      .where('holiday.is_active = :isActive', { isActive: true });

    if (year) {
      query.andWhere('holiday.year = :year', { year });
    }

    const [holidays, total] = await query
      .orderBy('holiday.date', 'ASC')
      .take(limit)
      .skip((page - 1) * limit)
      .getManyAndCount();

    return { holidays, total };
  }

  /**
   * Helper: checks if a given date is a holiday in the specified state.
   */
  async isHoliday(date: Date, stateCode?: string): Promise<boolean> {
    const formattedDate = date.toISOString().split('T')[0];
    const query = this.holidayRepository.createQueryBuilder('holiday')
      .where('holiday.is_active = :isActive', { isActive: true })
      .andWhere('holiday.date = :date', { date: formattedDate });

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
  }
}
