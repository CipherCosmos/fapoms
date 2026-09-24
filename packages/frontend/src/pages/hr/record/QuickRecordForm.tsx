import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { isValidIfsc } from '@fapoms/shared';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { invalidateBankMutation } from '../../../services/queryInvalidation';
import { identityFormatHint, normaliseIdentityOnBlur } from '../../../config/identity-fields';
import { EDIT_FIELDS, resolveIfsc } from '../AssayerForms';
import { buildAssayerEditBody, maskedIdentifier, type Assayer } from '../assayer-shared';
import { fmtDate } from '../../../utils/dates';

export interface QuickBox {
  key: keyof Assayer & string;
  label: string;
  placeholder?: string;
  type?: 'text' | 'date' | 'tel';
  mono?: boolean;
}

/**
 * No PAN here. It used to be the fourth box, which made it the second place in the onboarding
 * drawer to type the same number — the first being the PAN card's own row on the Documents tab,
 * where the number sits beside the scan it is checked against. One number, one place: there.
 */
export const PAYOUT_BOXES: QuickBox[] = [
  { key: 'bankAccountNumber', label: 'Bank account number', placeholder: 'e.g. 50100123456789', mono: true },
  { key: 'ifscCode', label: 'IFSC', placeholder: 'e.g. HDFC0001234', mono: true },
  { key: 'bankName', label: 'Bank', placeholder: 'Filled in from the IFSC' },
];

export const CONTACT_BOXES: QuickBox[] = [
  { key: 'phone', label: 'Phone', placeholder: 'e.g. 98220 01133', type: 'tel' },
  { key: 'emergencyContactPhone', label: 'Emergency contact phone', placeholder: 'e.g. 98220 01144', type: 'tel' },
  { key: 'joiningDate', label: 'Joining date', type: 'date' },
];

const MASKED_KEYS = new Set(['bankAccountNumber', 'panNumber', 'aadhaarNumber']);
const BANK_KEYS = new Set(['bankAccountNumber', 'ifscCode', 'bankName']);

/**
 * A few record fields as one small form, saved through the same edit-body rules as the record page.
 *
 * TWO KINDS OF BOX, ON PURPOSE.
 *
 * The account number and the PAN start EMPTY, with a masked copy shown beside them. The record only
 * holds masked copies of those, a box pre-filled with a mask is a box somebody saves over a real
 * number, and re-typing them from the document is the check itself. That is not changing.
 *
 * Everything else — the phone, the emergency contact, the joining date — used to start empty too,
 * with "On file: 98220 01133" printed underneath. That is the onboarding drawer asking the desk for
 * a phone number the record already has. Those boxes now open holding what is on file, and only a
 * box whose value is changed is sent.
 *
 * A box emptied by hand is still not sent. This quick form has never been able to erase a field on
 * somebody's record, and pre-filling must not quietly give it that power — clearing a phone number
 * belongs on the record page, where it is deliberate.
 */
export const QuickRecordForm: React.FC<{
  assayer: Assayer;
  boxes: QuickBox[];
  saveLabel: string;
  onSaved: () => void;
}> = ({ assayer, boxes, saveLabel, onSaved }) => {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<Record<string, string>>({});
  const [bankHint, setBankHint] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The account number typed a second time — only asked for once a new number has been typed. */
  const [accountConfirm, setAccountConfirm] = useState('');

  const fields = EDIT_FIELDS.filter((f) => boxes.some((b) => b.key === f.key));
  const set = (key: string, value: string) => setForm((f) => ({ ...f, [key]: value }));

  /** What a box opens holding. Empty for the masked identifiers — see the comment above. */
  const seedValue = (b: QuickBox): string => {
    if (MASKED_KEYS.has(b.key)) return '';
    const v = assayer[b.key] as unknown as string | null | undefined;
    if (v === null || v === undefined || v === '') return '';
    if (b.type === 'date') return String(v).slice(0, 10);
    if (b.type === 'tel') {
      const digits = String(v).replace(/\D/g, '');
      return digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
    }
    return String(v);
  };
  const shown = (b: QuickBox): string => form[b.key] ?? seedValue(b);

  /** Only changed, non-empty boxes are sent: an unchanged prefill is not an edit, and empty never erases. */
  const typed = boxes
    .map((b) => [b.key, shown(b)] as const)
    .filter(([key, v]) => v.trim() !== '' && v.trim() !== seedValue(boxes.find((b) => b.key === key)!).trim());

  const onFile = (b: QuickBox): string | null => {
    const v = assayer[b.key] as unknown as string | null | undefined;
    if (!v) return null;
    if (MASKED_KEYS.has(b.key)) return maskedIdentifier(v);
    if (b.type === 'date') return fmtDate(v);
    return String(v);
  };

  const lookUpIfsc = async (code: string) => {
    if (!isValidIfsc(code)) { setBankHint(null); return; }
    const info = await resolveIfsc(code);
    if (!info) { setBankHint(null); return; }
    setBankHint(`${info.bankName}${info.branchName ? ` — ${info.branchName}` : ''}${info.city ? `, ${info.city}` : ''}`);
    setForm((f) => (f.bankName?.trim() ? f : { ...f, bankName: info.bankName }));
  };

  const save = async () => {
    setError(null);
    // The second typing rides along for the check only — `buildAssayerEditBody` never puts it in the body.
    const { body, problems } = buildAssayerEditBody(
      fields, { ...Object.fromEntries(typed), bankAccountNumberConfirm: accountConfirm }, assayer,
    );
    if (problems.length) { setError(problems.join(' ')); return; }
    setSaving(true);
    try {
      await api.request(`/assayers/${assayer.id}`, { method: 'PUT', body: JSON.stringify(body) });
      if (typed.some(([k]) => BANK_KEYS.has(k))) void invalidateBankMutation(queryClient, assayer.id);
      setForm({});
      setBankHint(null);
      setAccountConfirm('');
      onSaved();
    } catch (e) {
      setError(`Not saved. ${userMessage(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' }}>
        {boxes.map((b) => {
          const value = shown(b);
          const prefilled = !MASKED_KEYS.has(b.key) && seedValue(b) !== '';
          const hint = identityFormatHint(b.key, value);
          const current = onFile(b);
          return (
            <label key={b.key} style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: 'var(--text-xs)' }}>
              <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>{b.label}</span>
              <input
                type={b.type === 'date' ? 'date' : 'text'}
                inputMode={b.type === 'tel' ? 'tel' : undefined}
                value={value}
                placeholder={b.placeholder}
                onChange={(e) => set(b.key, e.target.value)}
                onBlur={() => {
                  const cleaned = normaliseIdentityOnBlur(b.key, value);
                  const next = cleaned ?? value;
                  if (cleaned !== null) set(b.key, cleaned);
                  if (b.key === 'ifscCode') void lookUpIfsc(next.trim().toUpperCase());
                }}
                style={{
                  padding: '7px 9px', fontSize: 'var(--text-xs)', borderRadius: '6px',
                  background: 'var(--bg-surface)', color: 'var(--text-primary)',
                  border: `1px solid ${hint ? 'var(--warning)' : 'var(--border-color)'}`,
                  fontFamily: b.mono ? 'monospace' : undefined,
                  textTransform: b.key === 'panNumber' || b.key === 'ifscCode' ? 'uppercase' : undefined,
                }}
              />
              <span style={{ color: hint ? 'var(--warning)' : 'var(--text-muted)', fontSize: 'var(--text-2xs)' }}>
                {hint ?? (b.key === 'bankName' && bankHint
                  ? bankHint
                  : prefilled
                    ? 'From their record — change it only if it is wrong.'
                    : current ? `On file: ${current}` : 'Nothing on file')}
              </span>
            </label>
          );
        })}
      </div>
      {typed.some(([k]) => k === 'bankAccountNumber') && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: '3px', fontSize: 'var(--text-xs)', maxWidth: '320px' }}>
          <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Re-enter account number</span>
          <input
            value={accountConfirm}
            inputMode="numeric"
            autoComplete="off"
            placeholder="Type it again, from the passbook"
            onChange={(e) => setAccountConfirm(e.target.value)}
            // A pasted copy repeats the slip it is meant to catch.
            onPaste={(e) => e.preventDefault()}
            style={{
              padding: '7px 9px', fontSize: 'var(--text-xs)', borderRadius: '6px', fontFamily: 'monospace',
              background: 'var(--bg-surface)', color: 'var(--text-primary)', border: '1px solid var(--border-color)',
            }}
          />
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-2xs)' }}>
            Typed, not pasted — the only check that catches a wrong digit.
          </span>
        </label>
      )}
      {error && <div role="alert" style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)' }}>{error}</div>}
      <div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={saving || typed.length === 0}
          onClick={() => void save()}
          style={{ fontSize: 'var(--text-xs)', padding: '7px 14px' }}
        >
          {saving ? 'Saving…' : saveLabel}
        </button>
      </div>
    </div>
  );
};
