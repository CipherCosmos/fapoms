import React, { useEffect, useState } from 'react';
import { Save, ArrowLeftRight, MessageSquarePlus, CreditCard, ArrowRight, Plus } from 'lucide-react';
import { StatusBadge, useToast } from '../../components/ui';
import {
  useClientBilling,
  useClientBillingHistory,
  useUpdateBilling,
  useTransitionBillingStatus,
  useAddBillingRemark,
} from '../../hooks/useClients';
import { billingStatusLabel } from '../../utils/statusLabels';
import { BILLING_TRANSITIONS } from '@fapoms/shared';
import type { ClientBillingStatus, ClientBillingEventType } from '@fapoms/shared';

const STATUS_COLORS: Record<string, { color: string; bg: string }> = {
  DRAFT: { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  ACTIVE: { color: '#10b981', bg: 'rgba(16,185,129,0.1)' },
  SUSPENDED: { color: '#ef4444', bg: 'rgba(239,68,68,0.1)' },
  INACTIVE: { color: '#6b7280', bg: 'rgba(107,114,128,0.1)' },
};

const EVENT_ICONS: Record<ClientBillingEventType, { icon: React.ReactNode; color: string }> = {
  STATUS_CHANGE: { icon: <ArrowLeftRight size={13} />, color: '#3b82f6' },
  REMARK: { icon: <MessageSquarePlus size={13} />, color: '#f59e0b' },
  PROFILE_UPDATE: { icon: <CreditCard size={13} />, color: '#10b981' },
};

function formatDateTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) +
    ', ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export const BillingPanel: React.FC<{ clientId: string }> = ({ clientId }) => {
  const { data: billing, isLoading } = useClientBilling(clientId);
  const { data: history = [], isLoading: historyLoading } = useClientBillingHistory(clientId);
  const update = useUpdateBilling();
  const transition = useTransitionBillingStatus();
  const addRemark = useAddBillingRemark();
  const { toast } = useToast();

  // Profile edit form
  const [form, setForm] = useState<Record<string, string>>({});
  // Transition
  const [targetStatus, setTargetStatus] = useState('');
  const [transitionRemarks, setTransitionRemarks] = useState('');
  // Remark
  const [remark, setRemark] = useState('');

  useEffect(() => {
    if (billing) {
      setForm({
        paymentTerms: billing.paymentTerms,
        currency: billing.currency,
        taxIdentifier: billing.taxIdentifier ?? '',
        invoiceCycle: billing.invoiceCycle,
        billingAddress: billing.billingAddress,
        bankAccount: billing.bankAccount ?? '',
        bankName: billing.bankName ?? '',
        ifscCode: billing.ifscCode ?? '',
        notes: billing.notes ?? '',
      });
    }
  }, [billing]);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync({
        clientId,
        payload: {
          paymentTerms: form.paymentTerms,
          currency: form.currency,
          taxIdentifier: form.taxIdentifier || undefined,
          invoiceCycle: form.invoiceCycle,
          billingAddress: form.billingAddress,
          bankAccount: form.bankAccount || undefined,
          bankName: form.bankName || undefined,
          ifscCode: form.ifscCode || undefined,
          notes: form.notes || undefined,
        },
      });
      toast('success', 'Billing profile updated');
    } catch (err: any) {
      toast('error', err?.message || 'Failed to update billing');
    }
  };

  const handleTransition = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetStatus) return;
    try {
      await transition.mutateAsync({ clientId, status: targetStatus as ClientBillingStatus, remarks: transitionRemarks || undefined });
      toast('success', `Billing moved to ${billingStatusLabel(targetStatus)}`);
      setTargetStatus('');
      setTransitionRemarks('');
    } catch (err: any) {
      toast('error', err?.message || 'Status transition failed');
    }
  };

  const handleAddRemark = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!remark.trim()) return;
    try {
      await addRemark.mutateAsync({ clientId, remarks: remark.trim() });
      toast('success', 'Remark added');
      setRemark('');
    } catch (err: any) {
      toast('error', err?.message || 'Failed to add remark');
    }
  };

  if (isLoading) return <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>;

  const currentStatus = billing?.status ?? 'DRAFT';
  const allowedTargets = BILLING_TRANSITIONS[currentStatus as ClientBillingStatus] ?? [];

  const inputStyle: React.CSSProperties = { padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', width: '100%' };
  const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' };
  const sectionTitle: React.CSSProperties = { margin: 0, fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Current status + transition */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h4 style={{ margin: 0, fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
            <CreditCard size={14} /> Billing Status
          </h4>
          <StatusBadge label={billingStatusLabel(currentStatus)} color={STATUS_COLORS[currentStatus]?.color ?? '#6b7280'} bg={STATUS_COLORS[currentStatus]?.bg ?? 'rgba(107,114,128,0.1)'} />
        </div>
        {allowedTargets.length > 0 ? (
          <form onSubmit={handleTransition} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <select value={targetStatus} onChange={(e) => setTargetStatus(e.target.value)} style={{ ...inputStyle, width: 'auto', flex: 1, minWidth: 160 }}>
                <option value="">-- Move to... --</option>
                {allowedTargets.map((s) => (
                  <option key={s} value={s}>{billingStatusLabel(s)}</option>
                ))}
              </select>
              <button type="submit" disabled={!targetStatus || transition.isPending} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <ArrowLeftRight size={14} /> {transition.isPending ? 'Updating...' : 'Transition'}
              </button>
            </div>
            <input type="text" placeholder="Reason (optional)" value={transitionRemarks} onChange={(e) => setTransitionRemarks(e.target.value)} style={inputStyle} />
          </form>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No further transitions available from this status.</div>
        )}
      </section>

      {/* Add remark */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h4 style={sectionTitle}><MessageSquarePlus size={14} /> Add Remark</h4>
        <form onSubmit={handleAddRemark} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="text" placeholder="Add a note about billing..." value={remark} onChange={(e) => setRemark(e.target.value)} style={inputStyle} />
          <button type="submit" disabled={!remark.trim() || addRemark.isPending} className="btn btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
            <Plus size={14} /> Add
          </button>
        </form>
      </section>

      {/* Timeline */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h4 style={sectionTitle}><ArrowLeftRight size={14} /> Timeline</h4>
        {historyLoading ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>
        ) : history.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-md)' }}>
            No billing activity recorded yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {history.map((h, idx) => {
              const ev = EVENT_ICONS[h.eventType as ClientBillingEventType] ?? { icon: <Plus size={13} />, color: '#6b7280' };
              const isLast = idx === history.length - 1;
              return (
                <div key={h.id} style={{ display: 'flex', gap: 12 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                    <span style={{ width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: `${ev.color}22`, color: ev.color, border: `1px solid ${ev.color}55`, flexShrink: 0 }}>
                      {ev.icon}
                    </span>
                    {!isLast && <span style={{ width: 2, flex: 1, background: 'var(--border-color)', minHeight: 24 }} />}
                  </div>
                  <div style={{ paddingBottom: isLast ? 0 : 16, flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {h.eventType === 'STATUS_CHANGE' && (
                          <>
                            {billingStatusLabel(h.fromStatus)} <ArrowRight size={12} style={{ verticalAlign: 'middle' }} /> {billingStatusLabel(h.toStatus)}
                          </>
                        )}
                        {h.eventType === 'REMARK' && 'Remark added'}
                        {h.eventType === 'PROFILE_UPDATE' && `Updated: ${h.remarks ?? 'profile'}`}
                      </div>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{formatDateTime(h.createdAt)}</span>
                    </div>
                    {h.eventType === 'PROFILE_UPDATE' && h.fromValue !== null && (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                        <span style={{ textDecoration: 'line-through', opacity: 0.6 }}>{h.fromValue || '(empty)'}</span>
                        <ArrowRight size={11} style={{ margin: '0 4px', verticalAlign: 'middle' }} />
                        <span>{h.toValue || '(empty)'}</span>
                      </div>
                    )}
                    {h.eventType !== 'PROFILE_UPDATE' && h.remarks && (
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{h.remarks}</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Profile edit */}
      <section style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 14, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
        <h4 style={sectionTitle}><Save size={14} /> Billing Details</h4>
        <form onSubmit={handleProfileSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={labelStyle}>
              Payment Terms
              <input style={inputStyle} value={form.paymentTerms ?? ''} onChange={(e) => set('paymentTerms', e.target.value)} />
            </label>
            <label style={labelStyle}>
              Currency
              <input style={inputStyle} value={form.currency ?? ''} onChange={(e) => set('currency', e.target.value)} />
            </label>
            <label style={labelStyle}>
              Tax Identifier
              <input style={inputStyle} value={form.taxIdentifier ?? ''} onChange={(e) => set('taxIdentifier', e.target.value)} />
            </label>
            <label style={labelStyle}>
              Invoice Cycle
              <input style={inputStyle} value={form.invoiceCycle ?? ''} onChange={(e) => set('invoiceCycle', e.target.value)} />
            </label>
            <label style={labelStyle}>
              Bank Account
              <input style={inputStyle} value={form.bankAccount ?? ''} onChange={(e) => set('bankAccount', e.target.value)} />
            </label>
            <label style={labelStyle}>
              Bank Name
              <input style={inputStyle} value={form.bankName ?? ''} onChange={(e) => set('bankName', e.target.value)} />
            </label>
            <label style={labelStyle}>
              IFSC Code
              <input style={inputStyle} value={form.ifscCode ?? ''} onChange={(e) => set('ifscCode', e.target.value)} />
            </label>
          </div>
          <label style={labelStyle}>
            Billing Address
            <textarea rows={2} style={inputStyle} value={form.billingAddress ?? ''} onChange={(e) => set('billingAddress', e.target.value)} />
          </label>
          <label style={labelStyle}>
            Notes
            <textarea rows={2} style={inputStyle} value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
          </label>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" disabled={update.isPending} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Save size={14} /> {update.isPending ? 'Saving...' : 'Save Billing Details'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
};
