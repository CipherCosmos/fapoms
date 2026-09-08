import React from 'react';
import { Building2, CheckCircle2, Clock, Ban } from 'lucide-react';
import { EmpanelmentStatus, standingAllowsPlanning } from '@fapoms/shared';
import { STANDING_STANCE_TONE, standingStance } from '../AssayerVettingTab';
import type { ClientEmpanelment } from './record-types';

export interface EmpanelmentStandingCardProps {
  empanelments: ClientEmpanelment[];
  canManage?: boolean;
  onManageStandings?: () => void;
  onManageVetting?: () => void;
  onEditStanding?: (empanelment: ClientEmpanelment) => void;
}

// Invariant: Hard-blocked standings that can NEVER be overridden by any user/supervisor
export const HARD_BLOCKED_STANDINGS = new Set<string>([
  EmpanelmentStatus.REJECTED,
  EmpanelmentStatus.TERMINATED,
  'EXPIRED',
  'SUSPENDED',
]);

export const isHardBlockedStanding = (status: string | null | undefined): boolean =>
  HARD_BLOCKED_STANDINGS.has(status ?? '');

export const EmpanelmentStandingCard: React.FC<EmpanelmentStandingCardProps> = ({
  empanelments,
  canManage = false,
  onManageStandings,
  onManageVetting,
  onEditStanding,
}) => {
  const hardBlocked = empanelments.filter((e) => isHardBlockedStanding(e.status));

  return (
    <div
      data-testid="empanelment-standing-card"
      style={{
        background: 'var(--bg-surface-1)',
        border: '1px solid var(--border-color)',
        borderRadius: '10px',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Building2 size={16} style={{ color: 'var(--accent)' }} />
          <div>
            <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>
              Client Bank Empanelments
            </span>
            <span style={{ display: 'block', fontSize: '11px', color: 'var(--text-muted)' }}>
              Client-specific dispatch authorization
            </span>
          </div>
        </div>
        {(onManageStandings || onManageVetting) && (
          <button
            type="button"
            onClick={onManageStandings || onManageVetting}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--accent)',
              fontSize: '12px',
              cursor: 'pointer',
              textDecoration: 'underline',
              padding: 0,
            }}
          >
            Manage all
          </button>
        )}
      </div>

      {empanelments.length === 0 ? (
        <div style={{ padding: '12px', background: 'var(--bg-surface-2)', borderRadius: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>
          No client empanelments recorded on file. Add client standings under Vetting to enable partner-specific dispatch.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {empanelments.map((e) => {
            const isPlannable = standingAllowsPlanning(e.status);
            const isHardBlocked = isHardBlockedStanding(e.status);
            const tone = STANDING_STANCE_TONE[standingStance(e.status)];
            const rowKey = e.clientId || e.id;

            return (
              <div
                key={e.id}
                data-testid={`empanelment-row-${rowKey}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  background: 'var(--bg-surface-2)',
                  border: '1px solid var(--border-color)',
                  fontSize: '12px',
                  flexWrap: 'wrap',
                  gap: '6px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <strong>{e.client?.name || 'Unknown client'}</strong>
                  {e.client?.clientCode && (
                    <span style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--text-muted)' }}>
                      ({e.client.clientCode})
                    </span>
                  )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span
                    data-testid={`empanelment-badge-${rowKey}`}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '4px',
                      padding: '2px 8px',
                      borderRadius: '999px',
                      fontSize: '11px',
                      fontWeight: 700,
                      background: tone.bg,
                      color: tone.fg,
                      border: `1px solid ${tone.fg}`,
                    }}
                  >
                    {isPlannable && <CheckCircle2 size={11} />}
                    {isHardBlocked && <Ban size={11} />}
                    {!isPlannable && !isHardBlocked && <Clock size={11} />}
                    {e.status}
                  </span>

                  {/* Actions: HARD-BLOCKED STANDINGS CANNOT BE OVERRIDDEN */}
                  {canManage && onEditStanding && (
                    isHardBlocked ? (
                      <span
                        data-testid={`hard-block-indicator-${rowKey}`}
                        title="This standing is permanently hard-blocked by policy and cannot be overridden by operators or supervisors."
                        style={{ fontSize: '11px', color: 'var(--danger)', fontWeight: 600 }}
                      >
                        Non-overridable
                      </span>
                    ) : (
                      <button
                        type="button"
                        data-testid={`edit-standing-btn-${rowKey}`}
                        onClick={() => onEditStanding(e)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: 'var(--accent)',
                          fontSize: '11.5px',
                          cursor: 'pointer',
                          textDecoration: 'underline',
                          padding: 0,
                        }}
                      >
                        Update
                      </button>
                    )
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {hardBlocked.length > 0 && (
        <div
          data-testid="hard-block-explanation"
          style={{ fontSize: '11.5px', color: 'var(--text-muted)', lineHeight: 1.4, borderTop: '1px dashed var(--border-hair)', paddingTop: '6px' }}
        >
          <strong>Policy Notice:</strong> Standing is final and hard-blocked by policy. Restricted client standings (rejected, terminated, expired, suspended) are strictly non-overridable. No operator or supervisor bypass is permitted.
        </div>
      )}
    </div>
  );
};
