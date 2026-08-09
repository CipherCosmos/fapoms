import React, { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, ShieldAlert, ShieldQuestion, Plus, Search, Check, X, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import { card, label, Empty, ExpiryChip, fmtDate } from './hr-ui';
import { useCurrentRoles, canManageAssayers } from '../../hooks/useCurrentRoles';
import { SystemRole } from '@fapoms/shared';

/**
 * Identity document register.
 *
 * Field assayers visit client bank vaults, so identity verification is normally a precondition
 * of that access. The backend has add / verify / reject / remove routes for government identity
 * documents, all gated to HR — and the table was empty because nothing could write to it. The
 * compliance dashboard even carried a banner telling HR to "upload documents from each
 * assayer's profile", where the profile was a read-only list with no upload control.
 *
 * This page is the register that banner pointed at: record an Aadhaar / PAN / driving licence
 * with its number and expiry, then move it from Pending to Verified or Rejected. That
 * Pending → Verified transition, with who did it and when, is the verification trail an audit
 * of the workforce needs.
 *
 * Files are deliberately out of scope here: the file-upload route is gated to operations roles,
 * not HR, so attaching a scan needs a permission decision rather than a silent reuse of an
 * endpoint HR was not granted. The record, its number, its expiry and its verification state —
 * which is what compliance turns on — are all captured without one.
 */

const DOC_TYPES = ['AADHAAR', 'PAN', 'DRIVING_LICENCE', 'VOTER_ID', 'PASSPORT'] as const;

interface GovDocument {
  id: string;
  assayerId: string;
  documentType: string;
  documentNumber: string;
  expiryDate: string | null;
  verificationStatus: 'PENDING' | 'VERIFIED' | 'REJECTED';
  verifiedAt: string | null;
  verifiedBy: string | null;
}

interface AssayerLite {
  id: string;
  assayerCode: string;
  displayName: string;
  district: string | null;
  lifecycleStatus: string;
}

const STATUS_META = {
  VERIFIED: { icon: ShieldCheck, fg: 'var(--success)', bg: 'var(--status-active-bg)', label: 'Verified' },
  PENDING: { icon: ShieldQuestion, fg: 'var(--warning)', bg: 'var(--status-pending-bg)', label: 'Pending' },
  REJECTED: { icon: ShieldAlert, fg: 'var(--danger)', bg: 'var(--status-cancelled-bg)', label: 'Rejected' },
} as const;

const daysUntil = (iso: string | null): number | null =>
  iso ? Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000) : null;

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

export const HrDocumentsPage: React.FC = () => {
  const roles = useCurrentRoles();
  const canManage = canManageAssayers(roles);
  const narrow = useNarrow();
  // Deletion of an identity document is admin-only on the backend; verify is HR.
  const canDelete = roles.some((r) => [SystemRole.SUPER_ADMINISTRATOR, SystemRole.ADMINISTRATOR].includes(r));

  const [roster, setRoster] = useState<AssayerLite[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [docs, setDocs] = useState<GovDocument[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [docsLoading, setDocsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const people = await api.request<AssayerLite[]>('/assayers?limit=1000');
        if (cancelled) return;
        setRoster(people);
        setSelectedId((prev) => prev ?? people[0]?.id ?? null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loadDocs = async (assayerId: string) => {
    setDocsLoading(true);
    try {
      setDocs(await api.request<GovDocument[]>(`/assayers/${assayerId}/government-document`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDocsLoading(false);
    }
  };

  useEffect(() => { if (selectedId) loadDocs(selectedId); }, [selectedId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? roster.filter((a) => a.displayName.toLowerCase().includes(q) || a.assayerCode.toLowerCase().includes(q)) : roster;
  }, [roster, search]);

  const selected = roster.find((a) => a.id === selectedId) ?? null;

  const addDoc = async (documentType: string, documentNumber: string, expiryDate?: string) => {
    if (!selectedId) return;
    await api.request(`/assayers/${selectedId}/government-document`, {
      method: 'POST',
      body: JSON.stringify({ documentType, documentNumber, expiryDate: expiryDate || undefined }),
    });
    await loadDocs(selectedId);
  };

  const setStatus = async (id: string, verificationStatus: GovDocument['verificationStatus']) => {
    await api.request(`/assayers/government-document/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ verificationStatus }),
    });
    if (selectedId) await loadDocs(selectedId);
  };

  const removeDoc = async (id: string) => {
    await api.request(`/assayers/government-document/${id}`, { method: 'DELETE' });
    if (selectedId) await loadDocs(selectedId);
  };

  if (loading) return <div style={{ padding: '20px 4px', color: 'var(--text-muted)' }}>Loading document register…</div>;
  if (error) return <div style={{ padding: '20px 4px', color: 'var(--danger)' }}>{error}</div>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'minmax(240px, 300px) 1fr', gap: '18px', alignItems: 'start' }}>
      <div style={{ ...card, padding: '12px', position: narrow ? 'static' : 'sticky', top: '12px' }}>
        <div style={{ position: 'relative', marginBottom: '10px' }}>
          <Search size={13} style={{ position: 'absolute', left: '9px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find an assayer…"
            style={{ width: '100%', padding: '7px 10px 7px 28px', fontSize: '12.5px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)' }} />
        </div>
        <div style={{ maxHeight: '68vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {filtered.map((a) => {
            const active = a.id === selectedId;
            return (
              <button key={a.id} onClick={() => setSelectedId(a.id)}
                style={{ textAlign: 'left', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer', border: 'none',
                  background: active ? 'var(--status-pending-bg)' : 'transparent', color: active ? 'var(--accent)' : 'var(--text-secondary)' }}>
                <div style={{ fontSize: '13px', fontWeight: 600 }}>{a.displayName}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{a.assayerCode}{a.district ? ` · ${a.district}` : ''}</div>
              </button>
            );
          })}
          {filtered.length === 0 && <Empty>No assayer matches “{search}”.</Empty>}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {selected && (
          <div style={card}>
            <div style={{ fontSize: '16px', fontWeight: 700 }}>{selected.displayName}</div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>{selected.assayerCode} · {selected.lifecycleStatus}</div>
          </div>
        )}

        <div style={card}>
          <div style={{ ...label, marginBottom: '12px' }}>Identity documents ({docs.length})</div>
          {docs.length === 0 ? (
            <Empty>No identity document recorded for this assayer.</Empty>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {docs.map((doc) => {
                const meta = STATUS_META[doc.verificationStatus] ?? STATUS_META.PENDING;
                const Icon = meta.icon;
                const days = daysUntil(doc.expiryDate);
                return (
                  <div key={doc.id} style={{ padding: '11px 13px', background: 'var(--bg-surface-2)', borderRadius: '10px', display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                    <div style={{ minWidth: '160px' }}>
                      <div style={{ fontSize: '13px', fontWeight: 600 }}>{doc.documentType.replace(/_/g, ' ')}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', fontFamily: 'monospace' }}>{doc.documentNumber}</div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {doc.expiryDate && <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>exp {fmtDate(doc.expiryDate)}</span>}
                      {days !== null && <ExpiryChip days={days} />}
                    </div>

                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', fontSize: '11px', fontWeight: 700, padding: '3px 9px', borderRadius: '999px', background: meta.bg, color: meta.fg, marginLeft: 'auto' }}>
                      <Icon size={12} /> {meta.label}
                    </span>

                    {doc.verifiedAt && (
                      <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>{meta.label.toLowerCase()} {fmtDate(doc.verifiedAt)}</span>
                    )}

                    {canManage && doc.verificationStatus !== 'VERIFIED' && (
                      <button onClick={() => setStatus(doc.id, 'VERIFIED')} title="Mark verified"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11.5px', fontWeight: 600, padding: '5px 10px', borderRadius: '7px', border: '1px solid var(--success)', background: 'transparent', color: 'var(--success)', cursor: 'pointer' }}>
                        <Check size={12} /> Verify
                      </button>
                    )}
                    {canManage && doc.verificationStatus !== 'REJECTED' && (
                      <button onClick={() => setStatus(doc.id, 'REJECTED')} title="Reject"
                        style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '11.5px', fontWeight: 600, padding: '5px 10px', borderRadius: '7px', border: '1px solid var(--danger)', background: 'transparent', color: 'var(--danger)', cursor: 'pointer' }}>
                        <X size={12} /> Reject
                      </button>
                    )}
                    {canDelete && (
                      <button onClick={() => removeDoc(doc.id)} title="Remove record"
                        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px', display: 'flex' }}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {canManage && <AddDocumentForm busy={docsLoading} onAdd={addDoc} />}
        </div>
      </div>
    </div>
  );
};

const AddDocumentForm: React.FC<{ busy: boolean; onAdd: (type: string, number: string, expiry?: string) => Promise<void> }> = ({ busy, onAdd }) => {
  const [type, setType] = useState<string>(DOC_TYPES[0]);
  const [number, setNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!number.trim() || saving) return;
    setSaving(true);
    try {
      await onAdd(type, number.trim(), expiry || undefined);
      setNumber('');
      setExpiry('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', gap: '8px', marginTop: '14px', flexWrap: 'wrap', alignItems: 'center', borderTop: '1px solid var(--border-hair)', paddingTop: '14px' }}>
      <select value={type} onChange={(e) => setType(e.target.value)}
        style={{ padding: '7px 10px', fontSize: '12.5px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)' }}>
        {DOC_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}
      </select>
      <input value={number} onChange={(e) => setNumber(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()}
        placeholder="Document number" style={{ flex: '1 1 180px', padding: '7px 10px', fontSize: '12.5px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)', fontFamily: 'monospace' }} />
      <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} title="Expiry date (optional)"
        style={{ padding: '7px 8px', fontSize: '12px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-secondary)' }} />
      <button onClick={submit} disabled={!number.trim() || saving || busy} className="btn btn-primary"
        style={{ padding: '7px 14px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '5px', opacity: !number.trim() || saving ? 0.5 : 1 }}>
        <Plus size={13} /> Record
      </button>
    </div>
  );
};
