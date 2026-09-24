/**
 * Permissions that are useless without another one, and the role editor adds for you.
 *
 * `BILLING:FINAL_APPROVE` (the HOD's final approval, 2026-09-24) is used on the Billing page, and
 * the Billing page — like every read behind it — needs `BILLING:VIEW`. A custom "HOD" role built
 * with only the final approval could not open the page its notifications link to. Rather than a
 * warning somebody has to read, ticking the approval ticks the view it depends on.
 *
 * Only ever ADDS: unticking the view leaves the approval alone, and the editor says why the view
 * came back if the approval is still ticked.
 */

interface PermissionKeyed { id: string; resource: string; action: string; scope: string }

/** `needs[k]` = the permissions a holder of `k` must also hold. Keys are RESOURCE:ACTION:SCOPE. */
export const PERMISSION_NEEDS: Record<string, string[]> = {
  'BILLING:FINAL_APPROVE:ORGANIZATION': ['BILLING:VIEW:ORGANIZATION'],
};

const keyOf = (p: PermissionKeyed) => `${p.resource}:${p.action}:${p.scope}`.toUpperCase();

/** The draft selection with every permission its ticked entries depend on added. */
export function withImpliedPermissions(selected: Set<string>, catalogue: PermissionKeyed[]): Set<string> {
  const byKey = new Map(catalogue.map((p) => [keyOf(p), p.id]));
  const next = new Set(selected);
  for (const p of catalogue) {
    if (!next.has(p.id)) continue;
    for (const needed of PERMISSION_NEEDS[keyOf(p)] ?? []) {
      const id = byKey.get(needed);
      if (id) next.add(id);
    }
  }
  return next;
}

/** A sentence for the editor when a ticked permission brought another with it, or null. */
export function impliedPermissionNote(selected: Set<string>, catalogue: PermissionKeyed[]): string | null {
  const ticked = catalogue.filter((p) => selected.has(p.id)).map(keyOf);
  return ticked.includes('BILLING:FINAL_APPROVE:ORGANIZATION')
    ? 'Final billing approval (HOD) also needs "View" on Billing — it is ticked for you, because the HOD approves on the Billing page.'
    : null;
}
