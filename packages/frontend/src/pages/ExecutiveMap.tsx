import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { InteractivePlanningMap } from '../components/InteractivePlanningMap';
import { TerritoryTable, POSTURE } from './executive/TerritoryTable';
import type { Territory } from './executive/TerritoryTable';
import {
  ShieldAlert, RefreshCw, AlertTriangle, Users, Building2, Clock, IndianRupee, MapPin, FileSpreadsheet,
} from 'lucide-react';
import { api } from '../services/api';
import { userMessage } from '../services/errors';
import { useScope, withScope } from '../context/ScopeContext';
import { useUrlSelection } from '../hooks/useUrlSelection';
import { formatRupees as money } from '@fapoms/shared';
import { useExcelExport } from '../hooks/useExcelExport';

interface BranchPoint {
  id: string; projectBranchId: string; name: string; branchCode: string | null;
  district: string | null; state: string;
  latitude: number | null; longitude: number | null;
  status: string; clientId: string; clientName: string; projectId: string;
  packets: number; auditHours: number; scheduledDate: string | null;
  assigned: boolean;
  nearestAssayerKm: number | null; nearestAssayerName: string | null;
  assayersInRange: number; realisedRevenue: number; isolated: boolean;
}

interface CommandCenter {
  generatedAt: string;
  serviceableRadiusKm: number;
  totals: {
    branches: number; assayers: number; packets: number; auditHours: number;
    demandAssayerDays: number; dailyCapacity: number;
    unassignedBranches: number; isolatedBranches: number;
    realisedRevenue: number; pipelineValue: number; statesCovered: number;
  };
  territories: Territory[];
  coverageGaps: BranchPoint[];
  idleAssayers: Array<{ id: string; name: string; state: string; openAssignments: number; territoryPosture: string }>;
  branchPoints: BranchPoint[];
  assayerPoints: Array<{ id: string; name: string; state: string; latitude: number | null; longitude: number | null }>;
  /**
   * How much of the book the pin arrays actually carry. Every figure above — totals, territory
   * rollups, coverage gaps — is computed over the whole scope regardless; only the pins are
   * bounded, because a national book is tens of thousands of them and the browser draws one
   * marker each. Optional so an older server response still renders.
   */
  meta?: {
    branchPoints: { returned: number; total: number; truncated: boolean };
    assayerPoints: { returned: number; total: number; truncated: boolean };
    pointLimit: number;
  };
}

/**
 * Executive command centre.
 *
 * The previous version plotted branches and reported a "compliance rate" derived
 * from branch statuses. It could not answer the questions this view exists for:
 * where the work actually is, where the people are, and where those two do not
 * line up. Assayers were never drawn at all.
 *
 * Everything here is built on one geographic-intelligence call that measures
 * coverage from real coordinates rather than by matching state names — the names
 * disagree between client branch lists and internal rosters, and distance is what
 * actually decides whether an assayer can service a branch.
 */
export const ExecutiveMap: React.FC = () => {
  const navigate = useNavigate();
  const [data, setData] = useState<CommandCenter | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState('');
  const [clients, setClients] = useState<Array<{ id: string; name: string }>>([]);
  const [selectedState, setSelectedState] = useState<string | null>(null);
  const { scopeParams, scopeKey } = useScope();
  // In the URL so a refresh, or a trip to another screen and back, keeps the branch whose side
  // panel the operator is reading.
  const [selectedBranchId, setSelectedBranchId] = useUrlSelection('branchId');
  const [lens, setLens] = useState<'ALL' | 'GAPS' | 'UNASSIGNED'>('ALL');

  const { download: downloadExcel } = useExcelExport();
  const handleExport = () => {
    void downloadExcel('/reports/command-center', { ...scopeParams, clientId: clientId || undefined });
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The page's own client picker still wins when set; everything else comes from the
      // header's global scope, so the map draws the same slice the rest of the app is showing.
      const q = withScope(scopeParams, { clientId: clientId || undefined });
      setData(await api.request<CommandCenter>(`/planning/command-center${q ? `?${q}` : ''}`));
    } catch (e: any) {
      setError(`Failed to load command centre. ${userMessage(e)}`);
    } finally {
      setLoading(false);
    }
  }, [clientId, scopeKey]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.request<any[]>('/clients?limit=100')
      .then((list) => setClients((list || []).map((c: any) => ({ id: c.id, name: c.name }))))
      .catch(() => { /* client filter is optional */ });
  }, []);

  // The map shows whichever slice the lens and territory selection describe, so
  // clicking a territory or a lens re-frames the map rather than opening a
  // separate screen.
  const visibleBranches = useMemo(() => {
    if (!data) return [];
    let rows = data.branchPoints;
    if (selectedState) rows = rows.filter((b) => b.state === selectedState);
    if (lens === 'GAPS') rows = rows.filter((b) => b.isolated);
    if (lens === 'UNASSIGNED') rows = rows.filter((b) => !b.assigned);
    return rows;
  }, [data, selectedState, lens]);

  const mapBranches = useMemo(
    () => visibleBranches.map((b) => ({
      id: b.id, name: b.name, latitude: b.latitude, longitude: b.longitude,
      status: b.status, state: b.state, city: b.district ?? undefined,
      branchCode: b.branchCode ?? undefined,
    })),
    [visibleBranches],
  );

  const selected = data?.branchPoints.find((b) => b.id === selectedBranchId) ?? null;
  const t = data?.totals;
  // Capacity is expressed per day; demand in assayer-days. Dividing gives the
  // number of working days the current book would take at full utilisation.
  const daysToClear = t && t.dailyCapacity > 0 ? (t.demandAssayerDays / t.dailyCapacity).toFixed(1) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            <ShieldAlert size={22} style={{ color: 'var(--accent-primary)' }} /> Executive Command Center
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '4px 0 0' }}>
            Where the work is, where the people are, and where those two don’t line up.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <select value={clientId} onChange={(e) => { setClientId(e.target.value); setSelectedState(null); }}
            style={{ padding: '7px 11px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: 12.5 }}>
            <option value="">All clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button onClick={load} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} /> Refresh
          </button>
          <button onClick={handleExport} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--success)' }}>
            <FileSpreadsheet size={14} /> Export
          </button>
        </div>
      </div>

      {error && (
        <div style={{ padding: 14, background: 'var(--status-cancelled-bg)', border: '1px solid var(--status-cancelled-bg)', borderRadius: 'var(--radius-md)', color: 'var(--danger)', fontSize: 13 }}>
          {error}
        </div>
      )}
      {loading && !data && <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>Loading geographic intelligence…</div>}

      {data && t && (
        <>
          {/* Position — capacity against demand, which is the executive question. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(168px, 1fr))', gap: 12 }}>
            <Kpi icon={<Building2 size={16} />} label="Branches" value={String(t.branches)}
                 sub={`${t.statesCovered} states · ${t.packets.toLocaleString('en-IN')} packets`} color="var(--accent)" />
            <Kpi icon={<Clock size={16} />} label="Work outstanding" value={`${t.demandAssayerDays} days`}
                 sub={`${Math.round(t.auditHours).toLocaleString('en-IN')} audit-hours`} color="var(--accent)" />
            <Kpi icon={<Users size={16} />} label="Capacity" value={`${t.dailyCapacity}/day`}
                 sub={daysToClear ? `clears the book in ~${daysToClear} days` : `${t.assayers} assayers`} color="var(--success)" />
            <Kpi icon={<AlertTriangle size={16} />} label="Unreachable" value={String(t.isolatedBranches)}
                 sub={`no assayer within ${data.serviceableRadiusKm}km`} color={t.isolatedBranches ? 'var(--danger)' : 'var(--text-muted)'} />
            <Kpi icon={<MapPin size={16} />} label="Unassigned" value={String(t.unassignedBranches)}
                 sub="no assayer confirmed yet" color={t.unassignedBranches ? 'var(--warning)' : 'var(--text-muted)'} />
            <Kpi icon={<IndianRupee size={16} />} label="Book value" value={money(t.pipelineValue)}
                 sub={t.realisedRevenue > 0 ? `${money(t.realisedRevenue)} realised` : 'nothing invoiced yet'} color="var(--success)" />
          </div>

          {/* Lenses re-frame the same map rather than navigating away. */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <Lens active={lens === 'ALL'} onClick={() => setLens('ALL')} label="All branches" count={data.branchPoints.length} color="var(--text-secondary)" />
            <Lens active={lens === 'GAPS'} onClick={() => setLens('GAPS')} label="Coverage gaps" count={t.isolatedBranches} color="var(--danger)" />
            <Lens active={lens === 'UNASSIGNED'} onClick={() => setLens('UNASSIGNED')} label="Unassigned" count={t.unassignedBranches} color="var(--warning)" />
            {selectedState && (
              <button onClick={() => setSelectedState(null)}
                style={{ marginLeft: 4, padding: '6px 11px', fontSize: 11.5, fontWeight: 600, background: 'rgba(216,174,71,0.12)', border: '1px solid var(--accent-primary)', color: 'var(--accent-primary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
                {selectedState} ✕
              </button>
            )}
            <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-muted)' }}>
              showing {visibleBranches.length} of {data.meta?.branchPoints.total ?? data.branchPoints.length} branches
              {data.meta?.branchPoints.truncated && (
                /* The map carries the most decision-relevant pins first — unreachable, then
                   unassigned, then largest — but it is not the whole book, and saying so is the
                   difference between a bounded map and a wrong one. */
                <span style={{ color: 'var(--warning)' }}>
                  {' '}· map shows the {data.meta.branchPoints.returned.toLocaleString('en-IN')} most
                  critical pins; filter by client or state to see the rest
                </span>
              )}
            </span>
          </div>

          {/* Map + selected-branch detail */}
          <div style={{ display: 'grid', gridTemplateColumns: '3fr 1fr', gap: 16, minHeight: 460 }}>
            <div style={{ display: 'flex', flexDirection: 'column', minHeight: 460 }}>
              <InteractivePlanningMap
                branches={mapBranches}
                selectedBranchId={selectedBranchId}
                onSelectBranch={setSelectedBranchId}
                fillContainer
              />
            </div>

            <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', padding: 16, gap: 12, overflowY: 'auto', maxHeight: 560 }}>
              {selected ? (
                <>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{selected.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {selected.branchCode} · {selected.district}, {selected.state}
                    </div>
                  </div>
                  <Row label="Client" value={selected.clientName} />
                  <Row label="Workload" value={`${selected.packets} packets · ${selected.auditHours}h`} />
                  <Row label="Status" value={selected.status} />
                  <Row label="Assayer confirmed" value={selected.assigned ? 'Yes' : 'Not yet'}
                       color={selected.assigned ? 'var(--success)' : 'var(--warning)'} />
                  <Row label="Nearest assayer"
                       value={selected.nearestAssayerName ? `${selected.nearestAssayerName} · ${selected.nearestAssayerKm}km` : 'none located'}
                       color={selected.isolated ? 'var(--danger)' : undefined} />
                  <Row label={`Assayers within ${data.serviceableRadiusKm}km`} value={String(selected.assayersInRange)}
                       color={selected.assayersInRange === 0 ? 'var(--danger)' : undefined} />
                  {selected.isolated && (
                    <div style={{ fontSize: 11.5, color: 'var(--danger)', background: 'var(--status-cancelled-bg)', border: '1px solid var(--status-cancelled-bg)', borderRadius: 'var(--radius-sm)', padding: 9, lineHeight: 1.45 }}>
                      No assayer lives within serviceable range. This branch needs travel-and-stay costing, a partner, or a local hire — it cannot be scheduled normally.
                    </div>
                  )}
                  <button onClick={() => navigate(`/planning?projectId=${selected.projectId}&branchId=${selected.projectBranchId}`)} className="btn btn-secondary"
                    style={{ marginTop: 'auto', fontSize: 12 }}>
                    Open in Planning
                  </button>
                </>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-muted)', textAlign: 'center', gap: 10, fontSize: 12 }}>
                  <MapPin size={26} style={{ opacity: 0.35 }} />
                  <div>Select a branch on the map to see its workload and how far its nearest assayer is.</div>
                </div>
              )}
            </div>
          </div>

          {/* Territories */}
          <div>
            <SectionLabel>Territories — click one to focus the map, expand for districts</SectionLabel>
            <TerritoryTable territories={data.territories} selectedState={selectedState} onSelectState={setSelectedState} />
          </div>

          {/* The two lists that translate directly into action. */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))', gap: 16 }}>
            <div>
              <SectionLabel>Where to add assayers</SectionLabel>
              <div className="glass-card" style={{ padding: 14 }}>
                {data.coverageGaps.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--success)' }}>Every branch has an assayer within {data.serviceableRadiusKm}km.</div>
                ) : data.coverageGaps.map((g) => (
                  <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '5px 0', fontSize: 12, borderBottom: '1px solid var(--border-color)', flexWrap: 'wrap' }}>
                    <span>
                      <strong>{g.name}</strong>
                      <span style={{ color: 'var(--text-muted)' }}> · {g.district}, {g.state} · {g.packets} pkt</span>
                    </span>
                    <span style={{ color: 'var(--danger)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {g.nearestAssayerKm !== null ? `${g.nearestAssayerKm}km away` : 'none located'}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <SectionLabel>Spare capacity</SectionLabel>
              <div className="glass-card" style={{ padding: 14 }}>
                {data.idleAssayers.length === 0 ? (
                  <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Every assayer has open work.</div>
                ) : (
                  <>
                    <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.45 }}>
                      {data.idleAssayers.length} assayer(s) with no open assignment. Those sitting in a balanced or
                      under-utilised territory are the ones worth moving to the gaps on the left.
                    </div>
                    {data.idleAssayers.slice(0, 12).map((a) => {
                      const p = POSTURE[(a.territoryPosture as keyof typeof POSTURE)] ?? null;
                      return (
                        <div key={a.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '4px 0', fontSize: 12, flexWrap: 'wrap' }}>
                          <span>{a.name} <span style={{ color: 'var(--text-muted)' }}>· {a.state}</span></span>
                          {p && <span style={{ fontSize: 10.5, fontWeight: 700, color: p.color }}>{p.label}</span>}
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

const Kpi: React.FC<{ icon: React.ReactNode; label: string; value: string; sub?: string; color: string }> = ({ icon, label, value, sub, color }) => (
  <div className="glass-card" style={{ padding: '13px 15px', borderLeft: `3px solid ${color}` }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--text-muted)', fontWeight: 700 }}>
      <span style={{ color }}>{icon}</span>{label}
    </div>
    <div style={{ fontSize: 20, fontWeight: 800, marginTop: 5, fontFamily: 'var(--font-display)' }}>{value}</div>
    {sub && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
  </div>
);

const Lens: React.FC<{ active: boolean; onClick: () => void; label: string; count: number; color: string }> = ({ active, onClick, label, count, color }) => (
  <button onClick={onClick} style={{
    padding: '6px 12px', borderRadius: 'var(--radius-sm)', cursor: 'pointer', fontSize: 12, fontWeight: 600,
    background: active ? `${color}22` : 'transparent', color: active ? color : 'var(--text-secondary)',
    border: `1px solid ${active ? color : 'var(--border-color)'}`, display: 'flex', alignItems: 'center', gap: 7,
  }}>
    {label}
    <span style={{ background: active ? color : 'var(--bg-tertiary)', color: active ? 'var(--bg-page)' : 'var(--text-muted)', borderRadius: 9, padding: '1px 7px', fontSize: 10.5, fontWeight: 700 }}>{count}</span>
  </button>
);

const Row: React.FC<{ label: string; value: string; color?: string }> = ({ label, value, color }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '5px 0', borderBottom: '1px dashed var(--border-color)' }}>
    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</span>
    <span style={{ fontSize: 12, fontWeight: 600, color: color ?? 'var(--text-primary)', textAlign: 'right' }}>{value}</span>
  </div>
);

const SectionLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.9px', color: 'var(--text-muted)', marginBottom: 9 }}>{children}</div>
);
