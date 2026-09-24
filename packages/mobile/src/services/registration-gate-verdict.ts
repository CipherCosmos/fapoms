/**
 * Is this session still confined to finishing registration? Read from the server's own gate.
 *
 * The app learns it is in a registration-only session from a 403 carrying
 * `code: REGISTRATION_IN_PROGRESS`, and used to hold that for the rest of the session: nothing
 * ever lowered it, so a new joiner whom HR approved an hour ago stayed on the forced checklist
 * until they signed out. The server decides it per request from the person's current lifecycle
 * stage (`JwtAuthGuard`, `onboarding` on the principal), so the only faithful way to lower it is
 * to ask a route that gate covers and see whether it still says no.
 *
 * The rule of which stages count as "registering" lives on the server and is not copied here —
 * the app only reads the answer:
 *
 *  - a 2xx from a gated route: released (the rest of the app is open);
 *  - 403 with `REGISTRATION_IN_PROGRESS`: still registering;
 *  - anything else (no signal, 5xx, a different 403 such as a forced password change): unknown,
 *    and the current state is kept rather than guessed.
 */
export type RegistrationGateVerdict = 'in-progress' | 'released' | 'unknown';

export function registrationGateVerdict(status: number, code?: string | null): RegistrationGateVerdict {
  if (status >= 200 && status < 300) return 'released';
  if (status === 403 && code === 'REGISTRATION_IN_PROGRESS') return 'in-progress';
  return 'unknown';
}
