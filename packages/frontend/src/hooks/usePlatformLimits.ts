import { useEffect, useState } from 'react';
import { api } from '../services/api';
import { PLATFORM_LIMIT_FALLBACK, type PlatformLimits } from '@fapoms/shared';

/**
 * The shipped defaults, used until the server answers.
 *
 * They match the registry's defaults so a first paint is never wrong for an unconfigured
 * platform — but they are a starting value, not the rule. The rule is whatever the server says.
 * `@fapoms/shared`'s copy, not a second one: mobile's `getPlatformLimits()` hand-declared the
 * same object independently until both were pointed at it.
 */
const FALLBACK: PlatformLimits = PLATFORM_LIMIT_FALLBACK;

let cached: PlatformLimits | null = null;
let inFlight: Promise<PlatformLimits> | null = null;

/**
 * Operational limits, from the server that enforces them.
 *
 * Screens used to hardcode these while the server reads them from platform settings an
 * administrator can change at any time — so a screen could confidently state a rule (a geofence
 * radius, an expense cap) the platform no longer enforced.
 *
 * Cached module-wide: these change rarely and every screen wants the same answer, so one fetch
 * per page load serves all of them.
 */
export function usePlatformLimits(): PlatformLimits {
  const [limits, setLimits] = useState<PlatformLimits>(cached ?? FALLBACK);

  useEffect(() => {
    if (cached) return;
    inFlight ??= api
      .request<PlatformLimits>('/platform-settings/limits')
      // A failed lookup must not break the screen — it falls back to the shipped defaults,
      // which is exactly what the hardcoded values were, so this is never worse than before.
      .then((v) => { cached = v; return v; })
      .catch(() => FALLBACK);
    let alive = true;
    void inFlight.then((v) => { if (alive) setLimits(v); });
    return () => { alive = false; };
  }, []);

  return limits;
}
