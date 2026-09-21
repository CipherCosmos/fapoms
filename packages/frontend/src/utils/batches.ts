/**
 * Run `work` over `items` in consecutive batches of at most `size`, one batch at a time.
 *
 * For bulk routes whose server caps the ids per call: a selection larger than the cap is sent as
 * several ordinary requests rather than one refused one. Sequential on purpose — the batches write
 * the same tables, and a failure stops the run so the caller can report how far it got (the earlier
 * batches really did happen). The error propagates; nothing after the failed batch is sent.
 */
export async function inBatches<T>(items: readonly T[], size: number, work: (batch: T[]) => Promise<void>): Promise<void> {
  if (!Number.isInteger(size) || size < 1) throw new Error(`Batch size must be a positive integer, got ${size}.`);
  for (let i = 0; i < items.length; i += size) {
    await work(items.slice(i, i + size));
  }
}
