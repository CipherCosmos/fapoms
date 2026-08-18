import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bus, Plus, Edit2, Archive, Calculator, Info, Star } from 'lucide-react';
import {
  TravelMode,
  TRAVEL_MODE_ORDER,
  travelModeLabel,
  Region,
  REGION_ORDER,
  REGION_LABELS,
  CANONICAL_STATE_NAMES,
  formatRupees,
} from '@fapoms/shared';
import { api } from '../services/api';
import { userMessage } from '../services/errors';
import { Modal, AlertBanner, Select } from '../components/ui';
import { useCurrentRoles, canManageTransportRates } from '../hooks/useCurrentRoles';

/**
 * The transport rate card: what a kilometre costs by each way of travelling, per part of the
 * country. These rows are what grounds the travel figure in every offer the desk makes — the
 * quote engine resolves the most specific applicable rate for a branch's place and recommends
 * an amount from it BEFORE the offer goes out. Managing this table is managing what the
 * platform believes travel costs.
 */

interface TransportRate {
  id: string;
  mode: TravelMode;
  scopeType: 'NATIONAL' | 'REGION' | 'STATE';
  scopeValue: string | null;
  baseFare: number | string;
  perKmRate: number | string;
  isPreferred: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  isActive: boolean;
  notes: string | null;
  updatedAt?: string;
}

interface EstimateOption {
  mode: TravelMode;
  modeLabel: string;
  scopeType: string;
  scopeValue: string | null;
  baseFare: number;
  perKmRate: number;
  oneWayCost: number;
  roundTripCost: number;
  preferred: boolean;
  /** One-way minutes and whether they came from a road route or an average-speed estimate. */
  oneWayMinutes?: number;
  timeSource?: 'ROAD_ROUTE' | 'RATE_CARD_ESTIMATE';
  /** False when a business rule ruled the mode out; `whyNot` names the rule. */
  viable?: boolean;
  whyNot?: string | null;
  reason?: string | null;
}

interface Estimate {
  distanceKm: number;
  options: EstimateOption[];
  recommended: EstimateOption | null;
}

const SCOPE_LABEL: Record<TransportRate['scopeType'], string> = {
  NATIONAL: 'National',
  REGION: 'Region',
  STATE: 'State',
};

const scopeDisplay = (r: TransportRate): string =>
  r.scopeType === 'NATIONAL'
    ? 'National'
    : r.scopeType === 'REGION'
      ? `${REGION_LABELS[r.scopeValue as Region] ?? r.scopeValue}`
      : `${r.scopeValue}`;

const emptyForm = {
  mode: TravelMode.BUS as string,
  scopeType: 'NATIONAL' as TransportRate['scopeType'],
  scopeValue: '',
  baseFare: '0',
  perKmRate: '',
  isPreferred: false,
  effectiveFrom: new Date().toISOString().slice(0, 10),
  effectiveTo: '',
  notes: '',
};

export const TransportCosts: React.FC = () => {
  const canManage = canManageTransportRates(useCurrentRoles());
  const queryClient = useQueryClient();

  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [editIsActive, setEditIsActive] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Estimator inputs. The estimate itself always comes from the server — the whole point of
  // this panel is to show exactly what an offer's quote would use, never a client-side copy
  // of the formula (a hardcoded ₹8/km fallback in the planning map once diverged from what
  // was actually charged, and that class of bug stays dead).
  const [estKm, setEstKm] = useState('50');
  const [estState, setEstState] = useState('');
  const [estRegion, setEstRegion] = useState('');

  const { data: ratesRes, isLoading } = useQuery({
    queryKey: ['transport-rates'],
    queryFn: () => api.request<TransportRate[]>('/transport-rates'),
  });
  const rates: TransportRate[] = useMemo(
    () => ratesRes ?? [],
    [ratesRes],
  );

  const estKmNumber = Number(estKm);
  const estimateEnabled = Number.isFinite(estKmNumber) && estKmNumber > 0;
  const { data: estimateRes, isFetching: estimating } = useQuery({
    queryKey: ['transport-rates', 'estimate', estKm, estState, estRegion],
    queryFn: () =>
      api.request<Estimate>(
        `/transport-rates/estimate?distanceKm=${encodeURIComponent(estKm)}` +
          (estState ? `&state=${encodeURIComponent(estState)}` : '') +
          (estRegion ? `&region=${encodeURIComponent(estRegion)}` : ''),
      ),
    enabled: estimateEnabled,
  });
  const estimate: Estimate | null = estimateRes ?? null;

  const visibleRates = useMemo(() => {
    const list = showRetired ? rates : rates.filter((r) => r.isActive);
    // National first, then regions, then states; within a scope keep modes together.
    const scopeRank = { NATIONAL: 0, REGION: 1, STATE: 2 } as const;
    return [...list].sort(
      (a, b) =>
        scopeRank[a.scopeType] - scopeRank[b.scopeType] ||
        (a.scopeValue ?? '').localeCompare(b.scopeValue ?? '') ||
        TRAVEL_MODE_ORDER.indexOf(a.mode) - TRAVEL_MODE_ORDER.indexOf(b.mode),
    );
  }, [rates, showRetired]);

  const inactiveSeedCount = useMemo(
    // version 1 = never edited: a seed someone deliberately retired (or activated and
    // later retired) has a higher version and must not be nagged about forever.
    () => rates.filter((r) => !r.isActive && (r as any).version === 1 && r.notes?.startsWith('Seed default')).length,
    [rates],
  );

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...emptyForm });
    setEditIsActive(true);
    setShowModal(true);
  };

  const openEdit = (r: TransportRate) => {
    setEditingId(r.id);
    setForm({
      mode: r.mode,
      scopeType: r.scopeType,
      scopeValue: r.scopeValue ?? '',
      baseFare: String(r.baseFare ?? '0'),
      perKmRate: String(r.perKmRate ?? ''),
      isPreferred: r.isPreferred,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo ?? '',
      notes: r.notes ?? '',
    });
    setEditIsActive(r.isActive);
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (form.scopeType !== 'NATIONAL' && !form.scopeValue) {
      setError(`Choose a ${form.scopeType === 'REGION' ? 'region' : 'state'} for this rate's scope.`);
      return;
    }
    const body: Record<string, unknown> = {
      mode: form.mode,
      scopeType: form.scopeType,
      scopeValue: form.scopeType === 'NATIONAL' ? null : form.scopeValue || null,
      baseFare: Number(form.baseFare || 0),
      perKmRate: Number(form.perKmRate),
      isPreferred: form.isPreferred,
      effectiveFrom: form.effectiveFrom,
      effectiveTo: form.effectiveTo || null,
      notes: form.notes || null,
    };
    if (editingId) body.isActive = editIsActive;
    setSubmitting(true);
    try {
      if (editingId) {
        await api.request(`/transport-rates/${editingId}`, { method: 'PUT', body: JSON.stringify(body) });
        setSuccess('Transport rate updated.');
      } else {
        await api.request('/transport-rates', { method: 'POST', body: JSON.stringify(body) });
        setSuccess('Transport rate added.');
      }
      setShowModal(false);
      // Prefix invalidation reaches the estimator too — its query key starts with
      // 'transport-rates', and a stale estimate after a rate edit is a wrong number on screen.
      queryClient.invalidateQueries({ queryKey: ['transport-rates'] });
    } catch (err: any) {
      setError(`Could not save the rate. ${userMessage(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetire = async (r: TransportRate) => {
    if (!window.confirm(`Retire the ${travelModeLabel(r.mode)} rate for ${scopeDisplay(r)}? It stops pricing new offers but keeps its history.`)) return;
    try {
      await api.request(`/transport-rates/${r.id}`, { method: 'DELETE' });
      setSuccess('Rate retired. Past offers priced by it are unaffected.');
      queryClient.invalidateQueries({ queryKey: ['transport-rates'] });
    } catch (err: any) {
      setError(`Could not retire the rate. ${userMessage(err)}`);
    }
  };

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <h2 style={{ fontSize: '20px', fontWeight: 700, margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Bus style={{ color: 'var(--accent)' }} /> Transport Costs
          </h2>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            What travel costs by each mode, per place. Offers quote their travel from these rates — the most specific scope wins.
          </span>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} />
            Show retired
          </label>
          {canManage && (
            <button onClick={openCreate} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 14px' }}>
              <Plus size={14} /> Add Rate
            </button>
          )}
        </div>
      </div>

      {error && <AlertBanner type="error">{error}</AlertBanner>}
      {success && <AlertBanner type="success">{success}</AlertBanner>}

      {inactiveSeedCount > 0 && !showRetired && (
        <div className="glass-card" style={{ padding: '10px 14px', display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', color: 'var(--text-secondary)', border: '1px solid var(--accent-primary)' }}>
          <Info size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          <span>
            {inactiveSeedCount} seeded starter rate{inactiveSeedCount === 1 ? ' is' : 's are'} waiting inactive — tick “Show retired”,
            review the figures against real local costs, and activate the ones you stand behind. Nothing prices an offer until you do.
          </span>
        </div>
      )}

      {/* ── Estimator: exactly what a quote would use ─────────────────────── */}
      <div className="glass-card" style={{ padding: '18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
          <Calculator size={16} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: '14px', fontWeight: 700 }}>Journey estimator</span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            — the same resolution an offer uses, so what you see here is what the desk is recommended
          </span>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
            One-way distance (km)
            <input
              type="number" min={1} value={estKm} onChange={(e) => setEstKm(e.target.value)}
              style={{ width: '120px', padding: '8px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
            State
            <Select
              value={estState} onChange={setEstState}
              placeholder="Any / not specified"
              options={CANONICAL_STATE_NAMES.map((s) => ({ value: s, label: s }))}
              style={{ minWidth: '180px' }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
            Region (used when no state)
            <span title={estState ? 'The region follows the chosen state' : undefined} style={{ display: 'contents' }}>
              <Select
                value={estRegion} onChange={setEstRegion}
                disabled={!!estState}
                placeholder="—"
                options={REGION_ORDER.map((r) => ({ value: r, label: REGION_LABELS[r] }))}
                style={{ minWidth: '140px' }}
              />
            </span>
          </label>
        </div>

        {estimateEnabled && (
          <div style={{ marginTop: '14px' }}>
            {estimating ? (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Calculating…</div>
            ) : !estimate || estimate.options.length === 0 ? (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', display: 'flex', gap: '6px', alignItems: 'center' }}>
                <Info size={13} />
                No active transport rate covers this place — offers there fall back to the client contract's per-km formula.
              </div>
            ) : (
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                {estimate.options.map((o) => {
                  const isRec = estimate.recommended?.mode === o.mode;
                  // A mode a rule ruled out is still listed — ops may override — but it must not
                  // look like a live choice. Before this it rendered as an ordinary card, so a
                  // flight for an 8 km hop sat beside the auto-rickshaw as if either would do.
                  const ruledOut = o.viable === false;
                  const mins = o.oneWayMinutes;
                  const timeText = mins == null ? null : mins >= 60
                    ? `~${Math.floor(mins / 60)}h ${Math.round(mins % 60)}m one way`
                    : `~${Math.round(mins)} min one way`;
                  return (
                    <div key={o.mode} title={ruledOut ? (o.whyNot ?? 'Ruled out') : (o.reason ?? undefined)} style={{
                      padding: '10px 14px', borderRadius: '8px', minWidth: '150px',
                      border: isRec ? '1px solid var(--accent-primary)' : ruledOut ? '1px dashed var(--border-color)' : '1px solid var(--border-color)',
                      background: isRec ? 'rgba(216,174,71,0.08)' : 'transparent',
                      opacity: ruledOut ? 0.55 : 1,
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', fontWeight: 700 }}>
                        {o.modeLabel}
                        {isRec && <span style={{ fontSize: '9px', fontWeight: 800, color: 'var(--accent)', border: '1px solid var(--accent)', borderRadius: '4px', padding: '1px 5px' }}>RECOMMENDED</span>}
                        {ruledOut && <span style={{ fontSize: '9px', fontWeight: 800, color: 'var(--text-muted)', border: '1px solid var(--border-color)', borderRadius: '4px', padding: '1px 5px' }}>NOT SUITABLE</span>}
                        {o.preferred && !isRec && !ruledOut && <Star size={11} style={{ color: 'var(--text-muted)' }} />}
                      </div>
                      {timeText && (
                        <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                          {timeText}{o.timeSource === 'RATE_CARD_ESTIMATE' ? ' (est.)' : ''}
                        </div>
                      )}
                      {ruledOut && o.whyNot && (
                        <div style={{ fontSize: '10px', color: 'var(--warning)', marginTop: '2px' }}>{o.whyNot}</div>
                      )}
                      {isRec && o.reason && (
                        <div style={{ fontSize: '10px', color: 'var(--accent)', marginTop: '2px' }}>{o.reason}</div>
                      )}
                      <div style={{ fontSize: '17px', fontWeight: 800, color: isRec ? 'var(--accent)' : 'var(--text-primary)', marginTop: '2px' }}>
                        {formatRupees(o.roundTripCost)}
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        round trip · {formatRupees(o.oneWayCost)} one way
                      </div>
                      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                        {formatRupees(o.baseFare)} + {o.perKmRate}/km · {SCOPE_LABEL[o.scopeType as TransportRate['scopeType']] ?? o.scopeType}{o.scopeValue ? ` (${o.scopeValue})` : ''}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── The rate card itself ──────────────────────────────────────────── */}
      <div className="glass-card" style={{ padding: '18px' }}>
        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading…</div>
        ) : visibleRates.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)', fontSize: '13px' }}>
            No {showRetired ? '' : 'active '}transport rates yet.
            {canManage ? ' Add one, or tick “Show retired” to review the seeded starters.' : ''}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Mode</th>
                  <th>Scope</th>
                  <th style={{ textAlign: 'right' }}>Base fare</th>
                  <th style={{ textAlign: 'right' }}>Per km</th>
                  <th>Preferred</th>
                  <th>Effective</th>
                  <th>Status</th>
                  <th>Notes</th>
                  {canManage && <th />}
                </tr>
              </thead>
              <tbody>
                {visibleRates.map((r) => (
                  <tr key={r.id} style={{ opacity: r.isActive ? 1 : 0.55 }}>
                    <td style={{ fontWeight: 600 }}>{travelModeLabel(r.mode)}</td>
                    <td>
                      <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{SCOPE_LABEL[r.scopeType]}</span>
                      {r.scopeType !== 'NATIONAL' && <span> · {scopeDisplay(r)}</span>}
                    </td>
                    <td style={{ textAlign: 'right' }}>{formatRupees(Number(r.baseFare))}</td>
                    <td style={{ textAlign: 'right' }}>₹{Number(r.perKmRate)}</td>
                    <td>{r.isPreferred ? <Star size={13} style={{ color: 'var(--accent)' }} /> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
                    <td style={{ fontSize: '12px' }}>
                      {r.effectiveFrom}{r.effectiveTo ? ` → ${r.effectiveTo}` : ' →'}
                    </td>
                    <td>
                      <span style={{
                        fontSize: '10px', fontWeight: 700, padding: '2px 8px', borderRadius: '10px',
                        background: r.isActive ? 'rgba(52,168,83,0.12)' : 'var(--border-hair)',
                        color: r.isActive ? 'var(--success, #34a853)' : 'var(--text-muted)',
                      }}>
                        {r.isActive ? 'ACTIVE' : 'RETIRED'}
                      </span>
                    </td>
                    <td style={{ fontSize: '11px', color: 'var(--text-muted)', maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.notes ?? ''}>
                      {r.notes ?? '—'}
                    </td>
                    {canManage && (
                      <td>
                        <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                          <button onClick={() => openEdit(r)} className="btn btn-secondary" title="Edit" style={{ padding: '5px 8px' }}><Edit2 size={13} /></button>
                          {r.isActive && (
                            <button onClick={() => handleRetire(r)} className="btn btn-secondary" title="Retire — stops pricing new offers, keeps history" style={{ padding: '5px 8px' }}><Archive size={13} /></button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px', fontSize: '11px', color: 'var(--text-muted)', alignItems: 'center' }}>
          <Info size={12} />
          <span>
            Resolution per mode: a State rate beats a Region rate beats a National one. “Preferred” marks the mode whose cost
            becomes the offer's recommended travel; without one, the cheapest mode is used. Rates are never deleted — retiring
            keeps the history that past offers were priced from.
          </span>
        </div>
      </div>

      {showModal && (
        <Modal open onClose={() => setShowModal(false)} title={editingId ? 'Edit Transport Rate' : 'Add Transport Rate'}>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
                Mode of transport
                <Select value={form.mode} onChange={(v) => set({ mode: v })}
                  options={TRAVEL_MODE_ORDER.map((m) => ({ value: m, label: travelModeLabel(m) }))}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
                Applies to
                <Select value={form.scopeType} onChange={(v) => set({ scopeType: v as TransportRate['scopeType'], scopeValue: '' })}
                  options={[
                    { value: 'NATIONAL', label: 'Whole country' },
                    { value: 'REGION', label: 'One region' },
                    { value: 'STATE', label: 'One state' },
                  ]}
                />
              </label>
            </div>

            {form.scopeType === 'REGION' && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
                Region
                <Select value={form.scopeValue} onChange={(v) => set({ scopeValue: v })}
                  placeholder="Select region…"
                  options={REGION_ORDER.map((r) => ({ value: r, label: REGION_LABELS[r] }))}
                />
              </label>
            )}
            {form.scopeType === 'STATE' && (
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
                State
                <Select value={form.scopeValue} onChange={(v) => set({ scopeValue: v })}
                  placeholder="Select state…"
                  options={CANONICAL_STATE_NAMES.map((s) => ({ value: s, label: s }))}
                />
              </label>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
                Base fare (₹) — the cost of setting out at all
                <input type="number" min={0} step="0.01" value={form.baseFare} onChange={(e) => set({ baseFare: e.target.value })}
                  style={{ padding: '8px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px' }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
                Rate per km (₹)
                <input type="number" min={0} step="0.01" value={form.perKmRate} onChange={(e) => set({ perKmRate: e.target.value })} required
                  style={{ padding: '8px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px' }} />
              </label>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
                Effective from
                <input type="date" value={form.effectiveFrom} onChange={(e) => set({ effectiveFrom: e.target.value })} required
                  style={{ padding: '8px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px' }} />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
                Effective to (blank = open-ended)
                <input type="date" value={form.effectiveTo} onChange={(e) => set({ effectiveTo: e.target.value })}
                  style={{ padding: '8px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px' }} />
              </label>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer' }}>
              <input type="checkbox" checked={form.isPreferred} onChange={(e) => set({ isPreferred: e.target.checked })} />
              Preferred mode for this scope — its cost becomes the offer's recommended travel
            </label>

            {editingId && (
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--text-primary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={editIsActive} onChange={(e) => setEditIsActive(e.target.checked)} />
                Active — prices new offers. Untick to retire (seeded starters arrive unticked; activating them is the deliberate act).
              </label>
            )}

            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11px', color: 'var(--text-muted)' }}>
              Notes — why this rate is what it is
              <textarea value={form.notes} onChange={(e) => set({ notes: e.target.value })} rows={2}
                placeholder="e.g. State transport fare revision, April 2026"
                style={{ padding: '8px 10px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', fontSize: '13px', resize: 'vertical' }} />
            </label>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? 'Saving…' : editingId ? 'Save Changes' : 'Add Rate'}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
};

export default TransportCosts;
