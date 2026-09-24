import React, { useEffect, useState } from 'react';
import {
  ShieldCheck, ShieldAlert, Smartphone, Mail, MessageSquare, KeyRound,
  Copy, Check, Trash2, RefreshCw, Loader2, X,
} from 'lucide-react';
import * as mfa from '../../services/mfa';
import type { MfaFactor, MfaStatus, MfaStepUpProof } from '../../services/mfa';
import { userMessage } from '../../services/errors';
import { useToast, AlertBanner, Modal } from '../../components/ui';
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

/** Shown on the SMS card while the server has no SMS gateway, in place of a button that would only fail. */
export const SMS_UNAVAILABLE_NOTE =
  'Not available yet: text messages have not been set up on this system. Use an authenticator app or email instead.';

const labelStyle: React.CSSProperties = { fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-secondary)' };
const inputStyle: React.CSSProperties = {
  padding: '10px 14px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-md)', color: 'var(--text-primary)', fontSize: 'var(--text-base)', outline: 'none',
};

/**
 * An action that weakens the account, waiting for the person to prove it is them. The server
 * refuses both without the current password or a fresh authenticator code, so a session left open
 * on a shared desk (or stolen) cannot switch 2FA off or mint itself new recovery codes.
 */
type StepUp = { kind: 'disable'; factor: MfaFactor } | { kind: 'regenerate' };

/** Group a base32 setup key into 4-char blocks so it can be typed into an authenticator by hand. */
function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) || [secret]).join(' ');
}

export const MfaPanel: React.FC = () => {
  const { toast } = useToast();

  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [busy, setBusy] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [stepUp, setStepUp] = useState<StepUp | null>(null);
  const [proof, setProof] = useState<MfaStepUpProof>({});
  const [stepUpBusy, setStepUpBusy] = useState(false);
  const [stepUpError, setStepUpError] = useState<string | null>(null);

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
  /** Only an explicit "no" hides SMS; a status that has not loaded yet is not a refusal. */
  const unavailable = (f: MfaFactor) => f === 'SMS' && status?.smsAvailable === false;

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

  const openStepUp = (next: StepUp) => {
    setProof({}); setStepUpError(null); setStepUpBusy(false); setStepUp(next);
  };
  const closeStepUp = () => { setStepUp(null); setProof({}); setStepUpError(null); setStepUpBusy(false); };

  const removeFactor = (factor: MfaFactor) => openStepUp({ kind: 'disable', factor });
  const regenerate = () => openStepUp({ kind: 'regenerate' });

  const hasProof = !!proof.currentPassword || (proof.code ?? '').trim().length >= 6;

  /** Run the waiting action with the proof typed in. A wrong answer keeps the dialog open to retry. */
  const submitStepUp = async () => {
    if (!stepUp || !hasProof) return;
    setStepUpBusy(true); setStepUpError(null);
    try {
      if (stepUp.kind === 'disable') {
        await mfa.disableMfa(stepUp.factor, proof);
        closeStepUp();
        await refresh();
        toast({ type: 'success', message: `${FACTOR_META[stepUp.factor].label} turned off.` });
      } else {
        const { recoveryCodes: codes } = await mfa.regenerateRecoveryCodes(proof);
        closeStepUp();
        setRecoveryCodes(codes);
      }
    } catch (e) {
      setStepUpError(userMessage(e));
      setStepUpBusy(false);
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
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
          <h4 style={{ fontSize: 'var(--text-md)', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>
            Two-step verification (2FA)
          </h4>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: '4px 0 0', maxWidth: 560 }}>
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
            <strong style={{ fontSize: 'var(--text-base)', color: 'var(--text-primary)' }}>Save your recovery codes</strong>
          </div>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', margin: '0 0 12px' }}>
            Each code works <strong>once</strong>, to sign in if you lose your device. This is the only time they are shown.
          </p>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8,
            fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--text-sm)', marginBottom: 14,
          }}>
            {recoveryCodes.map((c) => (
              <span key={c} style={{
                background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-sm, 6px)', padding: '6px 10px', letterSpacing: 0.5, color: 'var(--text-primary)',
              }}>{c}</span>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={copyRecovery} className="btn btn-ghost" title="Copy all recovery codes to the clipboard" style={{ gap: 8, fontSize: 'var(--text-sm)' }}>
              {copied ? <Check size={15} /> : <Copy size={15} />}{copied ? 'Copied' : 'Copy all'}
            </button>
            <button onClick={() => setRecoveryCodes(null)} className="btn btn-primary" title="Confirm you saved the codes and close this panel" style={{ gap: 8, fontSize: 'var(--text-sm)', fontWeight: 600 }}>
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
          const offline = unavailable(factor);
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
                    <span style={{ fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--text-primary)' }}>{meta.label}</span>
                    {on && <span className="badge" style={{ fontSize: 'var(--text-3xs)', background: 'var(--status-active-bg, rgba(34,197,94,0.14))', color: 'var(--success, #22c55e)' }}>ON</span>}
                    {offline && !on && <span className="badge" title="Text messages have not been set up on this system yet" style={{ fontSize: 'var(--text-3xs)', background: 'var(--bg-tertiary)', color: 'var(--text-muted)' }}>Unavailable</span>}
                  </div>
                  <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', margin: '3px 0 0' }}>{meta.blurb}</p>
                  {offline && (
                    <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', margin: '3px 0 0' }}>{SMS_UNAVAILABLE_NOTE}</p>
                  )}
                </div>
                <div style={{ flexShrink: 0 }}>
                  {on ? (
                    <button onClick={() => removeFactor(factor)} className="btn btn-ghost" title={`Disable ${meta.label} as a two-step verification method`} style={{ gap: 6, fontSize: 'var(--text-xs)', color: 'var(--danger, #ef4444)' }}>
                      <Trash2 size={14} /> Turn off
                    </button>
                  ) : open ? (
                    <button onClick={closeFlow} className="btn btn-ghost" title="Cancel factor setup" style={{ gap: 6, fontSize: 'var(--text-xs)' }}>
                      <X size={14} /> Cancel
                    </button>
                  ) : offline ? null : (
                    <button onClick={() => startFlow(factor)} disabled={busy} className="btn btn-primary" title={`Configure and activate ${meta.label} for two-step verification`} style={{ gap: 6, fontSize: 'var(--text-xs)', fontWeight: 600 }}>
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
                      <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: 0 }}>
                        Open your authenticator app (Google Authenticator, Authy, 1Password…), choose
                        <strong> Add account → Scan a QR code</strong>, and point it at this code. Then enter the
                        6-digit code it shows.
                      </p>
                      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                        {flow.otpauthUri && <QrCode value={flow.otpauthUri} size={196} />}
                        <div style={{ flex: 1, minWidth: 220 }}>
                          <p style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-secondary)', margin: '2px 0 6px' }}>
                            Can’t scan? Enter this key by hand
                          </p>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <code style={{
                              fontFamily: 'var(--font-mono, monospace)', fontSize: 'var(--text-base)', letterSpacing: 1,
                              background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)',
                              borderRadius: 'var(--radius-sm, 6px)', padding: '8px 12px', color: 'var(--text-primary)',
                              wordBreak: 'break-all',
                            }}>{groupSecret(flow.secret || '')}</code>
                            <button
                              onClick={async () => { try { await navigator.clipboard.writeText(flow.secret || ''); toast({ type: 'success', message: 'Setup key copied.' }); } catch { /* ignore */ } }}
                              title="Copy the setup key to the clipboard for manual entry"
                              className="btn btn-ghost" style={{ gap: 6, fontSize: 'var(--text-xs)' }}
                            ><Copy size={14} /> Copy key</button>
                          </div>
                          <p style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', margin: '8px 0 0' }}>
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
                        title="Type the mobile number that should receive setup codes by text"
                        onChange={(e) => setFlow({ ...flow, phone: e.target.value })}
                        style={inputStyle}
                      />
                    </div>
                  )}

                  {flow.phase === 'code' && (
                    <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: 0 }}>
                      We sent a code to <strong>{flow.sentTo}</strong>. Enter it below.
                    </p>
                  )}

                  {(flow.phase === 'code' || flow.factor === 'TOTP') && flow.phase !== 'phone' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 240 }}>
                      <label style={labelStyle}>6-DIGIT CODE</label>
                      <input
                        inputMode="numeric" autoComplete="one-time-code" autoFocus={flow.factor !== 'TOTP'}
                        value={flow.code} placeholder="000000" maxLength={8}
                        title="Type the 6-digit code from your authenticator app or message"
                        onChange={(e) => setFlow({ ...flow, code: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') void confirmCode(); }}
                        style={{ ...inputStyle, letterSpacing: 4, fontSize: 'var(--text-lg)', textAlign: 'center' }}
                      />
                    </div>
                  )}

                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    {flow.factor === 'SMS' && flow.phase === 'phone' ? (
                      <button onClick={sendSms} disabled={busy || !(flow.phone || '').trim()} title="Send a setup code to this mobile number" className="btn btn-primary" style={{ gap: 8, fontWeight: 600 }}>
                        {busy && <Loader2 size={15} className="spin" />} Send code
                      </button>
                    ) : (
                      <button onClick={confirmCode} disabled={busy || flow.code.trim().length < 6} title="Check the code and turn on two-step verification" className="btn btn-primary" style={{ gap: 8, fontWeight: 600 }}>
                        {busy && <Loader2 size={15} className="spin" />} Verify & turn on
                      </button>
                    )}
                    {flow.phase === 'code' && flow.factor !== 'TOTP' && (
                      <button
                        onClick={() => (flow.factor === 'SMS' ? sendSms() : startFlow('EMAIL'))}
                        disabled={busy} title="Send the setup code again" className="btn btn-ghost" style={{ fontSize: 'var(--text-xs)' }}
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
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
            <KeyRound size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
            Recovery codes remaining: <strong style={{ color: 'var(--text-primary)' }}>{status?.recoveryCodesRemaining ?? 0}</strong>
          </div>
          <button onClick={regenerate} className="btn btn-ghost" title="Create new recovery codes; the current ones stop working at once" style={{ gap: 6, fontSize: 'var(--text-xs)' }}>
            <RefreshCw size={14} /> Regenerate recovery codes
          </button>
        </div>
      )}

      <Modal
        open={!!stepUp}
        onClose={closeStepUp}
        width={440}
        asForm
        onSubmit={(e) => { e.preventDefault(); void submitStepUp(); }}
        title={stepUp?.kind === 'disable'
          ? `Turn off ${FACTOR_META[stepUp.factor].label}?`
          : 'Generate new recovery codes?'}
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={closeStepUp}>Cancel</button>
            <button
              type="submit" className="btn btn-primary" disabled={!hasProof || stepUpBusy}
              style={stepUp?.kind === 'disable'
                ? { background: 'var(--danger)', borderColor: 'var(--danger)', opacity: hasProof ? 1 : 0.5, gap: 8 }
                : { opacity: hasProof ? 1 : 0.5, gap: 8 }}
            >
              {stepUpBusy && <Loader2 size={15} className="spin" />}
              {stepUp?.kind === 'disable' ? 'Turn off' : 'Generate new codes'}
            </button>
          </>
        }
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 'var(--text-sm)', lineHeight: 1.6, color: 'var(--text-secondary)', margin: 0 }}>
            {stepUp?.kind === 'disable'
              ? 'You will no longer be asked for this factor when you sign in. If it is your only factor, your account goes back to password-only.'
              : 'Your current recovery codes stop working immediately. Save the new ones somewhere safe.'}
          </p>
          <p style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--danger)', margin: 0 }}>This cannot be undone.</p>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', margin: 0 }}>
            To confirm it is you, enter your current password{active('TOTP') ? ' or a code from your authenticator app' : ''}.
          </p>
          {stepUpError && <AlertBanner type="error" message={stepUpError} />}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label htmlFor="mfa-stepup-password" style={labelStyle}>CURRENT PASSWORD</label>
            <input
              id="mfa-stepup-password" type="password" autoComplete="current-password" autoFocus
              value={proof.currentPassword ?? ''}
              title="Type the password you sign in with"
              onChange={(e) => setProof({ ...proof, currentPassword: e.target.value })}
              style={inputStyle}
            />
          </div>
          {active('TOTP') && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 240 }}>
              <label htmlFor="mfa-stepup-code" style={labelStyle}>OR AUTHENTICATOR CODE</label>
              <input
                id="mfa-stepup-code" inputMode="numeric" autoComplete="one-time-code" placeholder="000000" maxLength={8}
                value={proof.code ?? ''}
                title="Type the 6-digit code your authenticator app shows now"
                onChange={(e) => setProof({ ...proof, code: e.target.value })}
                style={{ ...inputStyle, letterSpacing: 4, textAlign: 'center' }}
              />
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
};

export default MfaPanel;
