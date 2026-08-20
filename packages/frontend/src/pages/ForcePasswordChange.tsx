import React, { useState } from 'react';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { api } from '../services/api';
import BrandLogo from '../components/BrandLogo';

/**
 * Forced password change for staff.
 *
 * Shown in place of the application when the signed-in account still holds a password
 * somebody else chose — a seeded credential or an administrator reset. It is deliberately
 * not dismissable: this deployment shipped with almost every staff account sharing one
 * password, and an optional banner would be ignored indefinitely.
 *
 * Sign-out stays available so nobody is trapped if they cannot complete the change.
 */

const MIN_LENGTH = 8;

interface Props {
  onChanged: () => void;
  onLogout: () => void;
}

export const ForcePasswordChange: React.FC<Props> = ({ onChanged, onLogout }) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Checked here as well as server-side so the answer is immediate.
    if (!currentPassword || !newPassword) {
      setError('Enter your current password and choose a new one.');
      return;
    }
    if (newPassword.length < MIN_LENGTH) {
      setError(`Your new password must be at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('The two new passwords do not match.');
      return;
    }
    if (newPassword === currentPassword) {
      setError('Your new password must be different from your current one.');
      return;
    }

    setBusy(true);
    try {
      await api.request('/users/me/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      onChanged();
    } catch (err: any) {
      const msg = err?.message;
      setError(Array.isArray(msg) ? msg.join(', ') : (msg || 'Could not change your password.'));
    } finally {
      setBusy(false);
    }
  };

  const field: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    background: 'var(--bg-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontSize: '13px',
    outline: 'none',
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg-primary)', padding: '24px',
    }}>
      <form onSubmit={submit} style={{
        width: '100%', maxWidth: '420px', display: 'flex', flexDirection: 'column', gap: '18px',
        background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-md)', padding: '28px',
      }}>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <BrandLogo size="md" showSubtext={false} />
        </div>

        <div style={{
          display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '12px',
          background: 'var(--status-pending-bg)', borderRadius: 'var(--radius-sm)',
        }}>
          <ShieldAlert size={18} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: '1px' }} />
          <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
            Your account is still using a password that was issued to you. Choose one only you
            know before continuing.
          </div>
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>CURRENT PASSWORD</span>
          <input type="password" value={currentPassword} autoComplete="current-password"
            onChange={(e) => setCurrentPassword(e.target.value)} style={field} />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>NEW PASSWORD</span>
          <input type="password" value={newPassword} autoComplete="new-password"
            onChange={(e) => setNewPassword(e.target.value)} style={field} />
          <span style={{ fontSize: '10.5px', color: 'var(--text-muted)' }}>At least {MIN_LENGTH} characters.</span>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
          <span style={{ fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.06em' }}>CONFIRM NEW PASSWORD</span>
          <input type="password" value={confirmPassword} autoComplete="new-password"
            onChange={(e) => setConfirmPassword(e.target.value)} style={field} />
        </label>

        {error && (
          <div style={{
            fontSize: '12px', color: 'var(--danger)', background: 'var(--status-cancelled-bg)',
            padding: '9px 11px', borderRadius: 'var(--radius-sm)',
          }}>{error}</div>
        )}

        <button type="submit" disabled={busy} className="btn btn-primary"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px', padding: '10px' }}>
          <KeyRound size={15} /> {busy ? 'Saving…' : 'Set password'}
        </button>

        <button type="button" onClick={onLogout} className="btn btn-secondary" style={{ padding: '8px' }}>
          Sign out
        </button>
      </form>
    </div>
  );
};

export default ForcePasswordChange;
