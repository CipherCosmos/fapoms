import React, { useState } from 'react';
import { ShieldCheck, Check, AlertCircle } from 'lucide-react';
import type { ConsentNotice } from '@fapoms/shared';
import PrimaryButton from './PrimaryButton';

/**
 * WHAT THE CANDIDATE READS BEFORE THE FORM EXISTS.
 *
 * The old form asked for a name, a PAN, an Aadhaar number, a bank account and a folder of scans,
 * and only then — on the last step, beside Submit — showed a tick-box declaring the answers true.
 * Everything had already been collected and saved by then, so the tick could not be a decision
 * about whether to hand it over.
 *
 * This is the first screen instead: nothing is collected until it is accepted, and the server
 * refuses every write until it has been. The words come from the API rather than from this file —
 * they are versioned, and the version is stamped on the acceptance — so what the page shows and
 * what the record claims was agreed can never drift apart.
 */
const ConsentGate: React.FC<{
  notice: ConsentNotice & { grievanceContact: string };
  candidateName: string | null;
  busy: boolean;
  error: string | null;
  onAccept: () => void;
}> = ({ notice, candidateName, busy, error, onAccept }) => {
  const [ticked, setTicked] = useState(false);

  return (
    <div className="pub-reg-card" style={{ padding: '30px 26px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <div style={{
          width: '46px', height: '46px', borderRadius: '50%', flexShrink: 0,
          background: 'rgba(34,197,94,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <ShieldCheck size={26} style={{ color: 'var(--success)' }} />
        </div>
        <div>
          <h1 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            {notice.title}
          </h1>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: '2px' }}>
            {candidateName ? `${candidateName} · ` : ''}Collected by {notice.collectedBy}
          </div>
        </div>
      </div>

      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
        {notice.intro}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {notice.purposes.map((purpose) => (
          <div
            key={purpose.what}
            style={{
              padding: '12px 14px', borderRadius: '10px', background: 'var(--bg-surface-2)',
              border: '1px solid var(--border-hair)',
            }}
          >
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
              {purpose.what}
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5, marginTop: '3px' }}>
              {purpose.why}
            </div>
          </div>
        ))}
      </div>

      <Section title="How long we keep it">
        <p style={{ margin: 0 }}>{notice.retention}</p>
      </Section>

      <Section title="What you can ask for">
        <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {notice.rights.map((right) => <li key={right}>{right}</li>)}
        </ul>
      </Section>

      <Section title="Changing your mind">
        <p style={{ margin: 0 }}>{notice.withdrawal}</p>
      </Section>

      <Section title="Who to contact">
        <p style={{ margin: 0 }}>{notice.grievanceContact}</p>
      </Section>

      <label style={{
        display: 'flex', alignItems: 'flex-start', gap: '12px', cursor: busy ? 'default' : 'pointer',
        padding: '14px', borderRadius: '8px', background: 'var(--bg-surface-2)',
        border: '1px solid var(--border-hair)', fontSize: 'var(--text-sm)',
        color: 'var(--text-secondary)', lineHeight: 1.55,
      }}>
        <input
          type="checkbox"
          checked={ticked}
          disabled={busy}
          onChange={(e) => setTicked(e.target.checked)}
          style={{ marginTop: '3px', width: '16px', height: '16px', flexShrink: 0 }}
        />
        <span>{notice.declaration}</span>
      </label>

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--danger)', fontSize: 'var(--text-xs)' }}>
          <AlertCircle size={15} /> {error}
        </div>
      )}

      <PrimaryButton
        onClick={onAccept}
        disabled={!ticked}
        busy={busy}
        style={{ alignSelf: 'flex-start' }}
      >
        <Check size={16} strokeWidth={3} />
        I agree — start my form
      </PrimaryButton>

      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)' }}>
        Notice version {notice.version}. A copy of exactly this page is kept with your application.
      </div>
    </div>
  );
};

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
    <div style={{
      fontSize: 'var(--text-2xs)', fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '0.08em', color: 'var(--text-secondary)',
    }}>
      {title}
    </div>
    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
      {children}
    </div>
  </div>
);

export default ConsentGate;
