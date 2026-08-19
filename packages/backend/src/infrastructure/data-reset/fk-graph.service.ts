import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** One foreign key: `child.column` references `parent`'s primary key. */
export interface FkEdge {
  child: string;
  column: string;
  parent: string;
  onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';
}

/**
 * Reads the FK graph from Postgres itself rather than hand-transcribing the ~70 constraints in
 * `1784000000000-BaselineSchema.ts` into a parallel static file. A copy drifts the moment a later
 * migration adds or changes a constraint and nobody remembers the second place to update it; a
 * live query cannot drift, because it *is* the schema being asked about. `cascadeClosure`,
 * `restrictConflicts` and `setNullEffects` below are exactly the checks that must never run
 * against a stale picture of what cascades, blocks, or nulls — that's the whole safety property
 * this module exists for.
 */
@Injectable()
export class FkGraphService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async loadEdges(): Promise<FkEdge[]> {
    const rows: Array<{ child: string; column: string; parent: string; on_delete: string }> =
      await this.dataSource.query(`
        SELECT
          tc.table_name       AS child,
          kcu.column_name     AS column,
          ccu.table_name      AS parent,
          rc.delete_rule      AS on_delete
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
        JOIN information_schema.referential_constraints rc
          ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
        JOIN information_schema.constraint_column_usage ccu
          ON ccu.constraint_name = rc.unique_constraint_name AND ccu.table_schema = tc.table_schema
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      `);

    return rows.map((r) => ({
      child: r.child,
      column: r.column,
      parent: r.parent,
      onDelete: (r.on_delete || 'NO ACTION').toUpperCase() as FkEdge['onDelete'],
    }));
  }
}

/**
 * Every table that will actually lose rows if `roots` are cleared — `roots` themselves plus a BFS
 * over `ON DELETE CASCADE` edges. Non-cascade edges (`SET NULL`, `RESTRICT`, `NO ACTION`) do not
 * propagate the closure: a `SET NULL` child keeps its rows (with the FK column nulled), and a
 * `RESTRICT`/`NO ACTION` child blocks the delete rather than following it — see
 * `restrictConflicts`.
 */
export function cascadeClosure(roots: Set<string>, edges: FkEdge[]): Set<string> {
  const closure = new Set(roots);
  const cascadeByParent = new Map<string, string[]>();
  for (const e of edges) {
    if (e.onDelete !== 'CASCADE') continue;
    const list = cascadeByParent.get(e.parent) ?? [];
    list.push(e.child);
    cascadeByParent.set(e.parent, list);
  }

  const queue = [...roots];
  while (queue.length > 0) {
    const table = queue.shift()!;
    for (const child of cascadeByParent.get(table) ?? []) {
      if (closure.has(child)) continue;
      closure.add(child);
      queue.push(child);
    }
  }
  return closure;
}

/**
 * Edges that will make Postgres outright refuse the delete: the parent is inside `impactedTables`
 * (selected or cascade-reached), the child is not, and the child's delete rule is `RESTRICT` or
 * `NO ACTION` — a live row in `child` referencing a deleted `parent` row is exactly what those
 * rules exist to prevent. This is a hard blocker: the admin must also select the child's domain
 * (or the operation cannot proceed at all), which is why `execute()` treats a non-empty result
 * here as a 409, not a warning.
 */
export function restrictConflicts(impactedTables: Set<string>, edges: FkEdge[]): FkEdge[] {
  return edges.filter(
    (e) =>
      (e.onDelete === 'RESTRICT' || e.onDelete === 'NO ACTION') &&
      impactedTables.has(e.parent) &&
      !impactedTables.has(e.child),
  );
}

/**
 * `SET NULL` edges out of `impactedTables` into a table nobody selected. Unlike `restrictConflicts`
 * these do NOT block the delete — Postgres just nulls the referencing column — but they're a real
 * side effect worth telling the admin about (e.g. "wiping Clients will clear the client on 40
 * branches that are otherwise untouched"), so they're surfaced in the preview separately rather
 * than folded into the hard-conflict list.
 */
export function setNullEffects(impactedTables: Set<string>, edges: FkEdge[]): FkEdge[] {
  return edges.filter(
    (e) => e.onDelete === 'SET NULL' && impactedTables.has(e.parent) && !impactedTables.has(e.child),
  );
}

/**
 * Children before parents, restricted to `tables` — the order a sequence of DELETEs must run in
 * for `tables` to be internally self-contained. Kahn's algorithm over every edge that lies
 * entirely within `tables`, regardless of its own delete rule: once execution has decided to
 * delete both ends of an edge, the child must go first no matter whether Postgres itself would
 * have cascaded, nulled, or restricted that edge on a plain DELETE. An edge to a table outside the
 * set isn't this function's problem — see `restrictConflicts`/`setNullEffects`, which is what
 * catches that case before execution ever reaches this ordering step.
 */
export function topologicalOrder(tables: Set<string>, edges: FkEdge[]): string[] {
  const inTables = (t: string) => tables.has(t);
  const remainingDeps = new Map<string, Set<string>>(); // table -> set of child tables that must be deleted before it

  for (const t of tables) remainingDeps.set(t, new Set());
  for (const e of edges) {
    if (!inTables(e.child) || !inTables(e.parent) || e.parent === e.child) continue;
    // A row in `parent` cannot be deleted while a row in `child` still references it (whatever
    // the delete rule) unless `child` is cleared first — so `parent` depends on `child`.
    remainingDeps.get(e.parent)!.add(e.child);
  }

  const order: string[] = [];
  const remaining = new Set(tables);
  while (remaining.size > 0) {
    let progressed = false;
    for (const t of [...remaining]) {
      const deps = remainingDeps.get(t)!;
      const unsatisfied = [...deps].some((d) => remaining.has(d));
      if (unsatisfied) continue;
      order.push(t);
      remaining.delete(t);
      progressed = true;
    }
    if (!progressed) {
      // A genuine cycle between selected tables. Postgres schemas in this app don't have one
      // (verified against the live graph in fk-graph.service.spec.ts), so this is a hard stop
      // rather than a silent best-effort order.
      throw new Error(
        `Cannot order tables for deletion — a cycle exists among: ${[...remaining].join(', ')}.`,
      );
    }
  }
  return order;
}
