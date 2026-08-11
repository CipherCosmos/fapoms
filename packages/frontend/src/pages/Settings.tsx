import React, { useState, useEffect } from 'react';
import {
  User, Lock, Palette, Check, Save, KeyRound, AlertCircle, CheckCircle2,
} from 'lucide-react';
import { api } from '../services/api';
import { userMessage } from '../services/errors';
import {
  THEMES,
  ACCENTS,
  CUSTOM_THEME_ID,
  useTheme,
} from '../hooks/useTheme';

type SettingsTab = 'PROFILE' | 'SECURITY' | 'APPEARANCE';

interface UserProfileData {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
  phone?: string;
  status: string;
  roles?: { name: string }[];
}

export const Settings: React.FC = () => {
  const [activeTab, setActiveTab] = useState<SettingsTab>('PROFILE');
  const [savingProfile, setSavingProfile] = useState<boolean>(false);
  const [profileMessage, setProfileMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Form State - Personal Profile
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [userRoles, setUserRoles] = useState<string[]>([]);

  // Form State - Security Password Change
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Appearance Theme
  const { theme, setTheme, custom, setCustom, customActive } = useTheme();

  // Load User Profile on Mount
  useEffect(() => {
    api.request<UserProfileData>('/users/me')
      .then((data) => {
        setFirstName(data.firstName || '');
        setLastName(data.lastName || '');
        setPhone(data.phone || '');
        setEmail(data.email || '');
        setUsername(data.username || '');
        setUserRoles((data.roles || []).map((r) => r.name));
      })
      .catch((err) => {
        console.error('Failed to load profile:', err);
      });
  }, []);

  // Save Profile Handler
  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingProfile(true);
    setProfileMessage(null);

    try {
      const updated = await api.request<UserProfileData>('/users/me', {
        method: 'PUT',
        body: JSON.stringify({ firstName, lastName, phone }),
      });
      setFirstName(updated.firstName || '');
      setLastName(updated.lastName || '');
      setPhone(updated.phone || '');
      try {
        localStorage.setItem('fapoms_user_cache', JSON.stringify(updated));
      } catch {}
      setProfileMessage({ type: 'success', text: 'Profile details updated successfully.' });
    } catch (err: any) {
      setProfileMessage({ type: 'error', text: `Failed to update profile details. ${userMessage(err)}` });
    } finally {
      setSavingProfile(false);
    }
  };

  // Change Password Handler
  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMessage(null);

    if (newPassword !== confirmPassword) {
      setPasswordMessage({ type: 'error', text: 'New password and confirmation do not match.' });
      return;
    }

    if (newPassword.length < 8) {
      setPasswordMessage({ type: 'error', text: 'Password must be at least 8 characters long.' });
      return;
    }

    setChangingPassword(true);
    try {
      await api.request('/users/me/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      setPasswordMessage({ type: 'success', text: 'Password updated successfully.' });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      setPasswordMessage({ type: 'error', text: `Failed to change password. Please check your current password. ${userMessage(err)}` });
    } finally {
      setChangingPassword(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', maxWidth: '1000px', margin: '0 auto' }}>
      
      {/* Header Banner */}
      <div>
        <h2 style={{ fontSize: '24px', fontWeight: 800, fontFamily: 'var(--font-display)', margin: 0 }}>
          Account & Workspace Settings
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '14px', margin: '4px 0 0' }}>
          Manage your personal details, security credentials, visual themes, and workspace preferences.
        </p>
      </div>

      {/* Tabs Navigation */}
      <div style={{
        display: 'flex',
        gap: '8px',
        borderBottom: '1px solid var(--border-color)',
        paddingBottom: '2px',
        overflowX: 'auto',
      }}>
        <button
          onClick={() => setActiveTab('PROFILE')}
          className={`btn ${activeTab === 'PROFILE' ? 'btn-primary' : 'btn-ghost'}`}
          style={{ gap: '8px', padding: '8px 16px', fontSize: '13px', borderRadius: 'var(--radius-md) var(--radius-md) 0 0' }}
        >
          <User size={16} />
          <span>Profile Details</span>
        </button>
        <button
          onClick={() => setActiveTab('SECURITY')}
          className={`btn ${activeTab === 'SECURITY' ? 'btn-primary' : 'btn-ghost'}`}
          style={{ gap: '8px', padding: '8px 16px', fontSize: '13px', borderRadius: 'var(--radius-md) var(--radius-md) 0 0' }}
        >
          <Lock size={16} />
          <span>Security & Password</span>
        </button>
        <button
          onClick={() => setActiveTab('APPEARANCE')}
          className={`btn ${activeTab === 'APPEARANCE' ? 'btn-primary' : 'btn-ghost'}`}
          style={{ gap: '8px', padding: '8px 16px', fontSize: '13px', borderRadius: 'var(--radius-md) var(--radius-md) 0 0' }}
        >
          <Palette size={16} />
          <span>Theme & Appearance</span>
        </button>
      </div>

      {/* TAB 1: PROFILE */}
      {activeTab === 'PROFILE' && (
        <div className="glass-card" style={{ padding: '28px', borderRadius: 'var(--radius-lg)' }}>
          <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '6px', color: 'var(--text-primary)' }}>Personal Profile</h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '24px' }}>
            Update your identity details as displayed across project workflows and audit trail records.
          </p>

          {profileMessage && (
            <div style={{
              padding: '12px 16px',
              borderRadius: 'var(--radius-md)',
              marginBottom: '20px',
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              background: profileMessage.type === 'success' ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)',
              border: `1px solid ${profileMessage.type === 'success' ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
              color: profileMessage.type === 'success' ? '#22c55e' : '#ef4444',
            }}>
              {profileMessage.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
              <span>{profileMessage.text}</span>
            </div>
          )}

          <form onSubmit={handleSaveProfile} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>FIRST NAME</label>
                <input
                  type="text"
                  required
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  style={{
                    padding: '10px 14px',
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-md)',
                    color: 'var(--text-primary)',
                    fontSize: '14px',
                    outline: 'none',
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>LAST NAME</label>
                <input
                  type="text"
                  required
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  style={{
                    padding: '10px 14px',
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-md)',
                    color: 'var(--text-primary)',
                    fontSize: '14px',
                    outline: 'none',
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>PHONE NUMBER</label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+91 98765 43210"
                  style={{
                    padding: '10px 14px',
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-md)',
                    color: 'var(--text-primary)',
                    fontSize: '14px',
                    outline: 'none',
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>EMAIL ADDRESS (READ-ONLY)</label>
                <input
                  type="email"
                  disabled
                  value={email}
                  style={{
                    padding: '10px 14px',
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-md)',
                    color: 'var(--text-muted)',
                    fontSize: '14px',
                    cursor: 'not-allowed',
                  }}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>USERNAME (READ-ONLY)</label>
                <input
                  type="text"
                  disabled
                  value={username}
                  style={{
                    padding: '10px 14px',
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-md)',
                    color: 'var(--text-muted)',
                    fontSize: '14px',
                    cursor: 'not-allowed',
                  }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>ASSIGNED ROLES</label>
                <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', paddingTop: '4px' }}>
                  {userRoles.map((r) => (
                    <span key={r} className="badge badge-accent" style={{ fontSize: '11px' }}>
                      {r.replace('_', ' ')}
                    </span>
                  ))}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px' }}>
              <button
                type="submit"
                disabled={savingProfile}
                className="btn btn-primary"
                style={{ gap: '8px', padding: '10px 24px', fontWeight: 600 }}
              >
                <Save size={16} />
                <span>{savingProfile ? 'Saving Changes...' : 'Save Profile'}</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* TAB 2: SECURITY */}
      {activeTab === 'SECURITY' && (
        <div className="glass-card" style={{ padding: '28px', borderRadius: 'var(--radius-lg)' }}>
          <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '6px', color: 'var(--text-primary)' }}>Password & Security</h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '24px' }}>
            Update your authentication password to maintain security compliance.
          </p>

          {passwordMessage && (
            <div style={{
              padding: '12px 16px',
              borderRadius: 'var(--radius-md)',
              marginBottom: '20px',
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              background: passwordMessage.type === 'success' ? 'rgba(34, 197, 94, 0.12)' : 'rgba(239, 68, 68, 0.12)',
              border: `1px solid ${passwordMessage.type === 'success' ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
              color: passwordMessage.type === 'success' ? '#22c55e' : '#ef4444',
            }}>
              {passwordMessage.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
              <span>{passwordMessage.text}</span>
            </div>
          )}

          <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '480px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>CURRENT PASSWORD</label>
              <input
                type="password"
                required
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                placeholder="Enter current password"
                style={{
                  padding: '10px 14px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  outline: 'none',
                }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>NEW PASSWORD</label>
              <input
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter new password (min. 8 characters)"
                style={{
                  padding: '10px 14px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  outline: 'none',
                }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-secondary)' }}>CONFIRM NEW PASSWORD</label>
              <input
                type="password"
                required
                minLength={8}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter new password"
                style={{
                  padding: '10px 14px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  outline: 'none',
                }}
              />
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-start', marginTop: '12px' }}>
              <button
                type="submit"
                disabled={changingPassword}
                className="btn btn-primary"
                style={{ gap: '8px', padding: '10px 24px', fontWeight: 600 }}
              >
                <KeyRound size={16} />
                <span>{changingPassword ? 'Updating Password...' : 'Update Password'}</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* TAB 3: APPEARANCE */}
      {activeTab === 'APPEARANCE' && (
        <div className="glass-card" style={{ padding: '28px', borderRadius: 'var(--radius-lg)' }}>
          <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '6px', color: 'var(--text-primary)' }}>Theme & Visual Style</h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '24px' }}>
            Customize your workspace visual theme, color palette, and interface styling.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
            {/* Built-in Preset Themes */}
            <div>
              <h4 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px', color: 'var(--text-primary)' }}>Preset Themes</h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '12px' }}>
                {THEMES.map((t) => {
                  const active = !customActive && theme === t.id;
                  return (
                    <div
                      key={t.id}
                      onClick={() => setTheme(t.id)}
                      style={{
                        padding: '14px',
                        borderRadius: 'var(--radius-md)',
                        border: `2px solid ${active ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                        background: 'var(--bg-secondary)',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        transition: 'all var(--transition-fast)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ width: '16px', height: '16px', borderRadius: '50%', background: t.swatch[2] }} />
                        <span style={{ fontSize: '13px', fontWeight: active ? 700 : 500, color: 'var(--text-primary)' }}>{t.label}</span>
                      </div>
                      {active && <Check size={16} style={{ color: 'var(--accent-primary)' }} />}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Custom Accent Color Palette */}
            <div>
              <h4 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px', color: 'var(--text-primary)' }}>Accent Color Palette</h4>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                {ACCENTS.map((item) => {
                  const active = customActive && custom.accent.toLowerCase() === item.hex.toLowerCase();
                  return (
                    <button
                      key={item.id}
                      onClick={() => {
                        setCustom({ accent: item.hex });
                        setTheme(CUSTOM_THEME_ID);
                      }}
                      style={{
                        width: '36px',
                        height: '36px',
                        borderRadius: '50%',
                        background: item.hex,
                        border: active ? '3px solid var(--text-primary)' : '2px solid transparent',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'transform 0.15s ease',
                      }}
                      title={item.label}
                    >
                      {active && <Check size={16} style={{ color: '#fff' }} />}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
export default Settings;
