import { Injectable, Logger, BadRequestException } from '@nestjs/common';
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
@Injectable()
export class RuleBypassService {
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
   * fail the operation it is recording. The count is accumulated in memory and flushed; the
   * audit event for evidential rules is written immediately, because those are the ones whose
   * absence changes what a completed audit record means.
   */
  noteBypass(rule: BypassableRule, context: { entityType?: string; entityId?: string; userId?: string; detail?: string }): void {
    this.pendingUsage.set(rule, (this.pendingUsage.get(rule) ?? 0) + 1);
    void this.flushUsage().catch(() => undefined);

    const info = BYPASSABLE_RULE_INFO[rule];
    if (!info?.evidential) return;

    /**
     * An evidential skip is written against the record itself.
     *
     * This is what makes the feature safe to keep: months later, "was this check-in inside the
     * geofence, or was the geofence off that afternoon?" is answerable from the record rather
     * than from somebody's memory of a test session.
     */
    /**
     * `audit_events.entity_id` is a NOT NULL uuid, so there is no such thing as an event with
     * no subject. Most skips have one — the assignment being checked in, the assayer being
     * offered — but the rule evaluators decide about an (assayer, branch, date) triple and do
     * not always hold an id to attach it to.
     *
     * Those are anchored to the bypass window itself, which is both a real uuid and the honest
     * answer: the subject of "a rule was skipped and nobody recorded against what" is the window
     * that permitted it. The first version used the literal string 'SYSTEM' here, which the
     * column rejected — so every constraint-level skip failed to write, silently, defeating the
     * audit trail this whole feature rests on.
     */
    const anchorId = context.entityId ?? this.cached?.id;
    if (!anchorId) return;

    void this.auditService
      .recordEventSafe({
        category: EventCategory.SYSTEM,
        eventType: 'RULE_BYPASSED',
        entityType: context.entityId ? (context.entityType ?? 'SYSTEM') : 'RULE_BYPASS_WINDOW',
        entityId: anchorId,
        userId: context.userId ?? 'system',
        remarks:
          `Rule "${info.label}" was NOT enforced — an administrator has it suspended. ` +
          `${info.protects}${context.detail ? ` (${context.detail})` : ''}`,
        metadata: { rule, evidential: true },
      })
      .catch(() => undefined);
  }

  private flushingUsage = false;
  private async flushUsage(): Promise<void> {
    if (this.flushingUsage || this.pendingUsage.size === 0) return;
    this.flushingUsage = true;
    const batch = new Map(this.pendingUsage);
    this.pendingUsage.clear();
    try {
      const window = await this.currentWindow();
      if (!window) return;
      const counts = { ...(window.usageCounts ?? {}) };
      for (const [rule, n] of batch) counts[rule] = (counts[rule] ?? 0) + n;
      await this.repository.update(window.id, { usageCounts: counts });
      window.usageCounts = counts;
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
    await this.flushUsage().catch(() => undefined);
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
