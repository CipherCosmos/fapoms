import React, { useEffect, useMemo, useState } from 'react';
import { Building2, Save, AlertTriangle, Info } from 'lucide-react';
import { useBillingClients } from '../../hooks/useBilling';
import { useClientDetail, useUpdateClient, useUpdateBilling } from '../../hooks/useClients';
import { useToast } from '../../components/ui';
import { userMessage } from '../../services/errors';
import { useSearchParams, Link } from 'react-router-dom';

/**
 * Client billing settings — the rate card that decides what each client is billed.
 *
 * This is the page the finance margin model depends on. The billing engine now bills the client
 * their contracted base fee rather than the assayer's cost, but that fee lived in columns
 * (client_configurations.default_base_fee and client_billing.gst_rate/tds_rate) that nothing
 * could write, so they were NULL on every client and billing fell back to platform defaults —
 * which is why the client-scope header used to read "GST 0% · TDS 0%" while the ledger charged
 * 18/10 from a hardcoded fallback.
 *
 * Setting a base fee here is what turns an audit's margin from zero into the spread between this
 * rate and what the assayer is paid.
 */

const num = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v));

export const ClientBillingSettingsPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const clientId = params.get('client') ?? '';
  const setClientId = (id: string) => setParams(id ? { client: id } : {}, { replace: true });
  const clients = useBillingClients();
  const detail = useClientDetail(clientId || null);
  const updateClient = useUpdateClient();
  const updateBilling = useUpdateBilling();
  const { toast } = useToast();

  // Rate card (client_configurations) and tax/terms (client_billing) are two records; the page
  // presents them as one form and saves whichever changed.
  const [baseFee, setBaseFee] = useState('');
  const [travelPerKm, setTravelPerKm] = useState('');
  const [freeKm, setFreeKm] = useState('');
  const [gst, setGst] = useState('');
  const [tds, setTds] = useState('');
  const [terms, setTerms] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const c = detail.data;
    if (!c) return;
    const cfg = c.configuration;
    const bill = c.billing;
    setBaseFee(cfg?.defaultBaseFee != null ? String(cfg.defaultBaseFee) : '');
    setTravelPerKm(cfg?.travelFeePerKm != null ? String(cfg.travelFeePerKm) : '');
    setFreeKm(cfg?.freeTravelAllowanceKm != null ? String(cfg.freeTravelAllowanceKm) : '');
    setGst(bill?.gstRate != null ? String(bill.gstRate) : '');
    setTds(bill?.tdsRate != null ? String(bill.tdsRate) : '');
    setTerms(bill?.paymentTerms ?? '');
  }, [detail.data]);

  const clientList = clients.data ?? [];
  const selectedName = useMemo(
    () => clientList.find((c) => c.clientId === clientId)?.clientName ?? '',
    [clientList, clientId],
  );

  const save = async () => {
    if (!clientId || saving) return;
    setSaving(true);
    try {
      await updateClient.mutateAsync({
        id: clientId,
        payload: {
          configuration: {
            defaultBaseFee: num(baseFee),
            travelFeePerKm: num(travelPerKm),
            freeTravelAllowanceKm: num(freeKm),
          },
        },
      });
      await updateBilling.mutateAsync({
        clientId,
        payload: { gstRate: num(gst), tdsRate: num(tds), paymentTerms: terms || undefined },
      });
      toast('success', 'Billing settings saved');
      detail.refetch?.();
    } catch (err) {
      toast({ type: 'error', title: 'Could not save', message: userMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  if (!clientId) {
    return (
      <div style={{ padding: '20px 24px', maxWidth: 720, ...cardStyle }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-secondary)', fontSize: 13 }}>
          <Building2 size={16} /> Choose a client above to set its billing rate card.
        </div>
        <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {clientList.map((c) => (
            <button key={c.clientId} onClick={() => setClientId(c.clientId)}
              style={{ padding: '7px 12px', fontSize: 12.5, fontWeight: 600, borderRadius: 8, border: '1px solid var(--border-color)', background: 'transparent', color: 'var(--accent)', cursor: 'pointer' }}>
              {c.clientName}
            </button>
          ))}
        </div>
      </div>
    );
  }

  const hasBaseFee = baseFee.trim() !== '' && Number(baseFee) > 0;

  return (
    <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Client billing settings</h1>
        <Link to="/billing" style={{ fontSize: 12.5, color: 'var(--accent)', textDecoration: 'none' }}>← Back to Finance</Link>
      </div>
      <div style={cardStyle}>
        <div style={{ fontSize: 16, fontWeight: 700 }}>{selectedName || 'Client'}</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Billing rate card and tax terms</div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>
          Billing status, banking details and remarks are managed on the client's record under{' '}
          <Link to="/clients" style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>Clients → Billing</Link>.
        </div>
      </div>

      {!hasBaseFee && (
        <div style={{ ...cardStyle, borderLeft: '3px solid var(--warning)', display: 'flex', gap: 9, alignItems: 'flex-start', fontSize: 12.5 }}>
          <AlertTriangle size={15} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
          <span style={{ color: 'var(--text-secondary)' }}>
            No base fee set. Until one is, this client's audits are billed at the assayer's cost —
            so every audit earns zero margin. Set a base fee to bill at the contracted rate.
          </span>
        </div>
      )}

      <div style={cardStyle}>
        <SectionTitle>What we bill the client</SectionTitle>
        <Field label="Base fee per audit (₹)" hint="Charged per branch audit. The margin is this minus what the assayer is paid.">
          <input type="number" value={baseFee} onChange={(e) => setBaseFee(e.target.value)} placeholder="e.g. 3000" style={inputStyle} />
        </Field>
        <Field label="Travel per chargeable km (₹)" hint="Applied after the free allowance below. Blank uses the platform default.">
          <input type="number" value={travelPerKm} onChange={(e) => setTravelPerKm(e.target.value)} placeholder="e.g. 8" style={inputStyle} />
        </Field>
        <Field label="Free travel allowance (km)" hint="Distance not charged for travel before the per-km rate applies.">
          <input type="number" value={freeKm} onChange={(e) => setFreeKm(e.target.value)} placeholder="e.g. 10" style={inputStyle} />
        </Field>
      </div>

      <div style={cardStyle}>
        <SectionTitle>Tax & terms</SectionTitle>
        <Field label="GST rate (%)" hint="Added to the client's invoice. Blank keeps the current contracted rate.">
          <input type="number" value={gst} onChange={(e) => setGst(e.target.value)} placeholder="e.g. 18" style={inputStyle} />
        </Field>
        <Field label="TDS rate (%)" hint="Withheld by the client on payment.">
          <input type="number" value={tds} onChange={(e) => setTds(e.target.value)} placeholder="e.g. 10" style={inputStyle} />
        </Field>
        <Field label="Payment terms" hint="e.g. NET30 — days from invoice to due.">
          <input value={terms} onChange={(e) => setTerms(e.target.value)} placeholder="NET30" style={inputStyle} />
        </Field>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={save} disabled={saving} className="btn btn-primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 18px', fontSize: 13 }}>
          <Save size={14} /> {saving ? 'Saving…' : 'Save billing settings'}
        </button>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: 'var(--text-muted)' }}>
          <Info size={12} /> Applies to audits billed from now on; existing entries are unchanged.
        </span>
      </div>
    </div>
  );
};

const cardStyle: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md, 10px)', padding: 16,
};
const inputStyle: React.CSSProperties = {
  width: 200, maxWidth: '100%', padding: '7px 10px', fontSize: 13, background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: 8, color: 'var(--text-primary)',
};

const SectionTitle: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 700, marginBottom: 12 }}>{children}</div>
);

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, padding: '8px 0', borderBottom: '1px solid var(--border-hair)', flexWrap: 'wrap' }}>
    <div style={{ minWidth: 200 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, maxWidth: 340 }}>{hint}</div>}
    </div>
    {children}
  </div>
);
