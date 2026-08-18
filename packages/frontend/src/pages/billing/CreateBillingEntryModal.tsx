import React, { useState, useEffect } from 'react';
import { Receipt } from 'lucide-react';
import { Modal, StyledInput, Select, useToast } from '../../components/ui';
import { useCreateBillingEntry } from '../../hooks/useBilling';
import { useClientsList } from '../../hooks/useClients';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { BillingLevel, BillingPricingModel, BillingState } from '@fapoms/shared';

const LEVELS = Object.values(BillingLevel);
const PRICING = Object.values(BillingPricingModel);
const INITIAL_STATES = [
  BillingState.PENDING_BILLING,
  BillingState.READY_FOR_BILLING,
  BillingState.DRAFT,
  BillingState.ON_HOLD,
];

interface ProjectOption { id: string; name: string; clientId: string; }
interface AssayerOption { id: string; name: string; displayName?: string; }

export const CreateBillingEntryModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { toast } = useToast();
  const create = useCreateBillingEntry();
  const clients = useClientsList({ limit: 1000 });

  const [form, setForm] = useState({
    level: BillingLevel.PROJECT as BillingLevel,
    clientId: '',
    projectId: '',
    assayerId: '',
    pricingModel: BillingPricingModel.FLAT_RATE,
    rate: '',
    quantity: '',
    baseAmount: '',
    travelAmount: '',
    adjustmentAmount: '',
    discountAmount: '',
    // Blank means "use the client's contracted rate", which the backend resolves
    // (dto.taxRate ?? contract.gstRate). This used to default to a literal '18', which the
    // backend takes as an explicit override — so a client contracted at a different GST rate
    // was silently billed 18%. TDS was already blank; GST now behaves the same way.
    taxRate: '',
    tdsRate: '',
    billingPeriodStart: '',
    billingPeriodEnd: '',
    description: '',
    initialState: BillingState.PENDING_BILLING,
  });

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [assayers, setAssayers] = useState<AssayerOption[]>([]);

  const clientOptions = clients.data?.items ?? [];

  useEffect(() => {
    if (!form.clientId) { setProjects([]); return; }
    let active = true;
    api.request<ProjectOption[]>(`/projects?clientId=${form.clientId}&limit=1000`)
      .then((res) => { if (active) setProjects(res ?? []); })
      .catch(() => { if (active) setProjects([]); });
    return () => { active = false; };
  }, [form.clientId]);

  useEffect(() => {
    let active = true;
    api.request<AssayerOption[]>('/assayers?limit=1000')
      .then((res) => { if (active) setAssayers(res ?? []); })
      .catch(() => { if (active) setAssayers([]); });
    return () => { active = false; };
  }, []);

  const set = (k: string, v: string | BillingLevel | BillingPricingModel | BillingState) =>
    setForm((f) => ({ ...f, [k]: v }));

  const num = (v: string) => (v === '' ? undefined : parseFloat(v));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.clientId) { toast('error', 'Select a client'); return; }
    if (form.level === BillingLevel.PROJECT && !form.projectId) { toast('error', 'Select a project'); return; }
    if (form.level === BillingLevel.ASSIGNMENT && !form.assayerId) { toast('error', 'Select an assayer'); return; }
    try {
      await create.mutateAsync({
        level: form.level,
        clientId: form.clientId,
        projectId: form.projectId || undefined,
        assignmentId: undefined,
        assayerId: form.assayerId || undefined,
        pricingModel: form.pricingModel,
        rate: num(form.rate),
        quantity: num(form.quantity),
        baseAmount: num(form.baseAmount),
        travelAmount: num(form.travelAmount),
        adjustmentAmount: num(form.adjustmentAmount),
        discountAmount: num(form.discountAmount),
        taxRate: num(form.taxRate),
        tdsRate: num(form.tdsRate),
        billingPeriodStart: form.billingPeriodStart || undefined,
        billingPeriodEnd: form.billingPeriodEnd || undefined,
        description: form.description || undefined,
        initialState: form.initialState,
      });
      toast('success', 'Billing entry created');
      onClose();
    } catch (err: any) {
      toast({ type: 'error', title: 'Failed to create entry', message: userMessage(err) });
    }
  };

  const inputProps = { style: { width: '100%' } };

  return (
    <Modal open onClose={onClose} title={<><Receipt size={18} /> Create Billing Entry</>} width="620px" maxHeight="90vh" asForm onSubmit={handleSubmit} footer={
      <>
        <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
        <button type="submit" disabled={create.isPending} className="btn btn-primary">
          {create.isPending ? 'Creating...' : 'Create Entry'}
        </button>
      </>
    }>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, overflowY: 'auto' }}>
        <Select
          value={form.level}
          onChange={(v) => set('level', v as BillingLevel)}
          options={LEVELS.map((l) => ({ value: l, label: l }))}
          style={{ width: '100%' }}
        />
        <Select
          value={form.initialState}
          onChange={(v) => set('initialState', v as BillingState)}
          options={INITIAL_STATES.map((s) => ({ value: s, label: s }))}
          style={{ width: '100%' }}
        />

        <label style={{ gridColumn: '1 / -1', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
          Client *
        </label>
        <Select
          value={form.clientId}
          onChange={(v) => set('clientId', v)}
          placeholder="Select client…"
          options={clientOptions.map((c) => ({ value: c.id, label: c.displayName ?? c.name }))}
          style={{ width: '100%', gridColumn: '1 / -1' }}
        />

        {form.level === BillingLevel.PROJECT && (
          <>
            <label style={{ gridColumn: '1 / -1', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Project *
            </label>
            <Select
              value={form.projectId}
              onChange={(v) => set('projectId', v)}
              placeholder="Select project…"
              options={projects.map((p) => ({ value: p.id, label: p.name }))}
              style={{ width: '100%', gridColumn: '1 / -1' }}
            />
          </>
        )}

        {form.level === BillingLevel.ASSIGNMENT && (
          <>
            <label style={{ gridColumn: '1 / -1', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Assayer *
            </label>
            <Select
              value={form.assayerId}
              onChange={(v) => set('assayerId', v)}
              placeholder="Select assayer…"
              options={assayers.map((a) => ({ value: a.id, label: a.displayName ?? a.name }))}
              style={{ width: '100%', gridColumn: '1 / -1' }}
            />
          </>
        )}

        <Select
          value={form.pricingModel}
          onChange={(v) => set('pricingModel', v as BillingPricingModel)}
          options={PRICING.map((p) => ({ value: p, label: p }))}
          style={{ width: '100%' }}
        />
        <StyledInput {...inputProps} placeholder="Rate" type="number" value={form.rate} onChange={(e) => set('rate', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Quantity" type="number" value={form.quantity} onChange={(e) => set('quantity', e.target.value)} />
        <StyledInput {...inputProps} placeholder="GST % (blank = client contract)" type="number" value={form.taxRate} onChange={(e) => set('taxRate', e.target.value)} />

        <StyledInput {...inputProps} placeholder="Base amount" type="number" value={form.baseAmount} onChange={(e) => set('baseAmount', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Travel amount" type="number" value={form.travelAmount} onChange={(e) => set('travelAmount', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Adjustment (+/-)" type="number" value={form.adjustmentAmount} onChange={(e) => set('adjustmentAmount', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Discount" type="number" value={form.discountAmount} onChange={(e) => set('discountAmount', e.target.value)} />
        <StyledInput {...inputProps} placeholder="TDS % (blank = client contract)" type="number" value={form.tdsRate} onChange={(e) => set('tdsRate', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Period start" type="date" value={form.billingPeriodStart} onChange={(e) => set('billingPeriodStart', e.target.value)} />
        <StyledInput {...inputProps} placeholder="Period end" type="date" value={form.billingPeriodEnd} onChange={(e) => set('billingPeriodEnd', e.target.value)} />

        <StyledInput {...inputProps} placeholder="Description" value={form.description} onChange={(e) => set('description', e.target.value)} style={{ gridColumn: '1 / -1', width: '100%' }} />
      </div>
    </Modal>
  );
};
