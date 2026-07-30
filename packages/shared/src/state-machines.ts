import {
  AssessmentStatus,
  ProjectStatus,
  ScheduleStatus,
  ValidationStatus,
} from './enums';

export type TransitionMap<T extends string> = Partial<Record<T, T[]>>;

export const PROJECT_TRANSITIONS: TransitionMap<ProjectStatus> = {
  [ProjectStatus.DRAFT]: [ProjectStatus.PLANNING],
  [ProjectStatus.PLANNING]: [ProjectStatus.SCHEDULING, ProjectStatus.CANCELLED],
  [ProjectStatus.SCHEDULING]: [ProjectStatus.EXECUTION, ProjectStatus.ON_HOLD],
  [ProjectStatus.EXECUTION]: [ProjectStatus.VALIDATION, ProjectStatus.ON_HOLD],
  [ProjectStatus.VALIDATION]: [ProjectStatus.COMPLETED],
  [ProjectStatus.COMPLETED]: [ProjectStatus.ARCHIVED],
  [ProjectStatus.ON_HOLD]: [ProjectStatus.SCHEDULING, ProjectStatus.EXECUTION],
};

export const ASSESSMENT_TRANSITIONS: TransitionMap<AssessmentStatus> = {
  [AssessmentStatus.PENDING_PLANNING]: [AssessmentStatus.ASSESSOR_RECOMMENDED],
  [AssessmentStatus.ASSESSOR_RECOMMENDED]: [
    AssessmentStatus.IN_NEGOTIATION,
    AssessmentStatus.UNASSIGNED,
  ],
  [AssessmentStatus.IN_NEGOTIATION]: [
    AssessmentStatus.ASSIGNED_AND_SCHEDULED,
    AssessmentStatus.ASSESSOR_RECOMMENDED,
  ],
  [AssessmentStatus.ASSIGNED_AND_SCHEDULED]: [
    AssessmentStatus.AWAITING_CLIENT_DATA,
    AssessmentStatus.UNASSIGNED,
  ],
  [AssessmentStatus.AWAITING_CLIENT_DATA]: [AssessmentStatus.CLIENT_DATA_RECEIVED],
  [AssessmentStatus.CLIENT_DATA_RECEIVED]: [AssessmentStatus.PDF_GENERATED],
  [AssessmentStatus.PDF_GENERATED]: [AssessmentStatus.READY_FOR_DISPATCH],
  [AssessmentStatus.READY_FOR_DISPATCH]: [AssessmentStatus.DISPATCHED_TO_ASSESSOR],
  [AssessmentStatus.DISPATCHED_TO_ASSESSOR]: [AssessmentStatus.AUDITED_PDF_RECEIVED],
  [AssessmentStatus.AUDITED_PDF_RECEIVED]: [AssessmentStatus.SENT_TO_DATA_ENTRY],
  [AssessmentStatus.SENT_TO_DATA_ENTRY]: [AssessmentStatus.DATA_ENTRY_IN_PROGRESS],
  [AssessmentStatus.DATA_ENTRY_IN_PROGRESS]: [
    AssessmentStatus.CLARIFICATION_NEEDED,
    AssessmentStatus.REPORT_FINALIZED,
  ],
  [AssessmentStatus.CLARIFICATION_NEEDED]: [AssessmentStatus.DATA_ENTRY_IN_PROGRESS],
  [AssessmentStatus.REPORT_FINALIZED]: [AssessmentStatus.PENDING_HEAD_APPROVAL],
  [AssessmentStatus.PENDING_HEAD_APPROVAL]: [
    AssessmentStatus.DELIVERED_TO_CLIENT,
    AssessmentStatus.DATA_ENTRY_IN_PROGRESS,
  ],
  [AssessmentStatus.DELIVERED_TO_CLIENT]: [AssessmentStatus.COMPLETED],
};

export const SCHEDULE_TRANSITIONS: TransitionMap<ScheduleStatus> = {
  [ScheduleStatus.TENTATIVE]: [ScheduleStatus.CONFIRMED],
  [ScheduleStatus.CONFIRMED]: [
    ScheduleStatus.RESCHEDULED,
    ScheduleStatus.COMPLETED,
  ],
  [ScheduleStatus.RESCHEDULED]: [ScheduleStatus.RESCHEDULED, ScheduleStatus.CONFIRMED, ScheduleStatus.COMPLETED],
};

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
};

export function isValidTransition<T extends string>(
  transitions: TransitionMap<T>,
  currentState: T,
  targetState: T,
): boolean {
  const allowedTargets = transitions[currentState];
  if (!allowedTargets) return false;
  return allowedTargets.includes(targetState);
}
