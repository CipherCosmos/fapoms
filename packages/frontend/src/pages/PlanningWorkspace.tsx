import React, { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Compass, Check, X, AlertTriangle, CheckCircle, Search, Star, Briefcase, MapPin, Phone, Mail, Award, Clock, DollarSign, Calendar, TrendingUp, Building2, Route, Users, Layers, RefreshCw } from 'lucide-react';
import { Priority, ProjectBranchStatus } from '@fapoms/shared';
import { branchStatusLabel } from '../utils/statusLabels';
import * as xlsx from 'xlsx';
import { api } from '../services/api';
import { InteractivePlanningMap } from '../components/InteractivePlanningMap';
import { useSocket } from '../hooks/useSocket';
import { connectSocket } from '../services/socket';
import { useSocketInvalidation } from '../hooks/useSocketInvalidation';
import { BranchHistoryDrawer } from './planning/BranchHistoryDrawer';
import { useToast } from '../components/ui';

interface ProjectOption {
  id: string;
  name: string;
  projectNumber: string;
}

interface ProjectBranch {
  id: string;
  projectId: string;
  branchId: string;
  status: string;
  priority: Priority;
  zoneId: string | null;
  scheduledDate: string | null;
  remarks: string | null;
  branch: {
    id: string;
    branchCode: string;
    solId: string | null;
    name: string;
    state: string;
    district: string;
    city: string;
    latitude: number | null;
    longitude: number | null;
  };
  assignment: {
    id: string;
    status: string;
    proposedFee: number;
    agreedFee: number | null;
    scheduledDate: string | null;
    remarks?: string | null;
    /** The ops user who created this offer — i.e. who owns this negotiation. */
    negotiatedByName?: string | null;
    /** Counter-offer rounds so far; proposeCounterFee() auto-declines at 3. */
    negotiationCount?: number;
    assayer?: { id: string; displayName: string; assayerCode?: string };
  } | null;
}

/** Hard limit enforced by AssignmentService.proposeCounterFee() — kept in sync here for display. */
const MAX_NEGOTIATION_ROUNDS = 3;

interface Candidate {
  id: string;
  assayerCode: string;
  displayName: string;
  phone: string;
  email: string | null;
  status: string;
  state: string;
  district: string;
  city: string;
  distanceKm: number | null;
  latitude: number | null;
  longitude: number | null;
  score?: number;
  baseFee?: number;
  pendingOnThisBranch?: boolean;
  /** Backend already computes these; the UI previously discarded them. */
  readableReasons?: { label: string; detail?: string; sentiment?: string }[];
  scoreBreakdown?: Record<string, number>;
}

/** A candidate the engine filtered out, and why. */
interface ExcludedCandidate {
  assayerId: string;
  displayName: string;
  reason: string;
  detail?: string;
}

interface AssayerDetail {
  id: string;
  assayerCode: string;
  displayName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string;
  address: string;
  state: string;
  district: string;
  city: string;
  pincode: string | null;
  status: string;
  lifecycleStatus: string;
  employmentType: string;
  joiningDate: string | null;
  department: string | null;
  region: string | null;
  skills: string[] | null;
  certifications: { name: string; expiryDate: string }[] | null;
  languages: string[] | null;
  specializations: string[] | null;
  experienceYears: number;
  performanceRating: number;
  totalAssignments: number;
  completedAssignments: number;
  cancelledAssignments: number;
  onTimeCompletions: number;
  totalEarnings: number;
  lastAssignmentDate: string | null;
  averageRating: number;
  notes: string | null;
  queryCount?: number;
  acceptanceRate?: number;
  rejectionRate?: number;
  auditHistory?: Array<{
    id: string;
    assignment_number: string;
    status: string;
    agreed_fee: number;
    proposed_fee: number;
    scheduled_date: string;
    completion_date: string;
    branch_name: string;
    branch_city: string;
    branch_state: string;
    project_name: string;
  }>;
  activeCommercialProfile?: {
    baseFee: number;
    hourlyRate?: number;
    dailyRate?: number;
    travelReimbursement?: number;
  } | null;
}

interface Remark {
  id: string;
  content: string;
  category: string;
  visibility: string;
  authorName: string;
  rating: number | null;
  createdAt: string;
}

interface DayPlanStop {
  order: number;
  branchId: string;
  branchName: string;
  branchCode: string;
  address: string;
  estimatedAuditHours: number;
  travelFromPreviousKm: number;
  travelFromPreviousMinutes: number;
  estimatedArrival: string;
  estimatedDeparture: string;
}

interface DayPlanCandidate {
  assayerId: string;
  assayerName: string;
  assayerCode: string;
  assayerCity: string;
  assayerPhone: string;
  overallScore: number;
  totalBranches: number;
  totalAuditHours: number;
  totalTravelKm: number;
  totalTravelMinutes: number;
  totalDayHours: number;
  estimatedBaseFee: number;
  estimatedTravelFee: number;
  estimatedTotalCost: number;
  dayStartTime: string;
  dayEndTime: string;
  utilizationPercent: number;
  totalPackets: number;
  costPerPacket: number | null;
  idleHours: number;
  stops: DayPlanStop[];
  clientPreferencesMatch: {
    skillsMatch: boolean;
    certificationsMatch: boolean;
    distanceWithinRange: boolean;
    isPreferredAssayer: boolean;
  };
}

interface BranchCluster {
  clusterId: string;
  radiusKm: number;
  // `id` (the project-branch id) was missing from this type though the backend always sends
  // it — assigning a day plan needs it for POST /assignments, which takes projectBranchId,
  // not the bare branch id.
  branches: Array<{
    id: string; branchId: string; branchName: string; branchCode: string;
    estimatedDurationHours: number; city: string; district: string;
    /** Packets in THIS cycle — what actually determines how long the branch takes. */
    packetCount: number | null;
    /** True when hours came from the stale per-branch estimate, not this cycle's packets. */
    durationFromStaticFallback: boolean;
  }>;
  totalPackets: number;
  totalEstimatedAuditHours: number;
  feasibleForOneDay: boolean;
}

interface ProjectDayPlan {
  projectId: string;
  projectName: string;
  targetDate: string;
  /** Stricter of the operator's manual filter and the client's own configured floor; null when neither applies. */
  effectiveMinDistanceKm: number | null;
  clusters: Array<{
    cluster: BranchCluster;
    dayPlans: DayPlanCandidate[];
    bestPlan: DayPlanCandidate | null;
    excludedAssayers: ExcludedCandidate[];
  }>;
  unclusteredBranches: Array<{ branchId: string; branchName: string; reason: string }>;
  /** Requested date wasn't workable (holiday/weekend) and the planner moved forward. */
  dateAdjustment: { requestedDate: string; reason: string } | null;
  /** Lone branches that would consume a full paid day for a few hours of work. */
  underutilizedBranches: Array<{
    branchId: string; branchName: string; packetCount: number | null;
    auditHours: number; idleHours: number; note: string;
  }>;
  summary: {
    totalClusters: number;
    totalBranchesCovered: number;
    totalAssayersNeeded: number;
    estimatedTotalCost: number;
    averageUtilization: number;
    totalPackets: number;
    averagePacketsPerDay: number;
    averageCostPerPacket: number | null;
  };
}

const CATEGORY_COLORS: Record<string, string> = {
  PERFORMANCE: '#d8ae47',
  QUALITY: '#d8ae47',
  BEHAVIORAL: '#b8791f',
  TRAINING: '#3f7d53',
  GENERAL: '#7c6e59',
};

// Values derive straight from the shared enum, wording from the shared status
// vocabulary — so this page can never drift from Field Execution or Scheduling
// in either the set of statuses it offers or what it calls them.
const STATUS_OPTIONS = [
  { value: 'ALL', label: 'All Statuses' },
  ...Object.values(ProjectBranchStatus).map(value => ({ value, label: branchStatusLabel(value) })),
];


/** Friendly names for the engine's scoring dimensions. */
const SCORE_DIMENSION_LABELS: Record<string, string> = {
  slaCompliance: 'SLA compliance',
  acceptanceRate: 'Accepts offers',
  workload: 'Spare capacity',
  distance: 'Proximity',
  travelTime: 'Travel time',
  performance: 'Performance rating',
  queryVolume: 'Clean paperwork',
  deliverySpeed: 'Turnaround speed',
  branchFamiliarity: 'Knows this branch',
  experience: 'Experience',
  cost: 'Cost',
  clientPreference: 'Client fit',
  customerDensity: 'Capacity vs branch size',
  profitability: 'Budget fit',
  riskScore: 'Risk suitability',
};

/**
 * Shows the strongest and weakest dimensions behind a candidate's score.
 *
 * The engine has always returned a full per-dimension breakdown; the UI discarded it and
 * showed only a single "% Match" number with a hardcoded tooltip listing six dimensions
 * (there are fifteen). Ops had no way to tell a candidate who is close-but-unreliable from
 * one who is distant-but-excellent.
 */
const ScoreBreakdown: React.FC<{ breakdown?: Record<string, number> }> = ({ breakdown }) => {
  if (!breakdown || Object.keys(breakdown).length === 0) return null;
  const entries = Object.entries(breakdown)
    .filter(([k]) => SCORE_DIMENSION_LABELS[k])
    .sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;
  const strengths = entries.slice(0, 3);
  const weakest = entries[entries.length - 1];

  const pill = (k: string, v: number, good: boolean) => (
    <span key={k} title={`${SCORE_DIMENSION_LABELS[k]}: ${Math.round(v)}/100`}
      style={{ fontSize: '9.5px', fontWeight: 600, padding: '1px 5px', borderRadius: '4px', whiteSpace: 'nowrap',
        background: good ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)',
        color: good ? 'var(--success)' : 'var(--danger)' }}>
      {SCORE_DIMENSION_LABELS[k]} {Math.round(v)}
    </span>
  );

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '2px' }}>
      {strengths.map(([k, v]) => pill(k, v, true))}
      {weakest[1] < 50 && pill(weakest[0], weakest[1], false)}
    </div>
  );
};

/**
 * Candidates the engine filtered out, and why.
 *
 * Excluded assayers used to disappear with no explanation, so "my best assayer isn't in the
 * list" was unanswerable — and genuine data problems (an expired certification, a full diary)
 * looked identical to a normal short list.
 */
const ExcludedCandidatesPanel: React.FC<{ excluded: ExcludedCandidate[] }> = ({ excluded }) => {
  const [open, setOpen] = useState(false);
  if (excluded.length === 0) return null;
  return (
    <div style={{ marginTop: '10px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface-2)' }}>
      <button onClick={() => setOpen(!open)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer' }}>
        <span>{excluded.length} assayer{excluded.length > 1 ? 's' : ''} not shown — why?</span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 10px 10px' }}>
          {excluded.map(e => (
            <div key={e.assayerId} style={{ padding: '6px 0', borderTop: '1px solid var(--border-color)' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: 600 }}>{e.displayName}</div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{e.reason}</div>
              {e.detail && <div style={{ fontSize: '10.5px', color: 'var(--warning)', marginTop: '2px' }}>└─ {e.detail}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * The active counter-offer banner — an assayer has proposed a different fee and ops needs to
 * accept, counter, or decline it.
 *
 * Single shared definition, used in every layout that shows a branch's negotiation state.
 * This used to be two near-identical blocks of inline JSX hand-copied into the "default" and
 * "three-col" layouts — already drifted apart in wording — and was missing entirely from
 * "two-col-branch-recom", so a counter-offer arriving while an operator had that layout open
 * was completely invisible to them until they happened to switch layouts.
 *
 * Also surfaces two things the old inline version never showed: who on the team is already
 * handling this negotiation (`negotiatedByName` — see project.controller.ts), and how many
 * counter-offer rounds remain before AssignmentService.proposeCounterFee() auto-declines it.
 */
const NegotiationBanner: React.FC<{
  assignment: NonNullable<ProjectBranch['assignment']>;
  onAccept: () => void;
  onCounter: () => void;
  onDecline: () => void;
}> = ({ assignment, onAccept, onCounter, onDecline }) => {
  const round = Math.max(1, assignment.negotiationCount ?? 1);
  const roundsLeft = Math.max(0, MAX_NEGOTIATION_ROUNDS - (assignment.negotiationCount ?? 0));

  return (
    <div style={{
      padding: '12px 14px',
      background: 'linear-gradient(135deg, var(--status-pending-bg), var(--status-pending-bg))',
      borderBottom: '1px solid var(--status-pending-bg)',
      borderLeft: '3px solid var(--warning)',
      display: 'flex', flexDirection: 'column', gap: '10px',
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
        <div style={{ width: '30px', height: '30px', borderRadius: '50%', background: 'var(--status-pending-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: '14px' }}>
          💬
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12.5px', fontWeight: 700, color: 'var(--warning)' }}>
              Counter offer from {assignment.assayer?.displayName || 'assayer'}
            </span>
            <span style={{ fontSize: '9.5px', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: 'var(--status-pending-bg)', color: 'var(--warning)', whiteSpace: 'nowrap' }}>
              Round {round} of {MAX_NEGOTIATION_ROUNDS}
            </span>
          </div>
          <div style={{ fontSize: '19px', fontWeight: 800, color: 'var(--text-primary)', marginTop: '3px' }}>
            ₹{assignment.proposedFee?.toLocaleString()}
          </div>
          {assignment.remarks && (
            <div style={{ fontSize: '11px', color: 'var(--warning)', marginTop: '3px', fontStyle: 'italic' }}>
              "{assignment.remarks}"
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', marginTop: '5px' }}>
            {assignment.negotiatedByName && (
              <span style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <Users size={10} /> Handled by <b style={{ color: 'var(--text-secondary)', fontWeight: 700 }}>{assignment.negotiatedByName}</b>
              </span>
            )}
            {roundsLeft <= 1 && (
              <span style={{ fontSize: '10px', color: 'var(--danger)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '3px' }}>
                <AlertTriangle size={10} />
                {roundsLeft === 0 ? 'Next counter auto-declines this offer' : 'Last round before auto-decline'}
              </span>
            )}
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', gap: '6px' }}>
        <button type="button" onClick={onAccept} className="btn btn-primary"
          style={{ flex: 1.3, padding: '7px 10px', fontSize: '11.5px', background: 'var(--success)', borderColor: 'var(--success)', color: 'var(--text-primary)', fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
          <Check size={13} /> Accept
        </button>
        <button type="button" onClick={onCounter} className="btn btn-secondary"
          style={{ flex: 1, padding: '7px 10px', fontSize: '11.5px', color: 'var(--accent)', borderColor: 'rgba(216,174,71,0.4)', background: 'rgba(216,174,71,0.1)', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
          <RefreshCw size={12} /> Counter
        </button>
        <button type="button" onClick={onDecline} className="btn btn-secondary"
          style={{ flex: 1, padding: '7px 10px', fontSize: '11.5px', color: 'var(--danger)', borderColor: 'var(--status-cancelled-bg)', background: 'var(--status-cancelled-bg)', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '5px' }}>
          <X size={13} /> Decline
        </button>
      </div>
    </div>
  );
};

/**
 * Shared, single definition of the branch queue panel.
 *
 * This used to be the same markup hand-copied into four separate layouts ("default",
 * "two-col-branch-recom", "two-col-branch-map", "three-col") with each copy drifting
 * further from the others (status wording, spacing, negotiation visibility). One component
 * now renders every layout's branch list so the queue looks and behaves identically
 * everywhere; only the width differs.
 */
const BranchListPanel: React.FC<{
  branches: ProjectBranch[];
  selectedBranchId: string | null;
  onSelectBranch: (id: string) => void;
  searchTerm: string;
  onSearchTermChange: (value: string) => void;
  loading?: boolean;
  width?: number;
}> = ({ branches, selectedBranchId, onSelectBranch, searchTerm, onSearchTermChange, loading = false, width = 340 }) => {
  return (
    <div style={{ width: `${width}px`, minWidth: `${width}px`, display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
      <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '6px', background: 'var(--bg-surface-2)' }}>
        <Search size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
        <input type="text" placeholder="Search branches..." value={searchTerm} onChange={e => onSearchTermChange(e.target.value)}
          style={{ flex: 1, background: 'none', border: 'none', color: 'var(--text-primary)', outline: 'none', fontSize: '12px' }} />
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '6px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '30px 12px', color: 'var(--text-muted)', fontSize: '12px' }}>
            <span className="spinner" style={{ display: 'inline-block', marginBottom: 8 }} />
            <div>Loading branches…</div>
          </div>
        ) : branches.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '30px 12px', color: 'var(--text-muted)', fontSize: '12px' }}>No branches in this project.</div>
        ) : branches.map(pb => {
          const isSelected = pb.id === selectedBranchId;
          const isAssigned = !!pb.assignment;
          const isDone = ['CLOSED'].includes(pb.status);
          const isValidationPending = ['AUDIT_COMPLETED', 'VALIDATION_COMPLETED'].includes(pb.status) || pb.assignment?.status === 'COMPLETED';
          const isNegotiating = pb.status === 'NEGOTIATION' || pb.assignment?.status === 'COUNTER_OFFER';

          const badgeBg = isDone ? 'var(--status-active-bg)' : isValidationPending ? 'var(--status-pending-bg)' : isAssigned ? 'rgba(216,174,71,0.15)' : isNegotiating ? 'rgba(216,174,71,0.2)' : 'var(--border-hair)';
          const badgeColor = isDone ? 'var(--success)' : isValidationPending ? 'var(--warning)' : isAssigned ? 'var(--accent)' : isNegotiating ? 'var(--accent)' : 'var(--text-muted)';
          // Wording comes from the shared status vocabulary so this badge matches
          // Field Execution and Scheduling for the same branch.
          const statusLabel = isDone
            ? `✓ ${branchStatusLabel(pb.status)}`
            : isValidationPending
            ? `🔍 ${branchStatusLabel(pb.status)}`
            : isNegotiating
            ? `💬 ${branchStatusLabel(ProjectBranchStatus.NEGOTIATION)}`
            : isAssigned
            ? `✓ ${branchStatusLabel(ProjectBranchStatus.ASSIGNMENT_CONFIRMED)}`
            : `⏳ ${branchStatusLabel(pb.status)}`;

          return (
            <div key={pb.id} onClick={() => onSelectBranch(pb.id)}
              style={{
                padding: '10px 12px', cursor: 'pointer', borderRadius: '8px', marginBottom: '6px',
                background: isSelected ? 'rgba(216,174,71,0.25)' : isDone ? 'var(--status-active-bg)' : isAssigned ? 'rgba(216,174,71,0.06)' : 'var(--bg-surface-2)',
                borderLeft: isSelected ? '4px solid var(--accent)' : isDone ? '4px solid var(--success)' : isAssigned ? '4px solid var(--accent)' : isNegotiating ? '4px solid var(--warning)' : '4px solid transparent',
                border: isSelected ? '1px solid rgba(216,174,71,0.5)' : '1px solid var(--border-hair)',
              }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{pb.branch.name}</div>
                <span style={{ fontSize: '10px', padding: '2px 7px', borderRadius: '4px', background: badgeBg, color: badgeColor, fontWeight: 700, whiteSpace: 'nowrap' }}>
                  {statusLabel}
                </span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span>{pb.branch.city}, {pb.branch.state}</span>
                {pb.assignment?.assayer?.displayName && (
                  <span style={{ fontSize: '10px', color: 'var(--accent)', fontWeight: 600 }}>👤 {pb.assignment.assayer.displayName}</span>
                )}
              </div>
              {/* Operators previously had no way to tell, from the queue, whether a
                  colleague was already negotiating this branch — risking duplicate
                  outreach to the same assayer. */}
              {isNegotiating && pb.assignment?.negotiatedByName && (
                <div style={{ fontSize: '9.5px', color: 'var(--warning)', marginTop: '2px' }}>
                  💬 Being negotiated by <b>{pb.assignment.negotiatedByName}</b>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

/**
 * Shared, single definition of the "recommended assayers" panel (header + SLA controls +
 * candidate list + negotiation banner + completion summary).
 *
 * The candidate list markup is produced by the caller's `renderCandidatesList(horizontal)`
 * closure, but the surrounding panel — the header, the "Show Distant / Min Radius Filter"
 * controls, the read-only completion summary for done branches, and the counter-offer
 * banner — used to be hand-copied into three layouts ("two-col-branch-recom", "default"
 * drawer, "three-col") and had already drifted in wording and behavior. One component now
 * renders every layout's recommendation panel for a consistent design.
 */
const RecommendationPanel: React.FC<{
  selectedPb: ProjectBranch | null | undefined;
  renderCandidatesList: (horizontal: boolean) => React.ReactNode;
  /** Fixed pixel width (three-col inspector). Omit and set flex to fill remaining space. */
  width?: number;
  /** Fill remaining horizontal space instead of a fixed width (two-col / drawer). */
  flex?: boolean;
  horizontal?: boolean;
  showAllCandidates: boolean;
  onToggleShowAll: (v: boolean) => void;
  slaEnabled: boolean;
  onToggleSla: (v: boolean) => void;
  slaRadius: number;
  onSlaRadiusChange: (v: number) => void;
  onRefresh: () => void;
  onAccept: (assignmentId: string, proposedFee: number) => void;
  onCounter: (assignment: NonNullable<ProjectBranch['assignment']>) => void;
  onDecline: (assignmentId: string) => void;
  /** Opens the branch's full timeline — the completed/closed panel is otherwise a dead end. */
  onViewHistory: (projectBranchId: string) => void;
}> = ({
  selectedPb, renderCandidatesList, width = 380, flex = false, horizontal = false,
  showAllCandidates, onToggleShowAll, slaEnabled, onToggleSla, slaRadius, onSlaRadiusChange,
  onRefresh, onAccept, onCounter, onDecline, onViewHistory,
}) => {
  const isDone = selectedPb && (
    ['AUDIT_COMPLETED', 'VALIDATION_COMPLETED', 'CLOSED'].includes(selectedPb.status) ||
    selectedPb.assignment?.status === 'COMPLETED'
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden', ...(flex ? { flex: 1, minWidth: 0 } : { width: `${width}px`, minWidth: `${width}px` }) }}>
      {selectedPb ? (
        isDone ? (
          /* Read-only Completion Summary for completed/under-validation branches */
          <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '24px' }}>{selectedPb.status === 'CLOSED' ? '✅' : '🔍'}</span>
              <div>
                <div style={{ fontSize: '15px', fontWeight: 800, color: selectedPb.status === 'CLOSED' ? 'var(--success)' : 'var(--warning)' }}>
                  {selectedPb.status === 'CLOSED' ? 'Audit Closed & Finalized' : 'Audit Completed — Under Validation'}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '3px' }}>
                  {selectedPb.branch.name} • {selectedPb.branch.city}, {selectedPb.branch.state}
                </div>
              </div>
            </div>
            {selectedPb.assignment && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px', background: 'var(--bg-surface-2)', borderRadius: '8px', border: '1px solid var(--border-hair)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <div>
                    <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' }}>ASSAYER</div>
                    <div style={{ fontSize: '13px', color: 'var(--accent)', fontWeight: 600 }}>👤 {selectedPb.assignment.assayer?.displayName}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' }}>AGREED FEE</div>
                    <div style={{ fontSize: '13px', color: 'var(--success)', fontWeight: 700 }}>₹{selectedPb.assignment.agreedFee ?? selectedPb.assignment.proposedFee ?? '—'}</div>
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '9px', fontWeight: 700, color: 'var(--text-muted)', marginBottom: '2px' }}>BRANCH STATUS</div>
                  <span style={{ fontSize: '12px', padding: '2px 8px', borderRadius: '4px', background: selectedPb.status === 'CLOSED' ? 'var(--status-active-bg)' : 'var(--status-pending-bg)', color: selectedPb.status === 'CLOSED' ? 'var(--success)' : 'var(--warning)', fontWeight: 700 }}>
                    {selectedPb.status.replace(/_/g, ' ')}
                  </span>
                </div>
              </div>
            )}
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontStyle: 'italic', lineHeight: 1.5 }}>
              This branch audit is {selectedPb.status === 'CLOSED' ? 'closed and finalized' : 'completed and currently under validator review'}. No further scheduling or reassignment actions are available.
            </div>
            <button
              onClick={() => onViewHistory(selectedPb.id)}
              style={{
                marginTop: '10px', padding: '8px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                background: 'var(--bg-page)', border: '1px solid var(--border-color)',
                color: 'var(--text-primary)', fontSize: '12px', fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: '6px', width: '100%', justifyContent: 'center',
              }}
            >
              View full branch history
            </button>
          </div>
        ) : (
          <>
            {selectedPb.status === 'NEGOTIATION' && selectedPb.assignment && (
              <NegotiationBanner
                assignment={selectedPb.assignment}
                onAccept={() => onAccept(selectedPb.assignment!.id, selectedPb.assignment!.proposedFee)}
                onCounter={() => onCounter(selectedPb.assignment!)}
                onDecline={() => onDecline(selectedPb.assignment!.id)}
              />
            )}

            {/* Branch Header & SLA Controls Bar */}
            <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-surface-2)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 700 }}>MATCHING INSPECTOR</span>
                  <div style={{ fontSize: '15px', fontWeight: 800, color: 'var(--text-primary)', marginTop: '1px' }}>{selectedPb.branch.name}</div>
                </div>
                <button onClick={onRefresh}
                  className="btn btn-secondary" title="Refresh candidates"
                  style={{ padding: '4px 8px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <RefreshCw size={11} /> Refresh
                </button>
              </div>

              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox" checked={showAllCandidates} onChange={(e) => onToggleShowAll(e.target.checked)} />
                  Show Distant (&gt;700km)
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: slaEnabled ? 'var(--warning)' : 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox" checked={slaEnabled} onChange={(e) => onToggleSla(e.target.checked)} />
                  Min Radius Filter
                </label>
                {slaEnabled && (
                  <select value={slaRadius} onChange={e => onSlaRadiusChange(Number(e.target.value))}
                    style={{ fontSize: '10px', padding: '2px 5px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--warning)', outline: 'none', cursor: 'pointer' }}>
                    {[25, 50, 100, 150, 200, 300, 500].map(v => <option key={v} value={v}>{v}km</option>)}
                  </select>
                )}
              </div>
            </div>

            {/* Scored Candidate Cards Container */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
              {renderCandidatesList(horizontal)}
            </div>
          </>
        )
      ) : (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', padding: '24px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
          👈 Select a branch from the left queue or click a map marker to inspect candidate matches.
        </div>
      )}
    </div>
  );
};

export const PlanningWorkspace: React.FC = () => {
  const { toast } = useToast();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(searchParams.get('projectId') || '');
  const [branches, setBranches] = useState<ProjectBranch[]>([]);
  const [zones, setZones] = useState<{ id: string; name: string }[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(null);
  const [historyBranchId, setHistoryBranchId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [isLoadingQueue, setIsLoadingQueue] = useState(false);
  const [isLoadingCandidates, setIsLoadingCandidates] = useState(false);
  const [excludedCandidates, setExcludedCandidates] = useState<ExcludedCandidate[]>([]);
  const [candidatesError, setCandidatesError] = useState<string | null>(null);
  const [routePoints, setRoutePoints] = useState<{ latitude: number; longitude: number }[] | undefined>(undefined);
  const [isOptimizing, setIsOptimizing] = useState(false);
  const [optimizedSummary, setOptimizedSummary] = useState<{ totalDistanceKm: number; totalDurationMinutes: number } | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [stateFilter, setStateFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [cityFilter, setCityFilter] = useState('');
  const [districtFilter, setDistrictFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('ALL');
  const [zoneFilter, setZoneFilter] = useState('ALL');

  const [showNegotiationModal, setShowNegotiationModal] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null);
  const [selectedCandidateForMap, setSelectedCandidateForMap] = useState<Candidate | null>(null);
  const [negotiatingFee, setNegotiatingFee] = useState('1500');
  const [commercialBaseFee, setCommercialBaseFee] = useState<number | null>(null);
  const [loadingCommercial, setLoadingCommercial] = useState(false);
  const [autoDispatch, setAutoDispatch] = useState(true);
  const [scheduledAuditDate, setScheduledAuditDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  });

  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [showAssayerDetailModal, setShowAssayerDetailModal] = useState(false);
  const [detailAssayer, setDetailAssayer] = useState<AssayerDetail | null>(null);
  const [detailRemarks, setDetailRemarks] = useState<Remark[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [showAllCandidates, setShowAllCandidates] = useState(false);
  const [slaEnabled, setSlaEnabled] = useState(true);
  const [slaRadius, setSlaRadius] = useState(50);

  // Single source of truth for "which candidates are actually eligible right now". The map
  // previously ranked off the raw `candidates` array, so an assayer who fails the min-radius
  // check (too close to the branch — see the "Inside Radius" flag below) could still show a
  // gold #1 badge on the map, contradicting the sidebar which excludes/flags them. Both now
  // read from this one filtered list.
  const displayCandidates = useMemo(() => {
    const slaFiltered = slaEnabled
      ? candidates.filter(c => c.distanceKm !== null && c.distanceKm >= slaRadius)
      : null;
    return slaFiltered ?? (showAllCandidates
      ? candidates
      : candidates.filter(c => c.distanceKm === null || c.distanceKm <= 700));
  }, [candidates, slaEnabled, slaRadius, showAllCandidates]);
  const drawerRef = useRef<HTMLDivElement>(null);
  const [dayPlanData, setDayPlanData] = useState<ProjectDayPlan | null>(null);
  const [isLoadingDayPlans, setIsLoadingDayPlans] = useState(false);
  const [expandedCluster, setExpandedCluster] = useState<string | null>(null);
  // Day plans previously had no date picker at all — always locked to the backend's default
  // of "right now", with no way to ask "what would tomorrow's coverage look like". Defaults to
  // tomorrow since field audits are scheduled ahead, not same-day.
  const [dayPlanTargetDate, setDayPlanTargetDate] = useState<string>(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  });
  const [dayPlanAssigning, setDayPlanAssigning] = useState<string | null>(null);

  useEffect(() => { loadProjects(); loadZones(); }, []);

  useSocketInvalidation();

  useEffect(() => {
    const socket = connectSocket();
    if (!socket) return;
    const handleRealtimeUpdate = () => {
      if (selectedProjectId) {
        loadProjectBranches(selectedProjectId);
      }
    };
    socket.on('assignment:counter-offered', handleRealtimeUpdate);
    socket.on('assignment:status-changed', handleRealtimeUpdate);
    socket.on('schedule:created', handleRealtimeUpdate);
    return () => {
      socket.off('assignment:counter-offered', handleRealtimeUpdate);
      socket.off('assignment:status-changed', handleRealtimeUpdate);
      socket.off('schedule:created', handleRealtimeUpdate);
    };
  }, [selectedProjectId]);

  useEffect(() => {
    if (selectedProjectId) {
      loadProjectBranches(selectedProjectId);
      setRoutePoints(undefined);
      setOptimizedSummary(null);
    } else {
      setBranches([]);
      setSelectedBranchId(null);
    }
  }, [selectedProjectId]);

  useEffect(() => {
    const selectedPb = branches.find(b => b.id === selectedBranchId);
    setSelectedCandidateForMap(null);
    if (selectedPb) {
      loadCandidates(selectedPb.branchId);
    } else {
      setCandidates([]);
    }
  }, [selectedBranchId, branches]);

  const { on: onSocketEvent } = useSocket();

  useEffect(() => {
    const unsubs: (() => void)[] = [];

    const refresh = () => {
      if (selectedBranchId) {
        const selectedPb = branches.find(b => b.id === selectedBranchId);
        if (selectedPb) loadCandidates(selectedPb.branchId);
      }
    };

    unsubs.push(onSocketEvent('assignment:created', refresh));
    unsubs.push(onSocketEvent('assignment:status-changed', refresh));
    unsubs.push(onSocketEvent('assignment:fee-updated', refresh));
    unsubs.push(onSocketEvent('schedule:created', refresh));
    unsubs.push(onSocketEvent('schedule:updated', refresh));

    return () => unsubs.forEach(u => u());
  }, [selectedBranchId, branches]);

  useEffect(() => {
    if (selectedBranchId && drawerRef.current) {
      drawerRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedBranchId]);

  const handleOptimizeRoute = async (candidate: Candidate) => {
    let assignedBranches = branches.filter(b => b.assignment && b.assignment.assayer?.displayName === candidate.displayName);
    if (assignedBranches.length === 0 && selectedBranchId) {
      const currentPb = branches.find(b => b.id === selectedBranchId);
      if (currentPb) {
        assignedBranches = [currentPb];
      }
    }
    if (assignedBranches.length === 0) {
      toast({ type: 'warning', title: 'Nothing to route', message: `${candidate.displayName} has no branches selected yet. Pick at least one branch first.` });
      return;
    }
    const originLat = candidate.latitude ?? assignedBranches[0].branch.latitude;
    const originLng = candidate.longitude ?? assignedBranches[0].branch.longitude;
    if (!originLat || !originLng) { toast({ type: 'warning', title: 'No starting location', message: 'This assayer has no saved location yet, so a route cannot be worked out. Add their address in Workforce first.' }); return; }
    const destinations = assignedBranches.filter(b => b.branch.latitude !== null && b.branch.longitude !== null).map(b => ({ id: b.branch.id, latitude: b.branch.latitude!, longitude: b.branch.longitude! }));
    if (destinations.length === 0) { toast({ type: 'warning', title: 'No branch locations', message: 'None of these branches have a location saved, so a route cannot be worked out.' }); return; }
    setIsOptimizing(true);
    setOptimizedSummary(null);
    setRoutePoints(undefined);
    try {
      const data = await api.request<any>('/geo/route/optimize', {
        method: 'POST',
        body: JSON.stringify({ origin: { latitude: originLat, longitude: originLng }, destinations, roundTrip: true, mode: 'driving' })
      });
      const { optimizedSequence, totalDistanceKm, totalDurationMinutes } = data;
      const points = [{ latitude: originLat, longitude: originLng }];
      for (const destId of optimizedSequence) {
        const matchedBranch = assignedBranches.find(b => b.branch.id === destId);
        if (matchedBranch?.branch.latitude && matchedBranch.branch.longitude) points.push({ latitude: matchedBranch.branch.latitude, longitude: matchedBranch.branch.longitude });
      }
      points.push({ latitude: originLat, longitude: originLng });
      setRoutePoints(points);
      setOptimizedSummary({ totalDistanceKm, totalDurationMinutes });
    } catch { toast({ type: 'error', title: 'Route could not be calculated', message: 'Could not reach the routing service. Check your connection and try again.' }); }
    finally { setIsOptimizing(false); }
  };

  const loadProjects = async () => {
    try {
      const response = await api.request<ProjectOption[]>('/projects', { method: 'GET' });
      setProjects(response);
      if (response.length > 0) setSelectedProjectId(response[0].id);
    } catch { console.error('Failed to load projects'); }
  };

  const loadZones = async () => {
    try {
      const data = await api.request<{ id: string; name: string }[]>('/zones?limit=100');
      setZones(data || []);
    } catch { console.error('Failed to load zones'); }
  };

  const loadProjectBranches = async (projectId: string) => {
    setIsLoadingQueue(true);
    setMessage(null);
    try {
      const data = await api.request<ProjectBranch[]>(`/projects/${projectId}/branches`);
      setBranches(data);
      setSelectedBranchId(data.length > 0 ? data[0].id : null);
    } catch { console.error('Failed to fetch project branches queue'); }
    finally { setIsLoadingQueue(false); }
  };

  const loadDayPlans = async () => {
    if (!selectedProjectId) return;
    setIsLoadingDayPlans(true);
    setDayPlanData(null);
    try {
      // Reuses the exact "Min Radius Filter" control already on this page (slaEnabled/
      // slaRadius) instead of a separate day-plans-only control — one setting, consistent
      // everywhere. Previously this request sent no params at all: no date (always locked to
      // the backend's "right now" default) and no radius (the endpoint had no minimum-distance
      // concept whatsoever until this fix).
      const params = new URLSearchParams({ targetDate: dayPlanTargetDate });
      if (slaEnabled) params.set('minDistanceKm', String(slaRadius));
      const data = await api.request<ProjectDayPlan>(`/planning/projects/${selectedProjectId}/day-plans?${params}`);
      setDayPlanData(data);
      if (data.clusters?.length > 0) setExpandedCluster(data.clusters[0].cluster.clusterId);
    } catch (err) { console.error('Failed to load day plans', err); }
    finally { setIsLoadingDayPlans(false); }
  };

  /**
   * Commits a day-plan candidate: creates a real assignment for every branch in the cluster,
   * all with this assayer and the plan's target date.
   *
   * Previously this whole screen was read-only — a detailed, correctly-computed report of the
   * optimal multi-branch route and cost that ops could only look at, then had to go re-create
   * by hand, branch by branch, through the single-branch flow. That defeats the point of
   * clustering in the first place: the value is committing to all N branches in one action.
   *
   * Base + travel cost is split evenly across the cluster's branches so each created
   * assignment carries a real proposed fee (summing back to the plan's estimatedTotalCost)
   * rather than 0 or a guess.
   */
  const handleAssignDayPlan = async (cluster: BranchCluster, plan: DayPlanCandidate) => {
    const key = `${cluster.clusterId}:${plan.assayerId}`;
    setDayPlanAssigning(key);
    const perBranchFee = Math.round(
      (plan.estimatedBaseFee + plan.estimatedTravelFee) / Math.max(1, plan.totalBranches),
    );

    const results: { branchName: string; ok: boolean; error?: string }[] = [];
    for (const stop of plan.stops) {
      const branchMeta = cluster.branches.find((b) => b.branchId === stop.branchId);
      if (!branchMeta) {
        results.push({ branchName: stop.branchName, ok: false, error: 'Branch missing from cluster data' });
        continue;
      }
      try {
        await api.request('/assignments', {
          method: 'POST',
          body: JSON.stringify({
            projectBranchId: branchMeta.id,
            assayerId: plan.assayerId,
            proposedFee: perBranchFee,
            scheduledDate: dayPlanTargetDate,
            remarks: `Assigned via Day Plan ${cluster.clusterId} — ${plan.totalBranches}-branch route with ${plan.assayerName}`,
          }),
        });
        results.push({ branchName: stop.branchName, ok: true });
      } catch (err: any) {
        results.push({ branchName: stop.branchName, ok: false, error: err?.message || 'Failed' });
      }
    }

    setDayPlanAssigning(null);
    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) {
      setMessage({ type: 'success', text: `Assigned all ${results.length} branch(es) in ${cluster.clusterId} to ${plan.assayerName}.` });
    } else {
      setMessage({
        type: 'error',
        text: `${results.length - failed.length}/${results.length} branches assigned to ${plan.assayerName}. Failed: ${failed.map((f) => `${f.branchName} (${f.error})`).join('; ')}`,
      });
    }
    if (selectedProjectId) loadProjectBranches(selectedProjectId);
    loadDayPlans();
  };

  const loadCandidates = async (branchId: string) => {
    setIsLoadingCandidates(true);
    setCandidatesError(null);
    try {
      // withMeta so we also receive `excluded` — candidates the engine filtered out, with the
      // reason. Previously they vanished silently and ops had no way to tell "nobody suitable"
      // apart from "everyone blocked by one misconfigured rule".
      const response = await api.request<{ data: Candidate[]; meta?: { excluded?: ExcludedCandidate[] } }>(
        `/planning/recommendations?branchId=${branchId}`,
        { method: 'GET', withMeta: true },
      );
      setCandidates(response.data || []);
      setExcludedCandidates(response.meta?.excluded || []);
    } catch (err: any) {
      // Was a bare `catch { console.error(...) }`, so a failure looked identical to
      // "no candidates" — the operator saw an empty list with no indication anything broke.
      setCandidates([]);
      setExcludedCandidates([]);
      setCandidatesError(err?.message || 'Could not load candidate recommendations.');
    }
    finally { setIsLoadingCandidates(false); }
  };

  const loadAssayerDetail = async (assayerId: string) => {
    setLoadingDetail(true);
    setShowAssayerDetailModal(true);
    try {
      const [profile, remarks] = await Promise.all([
        api.request<AssayerDetail>(`/assayers/${assayerId}/profile`, { method: 'GET' }),
        api.request<Remark[]>(`/assayers/${assayerId}/remark`, { method: 'GET' }),
      ]);
      setDetailAssayer(profile);
      setDetailRemarks(Array.isArray(remarks) ? remarks : []);
    } catch { console.error('Failed to load assayer details'); }
    finally { setLoadingDetail(false); }
  };

  const handleConfirmAssignment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedBranchId || !selectedCandidate) return;
    setMessage(null);
    setShowNegotiationModal(false);
    try {
      await api.request('/assignments', {
        method: 'POST',
        body: JSON.stringify({
          projectBranchId: selectedBranchId,
          assayerId: selectedCandidate.id,
          proposedFee: Number(negotiatingFee),
          scheduledDate: scheduledAuditDate,
          autoSchedule: autoDispatch,
        })
      });
      setMessage({ type: 'success', text: `Assigned ${selectedCandidate.displayName} to branch. Assayer will receive the offer on their mobile app.` });
      loadProjectBranches(selectedProjectId);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Scheduling failed due to validation rules.' });
    }
  };

  const handleExportCoverageReport = () => {
    if (!selectedProjectId || branches.length === 0) return;

    const data = branches.map((b) => ({
      'Branch Code': b.branch?.branchCode || '',
      'SOL ID': b.branch?.solId || '',
      'Branch Name': b.branch?.name || '',
      'City': b.branch?.city || '',
      'District': b.branch?.district || '',
      'State': b.branch?.state || '',
      'Priority': b.priority || '',
      'Zone ID': b.zoneId || '',
      'Status': b.status,
      'Audit Coverage Possible': ['ASSIGNMENT_CONFIRMED', 'SCHEDULED', 'AUDIT_COMPLETED'].includes(b.status) ? 'YES' : 'NO (Uncovered)',
      'Assigned Assayer': b.assignment?.assayer?.displayName || 'Unassigned',
      'Assignment Status': b.assignment?.status || '—',
      'Proposed Fee (₹)': b.assignment?.proposedFee ?? '—',
      'Agreed Fee (₹)': b.assignment?.agreedFee ?? '—',
      'Scheduled Date': b.assignment?.scheduledDate
        ? new Date(b.assignment.scheduledDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
        : b.scheduledDate
        ? new Date(b.scheduledDate).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
        : 'N/A',
      'Remarks': b.remarks || '',
    }));

    const ws = xlsx.utils.json_to_sheet(data);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Branch Coverage Schedule');
    xlsx.writeFile(wb, `Branch_Coverage_Report_${selectedProjectId}.xlsx`);
  };

  const statesList = Array.from(new Set(branches.map(b => b.branch?.state).filter(Boolean)));
  const filteredBranches = branches.filter(b => {
    const q = searchTerm.toLowerCase();
    return (b.branch?.name.toLowerCase().includes(q) || b.branch?.branchCode.toLowerCase().includes(q)) &&
      (stateFilter === 'ALL' || b.branch?.state === stateFilter) &&
      (statusFilter === 'ALL' || b.status === statusFilter) &&
      (cityFilter === '' || (b.branch?.city || '').toLowerCase().includes(cityFilter.toLowerCase())) &&
      (districtFilter === '' || (b.branch?.district || '').toLowerCase().includes(districtFilter.toLowerCase())) &&
      (priorityFilter === 'ALL' || b.priority === priorityFilter) &&
      (zoneFilter === 'ALL' || b.zoneId === zoneFilter);
  });
  const selectedPb = branches.find(b => b.id === selectedBranchId);
  const totalCount = branches.length;
  const confirmedCount = branches.filter(b => b.status === 'ASSIGNMENT_CONFIRMED' || b.status === 'SCHEDULED').length;
  const coveragePct = totalCount > 0 ? Number(((confirmedCount / totalCount) * 100).toFixed(1)) : 0;

  const layoutMode = localStorage.getItem('planning_layout') || 'default';
  const [layout, setLayout] = useState(layoutMode);
  const setLayoutMode = (m: string) => { setLayout(m); localStorage.setItem('planning_layout', m); };

  // ── Counter-offer negotiation handlers ──────────────────────────────────────────
  // Previously this exact logic (and the banner that triggers it) was hand-duplicated in the
  // "default" and "three-col" layouts, with the two copies already drifted apart in wording —
  // and missing entirely from "two-col-branch-recom", so a counter-offer arriving while that
  // layout was active was invisible until switching layouts. One definition now, used by all
  // three via the shared NegotiationBanner component below.
  const handleAcceptCounterOffer = async (assignmentId: string, proposedFee: number) => {
    try {
      await api.request(`/assignments/${assignmentId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus: 'ACCEPTED' }),
      });
      setMessage({ type: 'success', text: `Counter fee ₹${proposedFee.toLocaleString()} approved! Branch confirmed.` });
      if (selectedProjectId) loadProjectBranches(selectedProjectId);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to approve counter offer' });
    }
  };

  const handleOpenCounterProposal = (assignment: NonNullable<ProjectBranch['assignment']>) => {
    if (assignment.assayer) {
      setSelectedCandidate({ id: assignment.assayer.id, displayName: assignment.assayer.displayName } as any);
      setNegotiatingFee(String(assignment.proposedFee || 1500));
      setShowNegotiationModal(true);
    }
  };

  const handleDeclineCounterOffer = async (assignmentId: string) => {
    try {
      await api.request(`/assignments/${assignmentId}/transition`, {
        method: 'POST',
        body: JSON.stringify({ targetStatus: 'REJECTED', reason: 'Counter fee rejected by Operations Manager' }),
      });
      setMessage({ type: 'success', text: 'Counter offer rejected. Branch returned to candidate search.' });
      if (selectedProjectId) loadProjectBranches(selectedProjectId);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to reject counter offer' });
    }
  };

  const s = (sel: string, set: (v: string) => void, opts: { value: string; label: string }[]) => (
    <select value={sel} onChange={e => set(e.target.value)}
      style={{ padding: '7px 10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px', cursor: 'pointer' }}>
      {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );

  const renderCandidatesList = (horizontal: boolean) => {
    if (isLoadingCandidates) {
      return <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px' }}>Searching for assayers...</div>;
    }
    // A failed request previously rendered as "no candidates", which is indistinguishable from
    // a genuine empty result — the operator would go looking for assayers that were never queried.
    if (candidatesError) {
      return (
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', color: 'var(--danger)', fontSize: '12.5px', textAlign: 'center' }}>
          <AlertTriangle size={18} />
          <div>{candidatesError}</div>
          <button className="btn btn-secondary" style={{ fontSize: '11px', padding: '4px 10px' }}
            onClick={() => { const pb = branches.find(b => b.id === selectedBranchId); if (pb) loadCandidates(pb.branchId); }}>
            Retry
          </button>
        </div>
      );
    }
    if (displayCandidates.length === 0) {
      const msg = slaEnabled
        ? `No assayers found beyond ${slaRadius}km minimum radius.`
        : 'No suitable assayers found within 700km.';
      return (
        <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '13px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px' }}>
          <AlertTriangle size={20} style={{ color: 'var(--accent-secondary)' }} />
          <span>{msg}</span>
          {!slaEnabled && !showAllCandidates && candidates.length > 0 && (
            <button onClick={() => setShowAllCandidates(true)} className="btn btn-secondary" style={{ padding: '4px 8px', fontSize: '10px' }}>
              Show all ({candidates.length}) candidates
            </button>
          )}
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', gap: '12px', overflowX: horizontal ? 'auto' : 'hidden', flexDirection: horizontal ? 'row' : 'column', paddingBottom: '4px' }}>
        {displayCandidates.map(c => {
          const conf = c.score != null ? Math.round(c.score) : c.distanceKm != null && c.distanceKm < 30 ? 98 : c.distanceKm != null && c.distanceKm < 60 ? 88 : 74;
          const slaStatus = slaEnabled && c.distanceKm !== null
            ? (c.distanceKm >= slaRadius ? 'compliant' : 'breach')
            : null;
          const cardBorderColor = slaStatus === 'compliant' ? 'var(--status-active-bg)' : slaStatus === 'breach' ? 'var(--status-cancelled-bg)' : 'var(--border-color)';
          const cardBg = slaStatus === 'compliant' ? 'var(--status-active-bg)' : slaStatus === 'breach' ? 'var(--status-cancelled-bg)' : 'var(--bg-surface-2)';
          return (
            <div key={c.id} style={{
              minWidth: horizontal ? '320px' : 'auto', maxWidth: horizontal ? '340px' : 'auto', flexShrink: horizontal ? 0 : undefined,
              background: cardBg, border: `1px solid ${cardBorderColor}`, borderRadius: 'var(--radius-md)', padding: '14px',
              display: 'flex', flexDirection: 'column', gap: '10px'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '14px', fontWeight: 700, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {c.displayName}
                    {c.pendingOnThisBranch && (
                      <span title="This assayer already has a pending offer on this branch awaiting their response" style={{ fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '6px', background: 'var(--status-pending-bg)', color: 'var(--warning)', whiteSpace: 'nowrap', flexShrink: 0 }}>
                        ⏳ Pending Response
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px', marginTop: '2px', flexWrap: 'wrap' }}>
                    <Compass size={11} style={{ flexShrink: 0 }} />
                    <span>{c.distanceKm !== null ? `${c.distanceKm} km away` : 'Distance unavailable'}</span>
                    {slaEnabled && c.distanceKm !== null && (
                      <span style={{ fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: '4px', background: c.distanceKm >= slaRadius ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)', color: c.distanceKm >= slaRadius ? 'var(--success)' : 'var(--danger)' }}>
                        {c.distanceKm >= slaRadius ? `✓ >${slaRadius}km Radius` : `✗ Inside Radius`}
                      </span>
                    )}
                  </div>
                </div>
                <span title="Weighted across 15 dimensions including SLA compliance, acceptance history, proximity, workload, paperwork quality and cost." style={{ cursor: 'help', padding: '3px 8px', borderRadius: '8px', fontSize: '11px', fontWeight: 700, background: conf >= 90 ? 'var(--status-active-bg)' : 'var(--status-pending-bg)', color: conf >= 90 ? 'var(--status-active)' : 'var(--warning)', flexShrink: 0 }}>
                  {conf}% Match
                </span>
              </div>

              <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between', gap: '8px', background: 'var(--bg-surface-2)', padding: '6px 8px', borderRadius: '4px' }}>
                <span>📞 {c.phone}</span>
                <span>📍 {c.city}, {c.state}</span>
                <span>Base: ₹{c.baseFee ?? 1200}</span>
              </div>

              <ScoreBreakdown breakdown={c.scoreBreakdown} />

              {/* Row 1 Actions: View Map, Route TSP, Profile Details */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' }}>
                <button onClick={() => {
                  setSelectedCandidateForMap(selectedCandidateForMap?.id === c.id ? null : c);
                  if (layout.startsWith('two-col')) {
                    setLayoutMode('three-col');
                  }
                }}
                  className="btn btn-secondary" style={{ padding: '6px', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', background: selectedCandidateForMap?.id === c.id ? 'rgba(216,174,71,0.2)' : 'var(--bg-primary)', borderColor: selectedCandidateForMap?.id === c.id ? 'var(--accent-secondary)' : 'var(--border-color)', color: selectedCandidateForMap?.id === c.id ? 'var(--accent-secondary)' : 'var(--text-primary)' }}>
                  👁️ Map
                </button>
                <button onClick={async () => {
                  if (layout.startsWith('two-col')) {
                    setLayoutMode('three-col');
                  }
                  setSelectedCandidateForMap(c);
                  await handleOptimizeRoute(c);
                }} disabled={isOptimizing}
                  className="btn btn-secondary" style={{ padding: '6px', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                  <Compass size={11} /> {isOptimizing ? 'Routing...' : 'Route'}
                </button>
                <button onClick={() => loadAssayerDetail(c.id)}
                  className="btn btn-secondary" style={{ padding: '6px', fontSize: '11px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                  <Search size={11} /> Details
                </button>
              </div>

              {/* Row 2 Actions: Call & Negotiate vs Direct App Invite */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                <button onClick={async () => {
                  setSelectedCandidate(c);
                  setCommercialBaseFee(null);
                  setLoadingCommercial(true);
                  try {
                    const profile = await api.request<{ baseFee: number } | null>(`/assayers/${c.id}/commercial/active`, { method: 'GET' });
                    const baseFee = Number(profile?.baseFee ?? c.baseFee ?? 1200);
                    const distanceKm = c.distanceKm || 0;
                    const travelAllowance = Math.round(Math.max(0, distanceKm - 10) * 8);
                    const recommendedFee = baseFee + travelAllowance;
                    setCommercialBaseFee(baseFee);
                    setNegotiatingFee(recommendedFee.toString());
                  } catch {
                    const baseFee = Number(c.baseFee ?? 1200);
                    const distanceKm = c.distanceKm || 0;
                    const travelAllowance = Math.round(Math.max(0, distanceKm - 10) * 8);
                    const recommendedFee = baseFee + travelAllowance;
                    setCommercialBaseFee(baseFee);
                    setNegotiatingFee(recommendedFee.toString());
                  } finally {
                    setLoadingCommercial(false);
                    setShowNegotiationModal(true);
                  }
                }}
                  className="btn btn-primary" style={{ padding: '7px 10px', fontSize: '11px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}>
                  <Phone size={12} /> Call & Assign
                </button>

                <button onClick={async () => {
                  const selectedPb = branches.find(b => b.id === selectedBranchId);
                  if (!selectedPb) return;
                  try {
                    await api.request('/assignments', {
                      method: 'POST',
                      body: JSON.stringify({
                        projectBranchId: selectedPb.id,
                        assayerId: c.id,
                        remarks: 'Dispatched directly via App Invitation',
                      }),
                    });
                    setMessage({ type: 'success', text: `App invitation dispatched directly to ${c.displayName}!` });
                    if (selectedProjectId) loadProjectBranches(selectedProjectId);
                  } catch (err: any) {
                    setMessage({ type: 'error', text: err.message || 'Direct dispatch failed' });
                  }
                }}
                  className="btn btn-secondary" style={{ padding: '7px 10px', fontSize: '11px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px', background: 'var(--status-active-bg)', color: 'var(--status-active)', borderColor: 'var(--status-active-bg)' }}>
                  📲 Direct App Invite
                </button>
              </div>

              {optimizedSummary && routePoints && selectedCandidate?.id === c.id && (
                <div style={{ padding: '8px 10px', background: 'rgba(216,174,71,0.05)', border: '1px dashed rgba(216,174,71,0.3)', borderRadius: 'var(--radius-sm)', fontSize: '11px', color: 'var(--accent-secondary)', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  <div><b>🗺️ Optimized Route Details:</b></div>
                  <div>• Distance: {optimizedSummary.totalDistanceKm} km</div>
                  <div>• Est. Travel Time: {optimizedSummary.totalDurationMinutes} minutes</div>
                  <div>• Est. Travel Fee: ₹{(optimizedSummary.totalDistanceKm * 8).toFixed(0)} (₹8/km)</div>
                  <div style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Path covers multiple branch locations with TSP roundtrip routing optimization.</div>
                </div>
              )}
            </div>
          );
        })}
        <ExcludedCandidatesPanel excluded={excludedCandidates} />
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 64px)', overflow: 'hidden', margin: '-20px', background: 'var(--bg-page)' }}>
      {/* ── HIGH-DENSITY TOP COMMAND HEADER ── */}
      <div style={{
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--border-hair)',
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '12px',
        flexShrink: 0,
        zIndex: 30,
      }}>
        {/* Left: Workspace Title & Project Dropdown */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ fontSize: '13px', fontWeight: 800, color: 'var(--accent)', letterSpacing: '0.5px' }}>
              📍 STAGE 1: ASSAYER MATCHING
            </span>
          </div>
          <select
            value={selectedProjectId}
            onChange={e => setSelectedProjectId(e.target.value)}
            style={{
              padding: '5px 10px',
              background: 'var(--bg-input)',
              border: '1px solid rgba(216,174,71,0.35)',
              borderRadius: '6px',
              color: 'var(--text-primary)',
              fontSize: '12px',
              fontWeight: 700,
              outline: 'none',
              cursor: 'pointer',
              maxWidth: '220px',
            }}
          >
            {projects.map(p => <option key={p.id} value={p.id}>{p.name} ({p.projectNumber})</option>)}
          </select>
        </div>

        {/* Center: Stage Pipeline Switcher */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', background: 'var(--bg-surface-2)', padding: '3px 6px', borderRadius: '16px', border: '1px solid var(--border-hair)' }}>
          <div onClick={() => navigate('/planning')} style={{ padding: '3px 10px', background: 'var(--accent)', borderRadius: '12px', color: 'var(--on-accent)', fontSize: '11px', fontWeight: 800, cursor: 'pointer' }}>
            Stage 1: Match Assayers
          </div>
          <span style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>➔</span>
          <div onClick={() => navigate('/scheduling')} style={{ padding: '3px 10px', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>
            Stage 2: Dispatch
          </div>
          <span style={{ color: 'var(--text-secondary)', fontSize: '10px' }}>➔</span>
          <div onClick={() => navigate('/assignments')} style={{ padding: '3px 10px', color: 'var(--text-muted)', fontSize: '11px', fontWeight: 600, cursor: 'pointer' }}>
            Stage 3: Execution
          </div>
        </div>

        {/* Right: Key Metrics & Report Export */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
            <span style={{ color: 'var(--text-muted)' }}>Total: <b style={{ color: 'var(--text-primary)' }}>{totalCount}</b></span>
            <span style={{ padding: '2px 6px', borderRadius: '10px', background: 'var(--status-active-bg)', color: 'var(--success)', fontWeight: 700 }}>
              {coveragePct}% ({confirmedCount})
            </span>
            <span style={{ padding: '2px 6px', borderRadius: '10px', background: 'var(--status-pending-bg)', color: 'var(--warning)', fontWeight: 700 }}>
              Pending ({totalCount - confirmedCount})
            </span>
          </div>

          <button
            onClick={handleExportCoverageReport}
            style={{
              background: 'var(--status-active-bg)',
              border: '1px solid var(--status-active-bg)',
              borderRadius: '6px',
              color: 'var(--success)',
              cursor: 'pointer',
              padding: '4px 10px',
              fontSize: '11px',
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            📥 Excel Report
          </button>
        </div>
      </div>

      {/* ── SECONDARY INLINE FILTERS BAR ── */}
      <div style={{
        background: 'var(--bg-surface-2)',
        borderBottom: '1px solid var(--border-hair)',
        padding: '5px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        flexShrink: 0,
        zIndex: 25,
      }}>
        {s(stateFilter, setStateFilter, [{ value: 'ALL', label: 'All States' }, ...statesList.map(s => ({ value: s, label: s }))])}
        {s(statusFilter, setStatusFilter, STATUS_OPTIONS)}
        {s(priorityFilter, setPriorityFilter, [{ value: 'ALL', label: 'All Priorities' }, { value: 'LOW', label: 'Low' }, { value: 'MEDIUM', label: 'Medium' }, { value: 'HIGH', label: 'High' }, { value: 'CRITICAL', label: 'Critical' }])}
        {s(zoneFilter, setZoneFilter, [{ value: 'ALL', label: 'All Zones' }, ...zones.map(z => ({ value: z.id, label: z.name }))])}
        <input
          type="text"
          placeholder="Filter city..."
          value={cityFilter}
          onChange={e => setCityFilter(e.target.value)}
          style={{ width: '100px', padding: '4px 8px', background: 'var(--bg-input)', border: '1px solid var(--border-hair)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none', fontSize: '11px' }}
        />
        <input
          type="text"
          placeholder="Filter district..."
          value={districtFilter}
          onChange={e => setDistrictFilter(e.target.value)}
          style={{ width: '100px', padding: '4px 8px', background: 'var(--bg-input)', border: '1px solid var(--border-hair)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none', fontSize: '11px' }}
        />

        {(() => {
          const activeCount = [stateFilter !== 'ALL', statusFilter !== 'ALL', priorityFilter !== 'ALL', zoneFilter !== 'ALL', cityFilter !== '', districtFilter !== '', searchTerm !== ''].filter(Boolean).length;
          if (activeCount === 0) return null;
          return (
            <button
              type="button"
              onClick={() => { setStateFilter('ALL'); setStatusFilter('ALL'); setPriorityFilter('ALL'); setZoneFilter('ALL'); setCityFilter(''); setDistrictFilter(''); setSearchTerm(''); }}
              title="Clear all filters"
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 8px', fontSize: '11px', fontWeight: 600, color: 'var(--accent)', background: 'var(--status-pending-bg)', border: '1px solid var(--border-hair)', borderRadius: '4px', cursor: 'pointer', whiteSpace: 'nowrap' }}
            >
              <X size={12} /> Clear {activeCount}
            </button>
          );
        })()}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: '3px', alignItems: 'center' }}>
          {[
            ['default', 'Map + Drawer'],
            ['two-col-branch-recom', 'Branch + Match'],
            ['two-col-branch-map', 'Branch + Map'],
            ['three-col', '3 Column'],
            ['map-only', 'Map Only'],
            ['day-plans', '📋 Day Plans']
          ].map(([k, lbl]) => (
            <button
              key={k}
              onClick={() => { setLayoutMode(k); if (k === 'day-plans' && selectedProjectId && !dayPlanData) loadDayPlans(); }}
              style={{
                background: layout === k ? 'rgba(216,174,71,0.2)' : 'transparent',
                border: `1px solid ${layout === k ? 'var(--accent)' : 'var(--border-hair)'}`,
                borderRadius: '4px',
                color: layout === k ? 'var(--text-primary)' : 'var(--text-muted)',
                cursor: 'pointer',
                padding: '3px 7px',
                fontSize: '10px',
                fontWeight: layout === k ? 700 : 400,
              }}
            >
              {lbl}
            </button>
          ))}
        </div>
      </div>

      {/* ── Message Banner ── */}
      {message && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 16px', fontSize: '11px', borderBottom: '1px solid', background: message.type === 'success' ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)', borderColor: message.type === 'success' ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)', color: message.type === 'success' ? 'var(--accent-secondary)' : 'var(--danger)', flexShrink: 0 }}>
          <span>{message.text}</span>
        </div>
      )}

      {/* ── Layout: 2-Column (Branch Queue + Assayer Recommendations Panel) ── */}
      {layout === 'two-col-branch-recom' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'row', minHeight: 0, gap: '10px', padding: '8px', overflow: 'hidden' }}>
          {/* Column 1: Branch Queue */}
          <BranchListPanel
            branches={filteredBranches}
            loading={isLoadingQueue}
            selectedBranchId={selectedBranchId}
            onSelectBranch={setSelectedBranchId}
            searchTerm={searchTerm}
            onSearchTermChange={setSearchTerm}
            width={340}
          />

          {/* Column 2: Assayer Recommendations & Match Details */}
          <RecommendationPanel
            onViewHistory={setHistoryBranchId}
            selectedPb={selectedPb}
            renderCandidatesList={renderCandidatesList}
            flex
            showAllCandidates={showAllCandidates}
              onToggleShowAll={setShowAllCandidates}
              slaEnabled={slaEnabled}
              onToggleSla={setSlaEnabled}
              slaRadius={slaRadius}
              onSlaRadiusChange={setSlaRadius}
              onRefresh={() => { const pb = branches.find(b => b.id === selectedBranchId); if (pb) loadCandidates(pb.branchId); }}
            onAccept={handleAcceptCounterOffer}
            onCounter={handleOpenCounterProposal}
            onDecline={handleDeclineCounterOffer}
          />
        </div>
      )}

      {/* ── Layout: 2-Column (Branch Queue + Interactive Map) ── */}
      {(layout === 'two-col-branch-map' || (layout as any) === 'two-col') && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'row', minHeight: 0, gap: '10px', padding: '8px', overflow: 'hidden' }}>
          {/* Column 1: Branch Queue */}
          <BranchListPanel
            branches={filteredBranches}
            loading={isLoadingQueue}
            selectedBranchId={selectedBranchId}
            onSelectBranch={setSelectedBranchId}
            searchTerm={searchTerm}
            onSearchTermChange={setSearchTerm}
            width={340}
          />

          {/* Column 2: Interactive Planning Map */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
            <InteractivePlanningMap fillContainer
              branches={filteredBranches.map(b => ({ id: b.id, name: b.branch.name, latitude: b.branch.latitude, longitude: b.branch.longitude, status: b.status }))}
              selectedBranchId={selectedBranchId}
              onSelectBranch={id => setSelectedBranchId(id)}
              routePoints={routePoints}
              selectedAssayerFromParent={selectedCandidateForMap}
              slaEnabled={slaEnabled}
              slaRadius={slaRadius}
              rankedCandidates={displayCandidates}
              excludedCandidates={excludedCandidates}
            />
          </div>
        </div>
      )}

      {/* ── Layout: Default (Branch queue + Map + Assayer Match Drawer) ── */}
      {layout === 'default' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'row', minHeight: 0, gap: '8px', padding: '8px', overflow: 'hidden' }}>
          <BranchListPanel
            branches={filteredBranches}
            loading={isLoadingQueue}
            selectedBranchId={selectedBranchId}
            onSelectBranch={setSelectedBranchId}
            searchTerm={searchTerm}
            onSearchTermChange={setSearchTerm}
            width={280}
          />

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
            <InteractivePlanningMap fillContainer
              branches={filteredBranches.map(b => ({ id: b.id, name: b.branch.name, latitude: b.branch.latitude, longitude: b.branch.longitude, status: b.status }))}
              selectedBranchId={selectedBranchId}
              onSelectBranch={id => setSelectedBranchId(id)}
              routePoints={routePoints}
              selectedAssayerFromParent={selectedCandidateForMap}
              slaEnabled={slaEnabled}
              slaRadius={slaRadius}
              rankedCandidates={displayCandidates}
              excludedCandidates={excludedCandidates}
            />
            <div ref={drawerRef} style={{
              position: 'absolute', bottom: 0, left: 0, right: 0,
              maxHeight: selectedBranchId ? '280px' : '0px', overflow: 'hidden',
              transition: 'max-height 0.3s ease, opacity 0.2s ease', opacity: selectedBranchId ? 1 : 0, zIndex: 20,
              background: 'var(--bg-secondary)', borderTop: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
            }}>
              {selectedPb && (
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
                  <RecommendationPanel
                    onViewHistory={setHistoryBranchId}
                    selectedPb={selectedPb}
                    renderCandidatesList={renderCandidatesList}
                    flex
                    horizontal
                    showAllCandidates={showAllCandidates}
                    onToggleShowAll={setShowAllCandidates}
                    slaEnabled={slaEnabled}
                    onToggleSla={setSlaEnabled}
                    slaRadius={slaRadius}
                    onSlaRadiusChange={setSlaRadius}
                    onRefresh={() => { const pb = branches.find(b => b.id === selectedBranchId); if (pb) loadCandidates(pb.branchId); }}
                    onAccept={handleAcceptCounterOffer}
                    onCounter={handleOpenCounterProposal}
                    onDecline={handleDeclineCounterOffer}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Layout: 3-Column (Branch list + Map + Match Detail panel) ── */}
      {layout === 'three-col' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'row', minHeight: 0, gap: '10px', padding: '8px', overflow: 'hidden' }}>
          {/* Column 1: Branch Queue Panel */}
          <BranchListPanel
            branches={filteredBranches}
            loading={isLoadingQueue}
            selectedBranchId={selectedBranchId}
            onSelectBranch={setSelectedBranchId}
            searchTerm={searchTerm}
            onSearchTermChange={setSearchTerm}
            width={320}
          />

          {/* Column 2: Center Interactive GIS Map */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative', borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--border-color)' }}>
            <InteractivePlanningMap fillContainer
              branches={filteredBranches.map(b => ({ id: b.id, name: b.branch.name, latitude: b.branch.latitude, longitude: b.branch.longitude, status: b.status }))}
              selectedBranchId={selectedBranchId}
              onSelectBranch={id => setSelectedBranchId(id)}
              routePoints={routePoints}
              selectedAssayerFromParent={selectedCandidateForMap}
              slaEnabled={slaEnabled}
              slaRadius={slaRadius}
              rankedCandidates={displayCandidates}
              excludedCandidates={excludedCandidates}
            />
          </div>

          {/* Column 3: Right Match & Counter-Offer Inspector Panel */}
          <RecommendationPanel
            onViewHistory={setHistoryBranchId}
            selectedPb={selectedPb}
            renderCandidatesList={renderCandidatesList}
            width={380}
            showAllCandidates={showAllCandidates}
            onToggleShowAll={setShowAllCandidates}
            slaEnabled={slaEnabled}
            onToggleSla={setSlaEnabled}
            slaRadius={slaRadius}
            onSlaRadiusChange={setSlaRadius}
            onRefresh={() => { const pb = branches.find(b => b.id === selectedBranchId); if (pb) loadCandidates(pb.branchId); }}
            onAccept={handleAcceptCounterOffer}
            onCounter={handleOpenCounterProposal}
            onDecline={handleDeclineCounterOffer}
          />
        </div>
      )}

      {/* ── Layout: Map Only ── */}
      {layout === 'map-only' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '0 0 32px' }}>
          <InteractivePlanningMap fillContainer
            branches={filteredBranches.map(b => ({ id: b.id, name: b.branch.name, latitude: b.branch.latitude, longitude: b.branch.longitude, status: b.status }))}
            selectedBranchId={selectedBranchId}
            onSelectBranch={id => setSelectedBranchId(id)}
            routePoints={routePoints}
            selectedAssayerFromParent={selectedCandidateForMap}
            slaEnabled={slaEnabled}
            slaRadius={slaRadius}
          />
        </div>
      )}

      {/* ── Negotiation Modal ── */}
      {showNegotiationModal && selectedCandidate && selectedPb && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
          <form onSubmit={handleConfirmAssignment} className="glass-card" style={{ width: '580px', display: 'flex', flexDirection: 'column', gap: '20px', padding: '24px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h4 style={{ fontSize: '16px', fontWeight: 600 }}>Confirm Assignment</h4>
              <button type="button" onClick={() => setShowNegotiationModal(false)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={18} /></button>
            </div>

            {/* Assayer Summary */}
            <div style={{ display: 'flex', gap: '14px', padding: '14px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
              <div style={{ width: '44px', height: '44px', borderRadius: '50%', background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--on-accent)', fontSize: '17px', fontWeight: 700, flexShrink: 0 }}>
                {selectedCandidate.displayName.charAt(0).toUpperCase()}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)' }}>{selectedCandidate.displayName}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '1px' }}>{selectedCandidate.assayerCode}</div>
                <div style={{ display: 'flex', gap: '10px', marginTop: '6px', fontSize: '11px', color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}><MapPin size={10} /> {selectedCandidate.city}, {selectedCandidate.state}</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}><Phone size={10} /> {selectedCandidate.phone}</span>
                  {selectedCandidate.email && <span style={{ display: 'flex', alignItems: 'center', gap: '3px' }}><Mail size={10} /> {selectedCandidate.email}</span>}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', flexShrink: 0 }}>
                <span style={{ padding: '2px 8px', borderRadius: '8px', fontSize: '11px', fontWeight: 600, background: (selectedCandidate.score ?? 74) >= 90 ? 'var(--status-active-bg)' : 'var(--status-pending-bg)', color: (selectedCandidate.score ?? 74) >= 90 ? 'var(--status-active)' : 'var(--warning)' }}>
                  {selectedCandidate.score != null ? Math.round(selectedCandidate.score) : selectedCandidate.distanceKm != null && selectedCandidate.distanceKm < 30 ? 98 : selectedCandidate.distanceKm != null && selectedCandidate.distanceKm < 60 ? 88 : 74}% Match
                </span>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}><Compass size={10} /> {selectedCandidate.distanceKm ?? 'N/A'} km</span>
              </div>
            </div>

            {/* Branch + Assignment details in 2-col grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <div style={{ padding: '12px', background: 'rgba(216,174,71,0.05)', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(216,174,71,0.15)' }}>
                <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Building2 size={11} /> BRANCH
                </div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{selectedPb.branch.name}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>{selectedPb.branch.city}, {selectedPb.branch.state}</div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px' }}>Code: {selectedPb.branch.branchCode}</div>
              </div>
              <div style={{ padding: '12px', background: 'var(--status-active-bg)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--status-active-bg)' }}>
                <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <TrendingUp size={11} /> ASSIGNMENT
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Status: </span>
                  <span style={{ color: 'var(--warning)', fontWeight: 600 }}>{selectedPb.status.replace(/_/g, ' ')}</span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Priority: </span>
                  <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{selectedPb.priority || 'Normal'}</span>
                </div>
                {selectedCandidate.baseFee != null && (
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                    <span style={{ color: 'var(--text-muted)' }}>Suggested Fee: </span>
                    <span style={{ color: 'var(--warning)', fontWeight: 600 }}>₹{selectedCandidate.baseFee.toLocaleString()}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Fee inputs */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <DollarSign size={11} /> Base Fee
                </label>
                <div style={{ padding: '10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: loadingCommercial ? 'var(--text-muted)' : 'var(--warning)', fontSize: '14px', fontWeight: 600 }}>
                  {loadingCommercial ? 'Loading...' : commercialBaseFee != null ? `₹${commercialBaseFee.toLocaleString()}` : selectedCandidate.baseFee != null ? `₹${selectedCandidate.baseFee.toLocaleString()}` : 'Not set'}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <TrendingUp size={11} /> Negotiation Fee
                </label>
                <div style={{ position: 'relative' }}>
                  <span style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '13px' }}>₹</span>
                  <input type="number" value={negotiatingFee} onChange={e => setNegotiatingFee(e.target.value)} required
                    style={{ width: '100%', padding: '10px 10px 10px 26px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '14px', boxSizing: 'border-box' }} />
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <label style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Calendar size={11} /> Audit Scheduled Date
                </label>
                <input type="date" value={scheduledAuditDate} onChange={e => setScheduledAuditDate(e.target.value)} required
                  style={{ width: '100%', padding: '10px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px', boxSizing: 'border-box' }} />
              </div>
            </div>

            {/* Auto-Dispatch Toggle Option */}
            <div style={{ padding: '10px 12px', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <input type="checkbox" id="autoDispatchToggle" checked={autoDispatch} onChange={e => setAutoDispatch(e.target.checked)} style={{ width: '16px', height: '16px', cursor: 'pointer' }} />
              <label htmlFor="autoDispatchToggle" style={{ fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer', userSelect: 'none' }}>
                <span style={{ fontWeight: 700, color: autoDispatch ? 'var(--success)' : 'var(--warning)' }}>
                  {autoDispatch ? '⚡ Fast-Track Direct Lock: ' : '📋 Send to Unscheduled Queue: '}
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  {autoDispatch ? 'Auto-creates calendar dispatch packet on acceptance' : 'Acceptance moves offer to Unscheduled Queue for manual dispatching'}
                </span>
              </label>
            </div>

            {/* Action buttons */}
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
              <button type="button" onClick={() => setShowNegotiationModal(false)} className="btn btn-secondary">Cancel</button>
              <button type="submit" className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <Check size={14} /> Confirm Commitment
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── Assayer Detail Modal ── */}
      {showAssayerDetailModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 101 }}>
          <div className="glass-card" style={{ width: '800px', maxHeight: '90vh', display: 'flex', flexDirection: 'column', padding: '24px', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexShrink: 0 }}>
              <h4 style={{ fontSize: '16px', fontWeight: 600 }}>Assayer Details</h4>
              <button onClick={() => { setShowAssayerDetailModal(false); setDetailAssayer(null); setDetailRemarks([]); }}
                style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}><X size={18} /></button>
            </div>

            <div style={{ overflowY: 'auto', flex: 1, paddingRight: '4px' }}>
              {loadingDetail ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading assayer details...</div>
              ) : !detailAssayer ? (
                <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Assayer not found.</div>
              ) : (
                <>
                  {(() => {
                    const effectiveTotal = Math.max(detailAssayer.totalAssignments, detailAssayer.auditHistory?.length || 0);
                    const effectiveCompleted = Math.max(detailAssayer.completedAssignments, detailAssayer.auditHistory?.filter(a => ['COMPLETED', 'AUDIT_COMPLETED', 'CLOSED', 'VALIDATION_COMPLETED'].includes(a.status)).length || 0);
                    const completionRate = effectiveTotal > 0
                      ? Math.round((effectiveCompleted / effectiveTotal) * 100) : 0;
                    const onTimeRate = effectiveCompleted > 0
                      ? Math.round((Math.max(detailAssayer.onTimeCompletions, effectiveCompleted) / effectiveCompleted) * 100) : 0;
                    return (
                      <>
                        {/* Header Card */}
                        <div className="glass-card" style={{ padding: '20px', borderRadius: 'var(--radius-md)', marginBottom: '16px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '12px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                              <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--on-accent)', fontSize: '18px', fontWeight: 700 }}>
                                {detailAssayer.displayName.charAt(0).toUpperCase()}
                              </div>
                              <div>
                                <h3 style={{ fontSize: '18px', fontWeight: 700, margin: 0 }}>{detailAssayer.displayName}</h3>
                                <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginTop: '2px', flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{detailAssayer.assayerCode}</span>
                                  <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
                                  <span style={{ fontSize: '11px', padding: '1px 6px', borderRadius: '8px', background: detailAssayer.lifecycleStatus === 'ACTIVE' ? 'var(--status-active-bg)' : 'var(--status-pending-bg)', color: detailAssayer.lifecycleStatus === 'ACTIVE' ? 'var(--status-active)' : 'var(--warning)', fontWeight: 500 }}>{detailAssayer.lifecycleStatus}</span>
                                  <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
                                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '3px' }}><Briefcase size={10} /> {detailAssayer.employmentType}</span>
                                  <span style={{ width: '3px', height: '3px', borderRadius: '50%', background: 'var(--text-muted)' }} />
                                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '3px' }}><Star size={10} /> {detailAssayer.experienceYears} yrs exp</span>
                                </div>
                              </div>
                            </div>
                            <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                              <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '24px', fontWeight: 700, color: detailAssayer.averageRating >= 4 ? 'var(--status-active)' : detailAssayer.averageRating >= 3 ? 'var(--warning)' : 'var(--danger)' }}>
                                  {Number(detailAssayer.averageRating) > 0 ? Number(detailAssayer.averageRating).toFixed(1) : '—'}
                                </div>
                                <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '1px' }}>Avg Rating</div>
                              </div>
                              <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: '24px', fontWeight: 700, color: 'var(--accent-primary)' }}>
                                  {Number(detailAssayer.performanceRating).toFixed(1)}
                                </div>
                                <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '1px' }}>Perf. Rating</div>
                              </div>
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--border-color)' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><MapPin size={11} /> {detailAssayer.city}, {detailAssayer.state}</div>
                            {detailAssayer.phone && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><Phone size={11} /> {detailAssayer.phone}</div>}
                            {detailAssayer.email && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><Mail size={11} /> {detailAssayer.email}</div>}
                            {detailAssayer.department && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><Briefcase size={11} /> {detailAssayer.department}</div>}
                            {detailAssayer.region && <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}><MapPin size={11} /> Region: {detailAssayer.region}</div>}
                          </div>
                        </div>

                        {/* KPI Cards */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: '10px', marginBottom: '16px' }}>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><Briefcase size={10} /> Total Audits</div>
                            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--accent-primary)' }}>{effectiveTotal}</div>
                          </div>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><CheckCircle size={10} /> Completed</div>
                            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--status-active)' }}>{effectiveCompleted}</div>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '1px' }}>{completionRate}%</div>
                          </div>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><TrendingUp size={10} /> Acceptance</div>
                            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--accent)' }}>{detailAssayer.acceptanceRate ?? 100}%</div>
                          </div>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><X size={10} /> Rejection Rate</div>
                            <div style={{ fontSize: '20px', fontWeight: 700, color: (detailAssayer.rejectionRate || 0) > 15 ? 'var(--danger)' : 'var(--success)' }}>{detailAssayer.rejectionRate ?? 0}%</div>
                          </div>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><AlertTriangle size={10} /> Queries Raised</div>
                            <div style={{ fontSize: '20px', fontWeight: 700, color: (detailAssayer.queryCount || 0) > 0 ? 'var(--warning)' : 'var(--success)' }}>{detailAssayer.queryCount ?? 0}</div>
                          </div>
                          <div className="glass-card" style={{ padding: '12px', borderRadius: 'var(--radius-md)' }}>
                            <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '3px' }}><DollarSign size={10} /> Total Paid</div>
                            <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--warning)' }}>₹{Number(detailAssayer.totalEarnings).toLocaleString()}</div>
                          </div>
                        </div>

                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                          {/* Left: Skills & Certifications */}
                          <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
                            <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><Award size={13} /> Skills & Certifications</h4>
                            <div style={{ marginBottom: '10px' }}>
                              <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>SKILLS</div>
                              {detailAssayer.skills && detailAssayer.skills.length > 0 ? (
                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px' }}>
                                  {detailAssayer.skills.map(s => (
                                    <span key={s} style={{ padding: '2px 6px', background: 'rgba(216,174,71,0.1)', color: 'var(--accent-primary)', borderRadius: '8px', fontSize: '10px' }}>{s}</span>
                                  ))}
                                </div>
                              ) : (
                                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No skills recorded</div>
                              )}
                            </div>
                            <div>
                              <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>CERTIFICATIONS</div>
                              {detailAssayer.certifications && detailAssayer.certifications.length > 0 ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                  {detailAssayer.certifications.map(c => (
                                    <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 6px', background: 'var(--status-active-bg)', borderRadius: 'var(--radius-sm)' }}>
                                      <span style={{ fontSize: '11px', color: 'var(--text-primary)' }}>{c.name}</span>
                                      <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>Exp: {new Date(c.expiryDate).toLocaleDateString()}</span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No certifications recorded</div>
                              )}
                            </div>
                          </div>

                          {/* Right: Performance Insights */}
                          <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
                            <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><TrendingUp size={13} /> Performance Insights</h4>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                              <div>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>COMPLETION RATE</div>
                                <div style={{ height: '6px', background: 'var(--bg-primary)', borderRadius: '3px', overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: `${completionRate}%`, background: completionRate >= 80 ? 'var(--status-active)' : completionRate >= 50 ? 'var(--warning)' : 'var(--danger)', borderRadius: '3px', transition: 'width 0.3s' }} />
                                </div>
                                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '1px' }}>{completionRate}%</div>
                              </div>
                              <div>
                                <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>ON-TIME DELIVERY</div>
                                <div style={{ height: '6px', background: 'var(--bg-primary)', borderRadius: '3px', overflow: 'hidden' }}>
                                  <div style={{ height: '100%', width: `${onTimeRate}%`, background: onTimeRate >= 80 ? 'var(--status-active)' : onTimeRate >= 50 ? 'var(--warning)' : 'var(--danger)', borderRadius: '3px', transition: 'width 0.3s' }} />
                                </div>
                                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '1px' }}>{onTimeRate}%</div>
                              </div>
                              {detailAssayer.activeCommercialProfile && (
                                <div style={{ padding: '8px', background: 'rgba(216,174,71,0.1)', borderRadius: '6px', border: '1px solid rgba(216,174,71,0.2)' }}>
                                  <div style={{ fontSize: '10px', color: 'var(--accent)', fontWeight: 700, marginBottom: '2px' }}>ACTIVE COMMERCIAL RATE</div>
                                  <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>₹{detailAssayer.activeCommercialProfile.baseFee?.toLocaleString()} / audit</div>
                                  <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>
                                    Travel: ₹{detailAssayer.activeCommercialProfile.travelReimbursement || 0}/km | Daily: ₹{detailAssayer.activeCommercialProfile.dailyRate || 0}
                                  </div>
                                </div>
                              )}
                              {detailAssayer.totalEarnings > 0 && (
                                <div>
                                  <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '3px' }}>AVERAGE EARNINGS PER JOB</div>
                                  <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--warning)' }}>
                                    ₹{Math.round(Number(detailAssayer.totalEarnings) / Math.max(detailAssayer.completedAssignments, 1)).toLocaleString()}
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Audit History Timeline */}
                        <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)', marginTop: '14px' }}>
                          <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><Calendar size={13} /> Audit History & Fee Logs</h4>
                          {detailAssayer.auditHistory && detailAssayer.auditHistory.length > 0 ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '200px', overflowY: 'auto' }}>
                              {detailAssayer.auditHistory.map(ah => (
                                <div key={ah.id} style={{ padding: '8px 10px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', borderLeft: '3px solid var(--accent)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <div>
                                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)' }}>{ah.branch_name || 'Branch Audit'}</div>
                                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{ah.branch_city}, {ah.branch_state} | {ah.project_name || 'GSS Project'}</div>
                                  </div>
                                  <div style={{ textAlign: 'right' }}>
                                    <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--warning)' }}>₹{(ah.agreed_fee || ah.proposed_fee || 0).toLocaleString()}</div>
                                    <span style={{ fontSize: '9px', padding: '1px 5px', borderRadius: '3px', background: 'rgba(216,174,71,0.2)', color: 'var(--accent)', fontWeight: 600 }}>{ah.status}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div style={{ textAlign: 'center', padding: '12px', color: 'var(--text-muted)', fontSize: '11px' }}>No audit history recorded.</div>
                          )}
                        </div>

                        {/* Remarks */}
                        <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)', marginTop: '14px' }}>
                          <h4 style={{ fontSize: '13px', fontWeight: 600, margin: '0 0 10px', display: 'flex', alignItems: 'center', gap: '5px' }}><Star size={13} /> Reviews & Remarks</h4>
                          {detailRemarks.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '12px', color: 'var(--text-muted)', fontSize: '11px' }}>No remarks yet.</div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '300px', overflowY: 'auto' }}>
                              {detailRemarks.map(r => (
                                <div key={r.id} style={{ padding: '8px 10px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', borderLeft: `3px solid ${CATEGORY_COLORS[r.category] || 'var(--text-muted)'}` }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '3px' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                                      <span style={{ fontSize: '9px', padding: '1px 4px', borderRadius: '3px', background: `${CATEGORY_COLORS[r.category] || 'var(--text-muted)'}20`, color: CATEGORY_COLORS[r.category] || 'var(--text-muted)', fontWeight: 600 }}>{r.category}</span>
                                      <span style={{ fontSize: '9px', color: 'var(--text-muted)' }}>by {r.authorName}</span>
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '1px' }}>
                                      {r.rating != null && [1, 2, 3, 4, 5].map(s => (
                                        <Star key={s} size={9} fill={s <= r.rating! ? 'var(--warning)' : 'none'} color={s <= r.rating! ? 'var(--warning)' : 'var(--text-muted)'} />
                                      ))}
                                    </div>
                                  </div>
                                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.4 }}>{r.content}</div>
                                  <div style={{ fontSize: '9px', color: 'var(--text-muted)', marginTop: '2px' }}>{new Date(r.createdAt).toLocaleString()}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </>
                    );
                  })()}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Layout: Day Plans (Multi-Branch Cluster View) ── */}
      {layout === 'day-plans' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, padding: '0 32px 32px', overflowY: 'auto' }}>
          {/* Header & Refresh */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0 8px', flexWrap: 'wrap', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <Layers size={18} style={{ color: 'var(--accent-primary)' }} />
              <h2 style={{ fontSize: '16px', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>Multi-Branch Day Plans</h2>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Clusters nearby branches → assigns single assayer per cluster for one-day coverage</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '11px', color: 'var(--text-secondary)' }}>
                <Calendar size={12} />
                <input type="date" value={dayPlanTargetDate} min={new Date().toISOString().split('T')[0]}
                  onChange={(e) => setDayPlanTargetDate(e.target.value)}
                  style={{ padding: '4px 6px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '11px', outline: 'none' }} />
              </label>
              {/* Same control that drives the single-branch candidate list and map — reused
                  here rather than a separate day-plans-only setting, so "Min Radius Filter"
                  means one thing everywhere on this page. */}
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: slaEnabled ? 'var(--warning)' : 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}>
                <input type="checkbox" checked={slaEnabled} onChange={(e) => setSlaEnabled(e.target.checked)} />
                Min Radius Filter
              </label>
              {slaEnabled && (
                <select value={slaRadius} onChange={(e) => setSlaRadius(Number(e.target.value))}
                  style={{ fontSize: '10px', padding: '2px 5px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--warning)', outline: 'none', cursor: 'pointer' }}>
                  {[25, 50, 100, 150, 200, 300, 500].map(v => <option key={v} value={v}>{v}km</option>)}
                </select>
              )}
              <button onClick={loadDayPlans} disabled={isLoadingDayPlans}
                className="btn btn-primary" style={{ padding: '6px 14px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                <Route size={13} /> {isLoadingDayPlans ? 'Generating...' : 'Generate Day Plans'}
              </button>
            </div>
          </div>

          {dayPlanData?.effectiveMinDistanceKm != null && (
            <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', paddingBottom: '4px' }}>
              Enforcing a {dayPlanData.effectiveMinDistanceKm}km minimum distance
              {!slaEnabled || dayPlanData.effectiveMinDistanceKm > slaRadius
                ? " (this client's own configured floor — it always applies, regardless of the filter above)"
                : ''}.
            </div>
          )}

          {isLoadingDayPlans && (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-secondary)', fontSize: '13px' }}>
              <div className="loading-spinner" style={{ width: '30px', height: '30px', border: '3px solid var(--border-color)', borderTop: '3px solid var(--accent-primary)', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 12px' }} />
              Analyzing branch clusters, calculating routes & scoring assayers...
            </div>
          )}

          {!isLoadingDayPlans && !dayPlanData && (
            <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--text-muted)', fontSize: '13px' }}>
              <Layers size={40} style={{ color: 'var(--border-color)', margin: '0 auto 12px', display: 'block' }} />
              Click "Generate Day Plans" to cluster branches and find optimal assayer assignments.
            </div>
          )}

          {dayPlanData && (
            <>
              {/* Summary KPI Bar */}
              <div style={{ display: 'flex', gap: '16px', padding: '10px 0 14px', flexWrap: 'wrap' }}>
                {[
                  // Throughput first: an assayer-day is bought whole, so packets-per-day and
                  // cost-per-packet are what decide whether the day is worth committing —
                  // more so than the branch count.
                  { label: 'Packets / Day', value: dayPlanData.summary.averagePacketsPerDay || '—', icon: <Layers size={13} />, color: 'var(--accent-primary)' },
                  { label: 'Cost / Packet', value: dayPlanData.summary.averageCostPerPacket != null ? `₹${dayPlanData.summary.averageCostPerPacket.toLocaleString()}` : '—', icon: <DollarSign size={13} />, color: 'var(--accent)' },
                  { label: 'Total Packets', value: dayPlanData.summary.totalPackets || '—', icon: <Briefcase size={13} />, color: 'var(--status-active)' },
                  { label: 'Assayer-Days', value: dayPlanData.summary.totalAssayersNeeded, icon: <Users size={13} />, color: 'var(--warning)' },
                  { label: 'Branches Covered', value: dayPlanData.summary.totalBranchesCovered, icon: <Building2 size={13} />, color: 'var(--status-active)' },
                  { label: 'Est. Total Cost', value: `₹${dayPlanData.summary.estimatedTotalCost.toLocaleString()}`, icon: <DollarSign size={13} />, color: 'var(--accent)' },
                  { label: 'Avg Utilization', value: `${dayPlanData.summary.averageUtilization.toFixed(0)}%`, icon: <TrendingUp size={13} />, color: dayPlanData.summary.averageUtilization >= 70 ? 'var(--status-active)' : 'var(--warning)' },
                ].map((kpi, idx) => (
                  <div key={idx} style={{ background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', padding: '10px 16px', minWidth: '130px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' as const }}>{kpi.icon} {kpi.label}</div>
                    <div style={{ fontSize: '20px', fontWeight: 700, color: kpi.color }}>{kpi.value}</div>
                  </div>
                ))}
              </div>

              {/* Date moved because the requested day couldn't be worked. Previously the
                  planner would plan a holiday and only fail later, at assign time. */}
              {dayPlanData.dateAdjustment && (
                <div style={{ background: 'rgba(216,174,71,0.06)', border: '1px solid rgba(216,174,71,0.25)', borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Calendar size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                  <div style={{ fontSize: '11.5px', color: 'var(--accent)' }}>
                    <b>{dayPlanData.dateAdjustment.requestedDate}</b> can't be worked — {dayPlanData.dateAdjustment.reason}
                    {' '}Planned for <b>{dayPlanData.targetDate}</b> instead.
                  </div>
                </div>
              )}

              {/* The core signal this whole mechanism exists to surface: a full paid day
                  being spent on a couple of hours of work. */}
              {dayPlanData.underutilizedBranches.length > 0 && (
                <div style={{ background: 'var(--status-cancelled-bg)', border: '1px solid var(--status-cancelled-bg)', borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: '12px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--danger)', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <AlertTriangle size={13} /> {dayPlanData.underutilizedBranches.length} branch(es) would use a full paid day for a few hours of work
                  </div>
                  <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                    No neighbouring branch was close enough to bundle. Consider deferring these into a cycle where they can share a day.
                  </div>
                  {dayPlanData.underutilizedBranches.map((b, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: '8px', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '3px' }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-primary)', minWidth: '160px' }}>{b.branchName}</span>
                      <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{b.idleHours}h idle</span>
                      <span style={{ color: 'var(--text-muted)' }}>
                        {b.packetCount != null ? `${b.packetCount} packets ≈ ${b.auditHours}h` : `~${b.auditHours}h (no packet count recorded)`}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Unclustered branches warning */}
              {dayPlanData.unclusteredBranches.length > 0 && (
                <div style={{ background: 'var(--status-pending-bg)', border: '1px solid var(--status-pending-bg)', borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: '12px' }}>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--warning)', marginBottom: '6px' }}>⚠️ {dayPlanData.unclusteredBranches.length} Branch(es) Could Not Be Clustered</div>
                  {dayPlanData.unclusteredBranches.map((b, i) => (
                    <div key={i} style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '2px' }}>• {b.branchName}: {b.reason}</div>
                  ))}
                </div>
              )}

              {/* Clusters */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {dayPlanData.clusters.map(({ cluster, dayPlans, bestPlan, excludedAssayers }) => (
                  <div key={cluster.clusterId} style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
                    {/* Cluster Header */}
                    <div onClick={() => setExpandedCluster(expandedCluster === cluster.clusterId ? null : cluster.clusterId)}
                      style={{ padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        background: expandedCluster === cluster.clusterId ? 'rgba(216,174,71,0.06)' : 'transparent',
                        borderBottom: expandedCluster === cluster.clusterId ? '1px solid var(--border-color)' : 'none' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--accent-primary)', background: 'rgba(216,174,71,0.1)', padding: '3px 8px', borderRadius: '4px' }}>{cluster.clusterId}</span>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{cluster.branches.length} Branches</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                          {cluster.branches.map(b => b.branchName.replace(/^(Pune |Nashik |Mumbai |Bangalore )/, '')).join(' → ')}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        {cluster.totalPackets > 0 && (
                          <span style={{ fontSize: '11px', color: 'var(--accent-primary)', fontWeight: 700 }}>{cluster.totalPackets} packets</span>
                        )}
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}><Clock size={11} /> {cluster.totalEstimatedAuditHours}h audit</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-secondary)' }}><MapPin size={11} /> {cluster.radiusKm.toFixed(0)}km radius</span>
                        <span style={{ fontSize: '11px', fontWeight: 600, color: cluster.feasibleForOneDay ? 'var(--status-active)' : 'var(--danger)' }}>
                          {cluster.feasibleForOneDay ? '✅ Fits 1 day' : '❌ Exceeds capacity'}
                        </span>
                        {bestPlan && (
                          <span style={{ fontSize: '11px', color: 'var(--warning)', fontWeight: 600 }}>
                            Best: {bestPlan.assayerName} (₹{bestPlan.estimatedTotalCost.toLocaleString()})
                          </span>
                        )}
                        <span style={{ fontSize: '14px', color: 'var(--text-muted)', transition: 'transform 0.2s', transform: expandedCluster === cluster.clusterId ? 'rotate(180deg)' : 'none' }}>▾</span>
                      </div>
                    </div>

                    {/* Expanded Cluster: Day Plan Candidates */}
                    {expandedCluster === cluster.clusterId && (
                      <div style={{ padding: '14px 16px' }}>
                        {/* Branches in this cluster */}
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '14px', flexWrap: 'wrap' }}>
                          {cluster.branches.map(b => (
                            <div key={b.branchId} style={{ background: 'rgba(216,174,71,0.06)', border: '1px solid rgba(216,174,71,0.15)', borderRadius: 'var(--radius-sm)', padding: '6px 10px', fontSize: '11px' }}>
                              <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{b.branchName}</div>
                              <div style={{ color: 'var(--text-muted)', fontSize: '10px' }}>
                                {b.branchCode} • {b.city} •{' '}
                                {b.packetCount != null
                                  ? <>{b.packetCount} packets → {b.estimatedDurationHours}h</>
                                  : (
                                    // Distinguished from a real packet-derived figure: this is a
                                    // stale per-branch default that may not reflect this cycle.
                                    <span title="No packet count recorded for this cycle — estimated from the branch default, which may be out of date.">
                                      ~{b.estimatedDurationHours}h <span style={{ color: 'var(--warning)' }}>(est.)</span>
                                    </span>
                                  )}
                              </div>
                            </div>
                          ))}
                        </div>

                        {dayPlans.length === 0 ? (
                          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)', fontSize: '12px' }}>
                            <AlertTriangle size={18} style={{ color: 'var(--warning)', marginBottom: '6px' }} />
                            <div>No eligible assayers found for this cluster.</div>
                            {/* Previously the only signal here — this generic dead end hid
                                whether it was a genuine no-coverage gap or one misconfigured
                                business rule blocking every candidate. */}
                            {excludedAssayers.length > 0 && (
                              <div style={{ marginTop: '10px', textAlign: 'left' }}>
                                <ExcludedCandidatesPanel excluded={excludedAssayers} />
                              </div>
                            )}
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                            {dayPlans.map((plan, pIdx) => (
                              <div key={plan.assayerId} style={{
                                background: pIdx === 0 ? 'var(--status-active-bg)' : 'var(--bg-surface-2)',
                                border: `1px solid ${pIdx === 0 ? 'var(--status-active-bg)' : 'var(--border-color)'}`,
                                borderRadius: 'var(--radius-md)', padding: '14px', position: 'relative' as const,
                              }}>
                                {pIdx === 0 && (
                                  <span style={{ position: 'absolute' as const, top: '-1px', right: '12px', background: 'var(--status-active)', color: 'var(--text-primary)', fontSize: '9px', fontWeight: 700, padding: '2px 8px', borderRadius: '0 0 4px 4px' }}>
                                    ⭐ RECOMMENDED
                                  </span>
                                )}

                                {/* Assayer Info Row */}
                                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '12px' }}>
                                  <div>
                                    <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                      {plan.assayerName}
                                      <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 400 }}>({plan.assayerCode})</span>
                                    </div>
                                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', gap: '10px', marginTop: '3px' }}>
                                      <span><Phone size={10} /> {plan.assayerPhone}</span>
                                      <span><MapPin size={10} /> {plan.assayerCity}</span>
                                    </div>
                                  </div>
                                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                    <span style={{
                                      padding: '4px 10px', borderRadius: '8px', fontSize: '12px', fontWeight: 700,
                                      background: plan.overallScore >= 70 ? 'var(--status-active-bg)' : plan.overallScore >= 50 ? 'var(--status-pending-bg)' : 'var(--status-cancelled-bg)',
                                      color: plan.overallScore >= 70 ? 'var(--status-active)' : plan.overallScore >= 50 ? 'var(--warning)' : 'var(--danger)',
                                    }}>
                                      {plan.overallScore}% Score
                                    </span>
                                    {/* Previously this whole page was read-only: a correctly
                                        computed multi-branch route and cost ops could only look
                                        at, then had to manually re-create branch by branch
                                        through the single-branch flow. This commits all
                                        branches in the cluster to this assayer in one action. */}
                                    <button
                                      onClick={() => handleAssignDayPlan(cluster, plan)}
                                      disabled={dayPlanAssigning !== null}
                                      className="btn btn-primary"
                                      style={{ padding: '6px 12px', fontSize: '11px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}>
                                      {dayPlanAssigning === `${cluster.clusterId}:${plan.assayerId}`
                                        ? <>Assigning…</>
                                        : <><Check size={12} /> Assign All {plan.totalBranches}</>}
                                    </button>
                                  </div>
                                </div>

                                {/* Metrics Grid */}
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', marginBottom: '12px' }}>
                                  {[
                                    // Packets and idle time lead: they answer "is this day worth
                                    // buying", which branch/hour counts alone don't.
                                    ...(plan.totalPackets > 0 ? [{ label: 'Packets', val: String(plan.totalPackets), icon: '📦', warn: false }] : []),
                                    ...(plan.costPerPacket != null ? [{ label: 'Cost / Packet', val: `₹${plan.costPerPacket.toLocaleString()}`, icon: '💰', warn: false }] : []),
                                    // Idle time is the cost of a badly-packed day, so it's called
                                    // out in amber once it passes roughly a quarter of the day.
                                    { label: 'Idle (paid)', val: `${plan.idleHours}h`, icon: plan.idleHours >= 3 ? '⚠️' : '✅', warn: plan.idleHours >= 3 },
                                    { label: 'Branches', val: String(plan.totalBranches), icon: '🏢', warn: false },
                                    { label: 'Audit Time', val: `${plan.totalAuditHours}h`, icon: '⏱️', warn: false },
                                    { label: 'Travel', val: `${plan.totalTravelKm.toFixed(0)}km / ${plan.totalTravelMinutes.toFixed(0)}min`, icon: '🚗', warn: false },
                                    { label: 'Total Day', val: `${plan.totalDayHours.toFixed(1)}h`, icon: '📅', warn: false },
                                    { label: 'Day Window', val: `${plan.dayStartTime} → ${plan.dayEndTime}`, icon: '🕐', warn: false },
                                    { label: 'Utilization', val: `${plan.utilizationPercent}%`, icon: plan.utilizationPercent >= 70 ? '🔥' : '📊', warn: false },
                                  ].map((m, mi) => (
                                    <div key={mi} style={{ background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', padding: '6px 10px' }}>
                                      <div style={{ fontSize: '9px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' as const }}>{m.icon} {m.label}</div>
                                      <div style={{ fontSize: '13px', fontWeight: 600, color: m.warn ? 'var(--warning)' : 'var(--text-primary)', marginTop: '2px' }}>{m.val}</div>
                                    </div>
                                  ))}
                                </div>

                                {/* Cost Breakdown */}
                                <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', padding: '8px 12px', background: 'rgba(216,174,71,0.04)', border: '1px dashed rgba(216,174,71,0.2)', borderRadius: 'var(--radius-sm)' }}>
                                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                                    <span style={{ fontWeight: 600 }}>💰 Cost:</span>{' '}
                                    Base ₹{plan.estimatedBaseFee.toLocaleString()} + Travel ₹{plan.estimatedTravelFee.toLocaleString()} ={' '}
                                    <span style={{ fontWeight: 700, color: 'var(--warning)' }}>₹{plan.estimatedTotalCost.toLocaleString()}</span>
                                  </div>
                                </div>

                                {/* Client Preferences Match */}
                                <div style={{ display: 'flex', gap: '6px', marginBottom: '12px', flexWrap: 'wrap' }}>
                                  {[
                                    { label: 'Skills', ok: plan.clientPreferencesMatch.skillsMatch },
                                    { label: 'Certifications', ok: plan.clientPreferencesMatch.certificationsMatch },
                                    { label: 'Distance', ok: plan.clientPreferencesMatch.distanceWithinRange },
                                    { label: 'Preferred', ok: plan.clientPreferencesMatch.isPreferredAssayer },
                                  ].map((pm, pi) => (
                                    <span key={pi} style={{
                                      fontSize: '10px', padding: '2px 6px', borderRadius: '4px',
                                      background: pm.ok ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)',
                                      color: pm.ok ? 'var(--status-active)' : 'var(--danger)',
                                      fontWeight: 600, display: 'flex', alignItems: 'center', gap: '3px',
                                    }}>
                                      {pm.ok ? <Check size={9} /> : <X size={9} />} {pm.label}
                                    </span>
                                  ))}
                                </div>

                                {/* Route Stops Timeline */}
                                <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '10px' }}>
                                  <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '5px' }}>
                                    <Route size={12} /> Route Schedule (Optimized TSP)
                                  </div>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                                    {plan.stops.map((stop, si) => (
                                      <div key={si} style={{ display: 'flex', alignItems: 'stretch', gap: '10px' }}>
                                        {/* Timeline connector */}
                                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '20px' }}>
                                          <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: si === 0 ? 'var(--accent-primary)' : 'var(--status-active)', flexShrink: 0, marginTop: '5px' }} />
                                          {si < plan.stops.length - 1 && <div style={{ width: '2px', flex: 1, background: 'var(--border-color)' }} />}
                                        </div>
                                        {/* Stop content */}
                                        <div style={{ flex: 1, paddingBottom: '10px' }}>
                                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                                              #{stop.order} {stop.branchName}
                                            </span>
                                            <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>({stop.branchCode})</span>
                                          </div>
                                          <div style={{ fontSize: '10px', color: 'var(--text-secondary)', display: 'flex', gap: '12px', marginTop: '2px' }}>
                                            <span>🕐 Arrive {stop.estimatedArrival} → Depart {stop.estimatedDeparture}</span>
                                            <span>⏱️ Audit: {stop.estimatedAuditHours}h</span>
                                            {stop.travelFromPreviousKm > 0 && (
                                              <span>🚗 Travel: {stop.travelFromPreviousKm}km ({stop.travelFromPreviousMinutes}min)</span>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                    {/* Return leg */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '20px' }}>
                                        <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--warning)', flexShrink: 0 }} />
                                      </div>
                                      <div style={{ fontSize: '11px', color: 'var(--warning)', fontWeight: 600 }}>🏠 Return Home by {plan.dayEndTime}</div>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Also shown alongside a non-empty result — ops sees not just who's
                            recommended but who was considered and ruled out, and why. */}
                        {dayPlans.length > 0 && excludedAssayers.length > 0 && (
                          <ExcludedCandidatesPanel excluded={excludedAssayers} />
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {historyBranchId && (
        <BranchHistoryDrawer projectBranchId={historyBranchId} onClose={() => setHistoryBranchId(null)} />
      )}
    </div>
  );
};
