import { AssignmentStatus, ProjectBranchStatus, ProjectStatus, ScheduleStatus, ValidationStatus } from './enums';
export type TransitionMap<T extends string> = Partial<Record<T, T[]>>;
export declare const PROJECT_TRANSITIONS: TransitionMap<ProjectStatus>;
export declare const PROJECT_BRANCH_TRANSITIONS: TransitionMap<ProjectBranchStatus>;
export declare const ASSIGNMENT_TRANSITIONS: TransitionMap<AssignmentStatus>;
export declare const SCHEDULE_TRANSITIONS: TransitionMap<ScheduleStatus>;
export declare const VALIDATION_TRANSITIONS: TransitionMap<ValidationStatus>;
export declare function isValidTransition<T extends string>(transitions: TransitionMap<T>, currentState: T, targetState: T): boolean;
