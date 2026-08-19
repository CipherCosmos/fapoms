import React, { useState } from 'react';
import { BrandLogo } from '../components/BrandLogo';
import { fetchWithTimeout } from '../services/http';
import { consumeSignedOutReason } from '../services/session';

interface LoginProps {
  onLoginSuccess: (accessToken: string, refreshToken: string) => void;
}

export const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  /**
   * Why this person is here, when they did not click Sign Out.
   *
   * A session that runs out mid-click dropped people on this screen with nothing but an empty
   * username box. To a clerk that reads as "the system crashed and lost my work" — and when a
   * save was in flight it half did, which is exactly why the two cases get different wording.
   *
   * Read once in a `useState` initialiser rather than in an effect or inline: `consumeSignedOutReason`
   * clears the flag as it reads it, and React StrictMode double-invokes render in development, so
   * an inline read would return the reason on the first pass and `null` on the second — and it is
   * the second result that reaches the screen. This is the same pattern App.tsx uses for the
   * return path, for the same reason.
   */
  const [signedOutReason] = useState(() => consumeSignedOutReason());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      // Bounded, because this runs before there is a session and so cannot go through the api
      // client. Without a deadline a backend that accepted the connection and then went quiet
      // left this button spinning indefinitely: `isLoading` is only cleared in `finally`, which
      // a never-settling fetch never reaches, so the sole recovery was reloading the page.
      const response = await fetchWithTimeout('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const resData = await response.json().catch(() => ({}));

      if (response.ok && resData.success) {
        onLoginSuccess(resData.data.accessToken, resData.data.refreshToken);
      } else {
        setError(resData.message || resData.error?.message || 'Invalid username or password');
      }
    } catch (err) {
      setError('Unable to connect to authentication server. Please check your network connection.');
    } finally {
      setIsLoading(false);
    }
  };

  const setDemoAccount = (user: string, pass: string) => {
    setUsername(user);
    setPassword(pass);
    setError('');
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      width: '100%',
      background: 'radial-gradient(circle at 10% 20%, rgba(216,174,71,0.15) 0%, var(--bg-page) 90.2%)',
      padding: '24px',
      boxSizing: 'border-box'
    }}>
      <div className="glass-card" style={{
        width: '100%',
        maxWidth: '440px',
        padding: '40px',
        boxShadow: 'var(--shadow-lg), var(--shadow-neon)',
        border: '1px solid var(--border-hair)',
        borderRadius: 'var(--radius-lg)',
        position: 'relative',
        overflow: 'hidden'
      }}>
        {/* Glow Element */}
        <div style={{
          position: 'absolute',
          top: '-150px',
          right: '-150px',
          width: '300px',
          height: '300px',
          borderRadius: '50%',
          background: 'rgba(216,174,71,0.15)',
          filter: 'blur(60px)',
          zIndex: 0
        }} />

        <div style={{ position: 'relative', zIndex: 1 }}>
          
          {/* Logo Header */}
          <div style={{ textAlign: 'center', marginBottom: '32px' }}>
            {/* The real mark, not a letter tile. This was a 52px square showing "S"
                on a gold gradient — a stand-in that no longer matched the brand once
                the flame logo existed. BrandLogo renders the same SVG as the sidebar. */}
            <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
              <BrandLogo size="lg" showSubtext={false} />
            </div>
            <h1 style={{ fontSize: '24px', fontWeight: 800, fontFamily: 'var(--font-display)', marginBottom: '6px', color: 'var(--text-primary)' }}>Sumeru Audit Suite</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>Field Audit Planning & Operations Management</p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            
            {/*
              Amber, not red, and worded as a fact rather than a failure: nothing went wrong, a
              session simply ran out. It sits above the sign-in error because it explains the state
              the person arrived in, while the error below explains what just happened when they
              pressed the button.
            */}
            {signedOutReason && !error && (
              <div style={{
                background: 'rgba(216, 174, 71, 0.12)',
                border: '1px solid rgba(216, 174, 71, 0.35)',
                color: 'var(--text-primary)',
                padding: '12px 16px',
                borderRadius: 'var(--radius-md)',
                fontSize: '13px',
                lineHeight: 1.5,
                display: 'flex',
                alignItems: 'flex-start',
                gap: '8px'
              }}>
                <span aria-hidden="true">🔒</span>
                <span>
                  {signedOutReason === 'expired_save' ? (
                    <>
                      <strong>You were signed out before your last change could be saved.</strong>
                      {' '}Your sign-in timed out, so that change was not saved and you will need to
                      enter it again. Please sign in below — we will take you straight back to the
                      page you were on.
                    </>
                  ) : (
                    <>
                      <strong>You were signed out because you had been away for a while.</strong>
                      {' '}Nothing has been lost. Please sign in below — we will take you straight
                      back to the page you were on.
                    </>
                  )}
                </span>
              </div>
            )}

            {error && (
              <div style={{
                background: 'rgba(239, 68, 68, 0.12)',
                border: '1px solid rgba(239, 68, 68, 0.3)',
                color: '#ef4444',
                padding: '12px 16px',
                borderRadius: 'var(--radius-md)',
                fontSize: '13px',
                lineHeight: 1.4,
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}>
                <span style={{ fontWeight: 700 }}>⚠️</span>
                <span>{error}</span>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)' }}>Username or Email</label>
              <input 
                type="text"
                required
                autoCapitalize="none"
                autoCorrect="off"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter username or email"
                style={{
                  padding: '12px 16px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  outline: 'none',
                  transition: 'border var(--transition-fast)'
                }}
                onFocus={(e) => e.target.style.borderColor = 'var(--accent-primary)'}
                onBlur={(e) => e.target.style.borderColor = 'var(--border-color)'}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)' }}>Password</label>
              </div>
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                <input 
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter password"
                  style={{
                    width: '100%',
                    padding: '12px 42px 12px 16px',
                    background: 'var(--bg-secondary)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 'var(--radius-md)',
                    color: 'var(--text-primary)',
                    fontSize: '14px',
                    outline: 'none',
                    transition: 'border var(--transition-fast)'
                  }}
                  onFocus={(e) => e.target.style.borderColor = 'var(--accent-primary)'}
                  onBlur={(e) => e.target.style.borderColor = 'var(--border-color)'}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  style={{
                    position: 'absolute',
                    right: '12px',
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    fontSize: '14px',
                    cursor: 'pointer',
                    padding: '4px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}
                  title={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? '👁️' : '🙈'}
                </button>
              </div>
            </div>

            <button 
              type="submit" 
              disabled={isLoading}
              className="btn btn-primary"
              style={{
                padding: '12px',
                fontWeight: 600,
                fontSize: '15px',
                marginTop: '10px',
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px'
              }}
            >
              {isLoading ? (
                <>
                  <span style={{
                    display: 'inline-block',
                    width: '16px',
                    height: '16px',
                    border: '2px solid currentColor',
                    borderRightColor: 'transparent',
                    borderRadius: '50%',
                    animation: 'spin 0.75s linear infinite'
                  }} />
                  <span>Authenticating...</span>
                </>
              ) : (
                'Sign In'
              )}
            </button>

          </form>

          {/*
            Quick-demo login buttons removed. They shipped clickable super-admin, ops-manager
            and HR-manager credentials on every build (admin/admin123 etc.) that filled the
            form with the real seeded accounts — a one-click privileged sign-in on the public
            login page. Kept only behind the dev flag so local work still has the convenience.
          */}
          {import.meta.env.DEV && (
            <div style={{ marginTop: '28px', paddingTop: '20px', borderTop: '1px dashed var(--border-color)' }}>
              <p style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '10px', textAlign: 'center' }}>
                Quick Demo Login (dev only):
              </p>
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
                {/*
                  These must match the accounts the seed actually creates
                  (`infrastructure/database/seed.ts`): admin, admin2, manager, executive, validator —
                  all on `admin123`. Two of these buttons used to prefill `ops_manager`/`ops123` and
                  `hr_manager`/`hr123`, users that have never existed, so the only thing they did was
                  produce "Invalid credentials".
                */}
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => setDemoAccount('admin', 'admin123')} style={{ fontSize: '11px', padding: '4px 10px' }}>Super Admin</button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => setDemoAccount('manager', 'admin123')} style={{ fontSize: '11px', padding: '4px 10px' }}>Ops Manager</button>
                <button type="button" className="btn btn-sm btn-secondary" onClick={() => setDemoAccount('validator', 'admin123')} style={{ fontSize: '11px', padding: '4px 10px' }}>Validator</button>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
};
