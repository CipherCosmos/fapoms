import { SystemRole } from '@fapoms/shared';

/**
 * The desk's two real roles, resolved once for every data-entry page.
 * Heads (and admins) run the desk; validators are the working members.
 */
export function deskRole(roles: SystemRole[]): { isHead: boolean; isValidator: boolean } {
  const isHead = roles.some((r) =>
    [SystemRole.DESK, SystemRole.ADMIN].includes(r));
  return { isHead, isValidator: !isHead && roles.includes(SystemRole.DESK_OPERATOR) };
}

export interface QueueCounts { unassigned: number; working: number; rework: number; done: number }
export interface PagedQueue<T> { counts: QueueCounts; total: number; page: number; limit: number; items: T[] }

export interface PacketRow {
  id: string; fileName: string; status: string;
  receivedAt: string | null; assignedAt: string | null; completedAt: string | null;
  projectBranchId: string | null; branchName: string | null; branchCode: string | null;
  assignedToUserId: string | null; assigneeName: string | null;
  caseStatus: string | null; lane: 'unassigned' | 'working' | 'rework' | 'done';
}

export interface CaseListRow {
  id: string; status: string; projectBranchId: string;
  reviewerId?: string | null; reviewerName?: string | null;
  createdAt?: string;
  projectBranch?: { branch?: { name: string; branchCode: string } };
}

export interface TeamMember { id: string; name: string; username: string; role: string }

export const deskCard: React.CSSProperties = {
  background: 'var(--bg-surface)', border: '1px solid var(--border-color)',
  borderRadius: '10px', padding: '14px',
};
export const deskLabel: React.CSSProperties = {
  fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)',
};

export { fmtWhen } from '../../utils/dates';
