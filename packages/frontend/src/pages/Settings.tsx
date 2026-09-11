import React, { useCallback, useState, useEffect } from 'react';
import {
  User, Lock, Palette, Check, Save, KeyRound, AlertCircle, CheckCircle2, MonitorSmartphone,
} from 'lucide-react';
import { api } from '../services/api';
import { userMessage } from '../services/errors';
import { LoadFailure, caughtLoad } from '../components/LoadFailure';
import { changeOwnPasswordPath, isAssayerPrincipal } from '../config/self-service-endpoints';
import { SessionsPanel } from './account/SessionsPanel';
import { MfaPanel } from './account/MfaPanel';
import {
  THEMES,
  ACCENTS,
  CUSTOM_THEME_ID,
  useTheme,
} from '../hooks/useTheme';

type SettingsTab = 'PROFILE' | 'SECURITY' | 'SESSIONS' | 'APPEARANCE';

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
  /** An assayer is a different kind of principal; the field app owns their profile. */
  const isAssayer = isAssayerPrincipal(userRoles);

  // Form State - Security Password Change
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordMessage, setPasswordMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Appearance Theme
  const { theme, setTheme, custom, setCustom, customActive } = useTheme();

  /**
   * Whether this screen actually knows who you are.
   *
   * Every field below is seeded from `/users/me`, and that call used to be caught, written to the
   * console and dropped. So a refused or failed load drew a complete, ordinary-looking account
   * page with an empty name, an empty email, an empty username and no role badges — a person's own
   * record presented as though nothing were on it, with the browser console the only place that
   * said otherwise. The form was live too: Save Profile would have PUT those blanks over their
   * real name. Held in state so the screen says what happened and refuses to pretend.
   */
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileLoadError, setProfileLoadError] = useState<unknown>(null);

  const loadProfile = useCallback(() => {
    setProfileLoading(true);
    api.request<UserProfileData>('/users/me')
      .then((data) => {
        setFirstName(data.firstName || '');
        setLastName(data.lastName || '');
        setPhone(data.phone || '');
        setEmail(data.email || '');
        setUsername(data.username || '');
        setUserRoles((data.roles || []).map((r) => r.name));
        setProfileLoadError(null);
      })
      .catch((err) => {
        setProfileLoadError(err);
      })
      .finally(() => {
        setProfileLoading(false);
      });
  }, []);

  // Load User Profile on Mount
  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

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
      // The right door for this principal — an assayer is not a `users` row, and posting them at
      // the staff endpoint answered 404 while this screen blamed their current password.
      await api.request(changeOwnPasswordPath(userRoles), {
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
          My Account
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
          onClick={() => setActiveTab('SESSIONS')}
          className={`btn ${activeTab === 'SESSIONS' ? 'btn-primary' : 'btn-ghost'}`}
          style={{ gap: '8px', padding: '8px 16px', fontSize: '13px', borderRadius: 'var(--radius-md) var(--radius-md) 0 0' }}
        >
          <MonitorSmartphone size={16} />
          <span>Sessions & Devices</span>
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
      {activeTab === 'PROFILE' && isAssayer && (
        /*
         * An assayer's profile is not editable here, and this says so instead of offering a form
         * that cannot save.
         *
         * Profile edits post `PUT /users/me`, and an assayer is not a `users` row — they carry
         * their own credentials on the `assayers` table. There is no assayer counterpart to that
         * route, because the field app owns this screen: `mobile/src/screens/ProfileScreen.tsx`
         * is where an assayer maintains their own details. Offering the form here produced a
         * filled-in page, a working Save button, and a 404 naming an internal id.
         *
         * Their password IS changeable here — see `changeOwnPasswordPath` — so the Security tab
         * beside this one stays available.
         */
        <div className="glass-card" style={{ padding: '28px', borderRadius: 'var(--radius-lg)' }}>
          <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '6px', color: 'var(--text-primary)' }}>Personal Profile</h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '18px' }}>
            Your name, contact details and work preferences are kept in the FAPOMS field app, where
            you can edit them yourself. They are not editable from this browser.
          </p>
          <div style={{
            padding: '14px 16px', borderRadius: 'var(--radius-md)', fontSize: '13px',
            background: 'var(--bg-primary)', border: '1px solid var(--border-color)',
            color: 'var(--text-secondary)', lineHeight: 1.6,
          }}>
            <strong style={{ color: 'var(--text-primary)' }}>{[firstName, lastName].filter(Boolean).join(' ') || username}</strong>
            {email && <div>{email}</div>}
            {phone && <div>{phone}</div>}
            <div style={{ marginTop: 10 }}>
              To change your password, use <strong style={{ color: 'var(--text-primary)' }}>Security &amp; Password</strong> above.
              For anything else — your address, bank details or documents — speak to your HR contact,
              who keeps those on your record.
            </div>
          </div>
        </div>
      )}

      {activeTab === 'PROFILE' && !isAssayer && (
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

          {/* Refused or failed first, then still-loading, then the form. The form is deliberately
              not rendered over a failed load: blank required fields are indistinguishable from a
              person with no name on file, and the Save button beneath them would write exactly
              that back. */}
          {profileLoadError != null ? (
            <LoadFailure loads={[{ label: 'your profile', query: caughtLoad(profileLoadError, loadProfile) }]} />
          ) : profileLoading ? (
            <div style={{ padding: '24px 0', color: 'var(--text-muted)', fontSize: '13px' }}>Loading your profile…</div>
          ) : (
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
          )}
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

          {/* Two-step verification lives with the password — both are "how you prove it's you". */}
          <div style={{ height: 1, background: 'var(--border-color)', margin: '28px 0' }} />
          <MfaPanel />
        </div>
      )}

      {/* TAB 3: SESSIONS & DEVICES */}
      {activeTab === 'SESSIONS' && (
        <div className="glass-card" style={{ padding: '28px', borderRadius: 'var(--radius-lg)' }}>
          <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '6px', color: 'var(--text-primary)' }}>Sessions & Devices</h3>
          <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '24px' }}>
            Every device signed in to your account, with the address and when it was last active.
            If you don’t recognise one, sign it out — that device will be signed out and cannot refresh.
          </p>
          <SessionsPanel />
        </div>
      )}

      {/* TAB 4: APPEARANCE */}
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
