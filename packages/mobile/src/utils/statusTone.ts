import { AssignmentStatus } from '@fapoms/shared';

export type StatusTone = 'success' | 'warning' | 'info' | 'neutral' | 'danger' | 'primary' | 'accent';

/**
 * One tone per assignment status, for the whole app.
 *
 * Tone is a mobile-theme concern, so it lives here rather than in `@fapoms/shared` — but it has
 * exactly one definition. Two screens previously kept their own maps and had drifted apart:
 * HomeScreen showed CHECKED_IN as success and COMPLETED as neutral, while ScheduleScreen showed
 * CHECKED_IN as primary and COMPLETED as success, so the same job changed colour when the
 * assayer moved between tabs.
 *
 * Wording always comes from `assignmentStatusLabel` in `@fapoms/shared`, so a job reads the same
 * on the assayer's phone as it does on the operations desk.
 */
export const ASSIGNMENT_STATUS_TONE: Record<AssignmentStatus, StatusTone> = {
  [AssignmentStatus.PENDING]: 'warning',
  [AssignmentStatus.ACCEPTED]: 'info',
  [AssignmentStatus.CHECKED_IN]: 'primary',
  [AssignmentStatus.IN_PROGRESS]: 'primary',
  [AssignmentStatus.COMPLETED]: 'success',
  [AssignmentStatus.REJECTED]: 'danger',
  [AssignmentStatus.CANCELLED]: 'neutral',
};

export function assignmentStatusTone(status?: string | null): StatusTone {
  if (!status) return 'neutral';
  return ASSIGNMENT_STATUS_TONE[status as AssignmentStatus] ?? 'neutral';
}
