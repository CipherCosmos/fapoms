import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { EventCategory } from '@fapoms/shared';

import { AuditService } from '../../core/audit/audit.service';
import { NOT_A_RECORD_ENTITY_ID } from '../../core/audit/audit-event';
import { rowsAffected } from '../retention/retention.service';
import { FkGraphService, FkEdge, cascadeClosure, restrictConflicts, setNullEffects, topologicalOrder } from './fk-graph.service';
import { WIPE_DOMAINS, WipeDomain, NEVER_WIPEABLE_TABLES, findDomain, tableToDomain } from './wipe-domains.registry';
import { BackupOnDemandService, OnDemandBackup } from './backup-on-demand.service';

/**
 * Tables the `users` domain lists that must be deleted scoped to the accounts being removed
 * rather than wholesale — they have no enforced FK to `users` (verified against the live schema),
 * so nothing cascades them automatically the way `notifications` does.
 */
const USER_SCOPED_TABLES = new Set(['device_tokens', 'refresh_tokens']);

/**
 * The audit entry's `entity_id` for a wipe: this event is about the database as a whole rather
 * than one record, so there is no real id to name.
 *
 * Found the hard way — this was the literal string `'ALL'`, which Postgres rejected against the
 * `uuid NOT NULL` column, which rolled back the entire wipe. That rollback is the design working
 * (see the `recordEvent` call below — deliberately unguarded), but the value still had to be one
 * the column accepts. The nil-UUID sentinel that fixed it now lives in the audit module as
 * `NOT_A_RECORD_ENTITY_ID`, because three other call sites hit the same wall and, unlike this
 * one, swallowed the failure — so their trails were simply empty. The alias is kept for the name
 * it gives the value where a wipe is recorded.
 */
const WHOLE_DATABASE_ENTITY_ID = NOT_A_RECORD_ENTITY_ID;

export interface DomainSummary extends WipeDomain {
  counts: Record<string, number>;
}

export interface RestrictConflictDetail extends FkEdge {
  /** Rows in `child` that actually reference a row about to be deleted from `parent` — scoped to
   *  the real conflict, not the child table's total size. */
  affectedRowCount: number;
}

export interface SetNullEffectDetail extends FkEdge {
  affectedRowCount: number;
}

export interface PreviewResult {
  selectedDomains: string[];
  impactedTables: string[];
  /** Domains touched only as a cascade side effect of what was selected — must also be selected
   *  (or the selection changed) before execute() will proceed. */
  impliedDomains: string[];
  /** Hard blockers: Postgres will refuse the delete until these are resolved. */
  restrictConflicts: RestrictConflictDetail[];
  /** Non-blocking: rows that will have a reference nulled rather than being deleted themselves. */
  setNullEffects: SetNullEffectDetail[];
  counts: Record<string, number>;
}

export interface ExecuteInput {
  domainKeys: string[];
  /** Always includes the caller's own id — the controller enforces that before this is called. */
  keepUserIds: string[];
  billingConfirmed?: boolean;
  actorUserId: string;
  backup?: OnDemandBackup | null;
}

export interface ExecuteResult {
  removed: Record<string, number>;
  backup: OnDemandBackup | null;
}

@Injectable()
export class DataResetService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly fkGraph: FkGraphService,
    private readonly audit: AuditService,
    private readonly backup: BackupOnDemandService,
  ) {}

  async describeDomains(): Promise<{ domains: DomainSummary[] }> {
    const allTables = [...new Set(WIPE_DOMAINS.flatMap((d) => d.tables))];
    const counts = await this.countTables(allTables);
    return {
      domains: WIPE_DOMAINS.map((d) => ({
        ...d,
        counts: Object.fromEntries(d.tables.map((t) => [t, counts[t] ?? 0])),
      })),
    };
  }

  async preview(domainKeys: string[]): Promise<PreviewResult> {
    const domains = this.resolveDomains(domainKeys);
    const selectedTables = new Set(domains.flatMap((d) => d.tables));
    const edges = await this.fkGraph.loadEdges();
    const impacted = cascadeClosure(selectedTables, edges);

    this.assertNeverTouchesProtectedTables(impacted);

    const owner = tableToDomain();
    const impliedDomains = [
      ...new Set(
        [...impacted]
          .filter((t) => !selectedTables.has(t))
          .map((t) => owner.get(t))
          .filter((d): d is string => !!d),
      ),
    ];

    const conflicts = restrictConflicts(impacted, edges);
    const nullEffects = setNullEffects(impacted, edges);

    const [conflictDetails, nullEffectDetails, counts] = await Promise.all([
      this.withAffectedRowCounts(conflicts),
      this.withAffectedRowCounts(nullEffects),
      this.countTables([...impacted]),
    ]);

    return {
      selectedDomains: domainKeys,
      impactedTables: [...impacted],
      impliedDomains,
      restrictConflicts: conflictDetails,
      setNullEffects: nullEffectDetails,
      counts,
    };
  }

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const domains = this.resolveDomains(input.domainKeys);
    const selectedTables = new Set(domains.flatMap((d) => d.tables));
    const edges = await this.fkGraph.loadEdges();
    const impacted = cascadeClosure(selectedTables, edges);

    this.assertNeverTouchesProtectedTables(impacted);

    const conflicts = restrictConflicts(impacted, edges);
    if (conflicts.length > 0) {
      throw new ConflictException({
        message: 'This selection cannot be wiped as-is — some data is protected by the database until its dependents are cleared too.',
        restrictConflicts: conflicts,
      });
    }

    const owner = tableToDomain();
    const impliedDomains = [
      ...new Set(
        [...impacted]
          .filter((t) => !selectedTables.has(t))
          .map((t) => owner.get(t))
          .filter((d): d is string => !!d),
      ),
    ];
    if (impliedDomains.length > 0) {
      throw new ConflictException({
        message: 'This selection would also clear data from domains not selected — select them explicitly, or narrow the selection.',
        impliedDomains,
      });
    }

    if (domains.some((d) => d.requiresBillingConfirmation) && !input.billingConfirmed) {
      throw new ConflictException('Billing data is selected but its extra confirmation was not given.');
    }

    const preCounts = await this.countTables([...impacted]);
    /**
     * Only the tables a selected domain explicitly lists — deliberately NOT the cascade closure.
     *
     * A cascade-reached table is in `impacted` so the preview can report it, but it must not be
     * deleted from directly here: Postgres's own `ON DELETE CASCADE` already removes exactly the
     * child rows belonging to the parent rows that actually went, and that is the only thing that
     * respects a scoped parent delete.
     *
     * Getting this wrong was not hypothetical. Iterating the closure meant `user_roles` — pulled
     * in by its CASCADE from `users` — got a blanket `DELETE FROM "user_roles"`, which stripped
     * the roles off the *kept* accounts too. A wipe with a keep-list left the surviving admin
     * logged in and holding no permissions: exactly the lock-yourself-out failure this feature is
     * supposed to make impossible.
     */
    const order = topologicalOrder(selectedTables, edges);
    const keepIds = [...new Set(input.keepUserIds)];
    let removed: Record<string, number> = {};

    await this.dataSource.transaction('READ COMMITTED', async (manager) => {
      for (const table of order) {
        if (table === 'users') {
          await manager.query(`DELETE FROM "users" WHERE id <> ALL($1::uuid[])`, [keepIds]);
        } else if (USER_SCOPED_TABLES.has(table)) {
          await manager.query(
            `DELETE FROM "${table}" WHERE user_id IN (SELECT id FROM "users" WHERE id <> ALL($1::uuid[]))`,
            [keepIds],
          );
        } else {
          await manager.query(`DELETE FROM "${table}"`);
        }
      }

      /**
       * Measured, not inferred. Counting every impacted table again inside the transaction is
       * what makes the report honest about rows that went via a database cascade rather than a
       * statement issued here — `rowsAffected` on the explicit DELETEs cannot see those at all.
       */
      const postCounts = await this.countTables([...impacted], manager);
      removed = Object.fromEntries(
        [...impacted]
          .map((t) => [t, (preCounts[t] ?? 0) - (postCounts[t] ?? 0)] as const)
          .filter(([, delta]) => delta > 0),
      );

      // Deliberately unguarded, unlike the `.catch(() => undefined)` audit writes elsewhere in
      // this codebase — this is the one action where "it happened but left no record" must be
      // structurally impossible, so a failed insert rolls the whole wipe back with it. That is
      // not theoretical: the `'ALL'` entityId bug above was caught precisely because this threw
      // and nothing was deleted, while the same bug at three swallowed call sites went unnoticed
      // for months.
      await this.audit.recordEvent(
        {
          category: EventCategory.SYSTEM,
          eventType: 'DATA_RESET_EXECUTED',
          entityType: 'DATABASE',
          entityId: WHOLE_DATABASE_ENTITY_ID,
          userId: input.actorUserId,
          remarks: `Wiped domains: ${input.domainKeys.join(', ')}.${keepIds.length ? ` Kept ${keepIds.length} user account(s).` : ''}`,
          metadata: {
            domainKeys: input.domainKeys,
            keepUserIds: keepIds,
            preCounts,
            removed,
            backup: input.backup ?? null,
          },
        },
        { manager },
      );
    });

    return { removed, backup: input.backup ?? null };
  }

  // ---------------------------------------------------------------------------------------------

  private resolveDomains(domainKeys: string[]): WipeDomain[] {
    if (!domainKeys || domainKeys.length === 0) {
      throw new NotFoundException('Select at least one domain.');
    }
    return domainKeys.map((key) => {
      const domain = findDomain(key);
      if (!domain) throw new NotFoundException(`Unknown domain "${key}".`);
      return domain;
    });
  }

  /**
   * A defensive backstop, not the primary guard (that's `WIPE_DOMAINS` simply never listing these
   * tables). If a future migration ever added a CASCADE edge from a wipeable table into
   * `audit_events`/`workflow_history`/`outbox_events` — a schema mistake in itself — this is what
   * stops it from being truncated as a silent side effect instead of failing loudly here.
   */
  private assertNeverTouchesProtectedTables(impacted: Set<string>): void {
    const hit = NEVER_WIPEABLE_TABLES.filter((t) => impacted.has(t));
    if (hit.length > 0) {
      throw new ConflictException(
        `Refusing: this selection would reach permanently protected table(s): ${hit.join(', ')}.`,
      );
    }
  }

  /** Pass the transaction's `manager` to count what the open transaction can see; omit it to
   *  count committed state on a pooled connection. */
  private async countTables(tables: string[], manager?: EntityManager): Promise<Record<string, number>> {
    const runner = manager ?? this.dataSource;
    const entries = await Promise.all(
      tables.map(async (table) => {
        const rows = await runner.query(`SELECT COUNT(*)::int AS count FROM "${table}"`);
        return [table, rows[0]?.count ?? 0] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  private async withAffectedRowCounts<T extends FkEdge>(
    edges: T[],
  ): Promise<Array<T & { affectedRowCount: number }>> {
    return Promise.all(
      edges.map(async (edge) => {
        const rows = await this.dataSource.query(
          `SELECT COUNT(*)::int AS count FROM "${edge.child}" WHERE "${edge.column}" IN (SELECT id FROM "${edge.parent}")`,
        );
        return { ...edge, affectedRowCount: rows[0]?.count ?? 0 };
      }),
    );
  }
}
