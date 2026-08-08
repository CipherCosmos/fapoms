import React, { useEffect, useMemo, useState } from 'react';
import { Wallet, Search, Pencil, Plus, AlertTriangle, Clock } from 'lucide-react';
import { formatRupees as money } from '@fapoms/shared';
import { api } from '../../services/api';
import { card, label, Empty, fmtDate } from './hr-ui';
import { useHr } from './HrLayout';
import { CommercialProfileModal, type CommercialProfile } from './CommercialProfileModal';

/**
 * Pay & terms.
 *
 * Commercial profiles could only be seen and edited one assayer at a time, through a modal
 * buried in the detail drawer. There was no way to see the whole roster's rate card at once —
 * to compare terms, or to find who has no active profile and is therefore being priced at the
 * client's default fee. This page is that view, backed by a single batched call rather than one
 * request per assayer.
 *
 * "In force today" is the same rule the fee calculator uses: the profile effective on the date,
 * newest start winning. A profile dated in the future is flagged, not shown as the current rate,
 * so the pay an assayer is actually being quoted is never confused with one that has not started.
 */

interface AssayerLite {
  id: string;
  assayerCode: string;
  displayName: string;
  district: string | null;
  lifecycleStatus: string;
}

interface RosterPayRow {
  assayerId: string;
  profile: CommercialProfile | null;
  hasFutureProfile: boolean;
}

type Filter = 'all' | 'priced' | 'unpriced';

export const HrPayPage: React.FC = () => {
  const { canManage } = useHr();
  const [roster, setRoster] = useState<AssayerLite[]>([]);
  const [pay, setPay] = useState<Record<string, RosterPayRow>>({});
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ assayerId: string; profile: CommercialProfile | null } | null>(null);

  const load = async () => {
    try {
      const [people, rows] = await Promise.all([
        api.request<AssayerLite[]>('/assayers?limit=1000'),
        api.request<RosterPayRow[]>('/assayers/commercial/roster'),
      ]);
      setRoster(people);
      setPay(Object.fromEntries(rows.map((r) => [r.assayerId, r])));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return roster
      .filter((a) => !q || a.displayName.toLowerCase().includes(q) || a.assayerCode.toLowerCase().includes(q))
      .filter((a) => {
        const has = !!pay[a.id]?.profile;
        return filter === 'all' || (filter === 'priced' ? has : !has);
      });
  }, [roster, pay, search, filter]);

  const unpricedCount = roster.filter((a) => !pay[a.id]?.profile).length;

  if (loading) return <div style={{ padding: '20px 4px', color: 'var(--text-muted)' }}>Loading rate cards…</div>;
  if (error) return <div style={{ padding: '20px 4px', color: 'var(--danger)' }}>{error}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <button onClick={() => setFilter('all')} style={tile(filter === 'all')}>
          <div style={statValue}>{roster.length}</div>
          <div style={label}>On the roster</div>
        </button>
        <button onClick={() => setFilter('priced')} style={tile(filter === 'priced')}>
          <div style={statValue}>{roster.length - unpricedCount}</div>
          <div style={label}>Have a rate card</div>
        </button>
        <button onClick={() => setFilter('unpriced')} style={tile(filter === 'unpriced', unpricedCount > 0)}>
          <div style={{ ...statValue, color: unpricedCount > 0 ? 'var(--warning)' : undefined }}>{unpricedCount}</div>
          <div style={label}>On the default fee</div>
        </button>
      </div>

      {filter === 'unpriced' && unpricedCount > 0 && (
        <div style={{ ...card, borderLeft: '3px solid var(--warning)', display: 'flex', gap: '9px', alignItems: 'flex-start', fontSize: '12.5px' }}>
          <AlertTriangle size={15} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: '1px' }} />
          <span style={{ color: 'var(--text-secondary)' }}>
            These assayers have no commercial profile in force, so every assignment prices them at the
            client's contracted default base fee. Set a rate card to pay them their own agreed terms.
          </span>
        </div>
      )}

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '12px', flexWrap: 'wrap' }}>
          <Wallet size={15} style={{ color: 'var(--accent)' }} />
          <span style={{ ...label, fontSize: '12px' }}>Rate cards in force today</span>
          <div style={{ position: 'relative', marginLeft: 'auto' }}>
            <Search size={13} style={{ position: 'absolute', left: '9px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find an assayer…"
              style={{ padding: '7px 10px 7px 28px', fontSize: '12.5px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)', minWidth: '200px' }} />
          </div>
        </div>

        {rows.length === 0 ? (
          <Empty>No assayer matches the current filter.</Empty>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12.5px' }}>
              <thead>
                <tr>
                  {['Assayer', 'Base fee', 'Daily', 'Hourly', 'Travel', 'Effective', ''].map((h) => (
                    <th key={h} style={{ ...label, textAlign: h === 'Assayer' || h === '' ? 'left' : 'right', padding: '8px 10px', borderBottom: '1px solid var(--border-color)', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => {
                  const row = pay[a.id];
                  const p = row?.profile;
                  return (
                    <tr key={a.id} style={{ borderBottom: '1px solid var(--border-hair)' }}>
                      <td style={{ padding: '9px 10px' }}>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{a.displayName}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{a.assayerCode}{a.district ? ` · ${a.district}` : ''}</div>
                      </td>
                      {p ? (
                        <>
                          <td style={num}>{money(p.baseFee)}</td>
                          <td style={num}>{money(p.dailyRate)}</td>
                          <td style={num}>{money(p.hourlyRate)}</td>
                          <td style={num}>{money(p.travelReimbursement)}</td>
                          <td style={{ ...num, color: 'var(--text-muted)', fontSize: '11.5px' }}>
                            {fmtDate(p.effectiveStartDate)}
                            {row?.hasFutureProfile && (
                              <span title="A later profile is scheduled" style={{ marginLeft: '5px', color: 'var(--accent)' }}><Clock size={11} /></span>
                            )}
                          </td>
                        </>
                      ) : (
                        <td colSpan={5} style={{ padding: '9px 10px', color: 'var(--warning)', fontSize: '12px' }}>
                          No rate card — priced at the client default
                        </td>
                      )}
                      <td style={{ padding: '9px 10px', textAlign: 'right' }}>
                        {canManage && (
                          <button onClick={() => setEditing({ assayerId: a.id, profile: p ?? null })}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11.5px', fontWeight: 600, padding: '5px 10px', borderRadius: '7px', border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer' }}>
                            {p ? <><Pencil size={12} /> Edit</> : <><Plus size={12} /> Set terms</>}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <CommercialProfileModal
          open
          assayerId={editing.assayerId}
          profile={editing.profile}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
    </div>
  );
};

const statValue: React.CSSProperties = { fontSize: '24px', fontWeight: 700, lineHeight: 1.1 };
const num: React.CSSProperties = { padding: '9px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--text-secondary)' };
const tile = (active: boolean, warn = false): React.CSSProperties => ({
  ...card, flex: '1 1 150px', minWidth: 0, textAlign: 'left', cursor: 'pointer',
  border: `1px solid ${active ? (warn ? 'var(--warning)' : 'var(--accent)') : 'var(--border-color)'}`,
});
