import React from 'react';
import { useSocketConnection } from '../hooks/useSocketConnection';
import { ConflictModal } from '../components/ui';
import { AssignmentDetailDrawer } from './assignments/AssignmentDetailDrawer';
import { AssignmentQueueHeader } from './assignments/AssignmentQueueHeader';
import { AssignmentTable } from './assignments/AssignmentTable';
import {
  useAssignmentQueue,
  NEEDS_ATTENTION_FILTER,
} from './assignments/useAssignmentQueue';

export const Assignments: React.FC = () => {
  // Realtime socket tracking
  useSocketConnection();

  const {
    // Role permissions
    canActOnAssignments,
    // Selection state
    selectedAsnId,
    selectAssignment,
    selectedAsn,
    // Filters & Pagination
    statusFilter,
    applyFilter,
    page,
    setPage,
    total,
    totalPages,
    searchTerm,
    setSearchTerm,
    dateSort,
    setDateSort,
    currentViewLabel,
    showStageDrilldown,
    // Counts
    totalCount,
    activeCount,
    pendingCount,
    rejectedCount,
    escalatedCount,
    closedCount,
    cancelledCount,
    branchStatusCounts,
    // Issues
    openIssues,
    handledIssues,
    groupedIssues,
    showHandledIssues,
    setShowHandledIssues,
    openIssueAssignmentIds,
    // Data & Queries
    assignments,
    filteredAssignments,
    isLoading,
    isError,
    refetchList,
    todayStr,
    // Actions & Busy states
    quickBusyId,
    actionBusy,
    actionError,
    setActionError,
    quickAction,
    runTransition,
    runEscalate,
    askToComplete,
    planningLinkFor,
    // Export
    exporting,
    handleExport,
    // Modals
    confirmDialog,
    conflictModalOpen,
    setConflictModalOpen,
    conflictMessage,
    handleReloadLatest,
    confirm,
    confirmWithReason,
    error,
  } = useAssignmentQueue();

  const isAttentionView =
    statusFilter === NEEDS_ATTENTION_FILTER ||
    statusFilter === 'PENDING' ||
    statusFilter === 'REJECTED';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      {/* Workspace Header & Triage Chips */}
      <AssignmentQueueHeader
        totalCount={totalCount}
        activeCount={activeCount}
        pendingCount={pendingCount}
        rejectedCount={rejectedCount}
        escalatedCount={escalatedCount}
        closedCount={closedCount}
        cancelledCount={cancelledCount}
        branchStatusCounts={branchStatusCounts}
        statusFilter={statusFilter}
        applyFilter={applyFilter}
        showStageDrilldown={showStageDrilldown}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        currentViewLabel={currentViewLabel}
        exporting={exporting}
        handleExport={handleExport}
        onRefresh={handleReloadLatest}
        isError={isError}
        refetchList={refetchList}
        groupedIssues={groupedIssues}
        handledIssues={handledIssues}
        openIssues={openIssues}
        showHandledIssues={showHandledIssues}
        setShowHandledIssues={setShowHandledIssues}
        onSelectAssignment={selectAssignment}
      />

      {/* Split layout: List on Left, Detail Drawer on Right */}
      <div
        className="responsive-grid-split"
        style={{
          alignItems: 'start',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(320px, 400px)',
        }}
      >
        {/* Left Column - Multi-dimensional Assignments Queue Table */}
        <AssignmentTable
          assignments={assignments}
          filteredAssignments={filteredAssignments}
          selectedAsnId={selectedAsnId}
          onSelectAssignment={selectAssignment}
          statusFilter={statusFilter}
          searchTerm={searchTerm}
          isLoading={isLoading}
          page={page}
          total={total}
          totalPages={totalPages}
          setPage={setPage}
          dateSort={dateSort}
          setDateSort={setDateSort}
          quickBusyId={quickBusyId}
          onQuickAction={quickAction}
          isAttentionView={isAttentionView}
          openIssueAssignmentIds={openIssueAssignmentIds}
          todayStr={todayStr}
          isError={isError}
          error={error}
          onResetFilters={() => {
            applyFilter('ALL');
            setSearchTerm('');
          }}
          onRetry={() => {
            void refetchList();
          }}
        />

        {/* Right Column - Extracted Modular Details Panel */}
        <div
          className="glass-card"
          style={{
            padding: 0,
            display: 'flex',
            flexDirection: 'column',
            minHeight: '500px',
            overflow: 'hidden',
          }}
        >
          <AssignmentDetailDrawer
            assignment={selectedAsn}
            canActOnAssignments={canActOnAssignments}
            actionBusy={actionBusy}
            actionError={actionError}
            onClearActionError={() => setActionError(null)}
            onTransition={runTransition}
            onEscalate={runEscalate}
            askToComplete={askToComplete}
            planningLinkFor={planningLinkFor}
            confirm={confirm}
            confirmWithReason={confirmWithReason}
            hasOpenIssue={Boolean(selectedAsn?.id && openIssueAssignmentIds.has(selectedAsn.id))}
          />
        </div>
      </div>

      {confirmDialog}

      {/* Concurrent 409 conflict resolution experience */}
      <ConflictModal
        isOpen={conflictModalOpen}
        onClose={() => setConflictModalOpen(false)}
        onReload={handleReloadLatest}
        message={conflictMessage}
      />
    </div>
  );
};

export default Assignments;
