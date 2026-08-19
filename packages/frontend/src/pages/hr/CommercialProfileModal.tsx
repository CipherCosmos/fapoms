import React, { useState } from 'react';
import { formatRupees } from '@fapoms/shared';
import { Modal, Select, useToast } from '../../components/ui';
import { useConfirm } from '../../components/ui/ConfirmDialog';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { todayDateKey } from '../../utils/statusLabels';
import { fmtDate } from '../../utils/dates';

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

/**
 * Money, in the currency the profile is actually recorded in.
 *
 * `formatRupees` prints a ₹ sign on whatever number it is handed, and this dialog offers six
 * currencies — so a profile saved in USD was displayed, on this screen and on the Pay & Terms
 * table, as "₹500". Every profile in the live database happens to be INR today, which is exactly
 * why nobody had noticed: the first non-INR profile would have been read as rupees by everyone
 * who saw it. INR keeps the familiar ₹ formatting; anything else is printed with its own code.
 *
 * Exported so the Pay & Terms table and this dialog can never disagree about what a figure says.
 */
export const formatMoney = (value: number | string | null | undefined, currency?: string | null): string => {
  const code = (currency || 'INR').toUpperCase();
  if (code === 'INR') return formatRupees(value);
  const n = Number(value ?? 0);
  return `${Number.isFinite(n) ? n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : 0} ${code}`;
};

/**
 * Every figure carries the unit it is paid per, because the boxes were labelled "Daily rate" and
 * "Meal allowance" with nothing to say per what — and a clerk filling a monthly retainer into
 * "Daily rate" produces a number that is wrong by a factor of thirty with nothing on screen to
 * contradict it.
 *
 * The base fee is also the only figure here that prices an assignment: `FeePolicyService`
 * resolves the base fee off this profile and nothing else here reaches the billing path (travel is
 * quoted from the transport rate card; the daily rate is only weighed against the budget when the
 * recommendation engine compares candidates, and is never paid out). That is
 * said out loud rather than left for someone to discover after their carefully agreed hourly rate
 * never appears on an invoice.
 */
const NUMERIC_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: 'baseFee', label: 'Base fee — per audit', hint: 'Flat amount for one audit visit. This is the figure assignments are priced and paid at. Leave it at 0 and the client’s default fee is used instead.' },
  { key: 'hourlyRate', label: 'Hourly rate — per hour', hint: 'On record only. Not used to price or pay assignments.' },
  { key: 'dailyRate', label: 'Daily rate — per day', hint: 'Counted against the budget when the system compares candidates, but not paid out. Assignments are still paid on the base fee.' },
  { key: 'travelReimbursement', label: 'Travel reimbursement — per trip', hint: 'On record only. Actual travel is costed from the transport rate card, not from this figure.' },
  { key: 'accommodationAllowance', label: 'Accommodation allowance — per night', hint: 'On record only. Not used to price or pay assignments.' },
  { key: 'mealAllowance', label: 'Meal allowance — per day', hint: 'On record only. Not used to price or pay assignments.' },
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
  const { confirm, confirmDialog } = useConfirm();
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
      toast({ type: 'error', title: 'Start date required', message: 'Pick the date these pay terms start applying.' });
      return;
    }
    /**
     * Editing an existing profile rewrites the rate every future assignment is priced and paid
     * at — there is no separate approval step behind this dialog and no version history in the
     * UI to read the old numbers back from. Saving a *new* profile is not guarded the same way:
     * it adds a dated row rather than overwriting one, and the previous rate stays on record.
     *
     * The dialog names each figure that moved, old → new, because "are you sure?" on its own
     * cannot catch the mistake this is here to catch: a digit typed into the wrong box.
     */
    if (profile) {
      const changed = NUMERIC_FIELDS
        .filter((f) => Number(form[f.key] || 0) !== Number((profile as any)[f.key] ?? 0))
        // In the profile's own currency — the old figure in the currency it was stored in, the new
        // one in the currency about to be saved, so a currency change is visible in the list too.
        .map((f) => `${f.label}: ${formatMoney(Number((profile as any)[f.key] ?? 0), profile.currency)} → ${formatMoney(Number(form[f.key] || 0), form.currency)}`);
      if (changed.length > 0) {
        const ok = await confirm({
          title: 'Change what this person is paid?',
          message: (
            <>
              <div style={{ marginBottom: '8px' }}>
                Every assignment priced or paid against this profile from now on uses the new figures.
                Work already invoiced keeps the rate it was billed at.
              </div>
              <ul style={{ margin: 0, paddingLeft: '18px' }}>
                {changed.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </>
          ),
          confirmLabel: 'Save new pay terms',
          reversible: true,
          tone: 'danger',
        });
        if (!ok) return;
      }
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
      // Named, not "Commercial profile saved" — a clerk who has just typed six numbers wants to be
      // told which one the system will actually pay, and from when.
      toast({
        type: 'success',
        title: profile ? 'Pay terms updated' : 'Pay terms saved',
        message: Number(form.baseFee) > 0
          ? `Paid ${formatMoney(Number(form.baseFee), form.currency)} per audit from ${fmtDate(form.effectiveStartDate)}.`
          : `No base fee set, so audits from ${fmtDate(form.effectiveStartDate)} are still paid at the client's default fee.`,
      });
      onSaved();
      onClose();
    } catch (err) {
      toast({ type: 'error', title: 'Pay terms not saved', message: userMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const label: React.CSSProperties = { display: 'block', fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' };
  const input: React.CSSProperties = { padding: '9px 11px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: '8px', color: 'var(--text-primary)', width: '100%', boxSizing: 'border-box' as const, outline: 'none', fontSize: '13px' };

  return (
    <Modal open={open} onClose={onClose} title={profile ? 'Change what this person is paid' : 'Set what this person is paid'} asForm onSubmit={submit} width={520}>
      {/*
        Which of these six numbers actually reaches a payout, said before the boxes rather than
        after the mistake. Filling in an hourly rate and expecting it to be paid is the error this
        dialog invited, and there is nothing further down the system that would ever correct it.
      */}
      <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)', borderRadius: '8px', padding: '9px 11px', marginBottom: '12px', lineHeight: 1.5 }}>
        Assignments are priced and paid on the <strong>base fee</strong> only. The other figures are
        kept on this person's record as their agreed terms, but no invoice or payout is calculated
        from them.
      </div>
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
          <label style={label}>Paid at these terms from</label>
          <input type="date" value={form.effectiveStartDate || ''} onChange={(e) => setForm({ ...form, effectiveStartDate: e.target.value })} style={input} />
        </div>
        <div>
          <label style={label}>Until (leave blank for no end date)</label>
          <input type="date" value={form.effectiveEndDate || ''} onChange={(e) => setForm({ ...form, effectiveEndDate: e.target.value })} style={input} />
        </div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
        <button type="button" onClick={onClose} className="btn btn-secondary" style={{ fontSize: '12px', padding: '8px 14px' }}>Cancel</button>
        <button type="submit" disabled={busy} className="btn btn-primary" style={{ fontSize: '12px', padding: '8px 14px' }}>
          {busy ? 'Saving…' : profile ? 'Save changes' : 'Save pay terms'}
        </button>
      </div>
      {confirmDialog}
    </Modal>
  );
};

export default CommercialProfileModal;
