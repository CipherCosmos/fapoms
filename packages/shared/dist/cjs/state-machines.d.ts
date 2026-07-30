import { AssessmentStatus, ProjectStatus, ScheduleStatus, ValidationStatus } from './enums';
export type TransitionMap<T extends string> = Partial<Record<T, T[]>>;
export declare const PROJECT_TRANSITIONS: TransitionMap<ProjectStatus>;
export declare const ASSESSMENT_TRANSITIONS: TransitionMap<AssessmentStatus>;
export declare const SCHEDULE_TRANSITIONS: TransitionMap<ScheduleStatus>;
export declare const VALIDATION_TRANSITIONS: TransitionMap<ValidationStatus>;
export declare function isValidTransition<T extends string>(transitions: TransitionMap<T>, currentState: T, targetState: T): boolean;
//# sourceMappingURL=state-machines.d.ts.map