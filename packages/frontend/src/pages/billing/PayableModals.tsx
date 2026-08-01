import React, { useState, useEffect } from 'react';
import { Banknote } from 'lucide-react';
import { Modal, StyledInput, DetailDrawer, useToast } from '../../components/ui';
import { useCreatePayable, useTransitionPayable, useBillingPayables, useDisbursePayable } from '../../hooks/useBilling';
import { api } from '../../services/api';
import { PAYABLE_TRANSITIONS, AssayerPayableStatus } from '@fapoms/shared';
import type { PaymentMethod } from '@fapoms/shared';

interface AssayerOption { id: string; name: string; displayName?: string; }

const STATUS_COLOR: Record<AssayerPayableStatus, string> = {
  PENDING: '#f59e0b', APPROVED: '#60a5fa', PAID: '#22c55e', DISPUTED: '#ef4444', ON_HOLD: '#64748b',
};

const fmt = (n?: number) => (n ?? 0).toLocaleString('en-IN');

const selStyle: React.CSSProperties = {
  padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', width: '100%',
};

export const CreatePayableModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { toast } = useToast();
  const create = useCreatePayable();
  const [assayers, setAssayers] = useState<AssayerOption[]>([]);
  const [form, setForm] = useState({
    assayerId: '', baseAmount: '', travelAmount: '', taxRate: '', tdsRate: '', remarks: '',
  });

  useEffect(() => {
    let active = true;
    api.request<{ data: AssayerOption[] }>('/assayers?limit=1000')
      .then((res) => { if (active) setAssayers(res.data ?? []); })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const num = (v: string) => (v === '' ? undefined : parseFloat(v));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.assayerId) { toast('error', 'Select an assayer'); return; }
    try {
      await create.mutateAsync({
        assayerId: form.assayerId,
        baseAmount: num(form.baseAmount) ?? 0,
        travelAmount: num(form.travelAmount),
        taxRate: num(form.taxRate),
        tdsRate: num(form.tdsRate),
        remarks: form.remarks || undefined,
      });
      toast('success', 'Payable created'); onClose();
    } catch (err: any) { toast('error', err?.message || 'Failed to create payable'); }
  };

  return (
    <Modal open onClose={onClose} title={<><Banknote size={18} /> Create Assayer Payable</>} width="520px" asForm onSubmit={handleSubmit} footer={
      <>
        <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={create.isPending} className="btn btn-primary">{create.isPending ? 'Creating...' : 'Create Payable'}</button>
      </>
    }>
      <select value={form.assayerId} onChange={(e) => setForm((f) => ({ ...f, assayerId: e.target.value }))} style={selStyle}>
        <option value="">Select assayer…</option>
        {assayers.map((a) => <option key={a.id} value={a.id}>{a.displayName ?? a.name}</option>)}
      </select>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <StyledInput placeholder="Base amount *" type="number" value={form.baseAmount} onChange={(e) => setForm((f) => ({ ...f, baseAmount: e.target.value }))} style={{ width: '100%' }} />
        <StyledInput placeholder="Travel amount" type="number" value={form.travelAmount} onChange={(e) => setForm((f) => ({ ...f, travelAmount: e.target.value }))} style={{ width: '100%' }} />
        <StyledInput placeholder="Tax rate %" type="number" value={form.taxRate} onChange={(e) => setForm((f) => ({ ...f, taxRate: e.target.value }))} style={{ width: '100%' }} />
        <StyledInput placeholder="TDS rate %" type="number" value={form.tdsRate} onChange={(e) => setForm((f) => ({ ...f, tdsRate: e.target.value }))} style={{ width: '100%' }} />
      </div>
      <StyledInput placeholder="Remarks" value={form.remarks} onChange={(e) => setForm((f) => ({ ...f, remarks: e.target.value }))} style={{ width: '100%' }} />
    </Modal>
  );
};

export const PayableDetailDrawer: React.FC<{ payableId: string; onClose: () => void }> = ({ payableId, onClose }) => {
  const { toast } = useToast();
  const { data: payable } = useBillingPayables();
  const transition = useTransitionPayable();
  const [next, setNext] = useState<AssayerPayableStatus | ''>('');
  const [reason, setReason] = useState('');
  const disburse = useDisbursePayable();
  const [payRef, setPayRef] = useState('');
  const [payAmount, setPayAmount] = useState('');
  const [payMethod, setPayMethod] = useState<PaymentMethod>('BANK_TRANSFER' as PaymentMethod);

  if (!payable) return <DetailDrawer open onClose={onClose} title="Loading…" width={560}><div /></DetailDrawer>;

  const rec = payable.find((p) => p.id === payableId);
  if (!rec) return <DetailDrawer open onClose={onClose} title="Not found" width={560}><div /></DetailDrawer>;

  const allowed = PAYABLE_TRANSITIONS[rec.status] ?? [];
  const outstanding = Number(rec.totalAmount) - Number(rec.paidAmount ?? 0);
  // Money only leaves the business against an approved obligation.
  const canDisburse = rec.status === 'APPROVED' && outstanding > 0;

  const doDisburse = async () => {
    if (!payRef.trim()) { toast('error', 'A payment reference is required.'); return; }
    try {
      await disburse.mutateAsync({
        payableId: rec.id,
        paymentReference: payRef.trim(),
        method: payMethod,
        amount: payAmount ? Number(payAmount) : undefined,
      });
      toast('success', `Disbursed to ${rec.assayerName ?? 'assayer'}`);
      setPayRef(''); setPayAmount('');
    } catch (e: any) { toast('error', e?.message || 'Disbursement failed'); }
  };

  const doTransition = async () => {
    if (!next) return;
    try {
      await transition.mutateAsync({ id: rec.id, status: next, reason: reason || undefined });
      toast('success', `Payable → ${next}`); setNext(''); setReason('');
    } catch (e: any) { toast('error', e?.message || 'Transition failed'); }
  };

  const Row: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: '1px dashed var(--border-color)' }}>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 600 }}>{value}</span>
    </div>
  );

  return (
    <DetailDrawer
      open onClose={onClose} width={560}
      title={<span><strong style={{ fontSize: 15 }}>{rec.payableNumber}</strong> <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>{rec.assayerName ?? rec.assayerId}</span></span>}
      subtitle={<span style={{ color: STATUS_COLOR[rec.status], fontWeight: 700 }}>{rec.status}</span>}
      footer={
        allowed.length > 0 && (
          <div style={{ display: 'flex', gap: 8, width: '100%', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <select value={next} onChange={(e) => setNext(e.target.value as AssayerPayableStatus)} style={{ padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff' }}>
              <option value="">Transition…</option>
              {allowed.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason" style={{ padding: 8, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', width: 120 }} />
            <button onClick={doTransition} disabled={!next || transition.isPending} className="btn btn-primary">Apply</button>
          </div>
        )
      }
    >
      {canDisburse && (
        <div style={{ background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 'var(--radius-sm)', padding: 12, marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#22c55e', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 8 }}>
            Disburse — ₹{fmt(outstanding)} owed
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
            <StyledInput placeholder="Payment reference *" value={payRef} onChange={(e) => setPayRef(e.target.value)} style={{ width: '100%' }} />
            <select value={payMethod} onChange={(e) => setPayMethod(e.target.value as PaymentMethod)} style={selStyle}>
              {['BANK_TRANSFER', 'NEFT', 'RTGS', 'UPI', 'CHEQUE', 'OTHER'].map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <StyledInput placeholder={`Amount (blank = full ₹${fmt(outstanding)})`} type="number" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} style={{ flex: 1 }} />
            <button onClick={doDisburse} disabled={disburse.isPending} className="btn btn-primary">
              {disburse.isPending ? 'Paying…' : 'Pay'}
            </button>
          </div>
        </div>
      )}
      <div>
        <Row label="Assayer" value={rec.assayerName ?? rec.assayerId} />
        {rec.projectName && <Row label="Project" value={rec.projectName} />}
        {rec.assignmentNumber && <Row label="Assignment" value={rec.assignmentNumber} />}
        <Row label="Fee" value={`₹${fmt(rec.baseAmount)}`} />
        {rec.travelAmount ? <Row label="Travel" value={`₹${fmt(rec.travelAmount)}`} /> : null}
        {rec.taxAmount ? <Row label="Tax" value={`₹${fmt(rec.taxAmount)}`} /> : null}
        {rec.tdsAmount ? <Row label="TDS" value={`-₹${fmt(rec.tdsAmount)}`} /> : null}
        <Row label="Net payable" value={<span style={{ color: '#fff', fontWeight: 700 }}>₹{fmt(rec.totalAmount)}</span>} />
        <Row label="Paid" value={`₹${fmt(rec.paidAmount)}`} />
        <Row label="Still owed" value={<span style={{ color: outstanding > 0 ? '#f59e0b' : '#22c55e' }}>₹{fmt(outstanding)}</span>} />
        {rec.approvedAt && <Row label="Approved" value={new Date(rec.approvedAt).toLocaleDateString()} />}
        {rec.paidAt && <Row label="Paid" value={new Date(rec.paidAt).toLocaleDateString()} />}
      </div>
      {rec.remarks && <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{rec.remarks}</div>}
    </DetailDrawer>
  );
};
