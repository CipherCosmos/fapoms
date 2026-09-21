import React, { useEffect, useState } from 'react';
import { ShieldCheck, Check, AlertCircle, Loader2, Eye, EyeOff } from 'lucide-react';
import { PublicShell } from './registration/PublicShell';
import PrimaryButton from './registration/PrimaryButton';
import { StyledInput } from '../components/ui/inputs';

/**
 * WHERE A NEW COLLEAGUE CHOOSES THEIR OWN PASSWORD.
 *
 * Accounts used to start life with a password an administrator invented, typed into a form, and
 * passed on — so two people knew it, it usually travelled by messaging app, and it was usually
 * never changed. This page is the other end of the emailed link that replaced that: the person sets
 * their own password and nobody else ever sees it.
 *
 * Public, like the candidate registration page, and for the same reason: somebody with no account
 * yet cannot sign in to set one up. The link IS the credential, so it is single-use and expires.
 */

interface LinkHolder {
  valid: boolean;
  displayName?: string;
  email?: string;
  expiresAt?: string;
}

const MIN_LENGTH = 10;

export const AccountSetup: React.FC<{ token: string }> = ({ token }) => {
  const [holder, setHolder] = useState<LinkHolder | null>(null);
  const [checking, setChecking] = useState(true);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/v1/public/account-setup/${encodeURIComponent(token)}`);
        const body = await res.json().catch(() => ({}));
        if (!cancelled) setHolder(body?.data ?? body ?? { valid: false });
      } catch {
        if (!cancelled) setHolder({ valid: false });
      } finally {
        if (!cancelled) setChecking(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const tooShort = password.length > 0 && password.length < MIN_LENGTH;
  const mismatch = confirm.length > 0 && confirm !== password;
  const ready = password.length >= MIN_LENGTH && confirm === password && !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/public/account-setup/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        // The server's words, not ours: it knows whether this was a spent link, an expired one or
        // a password it will not accept, and each needs a different thing from the reader.
        throw new Error(body?.message || 'That did not work. Please try again.');
      }
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (checking) {
    return (
      <PublicShell>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '30px', color: 'var(--text-secondary)' }}>
          <Loader2 size={18} className="spin" /> Checking your link…
        </div>
      </PublicShell>
    );
  }

  if (!holder?.valid) {
    return (
      <PublicShell>
        <Card tone="var(--danger)" icon={<AlertCircle size={28} style={{ color: 'var(--danger)' }} />} title="This link no longer works">
          <p style={{ margin: 0, lineHeight: 1.6 }}>
            Password links can only be used once, and they expire after a couple of days. Ask
            whoever set up your account to send you a fresh one.
          </p>
        </Card>
      </PublicShell>
    );
  }

  if (done) {
    return (
      <PublicShell>
        <Card tone="var(--success)" icon={<Check size={28} strokeWidth={3} style={{ color: 'var(--success)' }} />} title="Your password is set">
          <p style={{ margin: 0, lineHeight: 1.6 }}>
            You can sign in now. Nobody else knows this password — not even the person who set up
            your account.
          </p>
          <PrimaryButton onClick={() => { window.location.href = '/login'; }} style={{ alignSelf: 'flex-start' }}>
            Go to sign in
          </PrimaryButton>
        </Card>
      </PublicShell>
    );
  }

  return (
    <PublicShell>
      <Card
        tone="var(--success)"
        icon={<ShieldCheck size={28} style={{ color: 'var(--success)' }} />}
        title={holder.displayName ? `Welcome, ${holder.displayName}` : 'Choose your password'}
      >
        <p style={{ margin: 0, lineHeight: 1.6 }}>
          Choose a password for your account{holder.email ? <> (<strong>{holder.email}</strong>)</> : null}.
          It is yours alone — nobody at the office can see it.
        </p>

        <Field label="New password">
          <div style={{ display: 'flex', gap: '8px' }}>
            <StyledInput
              
              type={reveal ? 'text' : 'password'}
              value={password}
              autoFocus
              autoComplete="new-password"
              onChange={(e) => setPassword(e.target.value)}
              style={{ flex: 1 }}
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? 'Hide password' : 'Show password'}
              className="btn btn-secondary"
              style={{ padding: '0 12px' }}
            >
              {reveal ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          {/* Said before they can get it wrong, not after. */}
          <Hint bad={tooShort}>
            {tooShort ? `A few more characters — ${MIN_LENGTH} at least.` : `At least ${MIN_LENGTH} characters.`}
          </Hint>
        </Field>

        <Field label="Type it again">
          <StyledInput
            
            type={reveal ? 'text' : 'password'}
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
          />
          {mismatch && <Hint bad>The two do not match yet.</Hint>}
        </Field>

        {error && (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>
            <AlertCircle size={16} /> {error}
          </div>
        )}

        <PrimaryButton onClick={() => void submit()} disabled={!ready} busy={busy} style={{ alignSelf: 'flex-start' }}>
          <Check size={16} strokeWidth={3} /> Set my password
        </PrimaryButton>
      </Card>
    </PublicShell>
  );
};

const Card: React.FC<{ tone: string; icon: React.ReactNode; title: string; children: React.ReactNode }> = ({
  tone, icon, title, children,
}) => (
  <div className="pub-reg-card" style={{ borderColor: tone, padding: '30px 26px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
      <div style={{
        width: '48px', height: '48px', borderRadius: '50%', flexShrink: 0,
        background: 'var(--bg-surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {icon}
      </div>
      <h1 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>{title}</h1>
    </div>
    {children}
  </div>
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
    <label className="form-label" style={{ margin: 0 }}>{label}</label>
    {children}
  </div>
);

const Hint: React.FC<{ bad?: boolean; children: React.ReactNode }> = ({ bad, children }) => (
  <span style={{ fontSize: 'var(--text-xs)', color: bad ? 'var(--danger)' : 'var(--text-muted)' }}>{children}</span>
);

export default AccountSetup;
