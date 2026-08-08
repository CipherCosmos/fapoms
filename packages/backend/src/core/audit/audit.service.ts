/**
 * FAPOMS — Audit Service
 *
 * Central service for recording business events.
 * All modules use this service to create audit trail entries.
 *
 * This service only INSERTS — it never updates or deletes audit records.
 * Business history is immutable (Part 6 §13, Constitution §History is Immutable).
 */

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditEventEntity } from './audit-event.entity';
import { EventCategory } from '@fapoms/shared';

export interface CreateAuditEventDto {
  category: EventCategory;
  eventType: string;
  entityType: string;
  entityId: string;
  previousState?: string;
  newState?: string;
  userId?: string;
  userDisplayName?: string;
  ipAddress?: string;
  remarks?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditEventEntity)
    private readonly auditRepository: Repository<AuditEventEntity>,
  ) {}

  /**
   * Record a business event in the audit trail.
   * This is an append-only operation.
   */
  async recordEvent(dto: CreateAuditEventDto): Promise<AuditEventEntity> {
    const event = this.auditRepository.create({
      category: dto.category,
      eventType: dto.eventType,
      entityType: dto.entityType,
      entityId: dto.entityId,
      previousState: dto.previousState ?? null,
      newState: dto.newState ?? null,
      userId: dto.userId ?? null,
      userDisplayName: dto.userDisplayName ?? null,
      ipAddress: dto.ipAddress ?? null,
      remarks: dto.remarks ?? null,
      metadata: dto.metadata ?? null,
    });

    return this.auditRepository.save(event);
  }

  /**
   * Record an event without letting an audit failure roll back the business operation that
   * caused it — but leave evidence when it happens.
   *
   * Callers throughout the codebase already append `.catch(() => {})` to `recordEvent`, on the
   * reasoning that a completed state change shouldn't be undone because its audit row failed
   * to insert. That reasoning holds, but a bare swallow means a missing trail entry leaves no
   * trace anywhere, which for an audit business is the one failure that must never be silent.
   * This logs at error level instead, so a gap is detectable rather than invisible.
   */
  async recordEventSafe(dto: CreateAuditEventDto): Promise<void> {
    try {
      await this.recordEvent(dto);
    } catch (error) {
      this.logger.error(
        `AUDIT WRITE FAILED — ${dto.eventType} on ${dto.entityType}:${dto.entityId} was not recorded: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Retrieve audit history for a specific entity.
   * Ordered by most recent first.
   */
  async getEntityHistory(
    entityType: string,
    entityId: string,
    limit = 50,
    offset = 0,
  ): Promise<{ events: AuditEventEntity[]; total: number }> {
    const [events, total] = await this.auditRepository.findAndCount({
      where: { entityType, entityId },
      order: { occurredAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    return { events, total };
  }

  /**
   * Retrieve audit events by user.
   */
  async getUserActivity(
    userId: string,
    limit = 50,
    offset = 0,
  ): Promise<{ events: AuditEventEntity[]; total: number }> {
    const [events, total] = await this.auditRepository.findAndCount({
      where: { userId },
      order: { occurredAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    return { events, total };
  }

  /** The global feed: everything, most recent first, optionally narrowed by category. */
  async getRecentActivity(
    limit = 50,
    offset = 0,
    category?: string,
  ): Promise<{ events: AuditEventEntity[]; total: number }> {
    const [events, total] = await this.auditRepository.findAndCount({
      where: category ? { category } : {},
      order: { occurredAt: 'DESC' },
      take: limit,
      skip: offset,
    });

    return { events, total };
  }
}
