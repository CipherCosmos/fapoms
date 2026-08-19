import React, { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, ShieldAlert, ShieldQuestion, Plus, Search, Check, X, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { Link } from 'react-router-dom';
import { Select } from '../../components/ui';
import { card, label, Empty, ExpiryChip, fmtDate, govDocStatusLabel } from './hr-ui';
import { useCurrentRoles, canManageAssayers } from '../../hooks/useCurrentRoles';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { SystemRole, HR_DOCUMENT_TYPES, hrDocumentTypeLabel, assayerLifecycleLabel } from '@fapoms/shared';

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

// The same five papers were listed here and in @fapoms/shared. Kept as an alias so the rest
// of this file reads unchanged, but there is now one list — and one spelling of each name.
const DOC_TYPES = HR_DOCUMENT_TYPES;

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

// Wording comes from the shared map in hr-ui so this register and the expiry list on the
// sibling chip cannot describe the same document with two different words.
const STATUS_META = {
  VERIFIED: { icon: ShieldCheck, fg: 'var(--success)', bg: 'var(--status-active-bg)', label: govDocStatusLabel('VERIFIED') },
  PENDING: { icon: ShieldQuestion, fg: 'var(--warning)', bg: 'var(--status-pending-bg)', label: govDocStatusLabel('PENDING') },
  REJECTED: { icon: ShieldAlert, fg: 'var(--danger)', bg: 'var(--status-cancelled-bg)', label: govDocStatusLabel('REJECTED') },
} as const;

/**
 * How many people this screen will pre-scan for "has any identity document".
 *
 * There is no bulk endpoint — documents are only readable one assayer at a time — so knowing who
 * is missing one means asking once per person. With the real roster (8 people, and zero documents
 * recorded between them) that is trivial and it is the whole job: the register was a per-person
 * search box, so the only way to learn that nobody had an ID on file was to click all of them and
 * remember. Above this size the scan stops being free, so it is skipped and the list simply
 * behaves as it did before rather than firing hundreds of requests on mount.
 */
const SCAN_LIMIT = 120;

/** Small fixed-concurrency map, so the scan does not open one socket per person at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]);
    }),
  );
  return out;
}

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
  // Two error slots on purpose. `fatalError` means the roster itself never arrived, so there is
  // nothing to show; `docError` is one person's documents failing to load or a verify/remove
  // being rejected. The two shared one slot, and a single failed action replaced the entire
  // register with a red sentence — losing the roster, the selection and any half-typed entry.
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  // assayerId -> how many identity documents they have. Populated by the pre-scan below and kept
  // in step by every add/remove, so "who has nothing on file" is a list rather than a hunt.
  const [docCounts, setDocCounts] = useState<Record<string, number>>({});
  const [scanned, setScanned] = useState(false);
  const [onlyMissing, setOnlyMissing] = useState(false);
  const { confirm, confirmDialog } = useConfirm();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const people = await api.request<AssayerLite[]>('/assayers?limit=1000');
        if (cancelled) return;
        setRoster(people);
        setSelectedId((prev) => prev ?? people[0]?.id ?? null);
        setLoading(false);

        // Pre-scan for who has nothing on file. Without it the only signal that a person's
        // identity papers are missing is selecting them and reading an empty panel, which for a
        // roster where *nobody* has a document means eight clicks to learn one fact.
        if (people.length <= SCAN_LIMIT) {
          const counts = await mapLimit(people, 6, async (a) => {
            try {
              const list = await api.request<GovDocument[]>(`/assayers/${a.id}/government-document`);
              return [a.id, list.length] as const;
            } catch {
              // A person whose documents cannot be read is not evidence that they have none, so
              // they are left out of the map and shown as unknown rather than falsely flagged.
              return null;
            }
          });
          if (cancelled) return;
          setDocCounts(Object.fromEntries(counts.filter(Boolean) as ReadonlyArray<readonly [string, number]>));
          setScanned(true);
        }
      } catch (e) {
        if (!cancelled) { setFatalError(userMessage(e)); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const loadDocs = async (assayerId: string) => {
    setDocsLoading(true);
    setDocError(null);
    try {
      const list = await api.request<GovDocument[]>(`/assayers/${assayerId}/government-document`);
      setDocs(list);
      setDocCounts((prev) => ({ ...prev, [assayerId]: list.length }));
    } catch (e) {
      setDocs([]);
      setDocError(userMessage(e));
    } finally {
      setDocsLoading(false);
    }
  };

  useEffect(() => { if (selectedId) loadDocs(selectedId); }, [selectedId]);

  const missingCount = useMemo(
    () => roster.filter((a) => docCounts[a.id] === 0).length,
    [roster, docCounts],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return roster.filter((a) => {
      if (onlyMissing && docCounts[a.id] !== 0) return false;
      if (!q) return true;
      return a.displayName.toLowerCase().includes(q) || a.assayerCode.toLowerCase().includes(q);
    });
  }, [roster, search, onlyMissing, docCounts]);

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
    try {
      await api.request(`/assayers/government-document/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ verificationStatus }),
      });
    } catch (e) {
      // Verify/reject is HR-gated on the backend. Rejection used to throw into an unhandled
      // promise: the button did nothing and the screen said nothing, so it read as a dead
      // control rather than as "you are not allowed to do this".
      setDocError(userMessage(e));
    }
    if (selectedId) await loadDocs(selectedId);
  };

  /**
   * Removing a document deletes the identity record and its verification trail outright — there
   * is no undo and no archive on this route. It was a bare trash icon wired straight to DELETE:
   * one mis-click on a crowded row destroyed an audited Verified→who→when trail that only the
   * person's original paperwork can rebuild. Now it names the document and demands the number be
   * typed, which also guarantees the row being deleted is the row that was meant.
   */
  const removeDoc = async (doc: GovDocument) => {
    const ok = await confirm({
      title: `Remove this ${hrDocumentTypeLabel(doc.documentType)} record?`,
      message: `The ${hrDocumentTypeLabel(doc.documentType)} numbered ${doc.documentNumber}${selected ? ` for ${selected.displayName}` : ''} is deleted, along with the record of who verified it and when. It would have to be entered and verified again from the original paperwork.`,
      confirmLabel: 'Remove document',
      reversible: false,
      tone: 'danger',
      confirmPhrase: doc.documentNumber,
    });
    if (!ok) return;
    try {
      await api.request(`/assayers/government-document/${doc.id}`, { method: 'DELETE' });
    } catch (e) {
      setDocError(userMessage(e));
    }
    if (selectedId) await loadDocs(selectedId);
  };

  if (loading) return <div style={{ padding: '20px 4px', color: 'var(--text-muted)' }}>Loading document register…</div>;
  if (fatalError) return <div style={{ padding: '20px 4px', color: 'var(--danger)' }}>{fatalError}</div>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: narrow ? '1fr' : 'minmax(240px, 300px) 1fr', gap: '18px', alignItems: 'start' }}>
      {confirmDialog}
      <div style={{ ...card, padding: '12px', position: narrow ? 'static' : 'sticky', top: '12px' }}>
        <div style={{ position: 'relative', marginBottom: '10px' }}>
          <Search size={13} style={{ position: 'absolute', left: '9px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find an assayer…"
            style={{ width: '100%', padding: '7px 10px 7px 28px', fontSize: '12.5px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)' }} />
        </div>

        {/*
          * The worklist, in one line. Eight people with no identity paper on file is a list to
          * work through, not something to discover one selection at a time — this says how many
          * there are and narrows the picker to exactly them.
          */}
        {scanned && (
          <button
            onClick={() => setOnlyMissing((v) => !v)}
            disabled={missingCount === 0 && !onlyMissing}
            style={{
              width: '100%', marginBottom: '10px', padding: '7px 10px', fontSize: '11.5px', fontWeight: 700,
              textAlign: 'left', borderRadius: '8px', cursor: missingCount === 0 && !onlyMissing ? 'default' : 'pointer',
              border: `1px solid ${onlyMissing ? 'var(--accent)' : 'var(--border-color)'}`,
              background: onlyMissing ? 'rgba(216,174,71,0.12)' : 'var(--bg-surface-2)',
              color: missingCount > 0 ? 'var(--danger)' : 'var(--text-muted)',
            }}
          >
            {missingCount === 0
              ? 'Everyone has an ID document on file'
              : onlyMissing
                ? `Showing the ${missingCount} with no ID — show everyone`
                : `${missingCount} have no ID document on file — show only them`}
          </button>
        )}

        <div style={{ maxHeight: '68vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {filtered.map((a) => {
            const active = a.id === selectedId;
            return (
              <button key={a.id} onClick={() => setSelectedId(a.id)}
                style={{ textAlign: 'left', padding: '8px 10px', borderRadius: '8px', cursor: 'pointer', border: 'none',
                  background: active ? 'var(--status-pending-bg)' : 'transparent', color: active ? 'var(--accent)' : 'var(--text-secondary)' }}>
                <div style={{ fontSize: '13px', fontWeight: 600 }}>{a.displayName}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{a.assayerCode}{a.district ? ` · ${a.district}` : ''}</div>
                {docCounts[a.id] === 0 && (
                  <div style={{ fontSize: '10.5px', fontWeight: 700, color: 'var(--danger)', marginTop: '2px' }}>No ID on file</div>
                )}
              </button>
            );
          })}
          {filtered.length === 0 && (
            <Empty>
              {onlyMissing && !search.trim()
                ? 'Everyone has at least one identity document recorded.'
                : `No assayer matches “${search}”.`}
            </Empty>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        {selected && (
          <div style={{ ...card, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: '16px', fontWeight: 700 }}>{selected.displayName}</div>
              {/* `lifecycleStatus` is a database enum; printed raw it read `DOCUMENT_VERIFICATION`
                  here while the roster called the same state "Document Verification". */}
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
                {selected.assayerCode} · {assayerLifecycleLabel(selected.lifecycleStatus)}
              </div>
            </div>
            {/* Identity papers and bank details are chased in the same sitting; this is the
                one-click hop to the rest of this person's file rather than a re-search. */}
            <Link to={`/hr/roster?assayer=${selected.id}`} className="btn btn-secondary"
              style={{ fontSize: '12px', padding: '7px 12px', textDecoration: 'none' }}>
              Open full record
            </Link>
          </div>
        )}

        {docError && (
          <div style={{ ...card, borderLeft: '3px solid var(--danger)', fontSize: '12.5px', color: 'var(--danger)' }}>{docError}</div>
        )}

        <div style={card}>
          <div style={{ ...label, marginBottom: '12px' }}>Identity documents ({docs.length})</div>
          {docsLoading && docs.length === 0 ? (
            <Empty>Loading this person’s documents…</Empty>
          ) : docs.length === 0 ? (
            /*
             * "No records found" is a dead end: it names the absence but not the remedy, and with
             * an empty register that is every single person. This says what belongs here and, for
             * whoever can act, points at the form immediately below it.
             */
            <Empty>
              <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>
                Nothing on file for {selected?.displayName ?? 'this assayer'} yet.
              </div>
              <div style={{ marginTop: '6px', maxWidth: '460px', marginInline: 'auto', lineHeight: 1.5 }}>
                An assayer’s file should hold at least one government identity document — Aadhaar, PAN,
                driving licence, voter ID or passport. Field staff are admitted to client bank vaults on
                the strength of it, so it is normally recorded before their first visit.
                {canManage
                  ? ' Enter the type and number below, then mark it Verified once you have seen the original.'
                  : ' HR records and verifies these; ask them to add it.'}
              </div>
            </Empty>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {docs.map((doc) => {
                const meta = STATUS_META[doc.verificationStatus] ?? STATUS_META.PENDING;
                const Icon = meta.icon;
                const days = daysUntil(doc.expiryDate);
                return (
                  <div key={doc.id} style={{ padding: '11px 13px', background: 'var(--bg-surface-2)', borderRadius: '10px', display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' }}>
                    <div style={{ minWidth: '160px' }}>
                      <div style={{ fontSize: '13px', fontWeight: 600 }}>{hrDocumentTypeLabel(doc.documentType)}</div>
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
                      <button onClick={() => removeDoc(doc)} title="Remove record"
                        style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px', display: 'flex' }}>
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/*
            * Keyed by the selected assayer so switching people in the roster REMOUNTS the form
            * and clears it. Its type/number/expiry live in its own state, and nothing reset them
            * on selection change: a half-typed PAN stayed in the box after clicking another
            * assayer, and pressing Add then filed that number against the wrong person — a
            * government identity document attached to someone it does not belong to.
            */}
          {canManage && <AddDocumentForm key={selectedId} busy={docsLoading} onAdd={addDoc} />}
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
      <Select
        value={type}
        onChange={setType}
        options={DOC_TYPES.map((t) => ({ value: t, label: hrDocumentTypeLabel(t) }))}
      />
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
