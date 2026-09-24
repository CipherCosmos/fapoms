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
