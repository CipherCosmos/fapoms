import { useEffect, useState } from 'react';
import { api } from '../services/api';

export interface PlatformLimits {
  // `maxNegotiationRounds` is gone from this type on purpose: in-app fee negotiation was
  // removed (2026-09). The endpoint still returns it as a literal 0 — an old-APK kill-switch
  // the mobile builds read — but no web screen has a round counter left to feed.
  checkInGeofenceMeters: number;
  maxSingleExpenseClaim: number;
}

/**
 * The shipped defaults, used until the server answers.
 *
 * They match the registry's defaults so a first paint is never wrong for an unconfigured
 * platform — but they are a starting value, not the rule. The rule is whatever the server says.
 */
const FALLBACK: PlatformLimits = {
  checkInGeofenceMeters: 2000,
  maxSingleExpenseClaim: 50_000,
};

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
