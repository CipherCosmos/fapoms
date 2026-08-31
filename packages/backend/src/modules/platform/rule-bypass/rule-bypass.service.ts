import { Injectable, Logger, BadRequestException, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import {
  BypassableRule,
  BYPASSABLE_RULE_INFO,
  MAX_BYPASS_HOURS,
  RuleBypassState,
  INACTIVE_BYPASS,
  EventCategory,
} from '@fapoms/shared';
import { RuleBypassWindowEntity } from './rule-bypass.entity';
import { AuditService } from '../../../core/audit/audit.service';

/**
 * FAPOMS — administrator-controlled suspension of operational rules.
 *
 * The capability itself is described in `@fapoms/shared/rule-bypass`. This is the enforcement
 * side, and it has three jobs beyond simply answering "is this rule off?":
 *
 *  1. **Answer fast.** `isBypassed` sits on the check-in path and inside the recommendation
 *     engine's per-candidate loop. A database round trip per candidate would make an ordinary
 *     recommendation measurably slower for a feature that is off almost all of the time, so the
 *     current window is cached and the cache is invalidated on every change.
 *
 *  2. **Fail closed.** Every path that cannot determine the state — no window, expired window,
 *     a database error — returns "not bypassed". A control that switches itself off when the
 *     database hiccups is not a control.
 *
 *  3. **Record what it was used for.** A window that was opened and never used is a note; a
 *     window under which forty check-ins skipped the geofence is a finding. Usage is counted
 *     per rule and each skip is written against the record it affected, so the question "which
 *     of these audits was produced with the controls off?" has an answer.
 */
/**
 * One rule's worth of unattributed skips, waiting to become a single audit row.
 *
 * `subjects` is a map rather than a list so that a candidate evaluated repeatedly within one
 * decision counts once as a subject and N times as an occurrence — which is the distinction the
 * aggregate row exists to preserve.
 */
interface PendingEvidence {
  occurrences: number;
  /** `entityType:entityId` → how many times that subject was involved. */
  subjects: Map<string, number>;
  /** A bounded sample of the human-readable reasons, distinct. */
  details: Set<string>;
}

@Injectable()
export class RuleBypassService implements OnModuleDestroy {
  private readonly logger = new Logger(RuleBypassService.name);

  /**
   * The active window, cached. `undefined` means "not loaded yet"; `null` means "loaded, and
   * there is no active window" — the common case, which must not re-query on every call.
   */
  private cached: RuleBypassWindowEntity | null | undefined = undefined;
  private cachedAt = 0;
  /** Short: a window revoked on another instance must stop applying quickly, not eventually. */
  private static readonly CACHE_MS = 5_000;

  /** Usage counts not yet written back, keyed by rule. Flushed periodically to avoid a write per skip. */
  private pendingUsage = new Map<string, number>();

  /**
   * Unattributed evidential skips waiting to be written as one audit row per rule.
   *
   * Keyed by rule; each entry counts the occurrences and remembers which subjects were involved.
   * See `noteBypass` for why these are aggregated and check-in skips are not.
   */
  private pendingEvidence = new Map<BypassableRule, PendingEvidence>();
  private evidenceTimer: NodeJS.Timeout | null = null;
  /** Distinct subjects across every entry of `pendingEvidence`. See `MAX_PENDING_SUBJECTS`. */
  private pendingSubjectCount = 0;

  /**
   * How long unattributed skips are collected before one audit row is written.
   *
   * Two seconds is comfortably longer than a recommendation request (measured at ~234 ms over a
   * 200k-assignment book), so the thousands of skips one request produces collapse into one row;
   * and short enough that the evidence is durable within a few seconds of the decision it
   * describes, which is what matters if the process is about to be restarted.
   */
  private static readonly EVIDENCE_FLUSH_MS = 2_000;

  /**
   * Distinct subjects named individually in one aggregate row. Beyond this the row still reports
   * the true total — `subjectCount` and `occurrences` are never truncated, only the id list is.
   * A jsonb column is not a place to put 5,000 uuids.
   */
  private static readonly MAX_NAMED_SUBJECTS = 50;

  /** Distinct human-readable reasons sampled per rule. The count lives in `occurrences`. */
  private static readonly MAX_SAMPLED_DETAILS = 50;

  /**
   * Total distinct subjects buffered across all rules before a flush is forced ahead of the timer.
   *
   * The bound has to be on *subjects*, not on rules: there are only twelve bypassable rules, so a
   * cap on `pendingEvidence.size` could never be reached and would be a guard that does nothing.
   * The dimension that actually grows is the candidate pool — a planning request over a national
   * desk can put thousands of assayer ids in here — and this is what stops an unusually long
   * sweep from holding all of them in memory for the full flush interval.
   */
  private static readonly MAX_PENDING_SUBJECTS = 5_000;

  constructor(
    @InjectRepository(RuleBypassWindowEntity)
    private readonly repository: Repository<RuleBypassWindowEntity>,
    private readonly auditService: AuditService,
  ) {}

  // -------------------------------------------------------------------------
  // Reading
  // -------------------------------------------------------------------------

  private async currentWindow(): Promise<RuleBypassWindowEntity | null> {
    if (this.cached !== undefined && Date.now() - this.cachedAt < RuleBypassService.CACHE_MS) {
      return this.cached;
    }
    try {
      const now = new Date();
      const window = await this.repository
        .createQueryBuilder('w')
        .where('w.isActive = true')
        .andWhere('w.revokedAt IS NULL')
        .andWhere('w.expiresAt > :now', { now })
        .orderBy('w.startsAt', 'DESC')
        .getOne();
      this.cached = window ?? null;
      this.cachedAt = Date.now();
      return this.cached;
    } catch (err: any) {
      // Fail closed, and say so. Silently treating an unreadable control as "off" is right;
      // silently treating it as "on" would be a way to disable the platform's controls with a
      // dropped connection.
      this.logger.error(`Could not read the rule-bypass window; treating all rules as enforced. ${err?.message ?? err}`);
      return null;
    }
  }

  /** The state, for the banner and the admin screen. Never throws. */
  async getState(): Promise<RuleBypassState> {
    const window = await this.currentWindow();
    if (!window) return INACTIVE_BYPASS;
    return {
      active: true,
      rules: window.rules as BypassableRule[],
      reason: window.reason,
      enabledBy: window.enabledBy,
      enabledByName: window.enabledByName,
      enabledAt: window.startsAt.toISOString(),
      expiresAt: window.expiresAt.toISOString(),
      // What the window has actually waved through so far — see `RuleBypassState.usageCounts`.
      usageCounts: (window.usageCounts ?? {}) as RuleBypassState['usageCounts'],
    };
  }

  /**
   * Is this rule currently suspended?
   *
   * The one question every enforcement point asks. Call it at the point of enforcement rather
   * than passing a flag down through call stacks: a bypass that travels as a parameter becomes
   * a parameter someone can set from a request body, which is precisely what this must not be.
   */
  async isBypassed(rule: BypassableRule): Promise<boolean> {
    const window = await this.currentWindow();
    return Boolean(window && window.rules.includes(rule));
  }

  /**
   * The same question, from a synchronous call site.
   *
   * Several rules are evaluated in synchronous methods — `checkLeaves`, `checkDistancePolicy`,
   * `checkSkillsAndCertifications` — that are called inside the recommendation engine's
   * per-candidate loop. Making them async to await this would turn one `await` into a
   * refactor across every filter and scorer, for a lookup that is almost always a cache hit.
   *
   * So this reads the last known window and, if that reading is stale, kicks off a refresh for
   * next time. Two consequences, both acceptable and both deliberate:
   *
   *  - **It fails closed.** A cold cache reports "enforced". Enabling a bypass can therefore
   *    take up to `CACHE_MS` to be honoured on these paths — a few seconds' lag in a feature an
   *    administrator has just deliberately switched on, which is the right way round. The
   *    opposite (assuming bypassed while unsure) would suspend controls on a cache miss.
   *  - **Expiry is re-checked here**, not trusted from the cached row, so a window cannot
   *    outlive its deadline by however long the cache happens to be warm.
   */
  isBypassedSync(rule: BypassableRule): boolean {
    if (Date.now() - this.cachedAt >= RuleBypassService.CACHE_MS) {
      // Fire-and-forget: warms the cache for the next call rather than blocking this one.
      void this.currentWindow().catch(() => undefined);
    }
    const window = this.cached;
    if (!window) return false;
    if (window.expiresAt.getTime() <= Date.now() || window.revokedAt) return false;
    return window.rules.includes(rule);
  }

  /**
   * Note that a rule was actually skipped, and against what.
   *
   * Deliberately not awaited by callers on hot paths — recording the skip must never be able to
   * fail the operation it is recording. The count is accumulated in memory and flushed; the audit
   * event for evidential rules is written for the rules whose absence changes what a completed
   * audit record means.
   *
   * ## Two kinds of skip, and why they are recorded differently
   *
   * The audit of 2026-08-16 found **1,447 of 2,564 `audit_events` rows were `RULE_BYPASSED`,
   * written in four days**. They did not come from anything happening 1,447 times; they came from
   * one screen being used a few times. `isBypassedSync` sits inside the recommendation engine's
   * per-candidate loop, and every filter that waves a candidate through calls this — so a single
   * planning request over a pool of 500 assayers wrote up to 500 near-identical rows recording
   * that a rule was skipped while *considering* people who were then not chosen.
   *
   * That is noise, and it is worse than noise: it buries the rows that matter under rows that do
   * not, in the exact table someone reads to find out whether the controls being off affected any
   * real record.
   *
   * So:
   *
   *  - **A skip attributed to a person, against a named record** — `userId` and `entityId` both
   *    present — is written immediately, one row each, exactly as before. This is the check-in
   *    path (`CHECK_IN_GEOFENCE`, `CHECK_IN_SCHEDULED_DAY` in `assignment.service.ts`), and it is
   *    the whole reason the feature is safe to keep: months later, "was this check-in inside the
   *    geofence, or was the geofence off that afternoon?" must be answerable from the assignment's
   *    own history. Nothing about those rows changes.
   *
   *  - **Everything else** — the planner sifting candidates, the constraint evaluator deciding
   *    about an (assayer, date) pair with no id to attach anything to — is buffered and written as
   *    **one row per rule per decision**, carrying the occurrence count and the subjects involved.
   *    One recommendation touching three suspended rules now writes 3 rows instead of ~1,500, and
   *    the row says more than any single one of the 1,500 did: how many candidates, and which.
   *
   * The discriminator is `userId && entityId` rather than `entityId` alone because the planner
   * does pass an `entityId` (the candidate assayer) — it just has no actor, because nobody decided
   * anything about that assayer. A skip with an actor and a subject is a decision about a record;
   * a skip with neither, or with only a subject, is a step in reaching one.
   */
  noteBypass(rule: BypassableRule, context: { entityType?: string; entityId?: string; userId?: string; detail?: string }): void {
    this.pendingUsage.set(rule, (this.pendingUsage.get(rule) ?? 0) + 1);
    void this.flushUsage().catch((e) => this.logger.error(`Could not record bypass usage: ${e?.message ?? e}`));

    const info = BYPASSABLE_RULE_INFO[rule];
    if (!info?.evidential) return;

    if (context.userId && context.entityId) {
      // No `.catch()`: `recordEventSafe` already absorbs a failed write and logs it at error
      // level. Adding one back would re-create the bare swallow it exists to replace — the
      // pattern that hid a broken audit write in this codebase for months.
      void this.auditService.recordEventSafe({
        category: EventCategory.SYSTEM,
        eventType: 'RULE_BYPASSED',
        entityType: context.entityType ?? 'SYSTEM',
        entityId: context.entityId,
        userId: context.userId,
        remarks:
          `Rule "${info.label}" was NOT enforced — an administrator has it suspended. ` +
          `${info.protects}${context.detail ? ` (${context.detail})` : ''}`,
        metadata: { rule, evidential: true },
      });
      return;
    }

    this.bufferEvidence(rule, context);
  }

  /** Accumulate one unattributed skip into the pending aggregate for its rule. */
  private bufferEvidence(
    rule: BypassableRule,
    context: { entityType?: string; entityId?: string; detail?: string },
  ): void {
    let pending = this.pendingEvidence.get(rule);
    if (!pending) {
      pending = { occurrences: 0, subjects: new Map(), details: new Set() };
      this.pendingEvidence.set(rule, pending);
    }
    pending.occurrences++;

    if (context.entityId) {
      const key = `${context.entityType ?? 'SYSTEM'}:${context.entityId}`;
      const seen = pending.subjects.get(key);
      pending.subjects.set(key, (seen ?? 0) + 1);
      // Counted here rather than re-summed on each call: this runs inside the recommendation
      // engine's per-candidate loop, and a loop over every buffered rule per skip would be work
      // proportional to the very amplification this method exists to remove.
      if (seen === undefined) this.pendingSubjectCount++;
    }
    // A bounded sample of the human-readable reasons. Distinct rather than counted: "barred by
    // RBL" said 400 times is one fact, and the count is already carried by `occurrences`.
    if (context.detail && pending.details.size < RuleBypassService.MAX_SAMPLED_DETAILS) {
      pending.details.add(context.detail);
    }

    if (this.pendingSubjectCount >= RuleBypassService.MAX_PENDING_SUBJECTS) {
      void this.flushEvidence().catch((e) => this.logger.error(`Could not record bypass evidence: ${e?.message ?? e}`));
      return;
    }

    if (!this.evidenceTimer) {
      this.evidenceTimer = setTimeout(
        () => void this.flushEvidence().catch((e) => this.logger.error(`Could not record bypass evidence: ${e?.message ?? e}`)),
        RuleBypassService.EVIDENCE_FLUSH_MS,
      );
      // Never hold the process open for a buffered audit row — `revokeCurrent` and
      // `onModuleDestroy` both flush explicitly, which are the paths that must not lose one.
      this.evidenceTimer.unref?.();
    }
  }

  /**
   * Write the buffered skips: one `RULE_BYPASSED` row per rule.
   *
   * Anchored to the bypass window itself. `audit_events.entity_id` is a NOT NULL uuid, so there is
   * no such thing as an event with no subject, and the window is both a real uuid and the honest
   * answer — the subject of "a rule was skipped while sifting candidates" is the window that
   * permitted it. (An earlier version used the literal string 'SYSTEM' here, which the column
   * rejected, so every constraint-level skip silently failed to write at all.)
   *
   * If there is no window to anchor to, the buffer is dropped rather than retried: a skip that
   * cannot name the window that allowed it has nothing left to say.
   */
  /**
   * Callers deliberately do not await this on the request path — recording evidence must never
   * be able to fail an operator's action. They do, however, all LOG a failure now: this row is
   * what tells a bank auditor whether the controls being off actually mattered, and a silent
   * `.catch(() => undefined)` meant a failed write closed the window reporting "no rules were
   * skipped" — the compliance answer, quietly wrong, with nothing anywhere to say so.
   */
  async flushEvidence(): Promise<void> {
    if (this.evidenceTimer) {
      clearTimeout(this.evidenceTimer);
      this.evidenceTimer = null;
    }
    if (this.pendingEvidence.size === 0) return;

    const batch = this.pendingEvidence;
    this.pendingEvidence = new Map();
    this.pendingSubjectCount = 0;

    const anchorId = this.cached?.id;
    if (!anchorId) return;

    for (const [rule, pending] of batch) {
      const info = BYPASSABLE_RULE_INFO[rule];
      const subjects = [...pending.subjects.entries()]
        // Most-skipped first, so the truncated list is the informative end of it.
        .sort((a, b) => b[1] - a[1])
        .slice(0, RuleBypassService.MAX_NAMED_SUBJECTS)
        .map(([key, count]) => ({ subject: key, count }));

      const scope =
        pending.subjects.size > 0
          ? `${pending.occurrences} time(s) across ${pending.subjects.size} record(s)`
          : `${pending.occurrences} time(s)`;
      const details = [...pending.details].slice(0, 5).join('; ');

      // Unguarded on purpose — see `noteBypass`: `recordEventSafe` cannot throw, and wrapping
      // it in a `.catch()` would only put the silent swallow back.
      await this.auditService
        .recordEventSafe({
          category: EventCategory.SYSTEM,
          eventType: 'RULE_BYPASSED',
          entityType: 'RULE_BYPASS_WINDOW',
          entityId: anchorId,
          userId: 'system',
          remarks:
            `Rule "${info?.label ?? rule}" was NOT enforced ${scope} while evaluating candidates — ` +
            `an administrator has it suspended. ${info?.protects ?? ''}${details ? ` (e.g. ${details})` : ''}`,
          /**
           * `aggregated: true` is what tells a reader this row stands for many skips rather than
           * one, so "1 row" is never mistaken for "1 occurrence". `subjectCount` and `occurrences`
           * are the true totals even when `subjects` has been truncated.
           */
          metadata: {
            rule,
            evidential: true,
            aggregated: true,
            occurrences: pending.occurrences,
            subjectCount: pending.subjects.size,
            subjects,
          },
        });
    }
  }

  /** Flush anything buffered before the process goes away. */
  async onModuleDestroy(): Promise<void> {
    await this.flushEvidence().catch((e) => this.logger.error(`Could not record bypass evidence: ${e?.message ?? e}`));
    await this.flushUsage().catch((e) => this.logger.error(`Could not record bypass usage: ${e?.message ?? e}`));
  }

  private flushingUsage = false;

  /**
   * Add the pending counts to `usage_counts` — in the database, not in this process.
   *
   * ## The bug this replaces
   *
   * This used to read `window.usageCounts`, merge the batch into it in JavaScript, and write the
   * whole object back. That is a read-modify-write on a shared row, and the backend runs as more
   * than one process. Two replicas flushing at the same time both read `{GEOFENCE: 10}`, one
   * writes `{GEOFENCE: 13}`, the other writes `{GEOFENCE: 12}`, and three skips become two. The
   * read was even served from a five-second cache, so the two writers did not have to be
   * simultaneous — merely within the same cache window — and the loser's write clobbered a value
   * it had never seen.
   *
   * These counts are the sentence the closing audit record is built from: "while it was open,
   * rules were skipped: Geofence ×40". Undercounting there understates a finding.
   *
   * ## Why this statement is atomic
   *
   * The current value is read by `w.usage_counts` *inside* the UPDATE, so the read and the write
   * are one statement against one row. Concurrent updaters serialise on the row lock, and under
   * READ COMMITTED the second one re-evaluates the SET expression against the row the first one
   * left behind — so increments compose instead of overwriting. `unnest($2::text[], $3::bigint[])`
   * carries the whole batch as two parallel arrays, keeping it to a single round trip whatever the
   * batch size, with no SQL built by string concatenation.
   *
   * `RETURNING` gives back the settled value, which is written into the cached entity so
   * `getState()` reports the real total rather than this replica's share of it.
   *
   * ## Deliberately unchanged
   *
   * When there is no current window the batch is dropped. A count belongs to the window it was
   * skipped under, and if that window is gone there is nothing to attribute it to. A *failure* to
   * read or write, by contrast, puts the batch back — that is a transient fault, not an absence.
   */
  private async flushUsage(): Promise<void> {
    if (this.flushingUsage || this.pendingUsage.size === 0) return;
    this.flushingUsage = true;
    const batch = new Map(this.pendingUsage);
    this.pendingUsage.clear();
    try {
      const window = await this.currentWindow();
      if (!window) return;

      const rules = [...batch.keys()];
      const counts = [...batch.values()];

      const rows = await this.repository.query(
        `UPDATE rule_bypass_windows w
            SET usage_counts = COALESCE(w.usage_counts, '{}'::jsonb) || (
                  SELECT COALESCE(
                           jsonb_object_agg(d.rule, COALESCE((w.usage_counts ->> d.rule)::bigint, 0) + d.n),
                           '{}'::jsonb
                         )
                    FROM unnest($2::text[], $3::bigint[]) AS d(rule, n)
                ),
                updated_at = now()
          WHERE w.id = $1
         RETURNING usage_counts`,
        [window.id, rules, counts],
      );

      const settled = Array.isArray(rows) ? rows[0]?.usage_counts : undefined;
      if (settled) window.usageCounts = settled as Record<string, number>;
    } catch {
      // Put them back so a transient failure does not lose the count.
      for (const [rule, n] of batch) this.pendingUsage.set(rule, (this.pendingUsage.get(rule) ?? 0) + n);
    } finally {
      this.flushingUsage = false;
    }
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /**
   * Open a bypass window. Administrator-only — enforced at the controller, stated again here.
   *
   * Replaces any window already running rather than merging with it, so what is suspended is
   * always exactly what the last administrator chose. Merging would let a window grow rule by
   * rule until nobody could say what was off.
   */
  async enable(
    rules: BypassableRule[],
    reason: string,
    hours: number,
    user: { id: string; name?: string | null },
  ): Promise<RuleBypassState> {
    const valid = Object.values(BypassableRule);
    const unknown = rules.filter((r) => !valid.includes(r));
    if (unknown.length) throw new BadRequestException(`Unknown rule(s): ${unknown.join(', ')}.`);
    if (rules.length === 0) throw new BadRequestException('Choose at least one rule to suspend.');

    const trimmedReason = (reason ?? '').trim();
    // Required, and not satisfiable with "test". The reason is what the person reading the
    // audit trail in six months has to work from.
    if (trimmedReason.length < 10) {
      throw new BadRequestException(
        'Give a reason of at least 10 characters — it is recorded against every record produced while these rules are off.',
      );
    }

    const requested = Number(hours);
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new BadRequestException('Give a duration in hours.');
    }
    if (requested > MAX_BYPASS_HOURS) {
      throw new BadRequestException(
        `A bypass window cannot exceed ${MAX_BYPASS_HOURS} hours. Re-open it if you need longer — that keeps a deliberate decision on the record.`,
      );
    }

    await this.revokeCurrent(user.id, 'Replaced by a new bypass window');

    const now = new Date();
    const window = this.repository.create({
      rules,
      reason: trimmedReason,
      enabledBy: user.id,
      enabledByName: user.name ?? null,
      startsAt: now,
      expiresAt: new Date(now.getTime() + requested * 3_600_000),
      usageCounts: {},
      createdBy: user.id,
      updatedBy: user.id,
    });
    const saved = await this.repository.save(window);
    this.invalidate();

    await this.auditService.recordEvent({
      category: EventCategory.SYSTEM,
      eventType: 'RULE_BYPASS_ENABLED',
      entityType: 'SYSTEM',
      entityId: saved.id,
      userId: user.id,
      remarks:
        `Suspended ${rules.length} operational rule(s) until ${saved.expiresAt.toISOString()}: ` +
        `${rules.map((r) => BYPASSABLE_RULE_INFO[r]?.label ?? r).join(', ')}. Reason: ${trimmedReason}`,
      metadata: { rules, hours: requested, expiresAt: saved.expiresAt.toISOString() },
    });

    this.logger.warn(
      `RULE BYPASS ENABLED by ${user.name ?? user.id} for ${requested}h: ${rules.join(', ')} — ${trimmedReason}`,
    );

    return this.getState();
  }

  /** Close the running window early. */
  async disable(user: { id: string; name?: string | null }): Promise<RuleBypassState> {
    const window = await this.currentWindow();
    if (!window) return INACTIVE_BYPASS;

    await this.revokeCurrent(user.id, 'Turned off by an administrator');
    this.invalidate();

    /**
     * Re-read the row rather than reporting from the cached copy.
     *
     * Usage is flushed asynchronously, so the cached object can easily predate the counts it is
     * being asked about — which produced a closing record stating the window was "never used"
     * while the row itself recorded a skip. That is the one sentence in this whole feature that
     * has to be right: it is what tells a reader whether the controls being off actually
     * mattered.
     */
    const settled = await this.repository.findOne({ where: { id: window.id } }).catch(() => null);
    const usageCounts = settled?.usageCounts ?? window.usageCounts ?? {};
    const used = Object.entries(usageCounts)
      .map(([r, n]) => `${BYPASSABLE_RULE_INFO[r as BypassableRule]?.label ?? r} ×${n}`)
      .join(', ');

    await this.auditService.recordEvent({
      category: EventCategory.SYSTEM,
      eventType: 'RULE_BYPASS_DISABLED',
      entityType: 'SYSTEM',
      entityId: window.id,
      userId: user.id,
      // The usage counts are the interesting part of the closing record.
      remarks: `Rule bypass turned off. While it was open, rules were skipped: ${used || 'never used'}.`,
      metadata: { usageCounts },
    });

    this.logger.warn(`RULE BYPASS DISABLED by ${user.name ?? user.id}`);
    return INACTIVE_BYPASS;
  }

  private async revokeCurrent(userId: string, _why: string): Promise<void> {
    // Both buffers, before the window they belong to stops being the current one. The evidence
    // flush first: it anchors to `this.cached.id`, which `invalidate()` is about to clear.
    await this.flushEvidence().catch((e) => this.logger.error(`Could not record bypass evidence: ${e?.message ?? e}`));
    await this.flushUsage().catch((e) => this.logger.error(`Could not record bypass usage: ${e?.message ?? e}`));
    await this.repository.update(
      { revokedAt: IsNull(), isActive: true },
      { revokedAt: new Date(), revokedBy: userId, updatedBy: userId },
    );
  }

  private invalidate(): void {
    this.cached = undefined;
    this.cachedAt = 0;
  }

  /** Past and present windows, newest first — the record an auditor asks for. */
  async history(limit = 50): Promise<RuleBypassWindowEntity[]> {
    return this.repository.find({ order: { startsAt: 'DESC' }, take: Math.min(limit, 200) });
  }
}
