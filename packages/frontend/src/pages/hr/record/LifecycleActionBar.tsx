import React, { useState } from 'react';
import { ArrowRight, RotateCcw } from 'lucide-react';
import {
  AssayerLifecycleStatus,
  assayerLifecycleLabel,
  nextAssayerLifecycleStates,
  nextOnboardingStep,
} from '@fapoms/shared';
import { LifecycleTransitionModal } from './LifecycleTransitionModal';

export interface LifecycleActionBarProps {
  currentStatus?: AssayerLifecycleStatus | string;
  assayerName?: string;
  assayerCode?: string;
  canManage?: boolean;
  assayer?: { lifecycleStatus: any; displayName: string; assayerCode: string };
  onTransition: (targetStatus: string, reason: string) => Promise<void>;
  busy?: boolean;
}

export const LifecycleActionBar: React.FC<LifecycleActionBarProps> = ({
  currentStatus: propStatus,
  assayerName: propName,
  assayerCode: propCode,
  canManage: propCanManage,
  assayer,
  onTransition,
  busy = false,
}) => {
  const currentStatus = propStatus ?? assayer?.lifecycleStatus;
  const assayerName = propName ?? assayer?.displayName ?? 'Assayer';
  const assayerCode = propCode ?? assayer?.assayerCode ?? '';
  const canManage = propCanManage ?? true;
  const [selectedTarget, setSelectedTarget] = useState<string | null>(null);

  const transitions = nextAssayerLifecycleStates(currentStatus);
  const forwardStep = nextOnboardingStep(currentStatus);

  const isRehireTarget = (target: string) =>
    target === AssayerLifecycleStatus.INVITED &&
    (currentStatus === AssayerLifecycleStatus.RESIGNED || currentStatus === AssayerLifecycleStatus.TERMINATED);

  if (!canManage || transitions.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="lifecycle-action-bar"
      style={{
        padding: '12px 18px',
        background: 'var(--bg-surface-2)',
        borderBottom: '1px solid var(--border-color)',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Permitted Next Actions
          </span>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Primary Forward Progression */}
          {forwardStep && (
            <button
              type="button"
              data-testid="lifecycle-btn-forward"
              onClick={() => setSelectedTarget(forwardStep)}
              disabled={busy}
              className="btn btn-primary"
              style={{ fontSize: '12px', padding: '6px 14px', display: 'flex', alignItems: 'center', gap: '6px' }}
            >
              {isRehireTarget(forwardStep) ? (
                <>
                  <RotateCcw size={13} /> Rehire / Start Re-onboarding
                </>
              ) : (
                <>
                  <ArrowRight size={13} /> Move to {assayerLifecycleLabel(forwardStep)}
                </>
              )}
            </button>
          )}

          {/* Secondary / Side Transitions */}
          {transitions
            .filter((t) => t !== forwardStep)
            .map((t) => {
              const isRehire = isRehireTarget(t);
              const isDanger =
                t === AssayerLifecycleStatus.SUSPENDED ||
                t === AssayerLifecycleStatus.TERMINATED ||
                t === AssayerLifecycleStatus.RESIGNED;

              return (
                <button
                  key={t}
                  type="button"
                  data-testid={`lifecycle-btn-${t.toLowerCase()}`}
                  onClick={() => setSelectedTarget(t)}
                  disabled={busy}
                  className={isDanger ? 'btn btn-secondary' : 'btn btn-secondary'}
                  style={{
                    fontSize: '12px',
                    padding: '6px 12px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    color: isDanger ? 'var(--danger)' : undefined,
                    borderColor: isDanger ? 'color-mix(in srgb, var(--danger) 40%, transparent)' : undefined,
                  }}
                >
                  {isRehire ? (
                    <>
                      <RotateCcw size={12} /> Rehire / Re-onboard
                    </>
                  ) : (
                    assayerLifecycleLabel(t)
                  )}
                </button>
              );
            })}
        </div>
      </div>

      {selectedTarget && (
        <LifecycleTransitionModal
          open={!!selectedTarget}
          onClose={() => setSelectedTarget(null)}
          assayerName={assayerName}
          assayerCode={assayerCode}
          currentStatus={currentStatus}
          targetStatus={selectedTarget}
          onConfirm={async (reason) => {
            await onTransition(selectedTarget, reason);
          }}
          busy={busy}
        />
      )}
    </div>
  );
};
