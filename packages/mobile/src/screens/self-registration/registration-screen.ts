import { ApplicationStatus } from '@fapoms/shared';

/**
 * Which screen the registration link opens on — kept out of the React Native files so it can be
 * tested; this package has no React Native test environment.
 */

/** A form out of the candidate's hands: they see where it stands, not the form. */
export const FINISHED_STATUSES: ReadonlySet<string> = new Set([
  ApplicationStatus.PENDING_VALIDATION,
  ApplicationStatus.APPROVED,
  ApplicationStatus.REJECTED,
  ApplicationStatus.WITHDRAWN,
]);

export type RegistrationScreen = 'form' | 'status' | 'expired-fix';

/**
 * The form, where the application stands, or — for a form HR sent back behind a link that has
 * since expired — what HR asked for, with the way to a working link.
 *
 * An expired link only ever shows progress (owner, 2026-09-24: "status-only after expiry"): the
 * server sends no form data with it and refuses every change, so opening the form behind it would
 * be an empty form whose every save came back "expired".
 */
export function registrationScreenFor(status: string, statusOnly: boolean): RegistrationScreen {
  if (statusOnly) return status === ApplicationStatus.AWAITING_INFO ? 'expired-fix' : 'status';
  return FINISHED_STATUSES.has(status) ? 'status' : 'form';
}

/**
 * A draft patch made safe to send while the link's saved answers are LOCKED (the server withheld
 * them: no code verified in this session). The form on screen was then filled from a copy with the
 * identity numbers left out, so a blank there is "not shown", never "cleared" — sending it would ask
 * the server to wipe a PAN or account number the candidate cannot even see. Blank values (top level
 * and in `record`) are dropped; anything actually typed goes through. Unlocked, the patch is as is.
 */
export function draftPatchForLock<P extends object>(patch: P, locked: boolean): Partial<P> {
  if (!locked) return patch;
  const blank = (v: unknown) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'record' && value && typeof value === 'object' && !Array.isArray(value)) {
      const kept = Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, v]) => !blank(v)));
      if (Object.keys(kept).length > 0) out.record = kept;
    } else if (!blank(value)) {
      out[key] = value;
    }
  }
  return out as Partial<P>;
}
