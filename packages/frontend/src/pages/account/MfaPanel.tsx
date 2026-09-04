import React, { useEffect, useState } from 'react';
import {
  ShieldCheck, ShieldAlert, Smartphone, Mail, MessageSquare, KeyRound,
  Copy, Check, Trash2, RefreshCw, Loader2, X,
} from 'lucide-react';
import * as mfa from '../../services/mfa';
import type { MfaFactor, MfaStatus } from '../../services/mfa';
import { userMessage } from '../../services/errors';
import { useToast, useConfirm, AlertBanner } from '../../components/ui';
import { QrCode } from '../../components/QrCode';

/** One card per factor. `phase` tracks where an in-progress enrolment has reached. */
type Phase = 'phone' | 'setup' | 'code';
interface Flow {
  factor: MfaFactor;
  phase: Phase;
  sentTo?: string;      // masked destination for EMAIL/SMS
  otpauthUri?: string;  // TOTP
  secret?: string;      // TOTP setup key
  phone?: string;       // SMS entry
  code: string;
}

const FACTOR_META: Record<MfaFactor, { label: string; blurb: string; Icon: typeof Smartphone }> = {
  TOTP: {
    label: 'Authenticator app',
    blurb: 'Google Authenticator, Authy, 1Password and similar. Works offline; the strongest option.',
    Icon: Smartphone,
  },
  EMAIL: { label: 'Email code', blurb: 'A one-time code sent to your email address when you sign in.', Icon: Mail },
  SMS: { label: 'Text message (SMS)', blurb: 'A one-time code texted to your phone when you sign in.', Icon: MessageSquare },
};

const labelStyle: React.CSSProperties = { fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' };
const inputStyle: React.CSSProperties = {
  padding: '10px 14px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', fontSize: '14px', outline: 'none',
};

/** Group a base32 setup key into 4-char blocks so it can be typed into an authenticator by hand. */
function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) || [secret]).join(' ');
}

export const MfaPanel: React.FC = () => {
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();

  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [busy, setBusy] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = React.useCallback(async () => {
    try {
      setStatus(await mfa.getMfaStatus());
    } catch (e) {
      toast({ type: 'error', title: 'Could not load your 2FA settings', message: userMessage(e) });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void refresh(); }, [refresh]);

  const active = (f: MfaFactor) => !!status?.factors.includes(f);

  const closeFlow = () => { setFlow(null); setFlowError(null); setBusy(false); };

  /** Open an enrolment flow. TOTP/email fetch immediately; SMS collects a number first. */
  const startFlow = async (factor: MfaFactor) => {
    setFlowError(null);
    if (factor === 'SMS') { setFlow({ factor, phase: 'phone', phone: '', code: '' }); return; }
    setBusy(true);
    try {
      if (factor === 'TOTP') {
        const { otpauthUri, secret } = await mfa.enrolTotp();
        setFlow({ factor, phase: 'setup', otpauthUri, secret, code: '' });
      } else {
        const { sentTo } = await mfa.enrolEmail();
        setFlow({ factor, phase: 'code', sentTo, code: '' });
      }
    } catch (e) {
      toast({ type: 'error', title: `Could not start ${FACTOR_META[factor].label} setup`, message: userMessage(e) });
    } finally {
      setBusy(false);
    }
  };

  /** SMS: send the code to the entered number, then move to the code step. */
  const sendSms = async () => {
    if (!flow || flow.factor !== 'SMS') return;
    setBusy(true); setFlowError(null);
    try {
      const { sentTo } = await mfa.enrolSms(flow.phone || '');
      setFlow({ ...flow, phase: 'code', sentTo });
    } catch (e) {
      setFlowError(userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /** Confirm the code for whichever factor is enrolling; surface recovery codes if any come back. */
  const confirmCode = async () => {
    if (!flow) return;
    setBusy(true); setFlowError(null);
    try {
      const code = flow.code.trim();
      const res = flow.factor === 'TOTP' ? await mfa.confirmTotp(code)
        : flow.factor === 'EMAIL' ? await mfa.confirmEmail(code)
        : await mfa.confirmSms(code);
      closeFlow();
      await refresh();
      if (res.recoveryCodes?.length) {
        setRecoveryCodes(res.recoveryCodes);
      } else {
        toast({ type: 'success', message: `${FACTOR_META[flow.factor].label} is now on.` });
      }
    } catch (e) {
      setFlowError(userMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const removeFactor = async (factor: MfaFactor) => {
    const ok = await confirm({
      title: `Turn off ${FACTOR_META[factor].label}?`,
      message: 'You will no longer be asked for this factor when you sign in. If it is your only factor, your account goes back to password-only.',
      confirmLabel: 'Turn off',
      reversible: false,
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await mfa.disableMfa(factor);
      await refresh();
      toast({ type: 'success', message: `${FACTOR_META[factor].label} turned off.` });
    } catch (e) {
      toast({ type: 'error', title: 'Could not turn it off', message: userMessage(e) });
    }
  };

  const regenerate = async () => {
    const ok = await confirm({
      title: 'Generate new recovery codes?',
      message: 'Your current recovery codes stop working immediately. Save the new ones somewhere safe.',
      confirmLabel: 'Generate new codes',
      reversible: false,
    });
    if (!ok) return;
    try {
      const { recoveryCodes: codes } = await mfa.regenerateRecoveryCodes();
      setRecoveryCodes(codes);
    } catch (e) {
      toast({ type: 'error', title: 'Could not regenerate codes', message: userMessage(e) });
    }
  };

  const copyRecovery = async () => {
    if (!recoveryCodes) return;
    try {
      await navigator.clipboard.writeText(recoveryCodes.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ type: 'info', message: 'Copy failed — select the codes and copy them manually.' });
    }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-secondary)', fontSize: 13 }}>
        <Loader2 size={16} className="spin" /> Loading your 2FA settings…
      </div>
    );
  }

  const anyActive = !!status?.confirmed;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Heading */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        <div style={{
          width: 40, height: 40, borderRadius: 'var(--radius-md)', flexShrink: 0,
          display: 'grid', placeItems: 'center',
          background: anyActive ? 'var(--status-active-bg, rgba(34,197,94,0.12))' : 'var(--bg-tertiary)',
          color: anyActive ? 'var(--success, #22c55e)' : 'var(--text-muted)',
        }}>
          {anyActive ? <ShieldCheck size={20} /> : <ShieldAlert size={20} />}
        </div>
        <div>
          <h4 style={{ fontSize: 15, fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
            Two-step verification (2FA)
          </h4>
          <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 0', maxWidth: 560 }}>
            {anyActive
              ? 'Your account asks for a second factor after your password. Add more than one so you are never locked out.'
              : 'Add a second step at sign-in so a stolen password is not enough to get into your account.'}
          </p>
        </div>
      </div>

      {/* Recovery-codes reveal (shown once, after enabling a first factor or regenerating) */}
      {recoveryCodes && (
        <div style={{
          border: '1px solid var(--accent-primary)', borderRadius: 'var(--radius-md)',
          background: 'rgba(216,174,71,0.08)', padding: 18,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <KeyRound size={16} style={{ color: 'var(--accent-primary)' }} />
            <strong style={{ fontSize: 14, color: 'var(--text-primary)' }}>Save your recovery codes</strong>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '0 0 12px' }}>
            Each code works <strong>once</strong>, to sign in if you lose your device. This is the only time they are shown.
          </p>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8,
            fontFamily: 'var(--font-mono, monospace)', fontSize: 13.5, marginBottom: 14,
          }}>
            {recoveryCodes.map((c) => (
              <span key={c} style={{
                background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-sm, 6px)', padding: '6px 10px', letterSpacing: 0.5, color: 'var(--text-primary)',
              }}>{c}</span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={copyRecovery} className="btn btn-ghost" style={{ gap: 8, fontSize: 13 }}>
              {copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copied' : 'Copy all'}
            </button>
            <button onClick={() => setRecoveryCodes(null)} className="btn btn-primary" style={{ gap: 8, fontSize: 13, fontWeight: 600 }}>
              <Check size={15} /> I’ve saved these
            </button>
          </div>
        </div>
      )}

      {/* Factor cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {(Object.keys(FACTOR_META) as MfaFactor[]).map((factor) => {
          const meta = FACTOR_META[factor];
          const on = active(factor);
          const open = flow?.factor === factor;
          return (
            <div key={factor} style={{
              border: `1px solid ${open ? 'var(--accent-primary)' : 'var(--border-color)'}`,
              borderRadius: 'var(--radius-md)', background: 'var(--bg-secondary)', padding: 16,
              transition: 'border-color var(--transition-fast)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <meta.Icon size={20} style={{ color: on ? 'var(--success, #22c55e)' : 'var(--text-muted)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{meta.label}</span>
                    {on && <span className="badge" style={{ fontSize: 10.5, background: 'var(--status-active-bg, rgba(34,197,94,0.14))', color: 'var(--success, #22c55e)' }}>ON</span>}
                  </div>
                  <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', margin: '3px 0 0' }}>{meta.blurb}</p>
                </div>
                <div style={{ flexShrink: 0 }}>
                  {on ? (
                    <button onClick={() => removeFactor(factor)} className="btn btn-ghost" style={{ gap: 6, fontSize: 12.5, color: 'var(--danger, #ef4444)' }}>
                      <Trash2 size={14} /> Turn off
                    </button>
                  ) : open ? (
                    <button onClick={closeFlow} className="btn btn-ghost" style={{ gap: 6, fontSize: 12.5 }}>
                      <X size={14} /> Cancel
                    </button>
                  ) : (
                    <button onClick={() => startFlow(factor)} disabled={busy} className="btn btn-primary" style={{ gap: 6, fontSize: 12.5, fontWeight: 600 }}>
                      Set up
                    </button>
                  )}
                </div>
              </div>

              {/* Inline enrolment flow */}
              {open && flow && (
                <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px dashed var(--border-color)', display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {flowError && <AlertBanner type="error" message={flowError} />}

                  {flow.factor === 'TOTP' && flow.phase === 'setup' && (
                    <>
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
                        Open your authenticator app (Google Authenticator, Authy, 1Password…), choose
                        <strong> Add account → Scan a QR code</strong>, and point it at this code. Then enter the
                        6-digit code it shows.
                      </p>
                      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                        {flow.otpauthUri && <QrCode value={flow.otpauthUri} size={196} />}
                        <div style={{ flex: 1, minWidth: 220 }}>
                          <p style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)', margin: '2px 0 6px' }}>
                            Can’t scan? Enter this key by hand
                          </p>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <code style={{
                              fontFamily: 'var(--font-mono, monospace)', fontSize: 14, letterSpacing: 1,
                              background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
                              borderRadius: 'var(--radius-sm, 6px)', padding: '8px 12px', color: 'var(--text-primary)',
                              wordBreak: 'break-all',
                            }}>{groupSecret(flow.secret || '')}</code>
                            <button
                              onClick={async () => { try { await navigator.clipboard.writeText(flow.secret || ''); toast({ type: 'success', message: 'Setup key copied.' }); } catch { /* ignore */ } }}
                              className="btn btn-ghost" style={{ gap: 6, fontSize: 12.5 }}
                            ><Copy size={14} /> Copy key</button>
                          </div>
                          <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '8px 0 0' }}>
                            Account name <em>FAPOMS</em>. Time-based (TOTP), 6 digits.
                          </p>
                        </div>
                      </div>
                    </>
                  )}

                  {flow.factor === 'SMS' && flow.phase === 'phone' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 320 }}>
                      <label style={labelStyle}>MOBILE NUMBER</label>
                      <input
                        type="tel" autoFocus value={flow.phone || ''} placeholder="e.g. 9876543210"
                        onChange={(e) => setFlow({ ...flow, phone: e.target.value })}
                        style={inputStyle}
                      />
                    </div>
                  )}

                  {flow.phase === 'code' && (
                    <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: 0 }}>
                      We sent a code to <strong>{flow.sentTo}</strong>. Enter it below.
                    </p>
                  )}

                  {(flow.phase === 'code' || flow.factor === 'TOTP') && flow.phase !== 'phone' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 240 }}>
                      <label style={labelStyle}>6-DIGIT CODE</label>
                      <input
                        inputMode="numeric" autoComplete="one-time-code" autoFocus={flow.factor !== 'TOTP'}
                        value={flow.code} placeholder="000000" maxLength={8}
                        onChange={(e) => setFlow({ ...flow, code: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') void confirmCode(); }}
                        style={{ ...inputStyle, letterSpacing: 4, fontSize: 18, textAlign: 'center' }}
                      />
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    {flow.factor === 'SMS' && flow.phase === 'phone' ? (
                      <button onClick={sendSms} disabled={busy || !(flow.phone || '').trim()} className="btn btn-primary" style={{ gap: 8, fontWeight: 600 }}>
                        {busy && <Loader2 size={15} className="spin" />} Send code
                      </button>
                    ) : (
                      <button onClick={confirmCode} disabled={busy || flow.code.trim().length < 6} className="btn btn-primary" style={{ gap: 8, fontWeight: 600 }}>
                        {busy && <Loader2 size={15} className="spin" />} Verify & turn on
                      </button>
                    )}
                    {flow.phase === 'code' && flow.factor !== 'TOTP' && (
                      <button
                        onClick={() => (flow.factor === 'SMS' ? sendSms() : startFlow('EMAIL'))}
                        disabled={busy} className="btn btn-ghost" style={{ fontSize: 12.5 }}
                      >Resend code</button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Recovery codes management (only once a factor is active) */}
      {anyActive && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', paddingTop: 4 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
            <KeyRound size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
            Recovery codes remaining: <strong style={{ color: 'var(--text-primary)' }}>{status?.recoveryCodesRemaining ?? 0}</strong>
          </div>
          <button onClick={regenerate} className="btn btn-ghost" style={{ gap: 6, fontSize: 12.5 }}>
            <RefreshCw size={14} /> Regenerate recovery codes
          </button>
        </div>
      )}

      {confirmDialog}
    </div>
  );
};

export default MfaPanel;
