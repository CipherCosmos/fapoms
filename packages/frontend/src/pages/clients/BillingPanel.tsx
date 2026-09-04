import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Save, CreditCard, AlertTriangle, Percent, Truck } from 'lucide-react';
import { Toggle, Select, useToast } from '../../components/ui';
import { Autocomplete } from '../../components/ui/Autocomplete';
import { useClientBilling, useClientDetail, useUpdateBilling, useUpdateClient } from '../../hooks/useClients';
import { userMessage } from '../../services/errors';
import { api } from '../../services/api';
import { isValidIfsc } from '@fapoms/shared';
import { applyPlaceToAddressGroup, composeAddress, emptyAddressGroup, stateOptionsFor, type AddressGroup } from './address-group';
import { taxIdHint, taxIdGstinConsequenceHint } from './field-hints';

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

// Fixed vocabulary, plus the "Other…" escape hatch below — this is an Indian platform, so INR
// covers the overwhelming majority of clients; USD/EUR/GBP cover the rest without pretending to
// be an exhaustive ISO-4217 list.
const CURRENCY_OPTIONS = ['INR', 'USD', 'EUR', 'GBP'].map((v) => ({ value: v, label: v }));
const PAYMENT_TERMS_OPTIONS = ['NET15', 'NET30', 'NET45', 'NET60'].map((v) => ({ value: v, label: v }));
const INVOICE_CYCLE_OPTIONS = ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY'].map((v) => ({
  value: v, label: v.charAt(0) + v.slice(1).toLowerCase(),
}));
const OTHER = '__other__';

type IfscBankInfo = { branchName: string; city: string; state: string; address: string };

export const BillingPanel: React.FC<{ clientId: string }> = ({ clientId }) => {
  const { data: billing, isLoading, isError: billingIsError } = useClientBilling(clientId);
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
  // Billing address is its own breakdown group for the same reason the client address is (see
  // address-group.ts): `client_billing.billing_address` is one text column, so the existing
  // value seeds the free-text line verbatim and pincode/city/district/state start blank.
  const [billingAddr, setBillingAddr] = useState(emptyAddressGroup());
  // Read-only supporting text next to IFSC — branch/city/state from the lookup, not extra
  // inputs of their own (Task 4: "not extra input fields").
  const [ifscInfo, setIfscInfo] = useState<IfscBankInfo | null>(null);
  const ifscDebounce = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      bankAccount: billing?.bankAccount ?? '',
      bankName: billing?.bankName ?? '',
      ifscCode: billing?.ifscCode ?? '',
      notes: billing?.notes ?? '',
    });
    setBillingAddr(emptyAddressGroup(billing?.billingAddress ?? ''));
  }, [billing]);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const setBillingAddrField = (k: keyof AddressGroup) => (v: string) => setBillingAddr((a) => ({ ...a, [k]: v }));
  const billingStateOptions = useMemo(() => stateOptionsFor(billingAddr.state), [billingAddr.state]);

  // IFSC autofill (Task 4): once the code is shape-valid, resolve it and fill Bank name — still
  // a plain, overwritable input, never locked. Debounced and keyed only on the code itself, so
  // editing Bank name afterwards does not get overwritten again on the next render.
  useEffect(() => {
    const code = (form.ifscCode || '').trim();
    if (!isValidIfsc(code)) { setIfscInfo(null); return undefined; }
    if (ifscDebounce.current) clearTimeout(ifscDebounce.current);
    ifscDebounce.current = setTimeout(async () => {
      try {
        // `api.request` already unwraps the controller's `{ success, data }` envelope (see
        // services/api.ts), so this resolves directly to the lookup result or null — the same
        // shape Autocomplete's own `/geo/autocomplete` call relies on.
        const data = await api.request<(IfscBankInfo & { bankName: string }) | null>(`/geo/ifsc/${code.toUpperCase()}`);
        if (data) {
          setForm((f) => ({ ...f, bankName: data.bankName }));
          setIfscInfo({ branchName: data.branchName, city: data.city, state: data.state, address: data.address });
        } else {
          setIfscInfo(null);
        }
      } catch {
        // A lookup failure (network, provider unreachable) is not a form error — the field
        // stays a plain input and the operator can still type the bank name themselves.
        setIfscInfo(null);
      }
    }, 400);
    return () => { if (ifscDebounce.current) clearTimeout(ifscDebounce.current); };
  }, [form.ifscCode]);

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
          taxIdentifier: form.taxIdentifier || undefined, billingAddress: composeAddress(billingAddr),
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

  /**
   * A fixed-vocabulary field with an escape hatch, one step past the branch state field's
   * "(as recorded)" pattern: picking "Other…" — or already holding a value outside the list,
   * e.g. an existing client billed on "45 days from invoice" — swaps in a plain text box
   * instead of silently replacing or blocking a value the dropdown does not recognise.
   */
  const vocabField = (value: string, onChange: (v: string) => void, options: { value: string; label: string }[], placeholder: string) => {
    const isOther = !options.some((o) => o.value === value);
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Select
          value={isOther ? OTHER : value}
          onChange={(v) => onChange(v === OTHER ? '' : v)}
          options={[...options, { value: OTHER, label: 'Other…' }]}
          style={{ width: 200, maxWidth: '100%' }}
        />
        {isOther && (
          <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} style={inputStyle} />
        )}
      </div>
    );
  };

  if (isLoading || detail.isLoading) return <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Loading…</div>;

  /**
   * A failed fetch must not fall through to the form below: `form` was seeded from `billing`
   * being `undefined` (the shape a failed query and a genuinely-empty profile share), so without
   * this check the operator sees the exact same screen — including, on a client that DOES have a
   * profile, the platform-default 18%/10% *in place of* whatever their real rates are — with Save
   * fully enabled and no signal that what's on screen is a fetch failure, not this client's data.
   * That is a real production reproduction, not a hypothetical: this client's own billing row
   * loaded fine moments earlier and then failed on a later fetch during a live backend restart,
   * and the panel briefly claimed the profile "isn't saved" while it plainly was. `billing` below
   * is only ever read once this returns, so a genuine absence and a failed load can no longer be
   * confused for each other in what follows.
   */
  if (billingIsError) {
    return (
      <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '12px 14px', borderLeft: '3px solid var(--danger)', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius-md)', fontSize: 12.5 }}>
        <AlertTriangle size={15} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 1 }} />
        <span style={{ color: 'var(--text-secondary)' }}>
          Could not load this client's billing profile — this is not saying it's unset, the request failed.
          Reload before editing, so a save here does not overwrite real rates with a guess.
        </span>
      </div>
    );
  }

  const hasRate = baseFee.trim() !== '' && Number(baseFee) > 0;
  /**
   * `billing` is `null` (not an object with defaulted fields) when this client has never had a
   * billing profile saved — `ClientService.findBilling` returns exactly what the row is, and the
   * error case that shares its "no object" shape was already returned above. The form still has
   * to show *something* in the GST/TDS/terms inputs meanwhile (blank number inputs read as zero,
   * which would be worse), so it fills them with the platform defaults. But filled with a
   * plausible number is indistinguishable from actually saved, in a screen whose whole job is
   * showing what will print on a real GST tax invoice: unlike the rate card just below (which
   * shows a genuinely blank field, plus its own warning here), the tax fields gave no signal at
   * all that "18" and "10" are a guess nobody has confirmed for this client, rather than a
   * decision — the kind of gap 'billing-relevant fields' review for this project called for
   * surfacing, not just correctly computing.
   */
  const hasBillingProfile = billing != null;

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

      {!hasBillingProfile && (
        <div style={{ display: 'flex', gap: 9, alignItems: 'flex-start', padding: '10px 12px', borderLeft: '3px solid var(--warning)', background: 'var(--bg-surface-2)', borderRadius: 'var(--radius-md)', fontSize: 12.5 }}>
          <AlertTriangle size={15} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
          <span style={{ color: 'var(--text-secondary)' }}>
            No billing profile saved for this client yet. The GST, TDS and terms below are the platform
            defaults shown so the form isn't blank — not a decision made for this client. Review them (SEZ
            or exempt clients and lower-deduction certificates are common) and save to confirm before this
            client is invoiced for real.
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
          {vocabField(form.paymentTerms ?? '', (v) => set('paymentTerms', v), PAYMENT_TERMS_OPTIONS, 'e.g. 45 days from invoice')}
        </Field>
        <Field label="Invoice cycle" hint="How often this client is invoiced.">
          {vocabField(form.invoiceCycle ?? '', (v) => set('invoiceCycle', v), INVOICE_CYCLE_OPTIONS, 'e.g. Per project milestone')}
        </Field>
      </section>

      <section style={sectionStyle}>
        <h4 style={sectionTitle}><Truck size={14} /> Invoice details</h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
          <label style={labelStyle}>
            GSTIN / tax identifier
            <input style={{ ...inputStyle, width: '100%' }} value={form.taxIdentifier ?? ''} onChange={(e) => set('taxIdentifier', e.target.value)} />
            {/* Advisory only — the column already holds either a GSTIN or a bare PAN for
                clients not GST-registered, and this must not block either. */}
            {taxIdHint(form.taxIdentifier ?? '') && (
              <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>{taxIdHint(form.taxIdentifier ?? '')}</span>
            )}
            {/* A bare PAN is a valid, accepted shape (the hint above stays silent for it) but it
                carries no GST state prefix, so it has a real tax-invoice consequence the operator
                should see now rather than discover on a printed invoice later. */}
            {taxIdGstinConsequenceHint(form.taxIdentifier ?? '') && (
              <span style={{ fontSize: '10.5px', color: 'var(--warning)' }}>{taxIdGstinConsequenceHint(form.taxIdentifier ?? '')}</span>
            )}
          </label>
          <label style={labelStyle}>Currency{vocabField(form.currency ?? '', (v) => set('currency', v), CURRENCY_OPTIONS, 'e.g. AED')}</label>
          <label style={labelStyle}>Bank account<input style={{ ...inputStyle, width: '100%' }} value={form.bankAccount ?? ''} onChange={(e) => set('bankAccount', e.target.value)} /></label>
          <label style={labelStyle}>
            Bank name
            <input style={{ ...inputStyle, width: '100%' }} value={form.bankName ?? ''} onChange={(e) => set('bankName', e.target.value)} />
          </label>
          <label style={labelStyle}>
            IFSC
            <input style={{ ...inputStyle, width: '100%' }} value={form.ifscCode ?? ''} onChange={(e) => set('ifscCode', e.target.value)} />
            {/* Read-only supporting text from the lookup — not extra input fields of their own. */}
            {ifscInfo && (
              <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>
                {[ifscInfo.branchName, ifscInfo.city, ifscInfo.state].filter(Boolean).join(', ')}
              </span>
            )}
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {/* Pincode first and geo-backed, same pattern as the client address and the branch
              form: picking a result fills district, city and state together. */}
          <label style={labelStyle}>
            Pincode
            <Autocomplete
              value={billingAddr.pincode}
              onChange={setBillingAddrField('pincode')}
              onSelect={(place) => setBillingAddr((a) => applyPlaceToAddressGroup('pincode', place, a))}
              placeholder="Type a pincode — the rest fills in"
              filterType={(r) => !!r.pincode}
            />
          </label>
          <label style={labelStyle}>
            City
            <Autocomplete
              value={billingAddr.city}
              onChange={setBillingAddrField('city')}
              onSelect={(place) => setBillingAddr((a) => applyPlaceToAddressGroup('city', place, a))}
              placeholder="Type to search city…"
            />
          </label>
          <label style={labelStyle}>
            District
            <Autocomplete
              value={billingAddr.district}
              onChange={setBillingAddrField('district')}
              onSelect={(place) => setBillingAddr((a) => applyPlaceToAddressGroup('district', place, a))}
              placeholder="Type to search district…"
            />
          </label>
          <label style={labelStyle}>
            State
            <Select
              value={billingAddr.state}
              onChange={setBillingAddrField('state')}
              options={billingStateOptions}
              placeholder="Select…"
              style={{ width: '100%' }}
            />
          </label>
        </div>
        <label style={labelStyle}>Billing address<textarea rows={2} style={{ ...inputStyle, width: '100%' }} value={billingAddr.address} onChange={(e) => setBillingAddrField('address')(e.target.value)} /></label>
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
