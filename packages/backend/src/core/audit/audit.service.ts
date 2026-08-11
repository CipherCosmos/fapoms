/**
 * FAPOMS — Audit Service
 *
 * Central service for recording business events.
 * All modules use this service to create audit trail entries.
 *
 * This service only INSERTS — it never updates or deletes audit records.
 * Business history is immutable (Part 6 §13, Constitution §History is Immutable).
 * That is now structural rather than a matter of discipline: `AuditRepository` exposes no
 * method that could change or remove an entry.
 */

import { Injectable, Logger } from '@nestjs/common';
import { AuditRepository } from './audit.repository';
import { AuditEvent, AuditEventPage, RecordAuditEventInput } from './audit-event';

export type CreateAuditEventDto = RecordAuditEventInput;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly repository: AuditRepository) {}

  /**
   * Record a business event in the audit trail.
   * This is an append-only operation.
   */
  async recordEvent(dto: CreateAuditEventDto): Promise<{ id: string }> {
    return this.repository.append(AuditEvent.record(dto));
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
  ): Promise<AuditEventPage> {
    return this.repository.findForEntity(entityType, entityId, limit, offset);
  }

  /**
   * Retrieve audit events by user.
   */
  async getUserActivity(userId: string, limit = 50, offset = 0): Promise<AuditEventPage> {
    return this.repository.findForUser(userId, limit, offset);
  }

  /** The global feed: everything, most recent first, optionally narrowed by category. */
  async getByEventType(eventType: string, limit = 100): Promise<AuditEventPage> {
    return this.repository.findByEventType(eventType, limit);
  }

  async getRecentActivity(limit = 50, offset = 0, category?: string): Promise<AuditEventPage> {
    return this.repository.findRecent(limit, offset, category);
  }
}
