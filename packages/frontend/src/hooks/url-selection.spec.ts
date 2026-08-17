/**
 * The merge rule behind `useUrlSelection`, tested without React.
 *
 * This package's jest transform only covers `.ts`, so the hook itself (a `.ts` file, but one that
 * imports react-router) cannot be rendered here. What can be pinned is the part that was actually
 * wrong: how a selection is folded into a query string that already has things in it.
 *
 * The bug, measured in the browser: arriving at `?status=COMPLETED&page=2&region=WEST` and
 * clicking one row left `?id=47b9ddc2…` and nothing else, because the click called
 * `navigate('/assignments?id=' + id)` — a fresh query string. A refresh then reloaded an
 * unfiltered page 1, usually without the selected row on it.
 */

/** Exactly what the hook does to the params, extracted so it can be asserted on directly. */
function applySelection(search: string, key: string, id: string | null): string {
  const next = new URLSearchParams(search);
  if (id) next.set(key, id);
  else next.delete(key);
  return next.toString();
}

describe('folding a selection into the URL', () => {
  it('keeps the filter, the page and the scope that were already there', () => {
    const before = 'status=COMPLETED&page=2&region=WEST';
    const after = new URLSearchParams(applySelection(before, 'id', 'asn-1'));

    expect(after.get('status')).toBe('COMPLETED');
    expect(after.get('page')).toBe('2');
    expect(after.get('region')).toBe('WEST');
    expect(after.get('id')).toBe('asn-1');
  });

  it('replaces a previous selection rather than appending a second one', () => {
    const after = new URLSearchParams(applySelection('id=asn-1&page=2', 'id', 'asn-2'));
    expect(after.getAll('id')).toEqual(['asn-2']);
    expect(after.get('page')).toBe('2');
  });

  it('clearing removes the key instead of writing "null"', () => {
    const after = new URLSearchParams(applySelection('id=asn-1&page=2', 'id', null));
    expect(after.has('id')).toBe(false);
    expect(after.get('page')).toBe('2');
  });

  it('works on a different key, so branch and assignment pages can coexist', () => {
    const after = new URLSearchParams(applySelection('projectId=p-1', 'branchId', 'b-9'));
    expect(after.get('projectId')).toBe('p-1');
    expect(after.get('branchId')).toBe('b-9');
  });

  it('is what the old behaviour was not: the fresh-string version loses everything', () => {
    // The shape that shipped, kept here as the thing being guarded against.
    const oldBehaviour = new URLSearchParams(`id=${'asn-1'}`);
    expect(oldBehaviour.get('status')).toBeNull();
    expect(oldBehaviour.get('region')).toBeNull();

    const nowKept = new URLSearchParams(applySelection('status=COMPLETED&region=WEST', 'id', 'asn-1'));
    expect(nowKept.get('status')).toBe('COMPLETED');
    expect(nowKept.get('region')).toBe('WEST');
  });
});
