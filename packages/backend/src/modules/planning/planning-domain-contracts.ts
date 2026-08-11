import { GeoCoordinate } from '../../core/value-objects/geo-coordinate.value-object';

export class BranchId {
  constructor(public readonly value: string) {
    if (!value) throw new Error('BranchId cannot be empty');
  }
}

export class SkillSet {
  constructor(public readonly values: string[]) {}
  
  has(skill: string): boolean {
    return this.values.includes(skill);
  }
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

export class AssayerId {
  constructor(public readonly value: string) {
    if (!value) throw new Error('AssayerId cannot be empty');
  }
}

export interface PlanningAssayer {
  assayerId: AssayerId;
  displayName: string;
  status: string;
  location: GeoCoordinate;
  skills: SkillSet;
  maxWeeklyWorkload: number;
}
