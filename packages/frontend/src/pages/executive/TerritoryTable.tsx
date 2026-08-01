import React, { useState } from 'react';
import { ChevronDown, ChevronRight, AlertTriangle, TrendingDown, CheckCircle2, XCircle } from 'lucide-react';

export interface District {
  district: string; branches: number; packets: number; auditHours: number;
  unassigned: number; isolated: number; assayers: number;
}

export interface Territory {
  state: string;
  branches: number; packets: number; auditHours: number;
  assayers: number; dailyCapacity: number;
  assignedBranches: number; unassignedBranches: number; isolatedBranches: number;
  realisedRevenue: number; pipelineValue: number;
  demandAssayerDays: number; loadRatio: number | null;
  avgNearestAssayerKm: number | null; unassignedShare: number;
  posture: 'NO_COVERAGE' | 'UNDER_RESOURCED' | 'UNDER_UTILISED' | 'BALANCED';
  districts: District[];
}

/**
 * Each posture is a different decision, so each gets its own colour and a plain
 * statement of what it means — a coloured badge alone leaves the reader to guess
 * whether it is good or bad.
 */
export const POSTURE: Record<Territory['posture'], { label: string; color: string; icon: React.ReactNode; meaning: string }> = {
  NO_COVERAGE:     { label: 'No coverage',     color: '#ef4444', icon: <XCircle size={13} />,       meaning: 'Work here, nobody living here. Needs hiring or a partner.' },
  UNDER_RESOURCED: { label: 'Under-resourced', color: '#f59e0b', icon: <AlertTriangle size={13} />, meaning: 'More work than local assayers can absorb. Expect travel cost or slipped dates.' },
  UNDER_UTILISED:  { label: 'Under-utilised',  color: '#60a5fa', icon: <TrendingDown size={13} />,  meaning: 'Spare capacity. Could take work from a neighbouring territory.' },
  BALANCED:        { label: 'Balanced',        color: '#22c55e', icon: <CheckCircle2 size={13} />,  meaning: 'Demand and local capacity are broadly matched.' },
};

const money = (n: number) => `₹${(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

/**
 * Territory-by-territory posture, drillable to district.
 *
 * Demand is shown in assayer-days rather than branch counts because a
 * 160-packet branch is four days of work and a 16-packet branch under an hour —
 * counting branches against headcount would compare unlike things and hide the
 * real imbalance.
 */
export const TerritoryTable: React.FC<{
  territories: Territory[];
  selectedState: string | null;
  onSelectState: (s: string | null) => void;
}> = ({ territories, selectedState, onSelectState }) => {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (s: string) =>
    setExpanded((p) => { const n = new Set(p); n.has(s) ? n.delete(s) : n.add(s); return n; });

  const maxPackets = Math.max(1, ...territories.map((t) => t.packets));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {territories.map((t) => {
        const meta = POSTURE[t.posture];
        const open = expanded.has(t.state);
        const isSel = selectedState === t.state;
        return (
          <div key={t.state} style={{
            background: 'var(--bg-secondary)',
            border: `1px solid ${isSel ? 'var(--accent-primary)' : 'var(--border-color)'}`,
            borderLeft: `3px solid ${meta.color}`,
            borderRadius: 'var(--radius-md)', overflow: 'hidden',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', flexWrap: 'wrap' }}>
              <button onClick={() => toggle(t.state)} title="Show districts"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex' }}>
                {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              </button>

              <button onClick={() => onSelectState(isSel ? null : t.state)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left', padding: 0, flex: 1, minWidth: 150, color: 'var(--text-primary)' }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>{t.state}</div>
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                  {t.branches} branches · {t.assayers} assayers
                  {t.avgNearestAssayerKm !== null && <> · avg {t.avgNearestAssayerKm}km to nearest</>}
                </div>
              </button>

              {/* Workload bar — relative share of the total book, so the biggest
                  territories are obvious without reading numbers. */}
              <div style={{ width: 96 }}>
                <div style={{ height: 5, background: 'var(--bg-tertiary)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${(t.packets / maxPackets) * 100}%`, height: '100%', background: meta.color }} />
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{t.packets.toLocaleString('en-IN')} packets</div>
              </div>

              <Metric label="Demand" value={`${t.demandAssayerDays}d`} />
              <Metric label="Capacity" value={`${t.dailyCapacity}/day`} />
              <Metric
                label="Load"
                value={t.loadRatio === null ? '—' : `${t.loadRatio}×`}
                color={t.loadRatio === null ? undefined : t.loadRatio > 1.5 ? '#f59e0b' : t.loadRatio < 0.35 ? '#60a5fa' : '#22c55e'}
              />
              <Metric label="Value" value={money(t.pipelineValue)} />

              <span title={meta.meaning} style={{
                display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 10.5, fontWeight: 700,
                padding: '3px 9px', borderRadius: 'var(--radius-sm)',
                background: `${meta.color}22`, color: meta.color, whiteSpace: 'nowrap',
              }}>{meta.icon}{meta.label}</span>
            </div>

            {open && (
              <div style={{ borderTop: '1px solid var(--border-color)', background: 'var(--bg-primary)', padding: '8px 12px 10px 38px' }}>
                <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: 6 }}>
                  Districts · {meta.meaning}
                </div>
                {t.districts.map((d) => (
                  <div key={d.district} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 0', fontSize: 11.5, flexWrap: 'wrap' }}>
                    <span style={{ flex: 1, minWidth: 120, fontWeight: 600 }}>{d.district}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{d.branches} br</span>
                    <span style={{ color: 'var(--text-muted)' }}>{d.packets.toLocaleString('en-IN')} pkt</span>
                    <span style={{ color: 'var(--text-muted)' }}>{Math.round(d.auditHours)}h</span>
                    <span style={{ color: d.assayers === 0 ? '#ef4444' : 'var(--text-secondary)' }}>
                      {d.assayers} assayer{d.assayers === 1 ? '' : 's'}
                    </span>
                    {d.isolated > 0 && <span style={{ color: '#ef4444', fontWeight: 600 }}>{d.isolated} unreachable</span>}
                    {d.unassigned > 0 && <span style={{ color: '#f59e0b' }}>{d.unassigned} unassigned</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

const Metric: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color }) => (
  <div style={{ minWidth: 62 }}>
    <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--text-muted)', fontWeight: 600 }}>{label}</div>
    <div style={{ fontSize: 12.5, fontWeight: 700, color: color ?? 'var(--text-primary)' }}>{value}</div>
  </div>
);
