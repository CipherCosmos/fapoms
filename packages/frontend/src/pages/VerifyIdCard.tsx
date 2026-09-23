import React, { useEffect, useState } from 'react';
import { verifyIdCardCode, verifyIdCardToken, type IdCardVerification } from '../services/public-id-card';
import { userMessage } from '../services/errors';

const TONE: Record<IdCardVerification['result'], { bg: string; fg: string; title: string }> = {
  VALID: { bg: '#ecfdf5', fg: '#047857', title: 'Valid ID card' },
  NOT_VALID: { bg: '#fef2f2', fg: '#b91c1c', title: 'NOT a valid ID card' },
  CODE_EXPIRED: { bg: '#fffbeb', fg: '#b45309', title: 'This code has expired' },
  NO_MATCH: { bg: '#fef2f2', fg: '#b91c1c', title: 'Not recognised' },
};

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

/**
 * CHECK AN ID CARD — the public page a bank branch, or anybody an appraiser shows their card to,
 * opens (owner, 2026-09-23). No sign-in. Two ways in: scan the live QR on the card
 * (`/verify/card/<token>`), or type the ID number and the 6-digit code shown under it (`/verify`).
 *
 * The answer comes from the record as it is NOW — somebody suspended this morning shows as not
 * valid, whatever their phone displays — and the photograph is shown so the face can be matched.
 */
export const VerifyIdCard: React.FC<{ token?: string | null }> = ({ token }) => {
  const [result, setResult] = useState<IdCardVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [assayerCode, setAssayerCode] = useState('');
  const [code, setCode] = useState('');

  useEffect(() => {
    if (!token) return;
    setBusy(true);
    verifyIdCardToken(token).then(setResult).catch((e) => setError(userMessage(e))).finally(() => setBusy(false));
  }, [token]);

  const check = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assayerCode.trim() || code.replace(/\D/g, '').length !== 6) {
      setError('Type the ID number and the 6-digit code shown on their card.');
      return;
    }
    setBusy(true); setError(null); setResult(null);
    try { setResult(await verifyIdCardCode(assayerCode, code)); } catch (err) { setError(userMessage(err)); } finally { setBusy(false); }
  };

  const tone = result ? TONE[result.result] : null;
  // 16px: anything smaller makes a phone zoom the page when the box is tapped.
  const box: React.CSSProperties = { width: '100%', boxSizing: 'border-box', padding: '12px 14px', fontSize: 'var(--text-md)', borderRadius: '10px', border: '1px solid #cbd5e1', background: '#fff', color: '#0f172a' };

  return (
    <div style={{ minHeight: '100vh', background: 'linear-gradient(160deg, #0b1633 0%, #1e2a6b 55%, #f1f5f9 55%)', padding: '24px 16px', boxSizing: 'border-box', display: 'flex', justifyContent: 'center' }}>
      <div style={{ width: '100%', maxWidth: '440px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#fff' }}>
          <img src="/sumeru-logo.png" alt="" style={{ height: '30px' }} />
          <div>
            <div style={{ fontWeight: 800, letterSpacing: '0.05em' }}>ID CARD CHECK</div>
            <div style={{ fontSize: 'var(--text-xs)', color: '#f4d77a' }}>Is this appraiser who they say they are, today?</div>
          </div>
        </div>

        <div style={{ background: '#fff', borderRadius: '18px', padding: '20px', boxShadow: '0 14px 36px rgba(11,22,51,0.3)', display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {busy && <div style={{ color: '#64748b' }}>Checking…</div>}
          {error && <div role="alert" style={{ color: '#b91c1c', fontSize: 'var(--text-sm)' }}>{error}</div>}

          {result && tone && (
            <div data-testid="verify-result" style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ background: tone.bg, color: tone.fg, borderRadius: '12px', padding: '14px' }}>
                <div style={{ fontSize: 'var(--text-xl)', fontWeight: 900 }}>{tone.title}</div>
                <div style={{ fontSize: 'var(--text-sm)', marginTop: '4px', color: '#0f172a' }}>{result.message}</div>
              </div>
              {result.fullName && (
                <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
                  <div style={{ width: '96px', height: '96px', borderRadius: '50%', overflow: 'hidden', background: '#e2e8f0', flexShrink: 0, border: '3px solid #d4a017' }}>
                    {result.photoUrl && <img src={result.photoUrl} alt={`Photograph of ${result.fullName}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 'var(--text-lg)', fontWeight: 800, color: '#0b1633' }}>{result.fullName}</div>
                    <div style={{ fontSize: 'var(--text-sm)', color: '#8a6100', fontWeight: 700 }}>{result.jobTitle}{result.organisation ? ` · ${result.organisation}` : ''}</div>
                    <div style={{ fontSize: 'var(--text-sm)', fontFamily: 'ui-monospace, monospace', color: '#0f172a', marginTop: '2px' }}>ID {result.assayerCode}</div>
                    {result.validTill && <div style={{ fontSize: 'var(--text-xs)', color: '#64748b' }}>Card valid until {fmt(result.validTill)}</div>}
                  </div>
                </div>
              )}
              {result.result === 'VALID' && (
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: result.clearedForNewWork ? '#047857' : '#b45309' }}>
                  {result.clearedForNewWork ? '✓ Cleared for audit work' : '⚠ Not cleared for new audit work right now'}
                </div>
              )}
              <div style={{ fontSize: 'var(--text-xs)', color: '#64748b' }}>
                Checked {new Date(result.checkedAt).toLocaleString('en-IN')}. Match the photograph to the person in front of you.
              </div>
            </div>
          )}

          <form onSubmit={(e) => void check(e)} style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderTop: result ? '1px solid #e2e8f0' : 'none', paddingTop: result ? '14px' : 0 }}>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: '#0f172a' }}>
              {result ? 'Check another card' : 'Scan the QR on their card — or type what it shows'}
            </div>
            <label style={{ fontSize: 'var(--text-xs)', color: '#475569' }}>
              ID number
              <input style={box} value={assayerCode} onChange={(e) => setAssayerCode(e.target.value.toUpperCase())} placeholder="e.g. AS0012" autoCapitalize="characters" />
            </label>
            <label style={{ fontSize: 'var(--text-xs)', color: '#475569' }}>
              6-digit code (changes every minute)
              <input style={{ ...box, letterSpacing: '0.3em', fontFamily: 'ui-monospace, monospace' }} value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" placeholder="••••••" />
            </label>
            <button type="submit" disabled={busy} style={{ padding: '12px', borderRadius: '10px', border: 'none', background: '#0b1633', color: '#fff', fontWeight: 800, fontSize: 'var(--text-base)', cursor: 'pointer' }}>
              Check
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

export default VerifyIdCard;
