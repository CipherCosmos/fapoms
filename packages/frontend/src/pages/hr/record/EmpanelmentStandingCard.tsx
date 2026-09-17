import React from 'react';
import { Building2, CheckCircle2, Clock, Ban } from 'lucide-react';
import { standingAllowsPlanning } from '@fapoms/shared';
import {
  HARD_BLOCKED_STANDINGS,
  STANDING_LABELS,
  STANDING_STANCE_TONE,
  humanizeEnum,
  standingStance,
} from '../AssayerVettingTab';
import type { ClientEmpanelment } from './record-types';

export interface EmpanelmentStandingCardProps {
  empanelments: ClientEmpanelment[];
  canManage?: boolean;
  onManageStandings?: () => void;
  onManageVetting?: () => void;
  onEditStanding?: (empanelment: ClientEmpanelment) => void;
}

/**
 * Invariant: hard-blocked standings can NEVER be overridden by any user or supervisor.
 *
 * The set itself lives once, in AssayerVettingTab.tsx, beside the dialog that enforces it there.
 * This card used to keep its own copy of the same four values, which is two lists waiting to
 * disagree the day a fifth is added.
 */
export const isHardBlockedStanding = (status: string | null | undefined): boolean =>
  HARD_BLOCKED_STANDINGS.has(status ?? '');

/** "Documents pending", never `DOCUMENTS_PENDING` — the words every other screen already uses. */
const standingLabel = (status: string): string => STANDING_LABELS[status] ?? humanizeEnum(status);

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
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>
              Client banks
            </span>
            <span style={{ display: 'block', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
              Each bank’s decision about this person
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
              fontSize: 'var(--text-xs)',
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
        <div style={{ padding: '12px', background: 'var(--bg-surface-2)', borderRadius: '6px', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          No banks recorded yet. Add each bank’s decision under Background so work from that bank can be offered.
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            maxHeight: '190px',
            overflowY: 'auto',
            paddingRight: '4px',
            scrollbarWidth: 'thin',
          }}
        >
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
                  fontSize: 'var(--text-xs)',
                  flexWrap: 'wrap',
                  gap: '6px',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <strong>{e.client?.name || 'Unknown client'}</strong>
                  {e.client?.clientCode && (
                    <span style={{ fontFamily: 'monospace', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
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
                      fontSize: 'var(--text-2xs)',
                      fontWeight: 700,
                      background: tone.bg,
                      color: tone.fg,
                      border: `1px solid ${tone.fg}`,
                    }}
                  >
                    {isPlannable && <CheckCircle2 size={11} />}
                    {isHardBlocked && <Ban size={11} />}
                    {!isPlannable && !isHardBlocked && <Clock size={11} />}
                    {standingLabel(e.status)}
                  </span>

                  {/* Actions: HARD-BLOCKED STANDINGS CANNOT BE OVERRIDDEN */}
                  {canManage && onEditStanding && (
                    isHardBlocked ? (
                      <span
                        data-testid={`hard-block-indicator-${rowKey}`}
                        style={{ fontSize: 'var(--text-2xs)', color: 'var(--danger)', fontWeight: 600 }}
                      >
                        Final
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
                          fontSize: 'var(--text-2xs)',
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
          style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', lineHeight: 1.4, borderTop: '1px dashed var(--border-hair)', paddingTop: '6px' }}
        >
          {hardBlocked.length === 1
            ? `${hardBlocked[0].client?.name || 'This bank'}’s decision is final. Nobody here can change it.`
            : 'These banks’ decisions are final. Nobody here can change them.'}
        </div>
      )}
    </div>
  );
};
