import { Injectable, Logger, Optional } from '@nestjs/common';
import { businessDateKey, EventCategory, DEAD_PAYABLE_STATUSES } from '@fapoms/shared';
import { ASSIGNED_ASSIGNMENT_STATUSES, sqlStatusList } from './assignment-workload';
import { UnitOfWork } from '../../infrastructure/persistence/unit-of-work';
import { FeePolicyService } from '../pricing/fee-policy.service';
import { AuditService } from '../../core/audit/audit.service';
import { AssignmentRefreshPushService } from '../notifications/assignment-refresh-push.service';

/**
 * TRAVEL IS CHARGED ONCE PER ASSAYER PER DAY.
 *
 * Owner decision 2026-09-24 (E2): an assayer may be given several branches on the same day. They
 * make one journey out for that day, so exactly one of that day's jobs carries the travel quote;
 * every other job the same assayer has on the same date is quoted base fee only.
 *
 * "Already charged" means: another live job of this assayer on this date (offered, accepted, on
 * site or completed — `ASSIGNED_ASSIGNMENT_STATUSES`) whose travel is non-zero — the countered figure
 * when there is one, else the frozen quote, the same precedence `assignmentMoney` pays by. Asking
 * for NON-ZERO travel rather than "any other job" is deliberate: a first job quoted with no travel
 * (routing was down, or the branch is inside the free commute) must not stop a genuine journey
 * later that day from being priced, and at most one job still ends up carrying it.
 *
 * Asked INSIDE the writer's transaction, after the assayer row is locked (`SELECT … FOR UPDATE` on
 * `assayers`), so two offers for the same assayer and day created at once are serialised: the
 * first to commit carries the travel and the second sees it. Which one is first is decided by
 * whoever takes the lock first — the day planner posts its stops one after another, in route
 * order, so there the first stop carries it.
 *
 * When the day changes afterwards — the carrying job is declined, auto-declined, cancelled (a
 * closure cascade included), reassigned away, or moved to another date, or a job is moved ONTO a
 * day that already carries travel — `DayTravelService.rebalance` below re-decides the day. See
 * `planDayTravel` for the rule.
 */
export async function dayTravelAlreadyCharged(
  runner: { query: (sql: string, params?: unknown[]) => Promise<any[]> },
  assayerId: string,
  day: Date | string,
  excludeAssignmentId: string | null | undefined,
): Promise<boolean> {
  const dayKey = businessDateKey(day);
  if (!assayerId || !dayKey) return false;
  const rows = await runner.query(
    `SELECT id FROM assignments
      WHERE assayer_id = $1
        AND scheduled_date = $2::date
        AND is_active = true
        AND status IN (${sqlStatusList(ASSIGNED_ASSIGNMENT_STATUSES)})
        AND COALESCE(counter_travel_fee, quoted_travel_fee, 0) > 0
        AND ($3::uuid IS NULL OR id <> $3::uuid)
      LIMIT 1`,
    [assayerId, dayKey, excludeAssignmentId ?? null],
  );
  return Array.isArray(rows) && rows.length > 0;
}

/** Marker the unit tests use to recognise the query above in a hand-rolled manager double. */
export const DAY_TRAVEL_QUERY_MARKER = 'COALESCE(counter_travel_fee, quoted_travel_fee, 0) > 0';


// ── Re-deciding a day after it changed ─────────────────────────────────────────────────────────

/** One live job of the assayer's day, as `rebalance` reads it under the lock. */
export interface DayTravelRow {
  id: string;
  assignmentNumber?: string | null;
  createdAt: Date | string;
  proposedFee: number | string | null;
  agreedFee: number | string | null;
  quotedBaseFee: number | string | null;
  quotedTravelFee: number | string | null;
  counterTravelFee: number | string | null;
  quotedDistanceKm: number | string | null;
  /** The fee payable is past re-pricing: APPROVED/PAID, part-paid, or on a SUBMITTED/APPROVED/PAID assayer bill. */
  payableFrozen: boolean;
  /** The client line is on a client invoice (INVOICED/PAID) — changing the fee would leave it disagreeing. */
  clientLineFrozen: boolean;
}

/** Why a job's price is left as it is. */
export type DayTravelHold = 'DESK_TYPED_FEE' | 'PAYOUT_FROZEN' | 'CLIENT_INVOICED';

export interface DayTravelPlan {
  /** The job that takes the day's journey over (priced base + full travel). */
  give: string | null;
  /** Jobs that carry travel the day already pays for, dropped to base only. */
  drop: string[];
  /** Jobs the rule would have changed but may not touch, and why. */
  held: Array<{ id: string; why: DayTravelHold }>;
  /** Jobs the plan needs a full-travel quote for before it can decide. Empty once decided. */
  needsQuote: string[];
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The same precedence `dayTravelAlreadyCharged` and `assignmentMoney` use: countered, else quoted. */
export function carriesDayTravel(r: Pick<DayTravelRow, 'counterTravelFee' | 'quotedTravelFee'>): boolean {
  const t = r.counterTravelFee !== null && r.counterTravelFee !== undefined ? num(r.counterTravelFee) : num(r.quotedTravelFee);
  return (t ?? 0) > 0;
}

/**
 * Is this job's fee still the calculator's own figure, or did a person type it?
 *
 * There is no column that records who chose a fee, so it is read off the row: a fee equal to its
 * own frozen quote (`quotedBaseFee + quotedTravelFee`, to the paisa) with nothing countered is
 * system-quoted — that includes the planning form submitted unchanged, since the box is pre-filled
 * with the same quote. Anything else is the desk's number, and the desk's number is never moved by
 * this rule. A row whose two fee columns disagree was edited by hand and counts as typed.
 */
export function isSystemQuotedFee(r: Pick<DayTravelRow, 'proposedFee' | 'agreedFee' | 'quotedBaseFee' | 'quotedTravelFee' | 'counterTravelFee'>): boolean {
  if (r.counterTravelFee !== null && r.counterTravelFee !== undefined) return false;
  const base = num(r.quotedBaseFee);
  if (base === null) return false;
  const quoted = base + (num(r.quotedTravelFee) ?? 0);
  const proposed = num(r.proposedFee);
  const agreed = num(r.agreedFee);
  const fee = agreed ?? proposed;
  if (fee === null) return false;
  if (proposed !== null && Math.abs(proposed - fee) >= 0.01) return false;
  return Math.abs(fee - quoted) < 0.01;
}

/** Null when the job may be re-priced; otherwise the reason it may not. */
export function dayTravelHold(r: DayTravelRow): DayTravelHold | null {
  if (r.payableFrozen) return 'PAYOUT_FROZEN';
  if (r.clientLineFrozen) return 'CLIENT_INVOICED';
  if (!isSystemQuotedFee(r)) return 'DESK_TYPED_FEE';
  return null;
}

const byCreation = (a: DayTravelRow, b: DayTravelRow): number => {
  const ta = new Date(a.createdAt).getTime();
  const tb = new Date(b.createdAt).getTime();
  if (ta !== tb) return (Number.isFinite(ta) ? ta : 0) - (Number.isFinite(tb) ? tb : 0);
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * THE RULE, as one pure decision over one assayer's live jobs on one day.
 *
 * Order is by creation (then id, so a tie is still deterministic). Creation order IS plan order:
 * the day planner posts its stops one after another in route order (`postStopsInOrder`) and plan
 * deploy walks its allocations in plan order, so "earliest created" is "the first stop of the day".
 *
 *  - NOBODY carries travel (the carrier was declined, cancelled, reassigned away or moved off the
 *    day): the earliest job with a measured distance takes the journey over. If that job may not be
 *    re-priced (a desk-typed fee, or money already frozen) the day is left alone — the rule never
 *    skips past the desk's number to charge a later job instead, it reports it. A job whose full
 *    quote has no travel at all (inside the free commute) passes the turn to the next one, the same
 *    reason `dayTravelAlreadyCharged` asks for NON-ZERO travel.
 *  - MORE THAN ONE carries travel (a job moved onto a day that already had its journey): one keeps
 *    it and the others that may be re-priced drop to base only. The keeper is, in order: a carrier
 *    that may not be re-priced (it cannot drop, so dropping another is the only way to charge the
 *    journey once); else the earliest carrier that is not the job that just arrived; else the
 *    earliest. So the job moved onto the day is the one that drops.
 *  - Exactly one carries it: nothing to do.
 *
 * `fullTravel` is the full-travel quote per job id (only needed for the no-carrier case); a job the
 * decision needs and that is missing comes back in `needsQuote`, and nothing else is decided.
 */
export function planDayTravel(
  rows: DayTravelRow[],
  opts: { arrivingId?: string | null; fullTravel: Map<string, number> },
): DayTravelPlan {
  const ordered = [...rows].sort(byCreation);
  const carriers = ordered.filter(carriesDayTravel);
  const plan: DayTravelPlan = { give: null, drop: [], held: [], needsQuote: [] };

  if (carriers.length === 0) {
    for (const r of ordered) {
      if (!((num(r.quotedDistanceKm) ?? 0) > 0)) continue;
      const hold = dayTravelHold(r);
      if (hold) {
        plan.held.push({ id: r.id, why: hold });
        return plan;
      }
      if (!opts.fullTravel.has(r.id)) {
        plan.needsQuote.push(r.id);
        return plan;
      }
      if ((opts.fullTravel.get(r.id) ?? 0) > 0) {
        plan.give = r.id;
        return plan;
      }
    }
    return plan;
  }

  if (carriers.length === 1) return plan;

  const keeper = carriers.find((c) => dayTravelHold(c) !== null)
    ?? carriers.find((c) => c.id !== opts.arrivingId)
    ?? carriers[0];
  for (const c of carriers) {
    if (c === keeper) continue;
    const hold = dayTravelHold(c);
    if (hold) plan.held.push({ id: c.id, why: hold });
    else plan.drop.push(c.id);
  }
  return plan;
}

/** Marker the unit tests use to recognise the locked day read in a hand-rolled manager double. */
export const DAY_TRAVEL_REBALANCE_MARKER = '/* day-travel:rebalance */';

export interface DayTravelChange {
  assignmentId: string;
  assignmentNumber: string | null;
  change: 'GAINED_TRAVEL' | 'DROPPED_TRAVEL';
  proposedFee: number;
  travelFee: number;
}

export interface DayTravelOutcome {
  changed: DayTravelChange[];
  held: Array<{ id: string; why: DayTravelHold }>;
}

type Runner = { query: (sql: string, params?: unknown[]) => Promise<any[]> };

/**
 * Keeps "travel once per assayer per day" true after the day changes.
 *
 * Runs AFTER the triggering change has committed, in its own transaction — never inside the
 * decline, cancel, reassignment or date move that prompted it. That is the safe order: re-pricing
 * reads rate cards and may fail, and a decline or a branch closure must never be refused or rolled
 * back because a price could not be recomputed. The cost is a short window in which the day is
 * charged zero or two journeys; the re-decision is idempotent (it recomputes the whole day from the
 * rows), so running it again — or twice concurrently, serialised by the assayer lock — converges.
 *
 * Under the same lock `create()` and `reassignAssignment()` take (`assayers … FOR UPDATE`), so an
 * offer being created for that assayer and day waits for this to finish and then sees its result.
 *
 * Money is re-priced the existing way: the assignment row's fee moves here, and the committed
 * `assignment:fee-updated` event makes `BillingEngineService.repriceAssignment` carry it to an
 * unfrozen payable and an UNBILLED client line.
 */
@Injectable()
export class DayTravelService {
  private readonly logger = new Logger(DayTravelService.name);

  constructor(
    private readonly uow: UnitOfWork,
    private readonly feePolicy: FeePolicyService,
    private readonly auditService: AuditService,
    @Optional() private readonly refreshPush?: AssignmentRefreshPushService,
  ) {}

  /** The locked read of the day: every live job, with whether its money may still move. */
  private async readDay(runner: Runner, assayerId: string, dayKey: string, lock: boolean): Promise<Array<DayTravelRow & { clientId: string | null; state: string | null; region: string | null }>> {
    const rows = await runner.query(
      `${DAY_TRAVEL_REBALANCE_MARKER}
       SELECT a.id, a.assignment_number, a.created_at, a.proposed_fee, a.agreed_fee,
              a.quoted_base_fee, a.quoted_travel_fee, a.counter_travel_fee, a.quoted_distance_km,
              p.client_id, b.state, b.region,
              EXISTS (
                SELECT 1 FROM assayer_payables ap
                  LEFT JOIN assayer_invoices ai ON ai.id = ap.assayer_invoice_id
                 WHERE ap.assignment_id = a.id AND ap.expense_id IS NULL
                   AND ap.status NOT IN (${DEAD_PAYABLE_STATUSES.map((s) => `'${s}'`).join(',')})
                   AND (ap.status IN ('APPROVED','PAID') OR COALESCE(ap.paid_amount, 0) > 0
                        OR ai.status IN ('SUBMITTED','APPROVED','HOD_APPROVED','PAID'))
              ) AS payable_frozen,
              EXISTS (
                SELECT 1 FROM billing_entries be
                 WHERE be.assignment_id = a.id AND be.state IN ('INVOICED','PAID')
              ) AS client_line_frozen
         FROM assignments a
         LEFT JOIN projects p ON p.id = a.project_id
         LEFT JOIN project_branches pb ON pb.id = a.project_branch_id
         LEFT JOIN branches b ON b.id = pb.branch_id
        WHERE a.assayer_id = $1
          AND a.scheduled_date = $2::date
          AND a.is_active = true
          AND a.status IN (${sqlStatusList(ASSIGNED_ASSIGNMENT_STATUSES)})
        ORDER BY a.created_at, a.id
        ${lock ? 'FOR UPDATE OF a' : ''}`,
      [assayerId, dayKey],
    );
    return (Array.isArray(rows) ? rows : []).map((r: any) => ({
      id: r.id,
      assignmentNumber: r.assignment_number ?? null,
      createdAt: r.created_at,
      proposedFee: r.proposed_fee,
      agreedFee: r.agreed_fee,
      quotedBaseFee: r.quoted_base_fee,
      quotedTravelFee: r.quoted_travel_fee,
      counterTravelFee: r.counter_travel_fee,
      quotedDistanceKm: r.quoted_distance_km,
      payableFrozen: r.payable_frozen === true || r.payable_frozen === 't',
      clientLineFrozen: r.client_line_frozen === true || r.client_line_frozen === 't',
      clientId: r.client_id ?? null,
      state: r.state ?? null,
      region: r.region ?? null,
    }));
  }

  /** The full-travel quote for jobs that may be handed the journey — taken OUTSIDE any transaction. */
  private async quoteFullTravel(
    assayerId: string,
    dayKey: string,
    rows: Array<DayTravelRow & { clientId: string | null; state: string | null; region: string | null }>,
    ids: string[],
    into: Map<string, { travelFee: number; mode: string | null }>,
  ): Promise<void> {
    for (const id of ids) {
      if (into.has(id)) continue;
      const r = rows.find((x) => x.id === id);
      if (!r) continue;
      const q = await this.feePolicy.quote({
        assayerId,
        clientId: r.clientId,
        distanceKm: Number(r.quotedDistanceKm) || 0,
        onDate: new Date(dayKey),
        place: { state: r.state, region: r.region },
      });
      into.set(id, { travelFee: Number(q.travelFee) || 0, mode: q.transport?.recommended?.mode ?? null });
    }
  }

  /**
   * Re-decide one assayer's day. `arrivingAssignmentId` names a job that has just been moved onto
   * this day (date change, reassignment), so it — not the job already carrying the journey — is the
   * one that drops. Never throws: a failure is logged and the triggering change stands.
   */
  async rebalance(input: {
    assayerId: string | null | undefined;
    day: Date | string | null | undefined;
    userId: string;
    reason: string;
    arrivingAssignmentId?: string | null;
  }): Promise<DayTravelOutcome> {
    const none: DayTravelOutcome = { changed: [], held: [] };
    const dayKey = input.day ? businessDateKey(input.day) : '';
    if (!input.assayerId || !dayKey) return none;
    const assayerId = input.assayerId;
    try {
      const quotes = new Map<string, { travelFee: number; mode: string | null }>();
      // Up to three passes: quote outside the transaction, decide under the lock, and go round
      // again only if the day moved underneath and now needs a quote nobody took.
      for (let attempt = 0; attempt < 3; attempt++) {
        const preview = await this.readDay(this.unlockedRunner(), assayerId, dayKey, false);
        // Keep quoting down the day until the decision needs nothing more. Each pass quotes the job
        // the decision stopped at, so this ends after at most one quote per job.
        let probe = planDayTravel(preview, { arrivingId: input.arrivingAssignmentId, fullTravel: this.travelOnly(quotes) });
        while (probe.needsQuote.length > 0) {
          const before = quotes.size;
          await this.quoteFullTravel(assayerId, dayKey, preview, probe.needsQuote, quotes);
          if (quotes.size === before) break;
          probe = planDayTravel(preview, { arrivingId: input.arrivingAssignmentId, fullTravel: this.travelOnly(quotes) });
        }

        const outcome = await this.uow.run(async (manager, emit) => {
          await manager.query('SELECT id FROM assayers WHERE id = $1 FOR UPDATE', [assayerId]);
          const rows = await this.readDay(manager, assayerId, dayKey, true);
          const plan = planDayTravel(rows, { arrivingId: input.arrivingAssignmentId, fullTravel: this.travelOnly(quotes) });
          if (plan.needsQuote.length > 0) return null; // the day changed; go round again

          const changed: DayTravelChange[] = [];
          const write = async (row: DayTravelRow, travel: number, mode: string | null, change: DayTravelChange['change']) => {
            const base = Number(row.quotedBaseFee) || 0;
            const total = base + travel;
            await manager.query(
              `UPDATE assignments
                  SET proposed_fee = $2, agreed_fee = $2, quoted_travel_fee = $3, quoted_transport_mode = $4,
                      entity_version = COALESCE(entity_version, 1) + 1, updated_by = $5, updated_at = NOW()
                WHERE id = $1`,
              [row.id, total, travel, mode, input.userId],
            );
            await this.auditService.recordEventSafe({
              category: EventCategory.OPERATIONAL,
              eventType: 'ASSIGNMENT_DAY_TRAVEL_REPRICED',
              entityType: 'ASSIGNMENT',
              entityId: row.id,
              userId: input.userId,
              remarks: change === 'GAINED_TRAVEL'
                ? `Took over the day's travel (₹${travel}) for ${dayKey}: ${input.reason}. Fee ₹${Number(row.agreedFee ?? row.proposedFee ?? 0)} → ₹${total}.`
                : `Travel for ${dayKey} is already charged on another job; priced base only: ${input.reason}. Fee ₹${Number(row.agreedFee ?? row.proposedFee ?? 0)} → ₹${total}.`,
              metadata: { day: dayKey, change, previousFee: num(row.agreedFee ?? row.proposedFee), newFee: total, travelFee: travel },
            }, { manager });
            emit('assignment:fee-updated', {
              eventType: 'assignment:fee-updated',
              assignmentId: row.id,
              assignmentNumber: row.assignmentNumber ?? null,
              proposedFee: total,
              agreedFee: total,
              assayerId,
              userId: input.userId,
              timestamp: new Date().toISOString(),
            });
            changed.push({ assignmentId: row.id, assignmentNumber: row.assignmentNumber ?? null, change, proposedFee: total, travelFee: travel });
          };

          if (plan.give) {
            const row = rows.find((r) => r.id === plan.give)!;
            const q = quotes.get(row.id)!;
            await write(row, q.travelFee, q.mode, 'GAINED_TRAVEL');
          }
          for (const id of plan.drop) {
            await write(rows.find((r) => r.id === id)!, 0, null, 'DROPPED_TRAVEL');
          }
          return { changed, held: plan.held };
        });

        if (outcome) {
          // The version moved on each changed job; the phone refreshes rather than meeting a
          // stale-version refusal at check-in. Nothing visible: the assayer never sees fees.
          for (const c of outcome.changed) this.refreshPush?.assignmentChanged(assayerId, c.assignmentId);
          if (outcome.held.length > 0) {
            this.logger.log(`Day travel for ${assayerId} on ${dayKey} left as it is on ${outcome.held.map((h) => `${h.id} (${h.why})`).join(', ')}.`);
          }
          return outcome;
        }
      }
      this.logger.warn(`Day travel for ${assayerId} on ${dayKey} kept changing; not re-decided this time.`);
      return none;
    } catch (err) {
      this.logger.error(`Could not re-decide day travel for ${assayerId} on ${dayKey}: ${err instanceof Error ? err.message : String(err)}`);
      return none;
    }
  }

  /** Several (assayer, day) pairs, each once. */
  async rebalanceMany(
    pairs: Array<{ assayerId: string | null | undefined; day: Date | string | null | undefined; arrivingAssignmentId?: string | null }>,
    userId: string,
    reason: string,
  ): Promise<void> {
    const seen = new Set<string>();
    for (const p of pairs) {
      const key = p.assayerId && p.day ? `${p.assayerId}|${businessDateKey(p.day)}` : '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      await this.rebalance({ assayerId: p.assayerId, day: p.day, userId, reason, arrivingAssignmentId: p.arrivingAssignmentId });
    }
  }

  private travelOnly(quotes: Map<string, { travelFee: number }>): Map<string, number> {
    return new Map([...quotes].map(([k, v]) => [k, v.travelFee]));
  }

  /** An unlocked read for the quote pass — its own short transaction, holding nothing across the quote. */
  private unlockedRunner(): Runner {
    return { query: (sql, params) => this.uow.run((m) => m.query(sql, params)) };
  }
}
