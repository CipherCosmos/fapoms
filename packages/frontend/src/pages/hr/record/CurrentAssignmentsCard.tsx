import React from 'react';
import * as RouterDom from 'react-router-dom';
import { Briefcase, ExternalLink, Calendar, MapPin, AlertCircle } from 'lucide-react';
import type { ActiveAssignment } from './record-types';
import { fmtDate } from '../../../utils/dates';

const SafeLink: React.FC<{
  to: string;
  style?: React.CSSProperties;
  title?: string;
  children?: React.ReactNode;
}> = ({ to, children, ...rest }) => {
  const RouterLink = (RouterDom as any)?.Link;
  if (RouterLink && (typeof RouterLink === 'function' || typeof RouterLink === 'object')) {
    return <RouterLink to={to} {...rest}>{children}</RouterLink>;
  }
  return <a href={to} {...rest}>{children}</a>;
};

interface CurrentAssignmentsCardProps {
  assayerId: string;
  assignments: ActiveAssignment[];
  loading?: boolean;
}

const statusBadgeStyle = (status: string): React.CSSProperties => {
  switch (status) {
    case 'IN_PROGRESS':
    case 'CHECKED_IN':
      return {
        background: 'var(--status-active-bg)',
        color: 'var(--success)',
        border: '1px solid color-mix(in srgb, var(--success) 30%, transparent)',
      };
    case 'ACCEPTED':
      return {
        background: 'var(--bg-surface-2)',
        color: 'var(--accent-primary)',
        border: '1px solid color-mix(in srgb, var(--accent-primary) 30%, transparent)',
      };
    case 'PENDING':
      return {
        background: 'var(--status-pending-bg)',
        color: 'var(--warning)',
        border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)',
      };
    default:
      return {
        background: 'var(--bg-surface-2)',
        color: 'var(--text-secondary)',
        border: '1px solid var(--border-color)',
      };
  }
};

export const CurrentAssignmentsCard: React.FC<CurrentAssignmentsCardProps> = ({
  assayerId,
  assignments,
  loading = false,
}) => {
  const inFlight = assignments.filter((a) =>
    ['PENDING', 'ACCEPTED', 'CHECKED_IN', 'IN_PROGRESS'].includes(a.status),
  );

  return (
    <section
      data-testid="current-assignments-card"
      style={{
        background: 'var(--bg-card)',
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
          <Briefcase size={16} style={{ color: 'var(--text-secondary)' }} />
          <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-secondary)' }}>
            Current Work & Commitments
          </h3>
        </div>
        <SafeLink
          to={`/assignments?assayerId=${encodeURIComponent(assayerId)}`}
          style={{
            fontSize: '12px',
            color: 'var(--accent-primary)',
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontWeight: 500,
          }}
          title="Open complete Assignment Queue for this assayer"
        >
          View in Assignment Queue
          <ExternalLink size={12} />
        </SafeLink>
      </div>

      {loading ? (
        <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', padding: '12px 0' }}>
          Loading active assignments…
        </div>
      ) : inFlight.length === 0 ? (
        <div
          style={{
            padding: '14px',
            borderRadius: '8px',
            background: 'var(--bg-surface-2)',
            border: '1px dashed var(--border-hair)',
            textAlign: 'center',
            fontSize: '12.5px',
            color: 'var(--text-muted)',
          }}
        >
          No active or in-flight assignments scheduled for this assayer.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {inFlight.map((asn) => {
            const branchName =
              (asn as any).projectBranch?.branch?.name ||
              (asn as any).branch?.name ||
              asn.branchName ||
              'Assigned Branch';
            const projectName = (asn as any).project?.name || asn.projectName;
            const isAttention = asn.status === 'PENDING' || asn.status === 'IN_PROGRESS';

            return (
              <div
                key={asn.id}
                style={{
                  padding: '10px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--border-color)',
                  background: 'var(--bg-surface-2)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '6px' }}>
                    <SafeLink
                      to={`/assignments?id=${encodeURIComponent(asn.id)}`}
                      style={{
                        fontWeight: 600,
                        fontSize: '12.5px',
                        fontFamily: 'monospace',
                        color: 'var(--accent-primary)',
                        textDecoration: 'none',
                      }}
                      title="Open assignment in queue"
                    >
                      {asn.assignmentNumber || asn.id.slice(0, 8)}
                    </SafeLink>
                    {projectName && (
                      <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        · {projectName}
                      </span>
                    )}
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      padding: '2px 8px',
                      borderRadius: '999px',
                      ...statusBadgeStyle(asn.status),
                    }}
                  >
                    {asn.status.replace('_', ' ')}
                  </span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '14px', fontSize: '11.5px', color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <MapPin size={12} />
                    <span>{branchName}</span>
                  </div>
                  {asn.scheduledDate && (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                      <Calendar size={12} />
                      <span>{fmtDate(asn.scheduledDate)}</span>
                    </div>
                  )}
                  {isAttention && (
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', color: 'var(--warning)', fontWeight: 500 }}>
                      <AlertCircle size={12} />
                      <span>{asn.status === 'PENDING' ? 'Awaiting acceptance' : 'Active on site'}</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
