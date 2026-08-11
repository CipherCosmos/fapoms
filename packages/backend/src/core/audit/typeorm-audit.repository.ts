import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditEventEntity } from './audit-event.entity';
import { AuditRepository, RecordedId } from './audit.repository';
import { AuditEvent, AuditEventPage } from './audit-event';

/**
 * The only place in the audit module that knows `audit_events` is a TypeORM table.
 *
 * Everything above it — `AuditService`, the controller, the dozens of call sites that record
 * events — now depends on `AuditRepository` and the `AuditEvent` domain type, so swapping the
 * trail onto a different store, or fanning writes to a second one for retention, changes this
 * file and nothing else.
 */
@Injectable()
export class TypeOrmAuditRepository extends AuditRepository {
  constructor(
    @InjectRepository(AuditEventEntity)
    private readonly events: Repository<AuditEventEntity>,
  ) {
    super();
  }

  async append(event: AuditEvent): Promise<RecordedId> {
    const row = this.events.create({
      category: event.category,
      eventType: event.eventType,
      entityType: event.entityType,
      entityId: event.entityId,
      previousState: event.previousState,
      newState: event.newState,
      userId: event.userId,
      userDisplayName: event.userDisplayName,
      ipAddress: event.ipAddress,
      remarks: event.remarks,
      metadata: event.metadata,
    });
    const saved = await this.events.save(row);
    return { id: saved.id };
  }

  async findForEntity(
    entityType: string,
    entityId: string,
    limit: number,
    offset: number,
  ): Promise<AuditEventPage> {
    const [events, total] = await this.events.findAndCount({
      where: { entityType, entityId },
      order: { occurredAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { events, total };
  }

  async findForUser(userId: string, limit: number, offset: number): Promise<AuditEventPage> {
    const [events, total] = await this.events.findAndCount({
      where: { userId },
      order: { occurredAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { events, total };
  }

  async findRecent(limit: number, offset: number, category?: string): Promise<AuditEventPage> {
    const [events, total] = await this.events.findAndCount({
      where: category ? { category } : {},
      order: { occurredAt: 'DESC' },
      take: limit,
      skip: offset,
    });
    return { events, total };
  }

  async findByEventType(eventType: string, limit: number): Promise<AuditEventPage> {
    const [events, total] = await this.events.findAndCount({
      where: { eventType },
      order: { occurredAt: 'DESC' },
      take: limit,
    });
    return { events, total };
  }
}
