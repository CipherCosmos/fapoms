import React from 'react';
import { Edit2, Trash2, PlayCircle } from 'lucide-react';
import { isOnboardingStage, nextAssayerLifecycleStates } from '@fapoms/shared';
import type { RosterPerson } from '../roster-filters';

export interface RosterRowActionsProps {
  person: RosterPerson;
  canCreate: boolean;
  canManage: boolean;
  onEdit: (id: string) => void;
  onResumeRegistration: (id: string) => void;
  onStartTransition: (person: RosterPerson, targetStatus: string) => void;
  onDelete: (person: RosterPerson) => void;
}

export const RosterRowActions: React.FC<RosterRowActionsProps> = ({
  person,
  canCreate,
  canManage,
  onEdit,
  onResumeRegistration,
  onStartTransition,
  onDelete,
}) => {
  const isJoining = isOnboardingStage(person.lifecycleStatus);
  const legalNextStates = nextAssayerLifecycleStates(person.lifecycleStatus);

  return (
    <div
      style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Resume registration for incomplete joiners */}
      {canCreate && isJoining && (
        <button
          type="button"
          aria-label={`Finish registering ${person.displayName}`}
          title={`Finish registering ${person.displayName}`}
          onClick={() => onResumeRegistration(person.id)}
          className="btn-icon"
          style={{
            padding: '6px',
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            color: 'var(--accent)',
          }}
        >
          <PlayCircle size={15} />
        </button>
      )}

      {/* Edit Profile */}
      {canManage && (
        <button
          type="button"
          aria-label={`Edit ${person.displayName}`}
          title={`Edit ${person.displayName}`}
          onClick={() => onEdit(person.id)}
          className="btn-icon"
          style={{
            padding: '6px',
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            color: 'var(--text-secondary)',
          }}
        >
          <Edit2 size={14} />
        </button>
      )}

      {/* Explicit Lifecycle Management: Render permitted next transitions if available */}
      {canManage && legalNextStates.length > 0 && (
        <div style={{ position: 'relative', display: 'inline-block' }}>
          <select
            aria-label={`Change lifecycle stage for ${person.displayName}`}
            value=""
            onChange={(e) => {
              const target = e.target.value;
              if (target) onStartTransition(person, target);
            }}
            style={{
              padding: '4px 6px',
              fontSize: '11px',
              borderRadius: '4px',
              border: '1px solid var(--border-color)',
              background: 'var(--bg-page)',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            <option value="" disabled>
              Move to…
            </option>
            {legalNextStates.map((target) => (
              <option key={target} value={target}>
                {target.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Destructive Delete: Capability-gated, visually separated with danger tone */}
      {canManage && (
        <button
          type="button"
          aria-label={`Delete ${person.displayName}`}
          title={`Delete ${person.displayName}`}
          onClick={() => onDelete(person)}
          className="btn-icon"
          style={{
            padding: '6px',
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            color: 'var(--danger)',
            marginLeft: '2px',
          }}
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  );
};
