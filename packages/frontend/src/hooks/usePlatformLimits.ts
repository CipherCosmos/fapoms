import { useEffect, useState } from 'react';
import { api } from '../services/api';

export interface PlatformLimits {
  maxNegotiationRounds: number;
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
  maxNegotiationRounds: 3,
  checkInGeofenceMeters: 2000,
  maxSingleExpenseClaim: 50_000,
};

let cached: PlatformLimits | null = null;
let inFlight: Promise<PlatformLimits> | null = null;

/**
 * Operational limits, from the server that enforces them.
 *
 * Screens used to hardcode these — "Round 2 of 3", a disabled counter-offer button at 3 — while
 * the server reads them from platform settings an administrator can change at any time. The
 * negotiation cap is the one that bites: exceeding it does not refuse the counter, it
 * auto-declines the entire offer. A screen showing a stale cap either freezes a negotiation the
 * platform would allow, or invites a click that destroys the assignment.
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
