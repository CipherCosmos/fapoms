/**
 * FAPOMS — Roster query service
 *
 * `AssayerService.findAll` loads a page and lets the roster screen filter it client-side, which
 * is fine for 1,000 rows and wrong for 11,000: a client filtering only what fits on one page
 * shows a subset of the truth and calls it the whole roster. This service builds the same
 * filters as a WHERE clause instead, so a filtered page reflects the whole table, not the page
 * that happened to load.
 *
 * Kept separate from `AssayerService` (owned by another change in flight) rather than folded
 * into `findAll` — a second entry point for the same table, built with `createQueryBuilder`
 * over `AssayerEntity` directly, so the two can land independently.
 */

import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { AssayerEntity } from './assayer.entity';
import type { GlobalScope } from '../../infrastructure/scope/global-scope';

/**
 * The filter catalogue, mirrored 1:1 against `ROSTER_FILTERS` in
 * `packages/frontend/src/pages/hr/roster-filters.ts`. Every entry here is a `field`-kind axis
 * from that file with a real column behind it; the `rule`-kind axes (payout-blocked, lapsed
 * certificate, etc.) and the qualification band stay client-side over the loaded page, because
 * they are computed rather than stored (qualification is scored on read — see
 * `qualification-score.service.ts` — and materialising it just to filter on it is its own
 * project, not a line item here).
 */
export interface RosterFilters {
  /** Free text against display_name/email/phone/assayer_code via the existing trigram indexes. */
  q?: string;
  state?: string[];
  region?: string[];
  lifecycleStatus?: string[];
  engagementType?: string[];
  unavailableReason?: string[];
  /** Empanelment standing against `assayer_client_empanelments.status`. */
  empanelmentStatus?: string[];
  /** Empanelment with one specific client. */
  empanelmentClientId?: string;
  joinedFrom?: string;
  joinedTo?: string;
}

export interface RosterPage {
  assayers: AssayerEntity[];
  total: number;
  /** Present only for the keyset path — the cursor to ask for the next page. */
  nextCursor?: string | null;
}

/** The slim row the typeahead and pickers actually need — never the 78-column record. */
export interface RosterSearchRow {
  id: string;
  assayerCode: string;
  displayName: string;
  state: string | null;
  lifecycleStatus: string;
  region: string | null;
}

const SEARCH_ROW_SELECT = [
  'a.id',
  'a.assayerCode',
  'a.displayName',
  'a.state',
  'a.lifecycleStatus',
  'a.region',
] as const;

@Injectable()
export class RosterQueryService {
  constructor(
    @InjectRepository(AssayerEntity)
    private readonly assayerRepository: Repository<AssayerEntity>,
  ) {}

  /** Base query every method here starts from: active roster, region-scoped exactly like `AssayerService.findAll`. */
  private baseQuery(scope?: Partial<GlobalScope>): SelectQueryBuilder<AssayerEntity> {
    const qb = this.assayerRepository.createQueryBuilder('a').where('a.isActive = true');
    if (scope?.regions?.length) {
      qb.andWhere('a.region IN (:...scopeRegions)', { scopeRegions: scope.regions });
    }
    return qb;
  }

  /** Apply every filter axis in `RosterFilters` that has a value. Shared by all three read paths below. */
  private applyFilters(qb: SelectQueryBuilder<AssayerEntity>, filters: RosterFilters): SelectQueryBuilder<AssayerEntity> {
    const f = filters ?? {};

    // ILIKE over the trigram-indexed columns — same columns the migration indexed for this
    // exact purpose, so this is the query planner's intended path, not a sequential scan.
    if (f.q && f.q.trim()) {
      qb.andWhere(
        '(a.displayName ILIKE :q OR a.email ILIKE :q OR a.phone ILIKE :q OR a.assayerCode ILIKE :q)',
        { q: `%${f.q.trim()}%` },
      );
    }
    if (f.state?.length) qb.andWhere('a.state IN (:...state)', { state: f.state });
    if (f.region?.length) qb.andWhere('a.region IN (:...region)', { region: f.region });
    if (f.lifecycleStatus?.length) {
      qb.andWhere('a.lifecycleStatus IN (:...lifecycleStatus)', { lifecycleStatus: f.lifecycleStatus });
    }
    if (f.engagementType?.length) {
      qb.andWhere('a.engagementType IN (:...engagementType)', { engagementType: f.engagementType });
    }
    if (f.unavailableReason?.length) {
      qb.andWhere('a.unavailableReason IN (:...unavailableReason)', { unavailableReason: f.unavailableReason });
    }
    if (f.joinedFrom) qb.andWhere('a.joiningDate >= :joinedFrom', { joinedFrom: f.joinedFrom });
    if (f.joinedTo) qb.andWhere('a.joiningDate <= :joinedTo', { joinedTo: f.joinedTo });

    // Empanelment axes need the join table; only touch it when asked for, so the common case
    // (no empanelment filter) stays a single-table query.
    if (f.empanelmentStatus?.length || f.empanelmentClientId) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM assayer_client_empanelments e
                  WHERE e.assayer_id = a.id AND e.is_active = true
                  ${f.empanelmentStatus?.length ? 'AND e.status IN (:...empanelmentStatus)' : ''}
                  ${f.empanelmentClientId ? 'AND e.client_id = :empanelmentClientId' : ''})`,
        {
          ...(f.empanelmentStatus?.length ? { empanelmentStatus: f.empanelmentStatus } : {}),
          ...(f.empanelmentClientId ? { empanelmentClientId: f.empanelmentClientId } : {}),
        },
      );
    }
    return qb;
  }

  /**
   * Offset page, filtered — the same `{ assayers, total }` shape `AssayerService.findAll`
   * returns, so the controller can keep composing it with `hydrateDocumentSummaries` etc.
   * unchanged. Ordered by `createdAt DESC, id DESC` — the tiebreaker matters once `after` (below)
   * needs a total order to resume from.
   */
  async findFiltered(
    filters: RosterFilters,
    page: number,
    limit: number,
    scope?: Partial<GlobalScope>,
  ): Promise<RosterPage> {
    const qb = this.applyFilters(this.baseQuery(scope), filters)
      .orderBy('a.createdAt', 'DESC')
      .addOrderBy('a.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    const [assayers, total] = await qb.getManyAndCount();
    return { assayers, total };
  }

  /**
   * Keyset page: `after` is `<createdAt ISO>_<id>` from the last row of the previous page.
   * Offset pagination re-scans and re-skips everything before the page on every request; at
   * 11k rows with filters that still match most of the table, page 9 of an offset query costs
   * as much as page 1 plus 8 pages of discarded rows. Keyset reads exactly the page it returns.
   *
   * No `total`/`totalPages` here — a keyset cursor doesn't need them and computing them would
   * cost the same full count this pagination exists to avoid paying on every page.
   */
  async findKeyset(
    filters: RosterFilters,
    after: string | undefined,
    limit: number,
    scope?: Partial<GlobalScope>,
  ): Promise<RosterPage> {
    const qb = this.applyFilters(this.baseQuery(scope), filters);

    if (after) {
      const [createdAtIso, id] = splitCursor(after);
      if (id) {
        /**
         * Compare against the cursor ROW, not the cursor STRING. The string's timestamp went
         * through JS `Date.toISOString()`, which keeps milliseconds — Postgres keeps
         * microseconds. On this roster that is not a rounding nicety: 1,155 of 1,163 rows share
         * one bulk-import timestamp (…03:01:16.139992), the string said …16.139, and
         * `created_at < '…139'` skipped the entire tie-group — keyset paging silently ended
         * after the first page for as long as this table has existed. The row-value subquery
         * reads the real microseconds back out of the table, so the equality arm actually fires.
         * The string timestamp survives only as the fallback for a cursor row deleted mid-walk.
         */
        qb.andWhere(
          `((a.createdAt, a.id) < (SELECT c.created_at, c.id FROM assayers c WHERE c.id = :cursorId)
            OR (NOT EXISTS (SELECT 1 FROM assayers c2 WHERE c2.id = :cursorId)
                AND a.createdAt < :cursorCreatedAt))`,
          { cursorId: id, cursorCreatedAt: createdAtIso ?? '1970-01-01T00:00:00Z' },
        );
      }
    }

    qb.orderBy('a.createdAt', 'DESC').addOrderBy('a.id', 'DESC').take(limit);
    const assayers = await qb.getMany();
    const last = assayers[assayers.length - 1];
    const nextCursor = assayers.length === limit && last ? makeCursor(last) : null;
    return { assayers, total: assayers.length, nextCursor };
  }

  /**
   * Typeahead: id, code, name, state, lifecycle, region — nothing a picker doesn't render, and
   * never a full `AssayerEntity` (banking columns, encrypted PAN/Aadhaar, the works). Capped at
   * 50 regardless of what's asked for; a dropdown showing more than that is not a typeahead.
   */
  async search(q: string, limit: number, scope?: Partial<GlobalScope>): Promise<RosterSearchRow[]> {
    const cappedLimit = Math.max(1, Math.min(limit || 20, 50));
    const qb = this.baseQuery(scope).select([...SEARCH_ROW_SELECT]);
    if (q && q.trim()) {
      qb.andWhere(
        '(a.displayName ILIKE :q OR a.email ILIKE :q OR a.phone ILIKE :q OR a.assayerCode ILIKE :q)',
        { q: `%${q.trim()}%` },
      );
    }
    qb.orderBy('a.displayName', 'ASC').take(cappedLimit);
    const rows = await qb.getRawMany();
    return rows.map((r) => ({
      id: r.a_id,
      assayerCode: r.a_assayerCode,
      displayName: r.a_displayName,
      state: r.a_state,
      lifecycleStatus: r.a_lifecycleStatus,
      region: r.a_region,
    }));
  }

  /**
   * Counts grouped by one axis, over the FULL filtered set (not the loaded window) — what the
   * roster's filter chips need to show "(1,203)" beside a value instead of a count that only
   * reflects whatever page happened to be on screen.
   *
   * One axis per call rather than every axis in one query: the axes don't share a GROUP BY, and
   * a screen typically only needs the counts for the filter panel it currently has open.
   */
  async countsByLifecycleStatus(filters: RosterFilters, scope?: Partial<GlobalScope>): Promise<Array<{ value: string; count: number }>> {
    const qb = this.applyFilters(this.baseQuery(scope), filters)
      .select('a.lifecycleStatus', 'value')
      .addSelect('COUNT(*)', 'count')
      .groupBy('a.lifecycleStatus');
    const rows = await qb.getRawMany();
    return rows.map((r) => ({ value: r.value, count: Number(r.count) }));
  }

  /**
   * Total matching the current filters, for the roster header ("11,203 people") and for the
   * export dialog's "you're about to export N rows" line — the loaded-window count was never
   * that number once filtering moved server-side.
   */
  async count(filters: RosterFilters, scope?: Partial<GlobalScope>): Promise<number> {
    return this.applyFilters(this.baseQuery(scope), filters).getCount();
  }

  /**
   * Stream matching rows in chunks, for the export route. Keyset under the hood (see
   * `findKeyset`) so a 50,000-row export never holds an offset-scanned tail in memory or in the
   * database's temp files — the caller asks for 500 at a time and writes each chunk out before
   * asking for the next.
   */
  async *streamChunks(filters: RosterFilters, chunkSize: number, scope?: Partial<GlobalScope>): AsyncGenerator<AssayerEntity[]> {
    let cursor: string | undefined;
    for (;;) {
      const { assayers, nextCursor } = await this.findKeyset(filters, cursor, chunkSize, scope);
      if (assayers.length === 0) return;
      yield assayers;
      if (!nextCursor) return;
      cursor = nextCursor;
    }
  }
}

function makeCursor(row: AssayerEntity): string {
  const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt);
  return `${createdAt}_${row.id}`;
}

/**
 * The keyset cursor for a row, for the ONE caller outside this service that must mint one: the
 * controller's unfiltered first page. That page comes from `AssayerService.findAll` (offset
 * query), and until 2026-09-05 its meta carried no `nextCursor` at all — so every "fetch it
 * all" walker stopped at page one, quietly re-capping the roster at 1,000 and leaving the Pay
 * screen's shortfall banner permanently lit. Exported as the same encoding `findKeyset` reads,
 * from the same file, so the mint and the parse cannot drift apart.
 */
export function rosterCursorFor(row: AssayerEntity): string {
  return makeCursor(row);
}

function splitCursor(cursor: string): [string | undefined, string | undefined] {
  const idx = cursor.lastIndexOf('_');
  if (idx <= 0) return [undefined, undefined];
  return [cursor.slice(0, idx), cursor.slice(idx + 1)];
}
