import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal, StyledInput, DetailDrawer, useToast } from '../../components/ui';
import { useRaiseConflict, useResolveConflict, useBillingEntries, useBillingConflicts } from '../../hooks/useBilling';
import {
  BillingConflictSeverity, BillingConflictStatus, BillingConflictAction,
  BillingEntityType,
} from '@fapoms/shared';
import { userMessage } from '../../services/errors';
import { formatRupees as money } from '@fapoms/shared';

const SEVERITIES = Object.values(BillingConflictSeverity);
const ENTITY_TYPES = Object.values(BillingEntityType);

const SEV_COLOR: Record<BillingConflictSeverity, string> = {
  INFO: 'var(--accent)', WARNING: 'var(--warning)', CRITICAL: 'var(--danger)',
};
const STATUS_COLOR: Record<BillingConflictStatus, string> = {
  OPEN: 'var(--warning)', RESOLVED: 'var(--success)', MERGED: 'var(--success)', SEPARATED: 'var(--accent)',
  REASSIGNED: 'var(--accent)', OVERRIDDEN: 'var(--accent)', REJECTED: 'var(--danger)', ON_HOLD: 'var(--text-muted)',
};
const ACTIONS = Object.values(BillingConflictAction);
const RESOLVE_STATUSES: BillingConflictStatus[] = [
  BillingConflictStatus.RESOLVED, BillingConflictStatus.MERGED, BillingConflictStatus.SEPARATED,
  BillingConflictStatus.REASSIGNED, BillingConflictStatus.OVERRIDDEN, BillingConflictStatus.REJECTED, BillingConflictStatus.ON_HOLD,
];


export const RaiseConflictModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { toast } = useToast();
  const raise = useRaiseConflict();
  const { data: entries } = useBillingEntries();
  const [severity, setSeverity] = useState<BillingConflictSeverity>(BillingConflictSeverity.WARNING);
  const [entityType, setEntityType] = useState<BillingEntityType>(BillingEntityType.ENTRY);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [description, setDescription] = useState('');
  const [reason, setReason] = useState('');

  const toggle = (id: string) => setSelectedIds((p) => p.includes(id) ? p.filter((x) => x !== id) : [...p, id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedIds.length === 0) { toast('error', 'Select at least one entry'); return; }
    if (!description.trim()) { toast('error', 'Enter a description'); return; }
    try {
      await raise.mutateAsync({ severity, entityType, entryIds: selectedIds, description, reason: reason || undefined });
      toast('success', 'Conflict raised'); onClose();
    } catch (err: any) { toast({ type: 'error', title: 'Failed to raise conflict', message: userMessage(err) }); }
  };

  const selStyle: React.CSSProperties = {
    padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', width: '100%',
  };

  return (
    <Modal open onClose={onClose} title={<><AlertTriangle size={18} /> Raise Billing Conflict</>} width="600px" maxHeight="90vh" asForm onSubmit={handleSubmit} footer={
      <>
        <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={raise.isPending} className="btn btn-primary">{raise.isPending ? 'Raising...' : 'Raise Conflict'}</button>
      </>
    }>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
        <select value={severity} onChange={(e) => setSeverity(e.target.value as BillingConflictSeverity)} style={selStyle}>
          {SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={entityType} onChange={(e) => setEntityType(e.target.value as BillingEntityType)} style={selStyle}>
          {ENTITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      <div>
        <label style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Entries</label>
        {entries?.length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>No entries yet.</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6, maxHeight: 200, overflowY: 'auto' }}>
          {(entries ?? []).map((en) => (
            <label key={en.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 8, background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}>
              <input type="checkbox" checked={selectedIds.includes(en.id)} onChange={() => toggle(en.id)} />
              <span style={{ fontSize: 13, flex: 1 }}>{en.entryNumber}</span>
              <span style={{ fontSize: 12, color: STATUS_COLOR[en.state as unknown as BillingConflictStatus] ?? 'var(--text-muted)' }}>{en.state}</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{money(en.totalAmount)}</span>
            </label>
          ))}
        </div>
      </div>

      <StyledInput placeholder="Description *" value={description} onChange={(e) => setDescription(e.target.value)} style={{ width: '100%' }} />
      <StyledInput placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: '100%' }} />
    </Modal>
  );
};

export const ConflictDetailDrawer: React.FC<{ conflictId: string; onClose: () => void }> = ({ conflictId, onClose }) => {
  const { toast } = useToast();
  const { data: conflicts } = useBillingConflicts();
  const resolve = useResolveConflict();
  const [action, setAction] = useState<BillingConflictAction>(BillingConflictAction.RESOLVE);
  const [status, setStatus] = useState<BillingConflictStatus>(BillingConflictStatus.RESOLVED);
  const [note, setNote] = useState('');

  if (!conflicts) return <DetailDrawer open onClose={onClose} title="Loading…" width={560}><div /></DetailDrawer>;
  const c = conflicts.find((x) => x.id === conflictId);
  if (!c) return <DetailDrawer open onClose={onClose} title="Not found" width={560}><div /></DetailDrawer>;

  const doResolve = async () => {
    if (!note.trim()) { toast('error', 'Enter a resolution note'); return; }
    try {
      await resolve.mutateAsync({ id: c.id, status, action, note });
      toast('success', 'Conflict resolved'); onClose();
    } catch (err: any) { toast({ type: 'error', title: 'Resolve failed', message: userMessage(err) }); }
  };

  const Row: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px dashed var(--border-color)' }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{value}</span>
    </div>
  );

  const selStyle: React.CSSProperties = {
    padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', width: '100%',
  };

  return (
    <DetailDrawer
      open onClose={onClose} width={560}
      title={<span><strong style={{ fontSize: 15 }}>{c.conflictNumber}</strong> <span style={{ color: SEV_COLOR[c.severity], fontSize: 12 }}>({c.severity})</span></span>}
      subtitle={<span style={{ color: STATUS_COLOR[c.status], fontWeight: 700 }}>{c.status}</span>}
      footer={
        c.status === BillingConflictStatus.OPEN ? (
          <div style={{ display: 'flex', gap: 8, width: '100%', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button onClick={doResolve} disabled={resolve.isPending} className="btn btn-primary">{resolve.isPending ? 'Resolving...' : 'Resolve'}</button>
          </div>
        ) : undefined
      }
    >
      <Row label="Entity type" value={c.entityType} />
      <Row label="Created by" value={c.createdByName ?? c.createdById} />
      <Row label="Created at" value={new Date(c.createdAt ?? c.updatedAt ?? '').toLocaleString()} />
      {c.resolvedAt && <Row label="Resolved at" value={new Date(c.resolvedAt).toLocaleString()} />}
      {c.resolvedByName && <Row label="Resolved by" value={c.resolvedByName} />}
      <Row label="Entries" value={`${c.entryIds.length} entries`} />
      <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}><strong>Description:</strong> {c.description}</div>
      {c.reason && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}><strong>Reason:</strong> {c.reason}</div>}
      {c.resolutionNote && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}><strong>Resolution:</strong> {c.resolutionNote}</div>}

      {c.status === BillingConflictStatus.OPEN && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--bg-tertiary)', padding: 12, borderRadius: 'var(--radius-sm)' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
            <select value={action} onChange={(e) => setAction(e.target.value as BillingConflictAction)} style={selStyle}>
              {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
            <select value={status} onChange={(e) => setStatus(e.target.value as BillingConflictStatus)} style={selStyle}>
              {RESOLVE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <StyledInput placeholder="Resolution note *" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: '100%' }} />
        </div>
      )}
    </DetailDrawer>
  );
};
