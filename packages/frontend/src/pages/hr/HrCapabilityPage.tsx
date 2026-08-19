import React, { useEffect, useMemo, useState } from 'react';
import { Award, Languages as LangIcon, Wrench, Plus, Trash2, AlertTriangle, Search } from 'lucide-react';
import { api } from '../../services/api';
import { card, label, Empty, ExpiryChip } from './hr-ui';
import { useHr } from './HrLayout';

/**
 * Capability & certifications.
 *
 * The backend has always had full CRUD on skills, languages and certifications, gated to
 * HR_MANAGER, and never had a screen. Every one of the 126 attribute rows in the database
 * arrived through the Excel importer, and an HR manager could not add a language, record a new
 * certification with its expiry, or remove a lapsed one. This page is that missing write path.
 *
 * Certification expiry is the reason it matters most: the eligibility gate refuses an assayer
 * whose certification has lapsed by the audit date, so a renewal that is recorded nowhere
 * quietly takes someone out of the assignable pool.
 */

type AttrType = 'SKILL' | 'LANGUAGE' | 'CERTIFICATION' | 'SPECIALIZATION';

interface WorkforceAttribute {
  id: string;
  assayerId: string;
  type: AttrType;
  name: string;
  level: string | null;
  expiryDate: string | null;
}

interface AssayerLite {
  id: string;
  assayerCode: string;
  displayName: string;
  state: string | null;
  district: string | null;
  lifecycleStatus: string;
}

type Vocabulary = Record<string, Array<{ name: string; assayerCount: number }>>;

const TYPE_META: Record<AttrType, { label: string; icon: typeof Award; hasExpiry: boolean }> = {
  SKILL: { label: 'Skills', icon: Wrench, hasExpiry: false },
  LANGUAGE: { label: 'Languages', icon: LangIcon, hasExpiry: false },
  CERTIFICATION: { label: 'Certifications', icon: Award, hasExpiry: true },
  SPECIALIZATION: { label: 'Specializations', icon: Award, hasExpiry: false },
};

const daysUntil = (iso: string | null): number | null => {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
};

/** Stacks the two-pane layout below this width so the picker/detail don't overlap on phones. */
function useNarrow(breakpoint = 760): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < breakpoint);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < breakpoint);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [breakpoint]);
  return narrow;
}

export const HrCapabilityPage: React.FC = () => {

  const { canManage } = useHr();
  const narrow = useNarrow();
  const [roster, setRoster] = useState<AssayerLite[]>([]);
  const [vocab, setVocab] = useState<Vocabulary>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [attrs, setAttrs] = useState<WorkforceAttribute[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [attrsLoading, setAttrsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Roster and vocabulary load once; the vocabulary drives the picker so names stay consistent.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [people, vocabulary] = await Promise.all([
          api.request<AssayerLite[]>('/assayers?limit=1000'),
          api.request<Vocabulary>('/assayers/workforce-attribute/vocabulary'),
        ]);
        if (cancelled) return;
        setRoster(people);
        setVocab(vocabulary);
        setSelectedId((prev) => prev ?? people[0]?.id ?? null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loadAttrs = async (assayerId: string) => {
    setAttrsLoading(true);
    try {
      const rows = await api.request<WorkforceAttribute[]>(`/assayers/${assayerId}/workforce-attribute`);
      setAttrs(rows);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAttrsLoading(false);
    }
  };

  useEffect(() => {
    if (selectedId) loadAttrs(selectedId);
  }, [selectedId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return roster;
    return roster.filter((a) =>
      a.displayName.toLowerCase().includes(q) || a.assayerCode.toLowerCase().includes(q));
  }, [roster, search]);

  const selected = roster.find((a) => a.id === selectedId) ?? null;

  const byType = (t: AttrType) => attrs.filter((a) => a.type === t);

  const addAttr = async (type: AttrType, name: string, expiryDate?: string) => {
    if (!selectedId || !name.trim()) return;
    await api.request(`/assayers/${selectedId}/workforce-attribute`, {
      method: 'POST',
      body: JSON.stringify({ type, name: name.trim(), expiryDate: expiryDate || undefined }),
    });
    await loadAttrs(selectedId);
    // A newly-typed name becomes part of the shared vocabulary immediately.
    setVocab((v) => {
      const list = v[type] ?? [];
      if (list.some((x) => x.name.toLowerCase() === name.trim().toLowerCase())) return v;
      return { ...v, [type]: [...list, { name: name.trim(), assayerCount: 1 }] };
    });
  };

  const removeAttr = async (id: string) => {
    if (!selectedId) return;
    await api.request(`/assayers/workforce-attribute/${id}`, { method: 'DELETE' });
    await loadAttrs(selectedId);
  };

  const updateExpiry = async (id: string, expiryDate: string) => {
    await api.request(`/assayers/workforce-attribute/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ expiryDate }),
    });
    if (selectedId) await loadAttrs(selectedId);
  };

  if (loading) return <div style={{ padding: '20px 4px', color: 'var(--text-muted)' }}>Loading capability register…</div>;
  if (error) return <div style={{ padding: '20px 4px', color: 'var(--danger)' }}>{error}</div>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'minmax(240px, 300px) 1fr', gap: '18px', alignItems: 'start' }}>
      {/* Roster picker */}
      <div style={{ ...card, padding: '12px', position: narrow ? 'static' : 'sticky', top: '12px' }}>
        <div style={{ position: 'relative', marginBottom: '10px' }}>
          <Search size={13} style={{ position: 'absolute', left: '9px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Find an assayer…"
            style={{ width: '100%', padding: '7px 10px 7px 28px', fontSize: '12.5px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)' }}
          />
        </div>
        <div style={{ maxHeight: '68vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {filtered.map((a) => {
            const active = a.id === selectedId;
            return (
              <button
                key={a.id}
                onClick={() => setSelectedId(a.id)}
                style={{
                  textAlign: 'left', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer', border: 'none',
                  background: active ? 'var(--status-pending-bg)' : 'transparent',
                  color: active ? 'var(--accent)' : 'var(--text-secondary)',
                }}
              >
                <div style={{ fontSize: '13px', fontWeight: 600 }}>{a.displayName}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {a.assayerCode}{a.district ? ` · ${a.district}` : ''}
                </div>
              </button>
            );
          })}
          {filtered.length === 0 && <Empty>No assayer matches “{search}”.</Empty>}
        </div>
      </div>

      {/* Capability editor */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {selected && (
          <div style={{ ...card }}>
            <div style={{ fontSize: '16px', fontWeight: 700 }}>{selected.displayName}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
              {selected.assayerCode} · {selected.lifecycleStatus}
            </div>
          </div>
        )}

        {(Object.keys(TYPE_META) as AttrType[]).map((type) => (
          <AttributeSection
            key={type}
            type={type}
            rows={byType(type)}
            vocab={vocab[type] ?? []}
            canManage={canManage}
            busy={attrsLoading}
            onAdd={addAttr}
            onRemove={removeAttr}
            onUpdateExpiry={updateExpiry}
          />
        ))}
      </div>
    </div>
  );
};

const AttributeSection: React.FC<{
  type: AttrType;
  rows: WorkforceAttribute[];
  vocab: Array<{ name: string; assayerCount: number }>;
  canManage: boolean;
  busy: boolean;
  onAdd: (type: AttrType, name: string, expiry?: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
  onUpdateExpiry: (id: string, expiry: string) => Promise<void>;
}> = ({ type, rows, vocab, canManage, busy, onAdd, onRemove, onUpdateExpiry }) => {
  const meta = TYPE_META[type];
  const Icon = meta.icon;
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState('');
  const [saving, setSaving] = useState(false);

  const held = new Set(rows.map((r) => r.name.toLowerCase()));
  const suggestions = vocab.filter((v) => !held.has(v.name.toLowerCase()));

  const submit = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      await onAdd(type, name, meta.hasExpiry ? expiry : undefined);
      setName('');
      setExpiry('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ ...card }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px' }}>
        <Icon size={15} style={{ color: 'var(--accent)' }} />
        <span style={{ ...label, fontSize: '12px' }}>{meta.label}</span>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>({rows.length})</span>
      </div>

      {rows.length === 0 ? (
        <Empty>{`No ${meta.label.toLowerCase()} recorded yet. They appear here once HR adds them to an assayer’s record.`}</Empty>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {rows.map((r) => {
            const days = daysUntil(r.expiryDate);
            return (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '7px 10px', background: 'var(--bg-surface-2)', borderRadius: '8px' }}>
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{r.name}</span>
                {meta.hasExpiry && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginLeft: 'auto' }}>
                    {days !== null && <ExpiryChip days={days} />}
                    {canManage && (
                      <input
                        type="date"
                        defaultValue={r.expiryDate ? r.expiryDate.slice(0, 10) : ''}
                        onChange={(e) => e.target.value && onUpdateExpiry(r.id, e.target.value)}
                        title="Renewal / expiry date"
                        style={{ fontSize: '11px', padding: '3px 6px', background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-secondary)' }}
                      />
                    )}
                  </div>
                )}
                {canManage && (
                  <button
                    onClick={() => onRemove(r.id)}
                    title={`Remove ${r.name}`}
                    style={{ marginLeft: meta.hasExpiry ? 0 : 'auto', background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: '2px', display: 'flex' }}
                  >
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {meta.hasExpiry && rows.some((r) => { const d = daysUntil(r.expiryDate); return d !== null && d < 0; }) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '10px', fontSize: '11.5px', color: 'var(--danger)' }}>
          <AlertTriangle size={12} /> A lapsed certification removes this assayer from the assignable pool until it is renewed.
        </div>
      )}

      {canManage && (
        <div style={{ display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            list={`vocab-${type}`}
            placeholder={`Add a ${meta.label.toLowerCase().replace(/s$/, '')}…`}
            style={{ flex: '1 1 180px', padding: '7px 10px', fontSize: '12.5px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)' }}
          />
          {/*
            The count is the TOTAL number of assayers holding this attribute — `COUNT(DISTINCT
            assayer_id)` over the whole roster — not "others besides the one being edited". It
            read "N others", which overstated by one whenever the current assayer already held
            it, and rendered "1 others" for a name this session had just invented. Labelled for
            what it is, which is also the more useful figure when picking a skill: how many
            people the register already recognises under that name. The Capability inventory on
            the compliance page shows the same number for the same reason.
          */}
          <datalist id={`vocab-${type}`}>
            {suggestions.map((s) => (
              <option key={s.name} value={s.name}>
                {`${s.assayerCount} assayer${s.assayerCount === 1 ? '' : 's'}`}
              </option>
            ))}
          </datalist>
          {meta.hasExpiry && (
            <input
              type="date"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              title="Expiry date (optional)"
              style={{ padding: '7px 8px', fontSize: '12px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-secondary)' }}
            />
          )}
          <button
            onClick={submit}
            disabled={!name.trim() || saving || busy}
            className="btn btn-primary"
            style={{ padding: '7px 14px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '5px', opacity: !name.trim() || saving ? 0.5 : 1 }}
          >
            <Plus size={13} /> Add
          </button>
        </div>
      )}
    </div>
  );
};
