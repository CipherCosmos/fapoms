import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { CacheService } from '../../infrastructure/cache/cache.service';
import { AuditEventEntity } from './audit-event.entity';
import { AuditChainEntity } from './audit-chain.entity';
import {
  GENESIS_HASH,
  computeRowHash,
  type SealableEvent,
} from './hash-chain';

/** A Postgres advisory-lock key, arbitrary but fixed, that serialises the sealer cluster-wide. */
const SEAL_ADVISORY_LOCK_KEY = 771_020_1;

export interface SealResult {
  sealed: number;
  /** True when the pass stopped at its batch ceiling with more still unsealed. */
  more: boolean;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  /** When ok is false, the chain position where verification first failed, and why. */
  brokenAtSeq?: string;
  reason?: 'CONTENT_ALTERED' | 'LINK_BROKEN' | 'EVENT_MISSING';
  /** True when verification stopped at `limit` before reaching the chain head. */
  truncated?: boolean;
}

/**
 * Seals audit events into the `audit_chain` hash chain, and verifies it.
 *
 * ## Sealing
 * A single-writer pass: it finds audit events that have no chain row yet, in a stable order
 * (occurred_at, then id), and appends one chain row per event, each hashing the previous row's hash
 * with the event's canonical content. Two guards make "single writer" true even in a cluster: the
 * Redis lock stops two replicas running the pass at once, and a Postgres advisory lock inside the
 * transaction is the backstop for the moment the Redis lock fails open (Redis down). Without a
 * single writer, two passes could each read the same chain tail and fork it.
 *
 * Events are sealed shortly AFTER they are written, not in the same transaction — so recording an
 * audit event never waits on a chain lock, and the write path keeps its atomicity with the business
 * change. The cost is a small sealing lag; an event is verifiable once sealed, and "unsealed events
 * exist" is itself a monitorable signal.
 *
 * ## Verification
 * Walks the chain from the genesis in seq order, recomputing each hash from the joined event and the
 * running previous hash. Any altered event content, any broken link (a deleted or reordered row), or
 * any missing event surfaces as the first failing seq — which is exactly the evidence a bank/RBI
 * audit asks for: not just "is it append-only" but "prove it was not rewritten".
 */
@Injectable()
export class AuditSealService {
  private readonly logger = new Logger(AuditSealService.name);

  /** How many events one sealing pass appends. Bounds the lock hold and WAL per tick. */
  private static readonly SEAL_BATCH = 2_000;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly cache: CacheService,
  ) {}

  /**
   * Append up to one batch of unsealed events to the chain. Cluster-safe and idempotent: if nothing
   * is unsealed it does nothing. Returns how many it sealed and whether more remain.
   */
  async sealPending(): Promise<SealResult> {
    return this.cache.withLock('lock:audit:seal', 120, () => this.sealOnce(), { retries: 0 });
  }

  private async sealOnce(): Promise<SealResult> {
    return this.dataSource.transaction(async (manager) => {
      // DB-level single-writer backstop: held to commit, so a second pass (e.g. after the Redis
      // lock failed open) waits here rather than forking the chain.
      await manager.query('SELECT pg_advisory_xact_lock($1)', [SEAL_ADVISORY_LOCK_KEY]);

      const tail = await manager
        .getRepository(AuditChainEntity)
        .createQueryBuilder('c')
        .select('c.row_hash', 'rowHash')
        .orderBy('c.seq', 'DESC')
        .limit(1)
        .getRawOne<{ rowHash: string }>();
      let prevHash = tail?.rowHash ?? GENESIS_HASH;

      // Events with no chain row yet, oldest first. LEFT JOIN … IS NULL is the "not yet sealed" set.
      const unsealed = await manager
        .getRepository(AuditEventEntity)
        .createQueryBuilder('e')
        .leftJoin(AuditChainEntity, 'c', 'c.audit_event_id = e.id')
        .where('c.seq IS NULL')
        .orderBy('e.occurred_at', 'ASC')
        .addOrderBy('e.id', 'ASC')
        .limit(AuditSealService.SEAL_BATCH)
        .getMany();

      if (unsealed.length === 0) return { sealed: 0, more: false };

      const chainRepo = manager.getRepository(AuditChainEntity);
      for (const event of unsealed) {
        const rowHash = computeRowHash(prevHash, this.toSealable(event));
        await chainRepo.insert({ auditEventId: event.id, prevHash, rowHash });
        prevHash = rowHash;
      }

      const more = unsealed.length === AuditSealService.SEAL_BATCH;
      this.logger.log(`Sealed ${unsealed.length} audit event(s) into the chain${more ? ' (more pending)' : ''}.`);
      return { sealed: unsealed.length, more };
    });
  }

  /**
   * Verify the chain from genesis. Reads chain rows in seq order joined to their events and
   * recomputes the hashes; the first divergence is reported with its cause.
   *
   * `limit` caps how far one call walks — a full re-verification of a very large chain is a heavy,
   * deliberate admin action, so the endpoint can page through it; `truncated` says the head was not
   * reached.
   */
  async verify(limit = 100_000): Promise<VerifyResult> {
    // One page of the chain in order, plus one extra to detect that more remains.
    const chainRows = await this.dataSource
      .getRepository(AuditChainEntity)
      .find({ order: { seq: 'ASC' }, take: limit + 1 });

    const truncated = chainRows.length > limit;
    const window = truncated ? chainRows.slice(0, limit) : chainRows;
    if (window.length === 0) return { ok: true, checked: 0 };

    // The events these chain rows seal, fetched once and indexed by id — the audit_events trigger
    // forbids deletion, so a missing one is itself evidence of tampering, handled below.
    const events = await this.dataSource
      .getRepository(AuditEventEntity)
      .find({ where: { id: In(window.map((c) => c.auditEventId)) } });
    const byId = new Map(events.map((e) => [e.id, e]));

    let expectedPrev = GENESIS_HASH;
    let checked = 0;
    for (const row of window) {
      const event = byId.get(row.auditEventId);
      if (!event) {
        return { ok: false, checked, brokenAtSeq: String(row.seq), reason: 'EVENT_MISSING' };
      }
      if (row.prevHash !== expectedPrev) {
        return { ok: false, checked, brokenAtSeq: String(row.seq), reason: 'LINK_BROKEN' };
      }
      if (computeRowHash(expectedPrev, this.toSealable(event)) !== row.rowHash) {
        return { ok: false, checked, brokenAtSeq: String(row.seq), reason: 'CONTENT_ALTERED' };
      }
      expectedPrev = row.rowHash;
      checked++;
    }
    return { ok: true, checked, truncated: truncated || undefined };
  }

  /** How many events are recorded but not yet sealed — a health signal for the sealer. */
  async unsealedCount(): Promise<number> {
    return this.dataSource
      .getRepository(AuditEventEntity)
      .createQueryBuilder('e')
      .leftJoin(AuditChainEntity, 'c', 'c.audit_event_id = e.id')
      .where('c.seq IS NULL')
      .getCount();
  }

  private toSealable(e: AuditEventEntity): SealableEvent {
    return {
      id: e.id,
      category: e.category,
      eventType: e.eventType,
      entityType: e.entityType,
      entityId: e.entityId,
      previousState: e.previousState,
      newState: e.newState,
      userId: e.userId,
      userDisplayName: e.userDisplayName,
      ipAddress: e.ipAddress,
      actorRole: e.actorRole,
      userAgent: e.userAgent,
      sessionId: e.sessionId,
      requestId: e.requestId,
      outcome: e.outcome,
      remarks: e.remarks,
      metadata: e.metadata,
      before: e.before,
      after: e.after,
      occurredAt: e.occurredAt,
    };
  }
}
