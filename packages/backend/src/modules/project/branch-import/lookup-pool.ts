/**
 * FAPOMS — ask an outside directory each distinct question once, a few at a time.
 *
 * A 5,000-row branch list asked the IFSC directory, India Post and the geocoder one row at a time,
 * in order: 5,000 sequential round trips of up to several seconds each, most of them the same
 * question (the same pincode, the same inferred IFSC) asked again. This answers each distinct key
 * once, with a small fixed number in flight — few enough to stay polite to free public services,
 * enough that one slow answer does not hold up the rest.
 *
 * A lookup that throws counts as "no answer" (null), exactly as the lookups themselves already
 * treat a network failure: one bad reply must not fail an import of thousands of rows.
 */

export interface UniqueLookupOptions {
  /** How many lookups may be in flight at once. */
  concurrency: number;
  /** Called after each distinct key is answered — for a progress bar. */
  onAnswered?: (answered: number, total: number) => Promise<void> | void;
  /** Called between lookups; throw to stop (cancellation). */
  checkpoint?: () => Promise<void>;
}

export async function lookupEachOnce<V>(
  keys: Iterable<string>,
  lookup: (key: string) => Promise<V | null>,
  options: UniqueLookupOptions,
): Promise<Map<string, V | null>> {
  const unique = [...new Set([...keys].filter((k) => !!k))];
  const answers = new Map<string, V | null>();
  if (unique.length === 0) return answers;

  let next = 0;
  let answered = 0;
  let stopped: unknown = null;
  const lane = async () => {
    while (!stopped && next < unique.length) {
      const key = unique[next++];
      try {
        if (options.checkpoint) await options.checkpoint();
      } catch (err) {
        stopped = err;
        return;
      }
      let value: V | null = null;
      try {
        value = await lookup(key);
      } catch {
        value = null;
      }
      answers.set(key, value ?? null);
      answered++;
      if (options.onAnswered) await options.onAnswered(answered, unique.length);
    }
  };

  const lanes = Math.max(1, Math.min(options.concurrency, unique.length));
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  if (stopped) throw stopped;
  return answers;
}
