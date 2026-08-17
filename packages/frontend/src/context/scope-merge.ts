/**
 * FAPOMS — how the header's scope and a page's own filters combine.
 *
 * Extracted from `ScopeContext.tsx` deliberately. These are pure functions with no React in them,
 * and this package's jest transform only covers `.ts` — logic that decides what a request is
 * filtered by should not be untestable because it happens to live next to a provider.
 */

/**
 * The five dimensions the header owns. A page filter naming one of these is not an independent
 * filter — it is a second opinion about the same thing.
 */
export const SCOPE_DIMENSIONS = ['projectId', 'clientId', 'region', 'zoneId', 'state'] as const;
export type ScopeDimension = (typeof SCOPE_DIMENSIONS)[number];

/** A page filter that names a scope dimension the header has already fixed to something else. */
export interface ScopeConflict {
  dimension: ScopeDimension;
  /** What the header says, and what the request will actually carry. */
  scoped: string;
  /** What the page asked for, and did not get. */
  requested: string;
}

/**
 * The one place a page filter and the header can disagree.
 *
 * Both halves write the *same* query parameters — `projectId`, `clientId`, `region`, `zoneId`,
 * `state` — so on the wire they are indistinguishable. This function used to merge them with
 * `search.set()`, which overwrites: whatever the page passed as `extra` silently replaced the
 * header's value. The header kept displaying "Project A" while the request asked for Project B,
 * and nothing on screen explained the rows on screen.
 *
 * **The global scope is a ceiling, so it wins on the wire.** A page filter may narrow *within* the
 * scope — that is the useful case, and it is unaffected, because narrowing means naming a
 * dimension the header left open. What it may never do is widen or sidestep, so a page asking for
 * a value the header has fixed differently is ignored here and reported by `scopeConflict` for the
 * page to surface. Silently honouring it would show data outside the declared scope; silently
 * dropping the page's choice is what made the old behaviour feel arbitrary. Neither is acceptable,
 * which is why the conflict is a value a component can render rather than something resolved here.
 */
export function withScope(
  params: Record<string, string>,
  extra: Record<string, string | number | undefined> = {},
): string {
  const search = new URLSearchParams(params);
  for (const [key, val] of Object.entries(extra)) {
    if (val === undefined || val === '' || val === 'ALL') continue;
    const scoped = params[key];
    // Same dimension, different answer: keep the ceiling. See `scopeConflict`.
    if (scoped !== undefined && scoped !== String(val)) continue;
    search.set(key, String(val));
  }
  return search.toString();
}

/**
 * The first dimension on which a page's filters contradict the header, or null when they agree.
 *
 * Returns one rather than all of them because the remedy is the same for each — widen the scope or
 * clear the page filter — and a banner listing four conflicts at once is a banner nobody reads.
 */
export function scopeConflict(
  params: Record<string, string>,
  extra: Record<string, string | number | undefined> = {},
): ScopeConflict | null {
  for (const dimension of SCOPE_DIMENSIONS) {
    const requested = extra[dimension];
    const scoped = params[dimension];
    if (requested === undefined || requested === '' || requested === 'ALL') continue;
    if (scoped !== undefined && scoped !== String(requested)) {
      return { dimension, scoped, requested: String(requested) };
    }
  }
  return null;
}
