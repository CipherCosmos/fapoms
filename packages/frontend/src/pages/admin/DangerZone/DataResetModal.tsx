import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { Modal, useToast } from '../../../components/ui';
import { controlStyle, Pill } from '../../../components/ui/settings';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { useCurrentUserId } from '../../../hooks/useCurrentRoles';
import { WipeDomain, domainRowCount } from './DangerZoneSection';

/** Mirrors DATA_RESET_CONFIRMATION_PHRASE in data-reset.controller.ts — server-side is the real
 *  check; this only lets the button disable itself before a request is even sent. */
const CONFIRMATION_PHRASE = 'DELETE ALL SELECTED DATA';

interface FkEdgeDetail {
  child: string;
  column: string;
  parent: string;
  onDelete: string;
  affectedRowCount: number;
}

interface PreviewResult {
  impactedTables: string[];
  impliedDomains: string[];
  restrictConflicts: FkEdgeDetail[];
  setNullEffects: FkEdgeDetail[];
  counts: Record<string, number>;
}

interface UserOption {
  id: string;
  displayName?: string;
  username?: string;
  email?: string;
  roles?: Array<{ name: string } | string>;
}

const roleNames = (u: UserOption) => (u.roles ?? []).map((r) => (typeof r === 'string' ? r : r?.name)).filter(Boolean).join(', ');

export const DataResetModal: React.FC<{
  domains: WipeDomain[];
  initialSelectedKeys: string[];
  onClose: () => void;
  onWiped: () => void;
}> = ({ domains, initialSelectedKeys, onClose, onWiped }) => {
  const { toast } = useToast();
  const currentUserId = useCurrentUserId();

  const [selectedKeys, setSelectedKeys] = useState<string[]>(initialSelectedKeys);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [billingConfirmed, setBillingConfirmed] = useState(false);
  const [takeBackupFirst, setTakeBackupFirst] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState<'idle' | 'backing-up' | 'wiping'>('idle');
  const [result, setResult] = useState<{ removed: Record<string, number>; backup: any } | null>(null);

  const [userSearch, setUserSearch] = useState('');
  const [keepUserIds, setKeepUserIds] = useState<string[]>(currentUserId ? [currentUserId] : []);
  const [users, setUsers] = useState<UserOption[] | null>(null);
  const [usersLoading, setUsersLoading] = useState(false);

  const domainByKey = useMemo(() => Object.fromEntries(domains.map((d) => [d.key, d])), [domains]);
  /** Which domain's row-list mentions this table — used to tell the admin exactly what to also select. */
  const tableToDomainLabel = useMemo(() => {
    const map: Record<string, string> = {};
    for (const d of domains) for (const t of d.tables) map[t] = d.label;
    return map;
  }, [domains]);
  const includesUsers = selectedKeys.includes('users');
  const includesBilling = selectedKeys.includes('billing');

  const toggleDomain = (key: string) =>
    setSelectedKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  const addDomain = (key: string) =>
    setSelectedKeys((prev) => (prev.includes(key) ? prev : [...prev, key]));

  // Live preview — debounced, refetches whenever the selection actually changes.
  useEffect(() => {
    if (selectedKeys.length === 0) { setPreview(null); return; }
    let cancelled = false;
    setPreviewLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await api.request<PreviewResult>('/admin/data-reset/preview', {
          method: 'POST',
          body: JSON.stringify({ domainKeys: selectedKeys }),
        });
        if (!cancelled) setPreview(res);
      } catch (err: any) {
        if (!cancelled) toast({ type: 'error', title: 'Could not compute preview', message: userMessage(err) });
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 300);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKeys.join(',')]);

  // Load the account picker only once "users" is actually selected — no need to fetch 500 rows
  // for a wipe that never touches accounts.
  useEffect(() => {
    if (!includesUsers || users !== null) return;
    setUsersLoading(true);
    // api.request already unwraps the {success, data} envelope, so this resolves straight to
    // the array — see ApiClient.request in services/api.ts.
    api.request<UserOption[]>('/users?limit=500')
      .then((res) => setUsers(res ?? []))
      .catch((err) => toast({ type: 'error', title: 'Could not load accounts', message: userMessage(err) }))
      .finally(() => setUsersLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includesUsers]);

  const toggleKeepUser = (id: string) => {
    if (id === currentUserId) return; // always kept — see below
    setKeepUserIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const filteredUsers = (users ?? []).filter((u) => {
    if (!userSearch.trim()) return true;
    const q = userSearch.toLowerCase();
    return (u.displayName ?? '').toLowerCase().includes(q)
      || (u.username ?? '').toLowerCase().includes(q)
      || (u.email ?? '').toLowerCase().includes(q);
  });

  const hasBlockingConflicts = (preview?.restrictConflicts.length ?? 0) > 0;
  const hasUnresolvedImplied = (preview?.impliedDomains.length ?? 0) > 0;
  const billingOk = !includesBilling || billingConfirmed;
  const confirmTextOk = confirmText === CONFIRMATION_PHRASE;

  const canSubmit =
    selectedKeys.length > 0 &&
    !previewLoading &&
    !hasBlockingConflicts &&
    !hasUnresolvedImplied &&
    billingOk &&
    confirmTextOk &&
    submitting === 'idle';

  const submit = async () => {
    setSubmitting(takeBackupFirst ? 'backing-up' : 'wiping');
    try {
      const res = await api.request<{ removed: Record<string, number>; backup: any }>(
        '/admin/data-reset/execute',
        {
          method: 'POST',
          body: JSON.stringify({
            domainKeys: selectedKeys,
            keepUserIds,
            billingConfirmed: includesBilling ? billingConfirmed : undefined,
            takeBackupFirst,
            confirmationPhrase: confirmText,
          }),
          // A backup + a multi-table wipe on a database with real volume can run well past the
          // default request timeout — same reasoning as the file-upload/report-export flows.
          timeoutMs: 180_000,
        },
      );
      setResult(res as any);
      toast('success', 'Data wiped.');
    } catch (err: any) {
      toast({ type: 'error', title: 'Wipe failed — nothing further was attempted', message: userMessage(err) });
    } finally {
      setSubmitting('idle');
    }
  };

  if (result) {
    return (
      <Modal open onClose={onWiped} title="Data wiped" width="520px">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--success, #34a853)' }}>
            <CheckCircle2 size={18} />
            <span style={{ fontSize: '13px', fontWeight: 600 }}>Done.</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '240px', overflowY: 'auto' }}>
            {Object.entries(result.removed).map(([table, count]) => (
              <div key={table} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: 'var(--text-secondary)', padding: '4px 0', borderBottom: '1px solid var(--border-hair, var(--border-color))' }}>
                <span>{table}</span>
                <span style={{ fontWeight: 700 }}>{Number(count).toLocaleString()} removed</span>
              </div>
            ))}
          </div>
          {result.backup && (
            <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', background: 'var(--bg-secondary)', padding: '10px', borderRadius: '6px' }}>
              A backup was taken first: <b>{result.backup.filename}</b> ({Math.round(result.backup.sizeBytes / 1024)} KB).
              To restore it manually: <code>./deploy/restore.sh --to-production {result.backup.filename}</code>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary" onClick={onWiped}>Done</button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} title="Wipe selected data" width="620px" height="80vh">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
        {/* Domains, editable here too */}
        <div>
          <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px' }}>Domains</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {domains.map((d) => {
              const checked = selectedKeys.includes(d.key);
              return (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => toggleDomain(d.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 11px', borderRadius: '16px',
                    fontSize: '11.5px', fontWeight: 600, cursor: 'pointer',
                    border: `1px solid ${checked ? 'var(--danger)' : 'var(--border-color)'}`,
                    background: checked ? 'rgba(216,71,71,0.12)' : 'transparent',
                    color: checked ? 'var(--danger)' : 'var(--text-secondary)',
                  }}
                >
                  {d.label} · {domainRowCount(d).toLocaleString()}
                </button>
              );
            })}
          </div>
        </div>

        {/* Live preview */}
        {selectedKeys.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {previewLoading && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '12px', color: 'var(--text-muted)' }}>
                <Loader2 size={13} className="spin" /> Checking what this would touch…
              </div>
            )}

            {hasBlockingConflicts && (
              <div style={{ border: '1px solid var(--danger)', background: 'rgba(216,71,71,0.08)', borderRadius: '8px', padding: '12px' }}>
                <div style={{ display: 'flex', gap: '7px', alignItems: 'center', fontSize: '12.5px', fontWeight: 700, color: 'var(--danger)' }}>
                  <AlertTriangle size={14} /> This can't be wiped as selected
                </div>
                {preview!.restrictConflicts.map((c, i) => (
                  <div key={i} style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px' }}>
                    <b>{c.affectedRowCount.toLocaleString()}</b> row(s) in <b>{tableToDomainLabel[c.child] ?? c.child}</b> still
                    reference <b>{tableToDomainLabel[c.parent] ?? c.parent}</b> — also select{' '}
                    <b>{tableToDomainLabel[c.child] ?? c.child}</b>, or unselect the domain that owns {tableToDomainLabel[c.parent] ?? c.parent}.
                  </div>
                ))}
              </div>
            )}

            {hasUnresolvedImplied && (
              <div style={{ border: '1px solid var(--warning)', background: 'rgba(216,120,71,0.08)', borderRadius: '8px', padding: '12px' }}>
                <div style={{ display: 'flex', gap: '7px', alignItems: 'center', fontSize: '12.5px', fontWeight: 700, color: 'var(--warning)' }}>
                  <AlertTriangle size={14} /> This selection also clears data you haven't selected
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {preview!.impliedDomains.map((key) => (
                    <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span><b>{domainByKey[key]?.label ?? key}</b> — cascades from what's already selected.</span>
                      <button type="button" className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: '11px' }} onClick={() => addDomain(key)}>
                        Add to selection
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {!previewLoading && (preview?.setNullEffects.length ?? 0) > 0 && (
              <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', display: 'flex', gap: '7px', alignItems: 'flex-start' }}>
                <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: '1px' }} />
                <span>
                  {preview!.setNullEffects.map((e, i) => (
                    <React.Fragment key={i}>
                      {i > 0 && '; '}
                      {e.affectedRowCount.toLocaleString()} row(s) in {e.child} will have their {e.column} cleared, not deleted
                    </React.Fragment>
                  ))}.
                </span>
              </div>
            )}
          </div>
        )}

        {/* Billing extra confirmation */}
        {includesBilling && (
          <label style={{ display: 'flex', gap: '9px', alignItems: 'flex-start', fontSize: '12.5px', color: 'var(--text-secondary)', padding: '10px', border: '1px solid var(--warning)', borderRadius: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={billingConfirmed}
              onChange={(e) => setBillingConfirmed(e.target.checked)}
              style={{ marginTop: '2px', cursor: 'pointer' }}
            />
            I understand this permanently deletes invoices, payments and payable records.
          </label>
        )}

        {/* Users keep-list */}
        {includesUsers && (
          <div>
            <div style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
              Accounts to keep <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}>— everyone else is removed</span>
            </div>
            <input
              type="text" placeholder="Search accounts…" value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              style={{ ...controlStyle, marginBottom: '8px' }}
            />
            <div style={{ maxHeight: '180px', overflowY: 'auto', border: '1px solid var(--border-color)', borderRadius: '6px' }}>
              {usersLoading ? (
                <div style={{ padding: '16px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>Loading accounts…</div>
              ) : (
                filteredUsers.map((u) => {
                  const isSelf = u.id === currentUserId;
                  const keep = isSelf || keepUserIds.includes(u.id);
                  return (
                    <label
                      key={u.id}
                      style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '7px 10px', borderBottom: '1px solid var(--border-hair, var(--border-color))', cursor: isSelf ? 'not-allowed' : 'pointer', opacity: isSelf ? 0.75 : 1 }}
                    >
                      <input type="checkbox" checked={keep} disabled={isSelf} onChange={() => toggleKeepUser(u.id)} style={{ cursor: isSelf ? 'not-allowed' : 'pointer' }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                          {u.displayName || u.username} {isSelf && <Pill tone="accent">You — always kept</Pill>}
                        </div>
                        <div style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>{u.email} {roleNames(u) && `· ${roleNames(u)}`}</div>
                      </div>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        )}

        {/* Backup checkbox */}
        <label style={{ display: 'flex', gap: '9px', alignItems: 'center', fontSize: '12.5px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
          <input type="checkbox" checked={takeBackupFirst} onChange={(e) => setTakeBackupFirst(e.target.checked)} style={{ cursor: 'pointer' }} />
          Take a backup before wiping
        </label>

        {/* Typed confirmation */}
        <div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
            Type <b>{CONFIRMATION_PHRASE}</b> to confirm:
          </div>
          <input
            type="text" value={confirmText} onChange={(e) => setConfirmText(e.target.value)}
            placeholder={CONFIRMATION_PHRASE} style={controlStyle}
          />
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', paddingTop: '4px' }}>
          <button className="btn btn-secondary" onClick={onClose} disabled={submitting !== 'idle'}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={!canSubmit}
            onClick={submit}
            style={{ background: 'var(--danger)', border: 'none', display: 'flex', alignItems: 'center', gap: '7px' }}
          >
            {submitting === 'backing-up' && <><Loader2 size={13} className="spin" /> Taking a backup first…</>}
            {submitting === 'wiping' && <><Loader2 size={13} className="spin" /> Wiping…</>}
            {submitting === 'idle' && 'Wipe now'}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default DataResetModal;
