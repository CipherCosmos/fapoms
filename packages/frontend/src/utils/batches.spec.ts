import { inBatches } from './batches';

/**
 * Bulk user status changes are capped at 500 ids per call on the server, while the directory can
 * select every filtered user (up to 2,000 loaded). Without batching, an organisation past 500 staff
 * would get a 400 for the whole selection.
 */
describe('inBatches', () => {
  it('sends every item, in order, in batches no larger than the cap', async () => {
    const seen: number[][] = [];
    await inBatches(Array.from({ length: 1201 }, (_, i) => i), 500, async (b) => { seen.push(b); });
    expect(seen.map((b) => b.length)).toEqual([500, 500, 201]);
    expect(seen.flat()).toEqual(Array.from({ length: 1201 }, (_, i) => i));
  });

  it('runs one batch at a time, never two at once', async () => {
    let running = 0; let peak = 0;
    await inBatches([1, 2, 3, 4, 5], 2, async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
    });
    expect(peak).toBe(1);
  });

  it('stops at the first failed batch and sends nothing after it', async () => {
    const seen: number[][] = [];
    await expect(inBatches([1, 2, 3, 4, 5], 2, async (b) => {
      seen.push(b);
      if (b[0] === 3) throw new Error('refused');
    })).rejects.toThrow('refused');
    expect(seen).toEqual([[1, 2], [3, 4]]);
  });

  it('does nothing for an empty selection', async () => {
    const work = jest.fn();
    await inBatches([], 500, work);
    expect(work).not.toHaveBeenCalled();
  });
});
