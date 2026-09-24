import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryFailedError, Repository } from 'typeorm';
import type { BackgroundJobProgress, BackgroundJobStatus } from '@fapoms/shared';
import { BackgroundJobEntity } from './background-job.entity';

/**
 * A RUNNING row untouched this long has lost its worker and may be claimed again. Three heartbeats
 * (`HEARTBEAT_INTERVAL_MS`, 20 s) plus margin.
 */
export const RECLAIM_AFTER_MS = 90_000;

/** How often a running job touches its row. Well inside `RECLAIM_AFTER_MS` and the recovery sweep's staleness. */
export const HEARTBEAT_INTERVAL_MS = 20_000;

/** Statuses a job is still open in — the dedupe index's predicate, in code. */
export const OPEN_STATUSES: BackgroundJobStatus[] = ['QUEUED', 'RUNNING', 'AWAITING_REVIEW'];
export const SETTLED_STATUSES: BackgroundJobStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

/** Another job holding the same `exclusive_key` is RUNNING, so this one cannot start yet. */
export class ExclusiveSlotBusyError extends Error {
  constructor() {
    super('Another job of this kind is running for the same scope.');
    this.name = 'ExclusiveSlotBusyError';
  }
}

export interface JobListFilter {
  /** Only this person's jobs. */
  requestedBy?: string;
  /**
   * An administrator's view of everybody's: `null` for unrestricted, otherwise jobs whose captured
   * regions all fall inside these. A job started by an unrestricted account (regions NULL) is not
   * inside any restricted set, so a regional administrator never sees national work.
   */
  withinRegions?: string[] | null;
  /** Tenant ceiling, when the reader belongs to one organisation. */
  organizationId?: string | null;
  kind?: string;
  scopeType?: string;
  scopeId?: string;
  statuses: BackgroundJobStatus[];
  /** Settled jobs only: finished after this. */
  finishedAfter?: Date;
  limit: number;
}

/**
 * Every statement against `background_jobs`, in one place.
 *
 * The lifecycle's safety lives in these WHERE clauses: every transition names the statuses it may
 * leave from, so a cancel that lands while the worker is finishing, a second worker picking up a
 * redelivered job, or a recovery sweep racing a live run each lose cleanly (zero rows) rather than
 * overwriting an answer. `BackgroundJobsService` decides what should happen; this decides whether it
 * still can.
 */
@Injectable()
export class BackgroundJobStore {
  constructor(
    @InjectRepository(BackgroundJobEntity) private readonly repo: Repository<BackgroundJobEntity>,
  ) {}

  findById(id: string): Promise<BackgroundJobEntity | null> {
    return this.repo.findOne({ where: { id } });
  }

  findOpenByDedupe(dedupeKey: string): Promise<BackgroundJobEntity | null> {
    return this.repo.findOne({ where: { dedupeKey, status: In(OPEN_STATUSES) } });
  }

  /**
   * Insert, unless an open job already holds the same dedupe key.
   *
   * `ON CONFLICT DO NOTHING` with no conflict target covers the partial unique index, so two
   * identical uploads racing each other produce one row, and the loser is told which one — the
   * check-then-insert the service does first is only the fast path.
   */
  async insert(values: Partial<BackgroundJobEntity>): Promise<{ job: BackgroundJobEntity; inserted: boolean }> {
    const result = await this.repo
      .createQueryBuilder()
      .insert()
      .into(BackgroundJobEntity)
      .values(values as any)
      .orIgnore()
      .returning(['id'])
      .execute();
    const id: string | undefined = result.identifiers?.[0]?.id ?? result.raw?.[0]?.id;
    if (id) {
      const job = await this.findById(id);
      if (job) return { job, inserted: true };
    }
    const existing = values.dedupeKey ? await this.findOpenByDedupe(values.dedupeKey) : null;
    if (!existing) {
      // Ignored for a reason other than the dedupe index, and nothing to point at. Should be
      // impossible (the id is generated); refusing is better than pretending it was accepted.
      throw new Error('The job could not be recorded.');
    }
    return { job: existing, inserted: false };
  }

  async setBullJobId(id: string, bullJobId: string): Promise<void> {
    await this.repo.update({ id }, { bullJobId });
  }

  /**
   * Move to RUNNING. From QUEUED on a first run; from RUNNING only when the row has gone STALE —
   * nothing has touched it for `RECLAIM_AFTER_MS`, so its worker is gone (a live run heartbeats
   * every 20 s). Null when the row has left both, or is RUNNING and still being worked.
   *
   * It used to re-claim any RUNNING row. Bull redelivers a job whose lock lapsed (a long
   * synchronous stretch blocks lock renewal), and that redelivery re-claimed and re-ran a job whose
   * first handler was still running — two runs of one job, side by side.
   */
  async claim(id: string, exclusiveKey: string | null): Promise<BackgroundJobEntity | null> {
    try {
      const result = await this.repo
        .createQueryBuilder()
        .update(BackgroundJobEntity)
        .set({
          status: 'RUNNING',
          exclusiveKey,
          attempts: () => 'attempts + 1',
          startedAt: () => 'COALESCE(started_at, now())',
          error: null,
        } as any)
        .where(
          `id = :id AND (status = 'QUEUED' OR (status = 'RUNNING' AND updated_at < now() - make_interval(secs => :staleSecs)))`,
          { id, staleSecs: RECLAIM_AFTER_MS / 1000 },
        )
        .execute();
      if (!result.affected) return null;
    } catch (err) {
      if (isUniqueViolation(err, 'uq_background_jobs_exclusive_running')) throw new ExclusiveSlotBusyError();
      throw err;
    }
    return this.findById(id);
  }

  /** Conditional transition. Null when the row was no longer in any of `from`. */
  async transition(
    id: string,
    from: BackgroundJobStatus[],
    patch: Partial<BackgroundJobEntity>,
  ): Promise<BackgroundJobEntity | null> {
    const result = await this.repo.update({ id, status: In(from) }, patch as any);
    if (!result.affected) return null;
    return this.findById(id);
  }

  /** Progress is only ever written onto a RUNNING row, so a late write cannot repaint a finished one. */
  async writeProgress(id: string, progress: BackgroundJobProgress): Promise<boolean> {
    const result = await this.repo.update({ id, status: 'RUNNING' }, { progress } as any);
    return !!result.affected;
  }

  /** Heartbeat: bump `updated_at` on a RUNNING row, so it never reads as abandoned while worked. */
  async touch(id: string): Promise<void> {
    await this.repo
      .createQueryBuilder()
      .update(BackgroundJobEntity)
      .set({ updatedAt: () => 'now()' } as any)
      .where('id = :id AND status = :running', { id, running: 'RUNNING' })
      .execute();
  }

  async patch(id: string, patch: Partial<BackgroundJobEntity>): Promise<void> {
    await this.repo.update({ id }, patch as any);
  }

  /** Flag a RUNNING job to stop. The worker reads it between chunks. */
  async requestCancel(id: string, by: string): Promise<BackgroundJobEntity | null> {
    return this.transition(id, ['RUNNING'], { cancelRequestedAt: new Date(), cancelRequestedBy: by });
  }

  async cancelRequestedAt(id: string): Promise<Date | null> {
    const row = await this.repo.findOne({ where: { id }, select: { id: true, cancelRequestedAt: true } });
    return row?.cancelRequestedAt ?? null;
  }

  async list(filter: JobListFilter): Promise<BackgroundJobEntity[]> {
    const qb = this.repo
      .createQueryBuilder('j')
      .where('j.status IN (:...statuses)', { statuses: filter.statuses });
    if (filter.requestedBy) qb.andWhere('j.requested_by = :requestedBy', { requestedBy: filter.requestedBy });
    if (filter.withinRegions !== undefined && filter.withinRegions !== null) {
      // `cardinality > 0`: an EMPTY array is contained in every array, so `'{}' <@ :regions` listed a
      // job with no captured regions to every regional administrator — while `isVisibleTo`, which
      // guards opening it, refused them. The list and the gate must give one answer.
      qb.andWhere('j.regions IS NOT NULL AND cardinality(j.regions) > 0 AND j.regions <@ CAST(:regions AS text[])', { regions: filter.withinRegions });
    }
    if (filter.organizationId) qb.andWhere('j.organization_id = :org', { org: filter.organizationId });
    if (filter.kind) qb.andWhere('j.kind = :kind', { kind: filter.kind });
    if (filter.scopeType) qb.andWhere('j.scope_type = :scopeType', { scopeType: filter.scopeType });
    if (filter.scopeId) qb.andWhere('j.scope_id = :scopeId', { scopeId: filter.scopeId });
    if (filter.finishedAfter) qb.andWhere('j.finished_at > :after', { after: filter.finishedAfter });
    return qb
      .orderBy('j.createdAt', 'DESC')
      .take(filter.limit)
      .getMany();
  }

  /** Open rows not touched for `idleMs` — what the recovery sweep reconciles against Bull. */
  async findStaleOpen(idleMs: number, limit = 200): Promise<BackgroundJobEntity[]> {
    return this.repo
      .createQueryBuilder('j')
      .where('j.status IN (:...statuses)', { statuses: ['QUEUED', 'RUNNING'] })
      .andWhere('j.updated_at < :before', { before: new Date(Date.now() - idleMs) })
      .orderBy('j.updatedAt', 'ASC')
      .take(limit)
      .getMany();
  }
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (!(err instanceof QueryFailedError)) {
    const code = (err as { code?: string } | null)?.code;
    if (code !== '23505') return false;
    return !constraint || (err as { constraint?: string }).constraint === constraint;
  }
  const driver = (err as QueryFailedError & { driverError?: { code?: string; constraint?: string } }).driverError;
  if (driver?.code !== '23505') return false;
  return !constraint || driver.constraint === constraint;
}
