import { readQueuePage, truncationNote } from './scheduling-queue-page';

describe('Scheduling queue says when it is showing only the first page', () => {
  it('reads rows and the server total from a withMeta answer', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}` }));
    expect(readQueuePage({ data: rows, meta: { pagination: { total: 342 } } })).toEqual({ rows, total: 342 });
  });
  it('falls back to the row count for a bare array or a missing total', () => {
    expect(readQueuePage([{ id: 'a' }]).total).toBe(1);
    expect(readQueuePage({ data: [{ id: 'a' }] }).total).toBe(1);
  });
  it('names the truncation, and says nothing when everything is shown', () => {
    expect(truncationNote(100, 342)).toMatch(/^Showing 100 of 342/);
    expect(truncationNote(40, 40)).toBeNull();
  });
});
