/**
 * FAPOMS — State Machine Definitions
 *
 * These transition maps define valid state changes for business entities.
 * Derived from Part 6 — Business State & Event Model.
 *
 * Invalid transitions must be rejected by business services.
 * Every transition generates a business event.
 */
import { AssignmentStatus, ProjectBranchStatus, ProjectStatus, ScheduleStatus, ValidationStatus } from './enums';
export type TransitionMap<T extends string> = Partial<Record<T, T[]>>;
export declare const PROJECT_TRANSITIONS: TransitionMap<ProjectStatus>;
export declare const PROJECT_BRANCH_TRANSITIONS: TransitionMap<ProjectBranchStatus>;
export declare const ASSIGNMENT_TRANSITIONS: TransitionMap<AssignmentStatus>;
export declare const SCHEDULE_TRANSITIONS: TransitionMap<ScheduleStatus>;
export declare const VALIDATION_TRANSITIONS: TransitionMap<ValidationStatus>;
/**
 * Checks whether a state transition is valid according to the transition map.
 * Returns true if the transition is allowed.
 */
export declare function isValidTransition<T extends string>(transitions: TransitionMap<T>, currentState: T, targetState: T): boolean;
//# sourceMappingURL=state-machines.d.ts.map