import React from 'react';
import type { Assayer } from '../assayer-shared';
import type { AssayerDossier, FrozenPayableItem, ActiveAssignment } from './record-types';
import { ProfileHeader } from './ProfileHeader';
import { LifecycleActionBar } from './LifecycleActionBar';
import { DeploymentReadinessCard } from './DeploymentReadinessCard';
import { KycReadinessCard } from './KycReadinessCard';
import { BankProfileCard } from './BankProfileCard';
import { FrozenPayoutDestinationCard } from './FrozenPayoutDestinationCard';
import { EmpanelmentStandingCard } from './EmpanelmentStandingCard';
import { CurrentAssignmentsCard } from './CurrentAssignmentsCard';
import { RecentTimelineCard, type TimelineEvent } from './RecentTimelineCard';

interface AssayerSummaryCockpitProps {
  assayer: Assayer;
  dossier: AssayerDossier | null;
  frozenPayables: FrozenPayableItem[];
  assignments: ActiveAssignment[];
  timelineEvents: TimelineEvent[];
  canManage: boolean;
  canDelete?: boolean;
  onLifecycleTransition: (toStatus: string, reason: string) => Promise<void>;
  onEditProfile?: () => void;
  onDeleteAssayer?: () => void;
  onNavigateTab: (tab: string) => void;
  onReload: () => void;
}

export const AssayerSummaryCockpit: React.FC<AssayerSummaryCockpitProps> = ({
  assayer,
  dossier,
  frozenPayables,
  assignments,
  timelineEvents,
  canManage,
  canDelete = false,
  onLifecycleTransition,
  onEditProfile,
  onDeleteAssayer,
  onNavigateTab,
  onReload,
}) => {
  return (
    <div
      data-testid="assayer-summary-cockpit"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        width: '100%',
      }}
    >
      {/* 1. Header: Identity, Canonical State, Location, Actions */}
      <ProfileHeader
        assayer={assayer}
        canManage={canManage}
        canDelete={canDelete}
        onEdit={onEditProfile}
        onDelete={onDeleteAssayer}
        onPinSaved={onReload}
      />

      {/* 2. Lifecycle Transition Bar: Forward path, side paths, rehire with consequences */}
      {canManage && (
        <LifecycleActionBar
          assayer={assayer}
          onTransition={onLifecycleTransition}
        />
      )}

      {/* 3. Core Operational Readiness (Grid on Desktop, stacked by priority on mobile) */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
          gap: '16px',
          alignItems: 'start',
        }}
      >
        {/* Q3 & Q4: Can they be deployed? Why blocked? */}
        <DeploymentReadinessCard
          assayer={assayer}
          dossier={dossier}
          onInspectDocuments={() => onNavigateTab('documents')}
          onInspectVetting={() => onNavigateTab('vetting')}
        />

        {/* Identity & Compliance Gate */}
        <KycReadinessCard
          dossier={dossier}
          assayerStatus={assayer.lifecycleStatus}
          onReviewDocuments={() => onNavigateTab('documents')}
        />
      </div>

      {/* 4. Financial & Payout Readiness (Live Bank vs. Frozen Payable Destination) */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
          gap: '16px',
          alignItems: 'start',
        }}
      >
        {/* Q5: Can they currently be paid? */}
        <BankProfileCard
          assayer={assayer}
          canManage={canManage}
          onEditBank={() => {
            if (onEditProfile) onEditProfile();
          }}
        />

        {/* Q6: What bank destination is associated with approved payables? */}
        <FrozenPayoutDestinationCard
          payables={frozenPayables}
        />
      </div>

      {/* 5. Work Execution & Client-Bank Empanelments */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
          gap: '16px',
          alignItems: 'start',
        }}
      >
        {/* Q7: What are they doing now? */}
        <CurrentAssignmentsCard
          assayerId={assayer.id}
          assignments={assignments}
        />

        {/* Client standings with hard-block invariants */}
        <EmpanelmentStandingCard
          empanelments={dossier?.empanelments || []}
          onManageVetting={() => onNavigateTab('vetting')}
        />
      </div>

      {/* 6. Activity & Audit Events (Confirmed backend events only) */}
      <RecentTimelineCard
        events={timelineEvents}
        onViewAll={() => onNavigateTab('history')}
      />
    </div>
  );
};
