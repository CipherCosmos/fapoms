/**
 * FAPOMS — State Machine Definitions
 *
 * These transition maps define valid state changes for business entities.
 * Derived from Part 6 — Business State & Event Model.
 *
 * Invalid transitions must be rejected by business services.
 * Every transition generates a business event.
 */

import {
  AssignmentStatus,
  ProjectBranchStatus,
  ProjectStatus,
  ScheduleStatus,
  ValidationStatus,
} from './enums';

// ---------------------------------------------------------------------------
// State Transition Definition
// ---------------------------------------------------------------------------

export type TransitionMap<T extends string> = Partial<Record<T, T[]>>;

// ---------------------------------------------------------------------------
// Project State Machine (Part 6 §3)
// ---------------------------------------------------------------------------

export const PROJECT_TRANSITIONS: TransitionMap<ProjectStatus> = {
  [ProjectStatus.DRAFT]: [ProjectStatus.PLANNING],
  [ProjectStatus.PLANNING]: [ProjectStatus.SCHEDULING, ProjectStatus.CANCELLED],
  [ProjectStatus.SCHEDULING]: [ProjectStatus.EXECUTION, ProjectStatus.ON_HOLD],
  [ProjectStatus.EXECUTION]: [ProjectStatus.VALIDATION, ProjectStatus.ON_HOLD],
  [ProjectStatus.VALIDATION]: [ProjectStatus.COMPLETED],
  [ProjectStatus.COMPLETED]: [ProjectStatus.ARCHIVED],
  [ProjectStatus.ON_HOLD]: [ProjectStatus.SCHEDULING, ProjectStatus.EXECUTION],
  // ARCHIVED and CANCELLED are terminal states
};

// ---------------------------------------------------------------------------
// Project Branch State Machine (Part 6 §4, consolidated)
// ---------------------------------------------------------------------------

export const PROJECT_BRANCH_TRANSITIONS: TransitionMap<ProjectBranchStatus> = {
  [ProjectBranchStatus.IMPORTED]: [ProjectBranchStatus.PLANNING],
  [ProjectBranchStatus.PLANNING]: [
    ProjectBranchStatus.CANDIDATE_SEARCH,
    ProjectBranchStatus.UNABLE_TO_COVER,
  ],
  [ProjectBranchStatus.CANDIDATE_SEARCH]: [
    ProjectBranchStatus.CONTACT_INITIATED,
    ProjectBranchStatus.UNABLE_TO_COVER,
  ],
  [ProjectBranchStatus.CONTACT_INITIATED]: [
    ProjectBranchStatus.NEGOTIATION,
    ProjectBranchStatus.CANDIDATE_SEARCH, // Rejected → search new candidate
  ],
  [ProjectBranchStatus.NEGOTIATION]: [
    ProjectBranchStatus.ASSIGNMENT_CONFIRMED,
    ProjectBranchStatus.CANDIDATE_SEARCH, // Rejected → search new candidate
  ],
  [ProjectBranchStatus.ASSIGNMENT_CONFIRMED]: [ProjectBranchStatus.SCHEDULED],
  [ProjectBranchStatus.SCHEDULED]: [ProjectBranchStatus.AUDIT_COMPLETED],
  [ProjectBranchStatus.AUDIT_COMPLETED]: [ProjectBranchStatus.VALIDATION_COMPLETED],
  [ProjectBranchStatus.VALIDATION_COMPLETED]: [ProjectBranchStatus.CLOSED],
  // UNABLE_TO_COVER, ON_HOLD, CANCELLED are (near-)terminal states
  [ProjectBranchStatus.UNABLE_TO_COVER]: [ProjectBranchStatus.PLANNING], // Can be reopened
  [ProjectBranchStatus.ON_HOLD]: [ProjectBranchStatus.PLANNING],
};

// ---------------------------------------------------------------------------
// Assignment State Machine (Part 6 §5)
// ---------------------------------------------------------------------------

export const ASSIGNMENT_TRANSITIONS: TransitionMap<AssignmentStatus> = {
  [AssignmentStatus.CREATED]: [AssignmentStatus.CANDIDATE_SELECTED],
  [AssignmentStatus.CANDIDATE_SELECTED]: [AssignmentStatus.CONTACT_INITIATED],
  [AssignmentStatus.CONTACT_INITIATED]: [AssignmentStatus.NEGOTIATION],
  [AssignmentStatus.NEGOTIATION]: [
    AssignmentStatus.ACCEPTED,
    AssignmentStatus.REJECTED,
  ],
  [AssignmentStatus.ACCEPTED]: [
    AssignmentStatus.SCHEDULED,
    AssignmentStatus.CANCELLED, // Emergency only
  ],
  [AssignmentStatus.SCHEDULED]: [AssignmentStatus.AUDIT_COMPLETED],
  [AssignmentStatus.AUDIT_COMPLETED]: [AssignmentStatus.CLOSED],
  // REJECTED and CANCELLED are terminal states
};

// ---------------------------------------------------------------------------
// Schedule State Machine (Part 6 §6)
// ---------------------------------------------------------------------------

export const SCHEDULE_TRANSITIONS: TransitionMap<ScheduleStatus> = {
  [ScheduleStatus.TENTATIVE]: [ScheduleStatus.CONFIRMED],
  [ScheduleStatus.CONFIRMED]: [
    ScheduleStatus.RESCHEDULED,
    ScheduleStatus.COMPLETED,
  ],
  [ScheduleStatus.RESCHEDULED]: [ScheduleStatus.CONFIRMED],
  // COMPLETED is terminal
};

// ---------------------------------------------------------------------------
// Validation State Machine (Part 6 §8)
// ---------------------------------------------------------------------------

export const VALIDATION_TRANSITIONS: TransitionMap<ValidationStatus> = {
  [ValidationStatus.PENDING]: [ValidationStatus.ASSIGNED],
  [ValidationStatus.ASSIGNED]: [ValidationStatus.OCR_PROCESSING],
  [ValidationStatus.OCR_PROCESSING]: [ValidationStatus.HUMAN_REVIEW],
  [ValidationStatus.HUMAN_REVIEW]: [
    ValidationStatus.APPROVED,
    ValidationStatus.CORRECTION_REQUIRED,
  ],
  [ValidationStatus.CORRECTION_REQUIRED]: [ValidationStatus.HUMAN_REVIEW],
  [ValidationStatus.APPROVED]: [ValidationStatus.SUBMITTED],
  // SUBMITTED is terminal
};

// ---------------------------------------------------------------------------
// Transition Validator
// ---------------------------------------------------------------------------

/**
 * Checks whether a state transition is valid according to the transition map.
 * Returns true if the transition is allowed.
 */
export function isValidTransition<T extends string>(
  transitions: TransitionMap<T>,
  currentState: T,
  targetState: T,
): boolean {
  const allowedTargets = transitions[currentState];
  if (!allowedTargets) return false;
  return allowedTargets.includes(targetState);
}
