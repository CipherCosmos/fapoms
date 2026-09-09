import { Controller, Get, Post, Param, Query, Req, UseGuards, ParseUUIDPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import type { Request } from 'express';
import { SystemRole, EventCategory } from '@fapoms/shared';
import { JwtAuthGuard, RolesGuard, Roles, RoleOnly } from '../../modules/auth/guards';
import { AuditService } from '../../core/audit/audit.service';
import { NOT_A_RECORD_ENTITY_ID } from '../../core/audit/audit-event';
import { OutboxDeadLetterService } from './outbox-dead-letter.service';

/**
 * The outbox, for the person who has to answer "did that event ever actually get delivered".
 *
 * `outbox_events` had no surface at all: no route, no health check, no metric, no admin view. An
 * event the relay gave up on after fifteen attempts stopped matching the relay's query, was never
 * purged by retention (which only deletes DISPATCHED rows), and left one `logger.error` line
 * behind. Nothing else in the system could tell you it existed.
 *
 * ## Who
 *
 * The developer, and them alone — the same audience and the same reasoning as `admin/logs`
 * (2026-09-05, when the DEVELOPER role took the technical estate). A domain event is plumbing:
 * its payload is internal structure, its failure is a delivery problem, and `POST .../replay`
 * re-publishes it to every subscriber — which for `assignment:status-changed` means the billing
 * engine. That is not a business decision an administrator should be handed, and role implication
 * being one-way, an administrator does not pass.
 *
 * Gated on the role itself and marked `@RoleOnly()` rather than on a grantable permission, for
 * the reason `admin/rule-bypass` and `notification-admin`'s four writes already document: a
 * capability that can re-fire an arbitrary domain event should not become reachable by ticking a
 * checkbox in the role editor.
 *
 * Every read and every replay is written to the audit trail. A screen whose purpose is to show
 * what the system failed to do, and to make it try again, must itself leave a record.
 */
@ApiTags('Outbox')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(SystemRole.DEVELOPER)
@RoleOnly()
@Controller('admin/outbox')
export class OutboxController {
  constructor(
    private readonly deadLetters: OutboxDeadLetterService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Counts, not rows: is anything stuck, is anything abandoned, how old is the oldest thing still
   * trying. Shaped like `admin/compliance/health` so an operator has one place to look per
   * subsystem rather than a different shape each time.
   */
  @Get('health')
  @ApiOperation({ summary: 'Outbox backlog: pending, retrying, dead-lettered, oldest pending' })
  async health() {
    return { success: true, data: await this.deadLetters.health() };
  }

  /** Everything the relay has given up on, newest failure first. */
  @Get('dead-letters')
  @ApiOperation({ summary: 'Domain events abandoned after exhausting their retries' })
  async list(@Query('limit') limit: string | undefined, @Req() req: Request) {
    const events = await this.deadLetters.list(limit ? Number(limit) : undefined);
    await this.record(req, 'OUTBOX_DEAD_LETTERS_READ', NOT_A_RECORD_ENTITY_ID, 'SUCCESS',
      `Read the outbox dead-letter queue (${events.length} event(s)).`, { returned: events.length });
    return { success: true, data: { events, count: events.length } };
  }

  /** One event with its payload — the detail the list deliberately does not carry. */
  @Get('dead-letters/:id')
  @ApiOperation({ summary: 'One outbox event, with the payload that would be republished' })
  async get(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const event = await this.deadLetters.get(id);
    await this.record(req, 'OUTBOX_EVENT_READ', id, 'SUCCESS',
      `Read outbox event ${id} (${event.eventName}).`, { eventName: event.eventName, attempts: event.attempts });
    return { success: true, data: event };
  }

  /**
   * Put one abandoned event back in front of the relay.
   *
   * Deliberately does NOT publish inline. Clearing `failed_at` and letting the ordinary tick pick
   * the row up means a replayed event travels the identical path as every other delivery — the
   * cluster lock, the same publisher, the same subscribers — rather than a second code path that
   * could drift from it. It also means the replay is durable: if this process dies a second later,
   * the row is still queued rather than lost between an HTTP response and a publish.
   *
   * Safe to press twice. Delivery has always been at-least-once (see `OutboxEntity`), and the
   * billing path is idempotent behind a deterministic job id, an already-booked read guard and two
   * unique indexes; the second replay of a row already back in the queue is refused outright by
   * the service, because it is no longer a dead letter.
   */
  @Post('dead-letters/:id/replay')
  @ApiOperation({ summary: 'Return an abandoned event to the relay for redelivery' })
  async replay(@Param('id', ParseUUIDPipe) id: string, @Req() req: Request) {
    const user = (req as any).user ?? {};
    const event = await this.deadLetters.replay(id, user.id ?? null);
    await this.record(req, 'OUTBOX_EVENT_REPLAYED', id, 'SUCCESS',
      `Returned outbox event ${id} (${event.eventName}) to the relay for redelivery.`,
      { eventName: event.eventName, subject: event.subject, previousAttempts: event.attempts });
    return { success: true, data: event };
  }

  private async record(
    req: Request,
    eventType: string,
    entityId: string,
    outcome: 'SUCCESS' | 'DENIED' | 'FAILURE',
    remarks: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const user = (req as any).user ?? {};
    await this.audit.recordEventSafe({
      category: EventCategory.SYSTEM,
      eventType,
      entityType: 'OutboxEvent',
      entityId,
      userId: user.id,
      userDisplayName: user.fullName ?? user.username ?? user.email ?? null,
      ipAddress: req.ip,
      outcome,
      remarks,
      metadata,
    });
  }
}
