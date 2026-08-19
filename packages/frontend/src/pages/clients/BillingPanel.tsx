import React, { useEffect, useState } from 'react';
import { Save, CreditCard, AlertTriangle, Percent, Truck } from 'lucide-react';
import { Toggle, useToast } from '../../components/ui';
import { useClientBilling, useClientDetail, useUpdateBilling, useUpdateClient } from '../../hooks/useClients';
import { userMessage } from '../../services/errors';

/**
 * A client's billing, in one place: what they are billed per audit (the rate card), the tax
 * treatment, payment terms, and the bank/address details that print on an invoice.
 *
 * These used to live on two screens — a "Client billing settings" page under Finance and this
 * panel under Clients — each editing half of the same client. There is no billing "status" and
 * no separate timeline any more: the profile is either set or not, and every edit is an audit
 * event on the client.
 */
const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));

export const BillingPanel: React.FC<{ clientId: string }> = ({ clientId }) => {
  const { data: billing, isLoading } = useClientBilling(clientId);
  const detail = useClientDetail(clientId);
  const updateBilling = useUpdateBilling();
  const updateClient = useUpdateClient();
  const { toast } = useToast();

  // Rate card + travel policy (client_configurations / clients.planning_preferences)
  const [baseFee, setBaseFee] = useState('');
  const [travelPerKm, setTravelPerKm] = useState('');
  const [freeKm, setFreeKm] = useState('');
  const [rechargeTravel, setRechargeTravel] = useState(true);
  // Tax, terms, identity (client_billing)
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const c = detail.data;
    const cfg = c?.configuration;
    setBaseFee(cfg?.defaultBaseFee != null ? String(cfg.defaultBaseFee) : '');
    setTravelPerKm(cfg?.travelFeePerKm != null ? String(cfg.travelFeePerKm) : '');
    setFreeKm(cfg?.freeTravelAllowanceKm != null ? String(cfg.freeTravelAllowanceKm) : '');
    setRechargeTravel((c?.planningPreferences as any)?.rechargeTravel !== false);
  }, [detail.data]);

  useEffect(() => {
    setForm({
      gstRate: billing?.gstRate != null ? String(billing.gstRate) : '18',
      tdsRate: billing?.tdsRate != null ? String(billing.tdsRate) : '10',
      paymentTerms: billing?.paymentTerms ?? 'NET30',
      invoiceCycle: billing?.invoiceCycle ?? 'MONTHLY',
      currency: billing?.currency ?? 'INR',
      taxIdentifier: billing?.taxIdentifier ?? '',
      billingAddress: billing?.billingAddress ?? '',
      bankAccount: billing?.bankAccount ?? '',
      bankName: billing?.bankName ?? '',
      ifscCode: billing?.ifscCode ?? '',
      notes: billing?.notes ?? '',
    });
  }, [billing]);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await updateClient.mutateAsync({
        id: clientId,
        payload: {
          configuration: { defaultBaseFee: num(baseFee), travelFeePerKm: num(travelPerKm), freeTravelAllowanceKm: num(freeKm) },
          planningPreferences: { ...((detail.data?.planningPreferences as Record<string, unknown>) ?? {}), rechargeTravel },
        },
      });
      await updateBilling.mutateAsync({
        clientId,
        payload: {
          gstRate: num(form.gstRate), tdsRate: num(form.tdsRate),
          paymentTerms: form.paymentTerms || undefined, invoiceCycle: form.invoiceCycle || undefined, currency: form.currency || undefined,
          taxIdentifier: form.taxIdentifier || undefined, billingAddress: form.billingAddress,
          bankAccount: form.bankAccount || undefined, bankName: form.bankName || undefined, ifscCode: form.ifscCode || undefined,
          notes: form.notes || undefined,
        },
      });
      toast('success', 'Billing saved. Applies to audits completed from now on.');
    } catch (err) {
      toast({ type: 'error', title: 'Could not save billing', message: userMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  if (isLoading || detail.isLoading) return <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>;

  const hasRate = baseFee.trim() !== '' && Number(baseFee) > 0;

  return (
    <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {!hasRate && (
        <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '10px 12px', borderLeft: '3px solid var(--warning)', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius-md)', fontSize: 12.5 }}>
          <AlertTriangle size={15} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
          <span style={{ color: 'var(--text-secondary)' }}>
            No rate set. Until one is, this client's audits are billed at what the assayer is paid — every audit earns zero margin.
          </span>
        </div>
      )}

      <section style={sectionStyle}>
        <h4 style={sectionTitle}><CreditCard size={14} /> What we bill per audit</h4>
        <Field label="Rate per audit (₹)" hint="Charged per branch audit. The margin is this minus what the assayer is paid. Also the fallback base when an assayer has no rate profile of their own.">
          <input type="number" value={baseFee} onChange={(e) => setBaseFee(e.target.value)} placeholder="e.g. 3000" style={inputStyle} />
        </Field>
        <Field label="Travel on the invoice" hint={rechargeTravel ? 'The assayer’s travel component is added to the client’s line.' : 'All-inclusive contract — travel stays our cost and never appears on the invoice.'}>
          <Toggle checked={rechargeTravel} onChange={setRechargeTravel} label={rechargeTravel ? 'Recharged' : 'Absorbed'} />
        </Field>
        <Field label="Travel per chargeable km (₹)" hint="Used when pricing offers for this client's audits, after the free allowance. Blank uses the platform default.">
          <input type="number" value={travelPerKm} onChange={(e) => setTravelPerKm(e.target.value)} placeholder="e.g. 8" style={inputStyle} />
        </Field>
        <Field label="Free travel allowance (km)" hint="Distance not charged for travel before the per-km rate applies.">
          <input type="number" value={freeKm} onChange={(e) => setFreeKm(e.target.value)} placeholder="e.g. 10" style={inputStyle} />
        </Field>
      </section>

      <section style={sectionStyle}>
        <h4 style={sectionTitle}><Percent size={14} /> Tax and terms</h4>
        <Field label="GST (%)" hint="Added to every line on this client's invoices.">
          <input type="number" value={form.gstRate ?? ''} onChange={(e) => set('gstRate', e.target.value)} style={inputStyle} />
        </Field>
        <Field label="TDS withheld by client (%)" hint="What the client deducts when paying us; shown on the invoice.">
          <input type="number" value={form.tdsRate ?? ''} onChange={(e) => set('tdsRate', e.target.value)} style={inputStyle} />
        </Field>
        <Field label="Payment terms" hint="e.g. NET30 — sets the due date when an invoice is created.">
          <input value={form.paymentTerms ?? ''} onChange={(e) => set('paymentTerms', e.target.value)} placeholder="NET30" style={inputStyle} />
        </Field>
        <Field label="Invoice cycle" hint="How often this client is invoiced.">
          <input value={form.invoiceCycle ?? ''} onChange={(e) => set('invoiceCycle', e.target.value)} placeholder="MONTHLY" style={inputStyle} />
        </Field>
      </section>

      <section style={sectionStyle}>
        <h4 style={sectionTitle}><Truck size={14} /> Invoice details</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <label style={labelStyle}>GSTIN / tax identifier<input style={{ ...inputStyle, width: '100%' }} value={form.taxIdentifier ?? ''} onChange={(e) => set('taxIdentifier', e.target.value)} /></label>
          <label style={labelStyle}>Currency<input style={{ ...inputStyle, width: '100%' }} value={form.currency ?? ''} onChange={(e) => set('currency', e.target.value)} /></label>
          <label style={labelStyle}>Bank account<input style={{ ...inputStyle, width: '100%' }} value={form.bankAccount ?? ''} onChange={(e) => set('bankAccount', e.target.value)} /></label>
          <label style={labelStyle}>Bank name<input style={{ ...inputStyle, width: '100%' }} value={form.bankName ?? ''} onChange={(e) => set('bankName', e.target.value)} /></label>
          <label style={labelStyle}>IFSC<input style={{ ...inputStyle, width: '100%' }} value={form.ifscCode ?? ''} onChange={(e) => set('ifscCode', e.target.value)} /></label>
        </div>
        <label style={labelStyle}>Billing address<textarea rows={2} style={{ ...inputStyle, width: '100%' }} value={form.billingAddress ?? ''} onChange={(e) => set('billingAddress', e.target.value)} /></label>
        <label style={labelStyle}>Notes<textarea rows={2} style={{ ...inputStyle, width: '100%' }} value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} /></label>
      </section>

      <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>Applies to audits completed from now on; booked lines are unchanged.</span>
        <button type="submit" disabled={saving} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save billing'}
        </button>
      </div>
    </form>
  );
};

const sectionStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, padding: 14, background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' };
const sectionTitle: React.CSSProperties = { margin: '0 0 6px', fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 };
const inputStyle: React.CSSProperties = { width: 200, maxWidth: '100%', padding: '7px 10px', fontSize: 13, background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none' };
const labelStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-muted)' };

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '8px 0', borderBottom: '1px solid var(--border-hair, var(--border-color))', flexWrap: 'wrap' }}>
    <div style={{ minWidth: 200, flex: 1 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, maxWidth: 380 }}>{hint}</div>}
    </div>
    {children}
  </div>
);
