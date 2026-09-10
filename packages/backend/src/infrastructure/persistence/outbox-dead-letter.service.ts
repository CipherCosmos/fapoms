import { Injectable, Logger, NotFoundException, ConflictException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThan, Not, Repository } from 'typeorm';
import { OutboxEntity } from './outbox.entity';
import { MAX_ATTEMPTS } from './outbox.relay';

/** One dead-lettered event, as an operator needs to see it. Payloads are not returned by the list. */
export interface OutboxDeadLetter {
  /** The outbox row id. It IS the event id — every payload carries it as `outboxEventId`. */
  id: string;
  eventName: string;
  occurredAt: Date;
  attempts: number;
  lastError: string | null;
  failedAt: Date | null;
  replayedAt: Date | null;
  replayedBy: string | null;
  /**
   * The ids inside the payload worth correlating on — assignment, payable, assayer, client — so
   * the list answers "what did this event concern" without returning the whole payload, which can
   * carry personal data and is what the detail read is for.
   */
  subject: Record<string, string>;
}

export interface OutboxHealth {
  /** Undelivered and still being retried. */
  pending: number;
  /** Undelivered, out of retries, waiting on a person. */
  deadLettered: number;
  /** Age in seconds of the oldest undelivered, still-retrying row. Null when there is none. */
  oldestPendingAgeSeconds: number | null;
  /** Rows that have been retried at least once and are not yet terminal — the early warning. */
  retrying: number;
  maxAttempts: number;
}

/** Payload keys worth showing on the list, in the order an operator would look for them. */
const SUBJECT_KEYS = [
  'outboxEventId', 'assignmentId', 'assignmentNumber', 'payableId', 'entryId',
  'assayerId', 'clientId', 'invoiceId', 'expenseId', 'userId',
] as const;

/**
 * The operational surface over `outbox_events` — what was abandoned, and how to put it back.
 *
 * ## The gap this closes
 *
 * `OutboxRelay` retries an undelivered event up to `MAX_ATTEMPTS` and then stops. Before this,
 * "stops" meant the row silently ceased to match the relay's `attempts < MAX_ATTEMPTS` filter:
 * no state said it had been abandoned, no route listed it, no health check counted it, no metric
 * moved, and `RetentionService.purgeDispatchedOutboxEvents` — which by design only deletes rows
 * with a `dispatched_at` — never cleaned it up either. A domain event could be permanently
 * undelivered, forever, and the only trace was one `logger.error` line at the moment of the
 * fifteenth failure.
 *
 * ## Terminal, but not final
 *
 * Retrying forever is not an option: a genuinely poisoned event would consume a batch slot on
 * every pass for the life of the deployment. Discarding it is not an option either: the row is
 * the only record that something the database committed was never told to anyone. So the row
 * stops, stays, and becomes visible — and a person decides.
 *
 * ## Replay is safe because delivery was always at-least-once
 *
 * Replay clears `failed_at` and resets `attempts`, and that is all it does: the ordinary relay
 * tick picks the row up on its next pass and publishes it through the same path the fast path
 * and every earlier retry used. Nothing here re-implements dispatch, so a replayed event cannot
 * take a different route than a normal one.
 *
 * Duplicates are already the designed-for case (`OutboxEntity`'s class comment: delivery is
 * at-least-once and every subscriber must tolerate redelivery), and the billing path — the one
 * that moves money — is defended four deep: a deterministic Bull job id
 * (`book-assignment:${assignmentId}`), `bookAssignment`'s already-booked read guard, and the
 * unique indexes `UQ_assayer_payables_fee_per_assignment` / `UQ_billing_entries_root_per_assignment`
 * that decide a race the read guard loses. Certification delivered one completion event 19 times
 * and got exactly one payable.
 */
@Injectable()
export class OutboxDeadLetterService {
  private readonly logger = new Logger(OutboxDeadLetterService.name);

  constructor(
    @InjectRepository(OutboxEntity)
    private readonly outbox: Repository<OutboxEntity>,
  ) {}

  /** Counts, for a health check or a dashboard tile. Cheap: four counts on an indexed table. */
  async health(): Promise<OutboxHealth> {
    const [pending, deadLettered, retrying, oldest] = await Promise.all([
      this.outbox.count({ where: { dispatchedAt: IsNull(), failedAt: IsNull() } }),
      this.outbox.count({ where: { dispatchedAt: IsNull(), failedAt: Not(IsNull()) } }),
      // Undelivered, still in the relay's queue, and already failed at least once — the early
      // warning that reaches a dashboard before anything becomes terminal.
      this.outbox.count({ where: { dispatchedAt: IsNull(), failedAt: IsNull(), attempts: MoreThan(0) } }),
      this.outbox.findOne({
        where: { dispatchedAt: IsNull(), failedAt: IsNull() },
        order: { occurredAt: 'ASC' },
        select: ['id', 'occurredAt'],
      }),
    ]);

    return {
      pending,
      deadLettered,
      retrying,
      oldestPendingAgeSeconds: oldest ? Math.round((Date.now() - new Date(oldest.occurredAt).getTime()) / 1000) : null,
      maxAttempts: MAX_ATTEMPTS,
    };
  }

  /** The dead letters, newest failure first. Bounded — this is a queue to be worked, not a log. */
  async list(limit = 100): Promise<OutboxDeadLetter[]> {
    const rows = await this.outbox.find({
      where: { dispatchedAt: IsNull(), failedAt: Not(IsNull()) },
      order: { failedAt: 'DESC' },
      take: Math.min(Math.max(limit, 1), 500),
    });
    return rows.map((row) => this.describe(row));
  }

  /** One dead letter WITH its payload — the detail read, so the list need not carry payloads. */
  async get(id: string): Promise<OutboxDeadLetter & { payload: Record<string, unknown> }> {
    const row = await this.outbox.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Outbox event ${id} not found.`);
    return { ...this.describe(row), payload: row.payload };
  }

  /**
   * Return one dead letter to the relay.
   *
   * Refuses anything that is not actually a dead letter: an already-dispatched row (replaying it
   * would be a deliberate duplicate rather than a recovery) and a row still being retried on its
   * own (the relay has not given up, so there is nothing to rescue). Both are conflicts, not
   * successes — a replay button that silently does nothing is how an operator comes to believe an
   * event was redelivered when it was not.
   *
   * `attempts` resets to 0 so the replayed row gets a full budget rather than failing once and
   * going straight back to terminal; `failed_at` clears so the relay's query matches it again.
   * The delivery itself is the relay's next tick — see the class comment.
   */
  async replay(id: string, userId: string | null): Promise<OutboxDeadLetter & { previousAttempts: number }> {
    const row = await this.outbox.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Outbox event ${id} not found.`);
    if (row.dispatchedAt) {
      throw new ConflictException(
        `Outbox event ${id} (${row.eventName}) was delivered at ${row.dispatchedAt.toISOString()} — there is nothing to replay.`,
      );
    }
    if (!row.failedAt) {
      throw new ConflictException(
        `Outbox event ${id} (${row.eventName}) has not been abandoned — it is on attempt ${row.attempts} of ${MAX_ATTEMPTS} and the relay is still retrying it.`,
      );
    }

    await this.outbox.update(id, {
      failedAt: null,
      attempts: 0,
      replayedAt: new Date(),
      replayedBy: userId,
    });
    this.logger.warn(
      `Outbox event ${id} (${row.eventName}) returned to the relay by ${userId ?? 'an operator'} ` +
        `after failing ${row.attempts} times: ${row.lastError ?? 'no error recorded'}.`,
    );

    const reloaded = await this.outbox.findOne({ where: { id } });
    // `attempts` on the returned row is 0 — that is the whole point of a replay — so the count
    // that was undone is carried separately. The audit record of a replay reads
    // "returned after failing N times", and reading it off the refreshed row made every one of
    // them say 0.
    return { ...this.describe(reloaded ?? row), previousAttempts: row.attempts };
  }

  private describe(row: OutboxEntity): OutboxDeadLetter {
    const subject: Record<string, string> = {};
    for (const key of SUBJECT_KEYS) {
      const value = (row.payload ?? {})[key];
      if (typeof value === 'string' || typeof value === 'number') subject[key] = String(value);
    }
    return {
      id: row.id,
      eventName: row.eventName,
      occurredAt: row.occurredAt,
      attempts: row.attempts,
      lastError: row.lastError,
      failedAt: row.failedAt,
      replayedAt: row.replayedAt,
      replayedBy: row.replayedBy,
      subject,
    };
  }
}
