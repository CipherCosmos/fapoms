import { GeoCoordinate } from '../../core/value-objects/geo-coordinate.value-object';
export declare class BranchId {
    readonly value: string;
    constructor(value: string);
}
export declare class SkillSet {
    readonly values: string[];
    constructor(values: string[]);
    has(skill: string): boolean;
}
export interface PlanningBranch {
    branchId: BranchId;
    branchCode: string;
    name: string;
    location: GeoCoordinate;
    city: string;
    state: string;
    requiredSkills: SkillSet;
}
export declare class AssayerId {
    readonly value: string;
    constructor(value: string);
}
export interface PlanningAssayer {
    assayerId: AssayerId;
    displayName: string;
    status: string;
    location: GeoCoordinate;
    skills: SkillSet;
    maxWeeklyWorkload: number;
}
