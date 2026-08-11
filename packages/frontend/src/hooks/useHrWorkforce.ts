import { useQuery } from '@tanstack/react-query';
import { api } from '../services/api';

export interface HrAction {
  severity: 'critical' | 'high' | 'medium' | 'low';
  area: string;
  title: string;
  detail: string;
  link: string;
}

export interface HrWorkforceOverview {
  generatedAt: string;
  headcount: {
    total: number; active: number; onboarding: number; exited: number;
    byLifecycle: { stage: string; count: number }[];
    byEmployment: { type: string; count: number }[];
    tenure: { unknown: number; under_3m: number; m3_to_1y: number; over_1y: number };
  };
  pipeline: {
    stalledAfterDays: number;
    inProgress: number;
    stages: { key: string; label: string; count: number; stalled: number; avgDaysInStage: number }[];
    stalled: { id: string; assayerCode: string; displayName: string; stage: string; state: string; district: string; since: string; daysInStage: number; movedBy: string | null }[];
  };
  compliance: {
    roster: number;
    incompleteCount: number;
    fields: { label: string; column: string; critical: boolean; blocks: string; have: number; missing: number; pct: number }[];
    incomplete: { id: string; assayerCode: string; displayName: string; state: string; district: string; lifecycleStatus: string; missing: string[] }[];
    governmentDocuments: { byStatus: { status: string; count: number }[]; roster: number; withGovDoc: number; withFile: number };
  };
  expiries: {
    certifications: { rows: any[]; expired: number; within30: number; within90: number; within180: number };
    documents: { rows: any[]; expired: number; within30: number; within90: number; within180: number };
  };
  capability: {
    coverage: { withSkill: number; withLanguage: number; withCertification: number; roster: number };
    skills: { name: string; assayerCount: number }[];
    languages: { name: string; assayerCount: number }[];
    certifications: { name: string; assayerCount: number }[];
    unprofiled: number;
  };
  deployment: {
    territories: { state: string; assayers: number; active: number; branches: number; branchesPerAssayer: number | null; posture: string }[];
    hiringNeeded: any[];
    idleTerritories: any[];
  };
  utilisation: {
    idleAfterDays: number; idleCount: number; neverAssigned: number;
    idle: { id: string; assayerCode: string; displayName: string; state: string; lastAssignmentDate: string | null; daysIdle: number | null; totalAssignments: number }[];
    utilization: { id: string; assayerCode: string; displayName: string; state: string; district: string; weeklyCapacity: number; currentAllocation: number; remainingCapacity: number; utilizationPercentage: number; posture: 'IDLE' | 'UNDER_UTILIZED' | 'BALANCED' | 'OVER_UTILIZED' }[];
    utilizationCounts: { idle: number; underUtilized: number; balanced: number; overUtilized: number; total: number };
    performance: { avgRating: string | null; rated: number; belowPar: number; totalAssignments: number; completedAssignments: number; cancelledAssignments: number; onTimeCompletions: number; onTimeRate: number | null };
  };
  attrition: {
    totalExits: number; exits90d: number; exits12m: number; terminations: number; joins90d: number;
    attritionRate12m: number;
    recent: { id: string; assayerCode: string; displayName: string; state: string; exitDate: string; mode: string; joiningDate: string | null }[];
  };
  activity: { id: string; eventType: string; previousState: string | null; newState: string | null; performedBy: string | null; remarks: string | null; occurredAt: string; assayerId: string; assayerCode: string; displayName: string }[];
  actions: HrAction[];
}

export function useHrWorkforce() {
  return useQuery({
    queryKey: ['hr', 'workforce'],
    queryFn: () => api.request<HrWorkforceOverview>('/hr/workforce'),
    staleTime: 60_000,
  });
}
