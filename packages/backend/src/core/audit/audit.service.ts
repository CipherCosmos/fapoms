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
  /**
   * Which lens the event belongs under, and therefore which filter chip surfaces it.
   *
   * The convention, previously unstated and unevenly applied:
   *   WORKFLOW    — a business entity moved between states. Anything that sets previousState
   *                 and newState on an operational entity belongs here. Half of these were
   *                 filed as OPERATIONAL, so the WORKFLOW filter showed an auditor only some
   *                 of the state changes that had occurred.
   *   OPERATIONAL — a business action that is not itself a state transition: something was
   *                 created, edited, removed, dispatched, priced.
   *   USER        — account and access changes. A user being suspended carries previousState
   *                 and newState too, but it is an access event, not a business workflow, and
   *                 stays under USER deliberately.
   *   SYSTEM      — automated housekeeping with no human actor.
   */
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

/** Postgres uuid form; anything else cannot be an actor id. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      // `user_id` is a uuid column, so a non-uuid actor (the string 'system', an assayer code,
      // an empty string) makes the INSERT throw — and a throw here means the trail entry is
      // lost, which is the one failure this system must not have. Null is the single
      // representation of "no human actor"; the original value is kept in the remarks/metadata
      // the caller supplied, so nothing is hidden.
      userId: UUID_PATTERN.test(dto.userId ?? '') ? (dto.userId as string) : null,
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
