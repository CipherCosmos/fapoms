import React, { useState } from 'react';
import { Modal, Select, useToast } from '../../components/ui';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { todayDateKey } from '../../utils/statusLabels';

export interface CommercialProfile {
  id: string;
  assayerId: string;
  baseFee: number;
  hourlyRate: number;
  dailyRate: number;
  travelReimbursement: number;
  accommodationAllowance: number;
  mealAllowance: number;
  currency: string;
  effectiveStartDate: string;
  effectiveEndDate: string | null;
}

const NUMERIC_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: 'baseFee', label: 'Base fee (per audit)', hint: 'Flat rate for one audit visit' },
  { key: 'hourlyRate', label: 'Hourly rate' },
  { key: 'dailyRate', label: 'Daily rate' },
  { key: 'travelReimbursement', label: 'Travel reimbursement', hint: 'Flat amount per trip. The per-kilometre allowance is a client contract term, not a per-assayer rate.' },
  { key: 'accommodationAllowance', label: 'Accommodation allowance' },
  { key: 'mealAllowance', label: 'Meal allowance' },
];

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SAR'];

/**
 * The form values for one profile — or an empty sheet when adding a new pay structure.
 *
 * `todayDateKey()` (local calendar) and not `new Date().toISOString().slice(0, 10)`: the ISO
 * slice is the **UTC** date, so from 17:30 IST onwards it pre-fills *tomorrow*. A pay structure
 * silently dated a day early takes effect on the wrong day and mis-prices every audit billed
 * against it that evening.
 */
const buildForm = (profile?: CommercialProfile | null): Record<string, string> => {
  if (profile) {
    return {
      baseFee: String(profile.baseFee ?? ''),
      hourlyRate: String(profile.hourlyRate ?? ''),
      dailyRate: String(profile.dailyRate ?? ''),
      travelReimbursement: String(profile.travelReimbursement ?? ''),
      accommodationAllowance: String(profile.accommodationAllowance ?? ''),
      mealAllowance: String(profile.mealAllowance ?? ''),
      currency: profile.currency || 'INR',
      effectiveStartDate: (profile.effectiveStartDate || '').slice(0, 10),
      effectiveEndDate: profile.effectiveEndDate ? profile.effectiveEndDate.slice(0, 10) : '',
    };
  }
  return {
    baseFee: '', hourlyRate: '', dailyRate: '', travelReimbursement: '', accommodationAllowance: '', mealAllowance: '',
    currency: 'INR', effectiveStartDate: todayDateKey(), effectiveEndDate: '',
  };
};

/**
 * Create or edit an assayer's commercial (pay) profile — the base fee, rates and
 * allowances the recommendation engine and billing quote from. Previously this
 * could only be set through the CSV import or raw API calls; the drawer now lets
 * an HR user set it directly.
 */
export const CommercialProfileModal: React.FC<{
  open: boolean;
  onClose: () => void;
  assayerId: string;
  profile?: CommercialProfile | null;
  onSaved: () => void;
}> = ({ open, onClose, assayerId, profile, onSaved }) => {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Record<string, string>>(() => buildForm(profile));

  /**
   * Re-seed the form whenever the dialog is opened, or opened onto a different profile.
   *
   * The lazy `useState` initialiser above runs **once per mount**. `HrPayPage` mounts this modal
   * conditionally so it was never a problem there, but `AssayerDetailDrawer` keeps it mounted the
   * whole time and only toggles `open` — so "Add pay structure" followed by "Edit" on an existing
   * profile still showed the *first* form's numbers, and Save wrote those stale rates against the
   * newly chosen profile's id. Real money, silently wrong.
   *
   * Fixed here rather than with a `key={profile?.id ?? 'new'}` at the call site: the bug then
   * returns the moment anyone adds a 37th call site (or drops the key while refactoring), and the
   * component would still be quietly unsafe to keep mounted. Owning the reset makes every present
   * and future caller correct by default.
   *
   * Deliberately keyed on the profile *id*, not the object: a background refetch that hands back
   * an equal-but-new object must not wipe out what the user is halfway through typing. The
   * dependency list also excludes `form`, so re-seeding never fights a keystroke.
   */
  const profileId = profile?.id ?? null;
  React.useEffect(() => {
    if (!open) return;
    setForm(buildForm(profile));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, profileId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.effectiveStartDate) {
      toast({ type: 'error', title: 'Start date required', message: 'Pick the date this pay structure takes effect.' });
      return;
    }
    setBusy(true);
    const payload: any = {
      baseFee: Number(form.baseFee) || 0,
      hourlyRate: Number(form.hourlyRate) || 0,
      dailyRate: Number(form.dailyRate) || 0,
      travelReimbursement: Number(form.travelReimbursement) || 0,
      accommodationAllowance: Number(form.accommodationAllowance) || 0,
      mealAllowance: Number(form.mealAllowance) || 0,
      currency: form.currency || 'INR',
      effectiveStartDate: new Date(form.effectiveStartDate).toISOString(),
    };
    if (form.effectiveEndDate) payload.effectiveEndDate = new Date(form.effectiveEndDate).toISOString();
    try {
      if (profile) {
        await api.request(`/assayers/commercial/${profile.id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api.request(`/assayers/${assayerId}/commercial`, { method: 'POST', body: JSON.stringify(payload) });
      }
      toast({ type: 'success', title: profile ? 'Pay updated' : 'Pay created', message: 'Commercial profile saved.' });
      onSaved();
      onClose();
    } catch (err) {
      toast({ type: 'error', title: 'Could not save pay', message: userMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const label: React.CSSProperties = { display: 'block', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' };
  const input: React.CSSProperties = { padding: '9px 11px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' as const, outline: 'none', fontSize: '13px' };

  return (
    <Modal open={open} onClose={onClose} title={profile ? 'Edit pay structure' : 'Add pay structure'} asForm onSubmit={submit} width={520}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px' }}>
        {NUMERIC_FIELDS.map((f) => (
          <div key={f.key} style={f.key === 'baseFee' ? { gridColumn: '1 / -1' } : undefined}>
            <label style={label}>{f.label}</label>
            {f.hint && <div style={{ fontSize: '10.5px', color: 'var(--text-muted)', marginBottom: '3px' }}>{f.hint}</div>}
            <input type="number" min={0} step="0.01" value={form[f.key] || ''} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} style={input} placeholder="0.00" />
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '12px', marginTop: '12px' }}>
        <div>
          <label style={label}>Currency</label>
          <Select
            value={form.currency || 'INR'}
            onChange={(v) => setForm({ ...form, currency: v })}
            options={CURRENCIES.map((c) => ({ value: c, label: c }))}
            style={{ width: '100%' }}
          />
        </div>
        <div>
          <label style={label}>Start date</label>
          <input type="date" value={form.effectiveStartDate || ''} onChange={(e) => setForm({ ...form, effectiveStartDate: e.target.value })} style={input} />
        </div>
        <div>
          <label style={label}>End date (optional)</label>
          <input type="date" value={form.effectiveEndDate || ''} onChange={(e) => setForm({ ...form, effectiveEndDate: e.target.value })} style={input} />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
        <button type="button" onClick={onClose} className="btn btn-secondary" style={{ fontSize: '12px', padding: '8px 14px' }}>Cancel</button>
        <button type="submit" disabled={busy} className="btn btn-primary" style={{ fontSize: '12px', padding: '8px 14px' }}>
          {busy ? 'Saving…' : profile ? 'Save changes' : 'Create pay'}
        </button>
      </div>
    </Modal>
  );
};

export default CommercialProfileModal;
