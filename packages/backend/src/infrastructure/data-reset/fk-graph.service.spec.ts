import { DataSource } from 'typeorm';
import { cascadeClosure, restrictConflicts, setNullEffects, topologicalOrder, FkEdge, FkGraphService } from './fk-graph.service';

/**
 * A small fabricated graph, not the live schema — these three functions are pure and the cases
 * that matter (a RESTRICT edge, a SET NULL edge, a multi-level cascade) are cheaper and clearer to
 * construct by hand than to find inside the real ~70-edge graph. The live graph itself is only
 * ever read, never asserted against in a unit test — see the integration note at the bottom.
 */
const EDGES: FkEdge[] = [
  { child: 'branches', column: 'client_id', parent: 'clients', onDelete: 'SET NULL' },
  { child: 'project_branches', column: 'branch_id', parent: 'branches', onDelete: 'CASCADE' },
  { child: 'documents', column: 'project_branch_id', parent: 'project_branches', onDelete: 'CASCADE' },
  { child: 'assignments', column: 'project_branch_id', parent: 'project_branches', onDelete: 'CASCADE' },
  { child: 'billing_entries', column: 'client_id', parent: 'clients', onDelete: 'RESTRICT' },
];

describe('cascadeClosure', () => {
  it('follows CASCADE edges transitively', () => {
    const closure = cascadeClosure(new Set(['branches']), EDGES);
    expect(closure).toEqual(new Set(['branches', 'project_branches', 'documents', 'assignments']));
  });

  it('does not follow a SET NULL or RESTRICT edge', () => {
    const closure = cascadeClosure(new Set(['clients']), EDGES);
    // branches (SET NULL) and billing_entries (RESTRICT) keep their rows, so neither table — nor
    // anything cascading from branches — is in the closure of deleting `clients` alone.
    expect(closure).toEqual(new Set(['clients']));
  });
});

describe('restrictConflicts', () => {
  it('flags a RESTRICT child left out of the impacted set', () => {
    const impacted = cascadeClosure(new Set(['clients']), EDGES);
    const conflicts = restrictConflicts(impacted, EDGES);
    expect(conflicts).toEqual([
      { child: 'billing_entries', column: 'client_id', parent: 'clients', onDelete: 'RESTRICT' },
    ]);
  });

  it('does not flag a SET NULL child — that is a warning, not a hard block', () => {
    const impacted = cascadeClosure(new Set(['clients']), EDGES);
    const conflicts = restrictConflicts(impacted, EDGES);
    expect(conflicts.some((c) => c.child === 'branches')).toBe(false);
  });

  it('reports nothing once the RESTRICT child is included', () => {
    const impacted = cascadeClosure(new Set(['clients', 'billing_entries']), EDGES);
    const conflicts = restrictConflicts(impacted, EDGES);
    expect(conflicts).toEqual([]);
  });
});

describe('setNullEffects', () => {
  it('flags a SET NULL child left out of the impacted set, as a non-blocking side effect', () => {
    const impacted = cascadeClosure(new Set(['clients']), EDGES);
    const effects = setNullEffects(impacted, EDGES);
    expect(effects).toEqual([
      { child: 'branches', column: 'client_id', parent: 'clients', onDelete: 'SET NULL' },
    ]);
  });

  it('reports nothing once the SET NULL child is also selected', () => {
    const impacted = cascadeClosure(new Set(['clients', 'branches']), EDGES);
    expect(setNullEffects(impacted, EDGES)).toEqual([]);
  });
});

describe('topologicalOrder', () => {
  it('orders children before their parents', () => {
    const tables = cascadeClosure(new Set(['branches']), EDGES);
    const order = topologicalOrder(tables, EDGES);

    expect(order.indexOf('documents')).toBeLessThan(order.indexOf('project_branches'));
    expect(order.indexOf('assignments')).toBeLessThan(order.indexOf('project_branches'));
    expect(order.indexOf('project_branches')).toBeLessThan(order.indexOf('branches'));
  });

  it('ignores edges pointing outside the given table set', () => {
    // clients isn't in `tables`, so the branches->clients SET NULL edge must not block ordering.
    const order = topologicalOrder(new Set(['branches', 'project_branches']), EDGES);
    expect(order).toEqual(['project_branches', 'branches']);
  });

  it('throws on a genuine cycle rather than guessing an order', () => {
    const cyclic: FkEdge[] = [
      { child: 'a', column: 'b_id', parent: 'b', onDelete: 'CASCADE' },
      { child: 'b', column: 'a_id', parent: 'a', onDelete: 'CASCADE' },
    ];
    expect(() => topologicalOrder(new Set(['a', 'b']), cyclic)).toThrow(/cycle/i);
  });
});

/**
 * WHERE THE GRAPH IS READ FROM, WHICH IS NOT A DETAIL.
 *
 * `loadEdges` used to query `information_schema`, whose views only show constraints on tables the
 * connected user OWNS. Since the role split the API connects as `fapoms_runtime`, which owns
 * nothing, so it read 0 of the database's 89 foreign keys and said so to nobody: the preview
 * reported no cascades and no blockers, and a wipe then deleted tables in an arbitrary order until
 * Postgres refused one. These are the two properties that stop that happening again — the source
 * it reads, and its refusal to treat "no edges" as "no constraints".
 */
describe('FkGraphService.loadEdges', () => {
  const serviceWith = (rows: unknown[]) => {
    const query = jest.fn().mockResolvedValue(rows);
    return { service: new FkGraphService({ query } as unknown as DataSource), query };
  };

  it('reads pg_catalog, never the ownership-gated information_schema views', async () => {
    const { service, query } = serviceWith([
      { child: 'billing_entries', column: 'assignment_id', parent: 'assignments', on_delete: 'RESTRICT' },
    ]);
    await service.loadEdges();
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toMatch(/pg_constraint/);
    expect(sql).not.toMatch(/information_schema/);
  });

  it('refuses rather than reporting a database with no foreign keys', async () => {
    const { service } = serviceWith([]);
    await expect(service.loadEdges()).rejects.toThrow(/no foreign keys/i);
  });

  it('carries each delete rule through as the closure and conflict checks expect it', async () => {
    const { service } = serviceWith([
      { child: 'project_branches', column: 'branch_id', parent: 'branches', on_delete: 'CASCADE' },
      { child: 'billing_entries', column: 'assignment_id', parent: 'assignments', on_delete: 'RESTRICT' },
      { child: 'branches', column: 'client_id', parent: 'clients', on_delete: 'SET NULL' },
    ]);
    const edges = await service.loadEdges();

    expect(edges).toEqual([
      { child: 'project_branches', column: 'branch_id', parent: 'branches', onDelete: 'CASCADE' },
      { child: 'billing_entries', column: 'assignment_id', parent: 'assignments', onDelete: 'RESTRICT' },
      { child: 'branches', column: 'client_id', parent: 'clients', onDelete: 'SET NULL' },
    ]);
    // The wipe that failed: assignments selected without billing must be refused, not attempted.
    expect(restrictConflicts(new Set(['assignments']), edges)).toEqual([
      { child: 'billing_entries', column: 'assignment_id', parent: 'assignments', onDelete: 'RESTRICT' },
    ]);
    // And with both selected, the child has to be deleted first.
    const order = topologicalOrder(new Set(['assignments', 'billing_entries']), edges);
    expect(order).toEqual(['billing_entries', 'assignments']);
  });
});
