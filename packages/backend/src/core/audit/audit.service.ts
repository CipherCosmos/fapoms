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
import { AuditRepository, AuditWriteScope } from './audit.repository';
import { AuditEvent, AuditEventPage, RecordAuditEventInput } from './audit-event';
import { getRequestContext } from '../context/request-context';

export type CreateAuditEventDto = RecordAuditEventInput;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly repository: AuditRepository) {}

  /**
   * Record a business event in the audit trail.
   * This is an append-only operation.
   *
   * The event is first enriched from the ambient request context, so who/where/which-session is
   * captured on every call site without any of them having to pass it. Explicit values on the dto
   * always win — a call that already knows the actor (login records the user before the guard has
   * run) or is deliberately anonymous keeps what it set.
   */
  async recordEvent(dto: CreateAuditEventDto, scope?: AuditWriteScope): Promise<{ id: string }> {
    return this.repository.append(AuditEvent.record(this.enrichFromContext(dto)), scope);
  }

  /**
   * Fill unset who/where/session fields from the current request context.
   *
   * Only fills what the caller left blank (`??`), so an explicit actor, IP, or anonymous intent is
   * never overwritten. Outside a request (a worker, a cron sweep, boot) there is no context and the
   * dto passes through unchanged — background events stay correctly actor-less rather than
   * borrowing whoever happened to trigger the process.
   */
  private enrichFromContext(dto: CreateAuditEventDto): CreateAuditEventDto {
    const ctx = getRequestContext();
    if (!ctx) return dto;
    return {
      ...dto,
      userId: dto.userId ?? ctx.userId,
      userDisplayName: dto.userDisplayName ?? ctx.displayName,
      ipAddress: dto.ipAddress ?? ctx.ipAddress,
      actorRole: dto.actorRole ?? ctx.role,
      userAgent: dto.userAgent ?? ctx.userAgent,
      sessionId: dto.sessionId ?? ctx.sessionId,
      requestId: dto.requestId ?? ctx.requestId,
    };
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
  async recordEventSafe(dto: CreateAuditEventDto, scope?: AuditWriteScope): Promise<void> {
    try {
      await this.recordEvent(dto, scope);
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
