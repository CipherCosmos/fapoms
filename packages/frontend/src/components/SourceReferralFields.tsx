import React from 'react';
import { REFERRAL_SOURCE_LABELS, ReferralSourceType, type SourceReferral } from '@fapoms/shared';

/**
 * Who referred an assayer — the source reference — as four boxes. One component for every web
 * door that asks (HR's Add candidate, the candidate's own form, the assayer record), so the
 * choices and the words cannot drift. The rule itself is the shared `normalizeSourceReferral`.
 */
export interface SourceReferralDraft {
  type: string;
  name: string;
  mobile: string;
  email: string;
}

export const EMPTY_REFERRAL: SourceReferralDraft = { type: '', name: '', mobile: '', email: '' };

export const referralDraftFrom = (r: Partial<SourceReferral> | null | undefined): SourceReferralDraft => ({
  type: r?.type ?? '', name: r?.name ?? '', mobile: r?.mobile ?? '', email: r?.email ?? '',
});

/** What to send: null for "nobody", the draft otherwise — the server tidies and checks it. */
export const referralPayload = (d: SourceReferralDraft): SourceReferralDraft | null =>
  (d.type || d.name.trim() || d.mobile.trim() || d.email.trim() ? d : null);

const box: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 'var(--text-sm)',
  border: '1px solid var(--border-color)', borderRadius: '8px', background: 'var(--bg-input, var(--bg-surface))',
  color: 'var(--text-primary)',
};
const lbl: React.CSSProperties = { fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: '4px', display: 'block' };

export const SourceReferralFields: React.FC<{
  value: SourceReferralDraft;
  onChange: (next: SourceReferralDraft) => void;
  /** Fires when focus leaves a box — where a form that saves as it goes saves. */
  onBlur?: () => void;
  disabled?: boolean;
  /** Prefix for the boxes' ids, so two on one page do not collide. */
  idPrefix?: string;
  /** The candidate's form says "you"; HR's screens say "them". */
  voice?: 'you' | 'them';
}> = ({ value, onChange, onBlur, disabled, idPrefix = 'referral', voice = 'them' }) => {
  const set = (k: keyof SourceReferralDraft) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    onChange({ ...value, [k]: e.target.value });
  const id = (k: string) => `${idPrefix}-${k}`;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '10px' }}>
      <div>
        <label htmlFor={id('type')} style={lbl}>{voice === 'you' ? 'Who they are' : 'Referred by'}</label>
        <select id={id('type')} style={box} value={value.type} onChange={set('type')} onBlur={onBlur} disabled={disabled}>
          <option value="">Nobody / not known</option>
          {Object.values(ReferralSourceType).map((t) => (
            <option key={t} value={t}>{REFERRAL_SOURCE_LABELS[t]}</option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={id('name')} style={lbl}>Referrer&rsquo;s name</label>
        <input id={id('name')} style={box} value={value.name} onChange={set('name')} onBlur={onBlur} disabled={disabled} maxLength={200} />
      </div>
      <div>
        <label htmlFor={id('mobile')} style={lbl}>Referrer&rsquo;s mobile</label>
        <input id={id('mobile')} style={box} value={value.mobile} onChange={set('mobile')} onBlur={onBlur} disabled={disabled}
          inputMode="numeric" placeholder="Their 10-digit mobile" />
      </div>
      <div>
        <label htmlFor={id('email')} style={lbl}>Referrer&rsquo;s email</label>
        <input id={id('email')} style={box} value={value.email} onChange={set('email')} onBlur={onBlur} disabled={disabled}
          inputMode="email" />
      </div>
    </div>
  );
};

export default SourceReferralFields;
