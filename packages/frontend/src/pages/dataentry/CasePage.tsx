import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CaseWorkspace } from './CaseWorkspace';

/**
 * The case workspace on its own URL, so a packet is linkable from anywhere —
 * queues, clarifications, notifications — instead of living behind a query
 * param on the board.
 */
export const CasePage: React.FC = () => {
  const { branchId } = useParams<{ branchId: string }>();
  const navigate = useNavigate();
  if (!branchId) return null;
  return (
    <CaseWorkspace
      projectBranchId={branchId}
      onBack={() => (window.history.length > 1 ? navigate(-1) : navigate('/data-entry'))}
    />
  );
};

export default CasePage;
