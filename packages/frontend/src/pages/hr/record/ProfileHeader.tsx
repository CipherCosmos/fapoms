import React, { useEffect, useState } from 'react';
import { MapPin, Edit2, CheckCircle2, Phone, Mail, Trash2 } from 'lucide-react';
import { assayerLifecycleLabel } from '@fapoms/shared';
import { api } from '../../../services/api';
import { GeoPrecisionBadge, geoNeedsFixing } from '../../../components/GeoPrecisionBadge';
import { PinCoordinateControl } from '../../../components/PinCoordinateControl';
import { STATUS_COLORS } from '../assayer-shared';
import type { Assayer } from '../assayer-shared';

export const coordinates = (a: { latitude?: number | null; longitude?: number | null }): string | null => {
  if (a.latitude == null || a.longitude == null) return null;
  return `${Number(a.latitude).toFixed(4)}, ${Number(a.longitude).toFixed(4)}`;
};

const Photograph: React.FC<{ assayerId: string; name: string }> = ({ assayerId, name }) => {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let made: string | null = null;
    api.request<Blob>(`/assayers/${assayerId}/photo`, { raw: true })
      .then((b) => {
        if (!live) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => {
        if (live) setUrl(null);
      });
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [assayerId]);

  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const box: React.CSSProperties = {
    width: '46px',
    height: '46px',
    borderRadius: '50%',
    flexShrink: 0,
    border: '1px solid var(--border-color)',
    objectFit: 'cover',
  };

  if (!url) {
    return (
      <div
        style={{
          ...box,
          background: 'var(--bg-surface-2)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: '15px',
          fontWeight: 700,
          color: 'var(--text-muted)',
        }}
        aria-hidden
      >
        {initials || '—'}
      </div>
    );
  }
  return <img src={url} alt={`Photograph of ${name}`} style={box} />;
};

export interface ProfileHeaderProps {
  assayer: Assayer;
  canManage: boolean;
  canDelete?: boolean;
  editing?: boolean;
  savingEdit?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  onStartEdit?: () => void;
  onSaveEdit?: () => void;
  onCancelEdit?: () => void;
  onPinned?: () => void;
  onPinSaved?: () => void;
}

export const ProfileHeader: React.FC<ProfileHeaderProps> = ({
  assayer,
  canManage,
  canDelete = false,
  editing = false,
  savingEdit = false,
  onEdit,
  onDelete,
  onStartEdit,
  onSaveEdit,
  onCancelEdit,
  onPinned,
  onPinSaved,
}) => {
  const tone = STATUS_COLORS[assayer.lifecycleStatus] ?? 'var(--text-muted)';
  const locationLabel = [assayer.city, assayer.state].filter(Boolean).join(', ') || '—';

  return (
    <header
      data-testid="profile-header"
      style={{
        padding: '16px 18px',
        borderBottom: '1px solid var(--border-color)',
        background: 'var(--bg-surface-1)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '14px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: '14px', minWidth: 0, alignItems: 'center' }}>
          <Photograph assayerId={assayer.id} name={assayer.displayName} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: '18px', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
                {assayer.displayName}
              </h2>
              <span
                data-testid="header-lifecycle-badge"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '2px 8px',
                  borderRadius: '999px',
                  fontSize: '11px',
                  fontWeight: 700,
                  background: 'var(--bg-surface-2)',
                  color: tone,
                  border: `1px solid ${tone}`,
                  letterSpacing: '0.02em',
                }}
              >
                {assayerLifecycleLabel(assayer.lifecycleStatus)}
              </span>
            </div>

            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>
              <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{assayer.assayerCode}</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '3px' }}>
                <MapPin size={11} /> {locationLabel}
              </span>
              {assayer.region && (
                <span style={{ color: 'var(--text-secondary)' }}>Region: {assayer.region}</span>
              )}
              {coordinates(assayer) && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontFamily: 'monospace' }}>{coordinates(assayer)}</span>
                  <GeoPrecisionBadge source={assayer.geoSource} matchedName={assayer.geoMatchedName} compact />
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Header Actions */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          {canManage && (editing ? (
            <>
              <button
                type="button"
                onClick={onSaveEdit}
                disabled={savingEdit}
                className="btn btn-primary"
                style={{ fontSize: '12px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '5px' }}
              >
                <CheckCircle2 size={13} /> {savingEdit ? 'Saving…' : 'Save changes'}
              </button>
              <button
                type="button"
                onClick={onCancelEdit}
                disabled={savingEdit}
                className="btn btn-secondary"
                style={{ fontSize: '12px', padding: '6px 12px' }}
              >
                Cancel
              </button>
            </>
          ) : (
            <>
              {(onStartEdit || onEdit) && (
                <button
                  type="button"
                  onClick={onStartEdit || onEdit}
                  className="btn btn-secondary"
                  style={{ fontSize: '12px', padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '5px' }}
                >
                  <Edit2 size={13} /> Edit
                </button>
              )}
              {canDelete && onDelete && (
                <button
                  type="button"
                  onClick={onDelete}
                  className="btn btn-secondary"
                  style={{ fontSize: '12px', padding: '6px 12px', color: 'var(--danger)', display: 'flex', alignItems: 'center', gap: '5px' }}
                  title="Delete assayer profile"
                >
                  <Trash2 size={13} /> Delete
                </button>
              )}
            </>
          ))}

          {assayer.phone && (
            <a
              href={`tel:${assayer.phone}`}
              className="btn btn-secondary"
              style={{ fontSize: '12px', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '5px', textDecoration: 'none' }}
              title={`Call ${assayer.phone}`}
            >
              <Phone size={12} /> Call
            </a>
          )}
          {assayer.email && (
            <a
              href={`mailto:${assayer.email}`}
              className="btn btn-secondary"
              style={{ fontSize: '12px', padding: '6px 10px', display: 'flex', alignItems: 'center', gap: '5px', textDecoration: 'none' }}
              title={`Email ${assayer.email}`}
            >
              <Mail size={12} /> Email
            </a>
          )}
        </div>
      </div>

      {/* Pin correction alert & control when needed */}
      {canManage && (editing || geoNeedsFixing(assayer.geoSource)) && (onPinned || onPinSaved) && (
        <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px dashed var(--border-hair)' }}>
          {geoNeedsFixing(assayer.geoSource) && (
            <div style={{ fontSize: '12px', color: 'var(--warning)', marginBottom: '8px' }}>
              {coordinates(assayer)
                ? 'This pin is an area approximation, not their exact base. Pinning will update travel calculations.'
                : 'No base location coordinate has been pinned. This person will be excluded from distance-based matching.'}
            </div>
          )}
          <PinCoordinateControl target="assayer" id={assayer.id} onPinned={onPinned || onPinSaved!} />
        </div>
      )}
    </header>
  );
};
