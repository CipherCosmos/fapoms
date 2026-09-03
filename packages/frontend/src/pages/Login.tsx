import React, { useState } from 'react';
import { ShieldCheck, MapPinned, FileCheck2, Eye, EyeOff, ArrowRight, AlertTriangle, Clock } from 'lucide-react';
import { BrandLogo } from '../components/BrandLogo';
import { fetchWithTimeout } from '../services/http';
import { consumeSignedOutReason } from '../services/session';

interface LoginProps {
  onLoginSuccess: (accessToken: string, refreshToken: string) => void;
}

/**
 * The front door.
 *
 * Two panels: what this system is on the left, the sign-in on the right. The previous version was
 * a single floating card on an empty page, which said nothing about what the person was signing
 * in to — this screen is reached by bank staff, field assayers and client users, several of whom
 * meet it before they have been told what the product is called.
 *
 * The left panel is decoration in the sense that removing it loses no capability, and not in the
 * sense that it can be sloppy: it is the only place the product introduces itself. It collapses
 * below 900px rather than shrinking, because a field assayer on a phone wants the password box
 * above the fold and nothing else.
 *
 * Everything behind the form is unchanged and deliberately so — the bounded fetch, the two
 * signed-out wordings, the dev-only quick login. This is a presentation change; the one place it
 * touches behaviour is the autocomplete attributes, which were missing and which password
 * managers need to offer a saved credential at all.
 */

/**
 * Responsive rules and focus states, as a stylesheet rather than inline styles.
 *
 * Inline styles cannot express a media query or `:focus-visible`, and both matter here: the panel
 * has to collapse on a phone, and a keyboard user has to be able to see which box they are in.
 * Scoped by a `lg-` prefix so nothing here can reach the rest of the app.
 */
const STYLES = `
.lg-split { display: flex; min-height: 100vh; width: 100%; }
.lg-brand {
  flex: 1.05; display: flex; flex-direction: column; justify-content: space-between;
  padding: 48px; box-sizing: border-box; position: relative; overflow: hidden;
  background:
    radial-gradient(circle at 15% 15%, rgba(216,174,71,0.22) 0%, transparent 45%),
    radial-gradient(circle at 85% 85%, rgba(216,174,71,0.10) 0%, transparent 50%),
    var(--bg-secondary);
  border-right: 1px solid var(--border-hair);
}
.lg-form-side {
  flex: 1; display: flex; align-items: center; justify-content: center;
  padding: 32px 24px; box-sizing: border-box; background: var(--bg-page);
}
.lg-form { width: 100%; max-width: 400px; }
.lg-input {
  width: 100%; box-sizing: border-box; padding: 12px 14px;
  background: var(--bg-secondary); border: 1px solid var(--border-color);
  border-radius: var(--radius-md); color: var(--text-primary); font-size: 14px;
  outline: none; transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}
.lg-input:focus { border-color: var(--accent-primary); box-shadow: 0 0 0 3px rgba(216,174,71,0.18); }
.lg-input::placeholder { color: var(--text-secondary); opacity: 0.65; }
.lg-point { display: flex; gap: 14px; align-items: flex-start; }
.lg-eye {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  background: none; border: none; color: var(--text-secondary); cursor: pointer;
  padding: 8px; display: flex; align-items: center; border-radius: var(--radius-sm);
}
.lg-eye:hover { color: var(--text-primary); }
@media (max-width: 900px) {
  .lg-brand { display: none; }
  .lg-split { display: block; }
  .lg-form-side { min-height: 100vh; }
}
`;

/** What this system is, for the person who has not been told. Three, because four is a brochure. */
const POINTS = [
  {
    icon: ShieldCheck,
    title: 'Audited end to end',
    body: 'Every assignment, valuation and payment carries a trail of who did what, and when.',
  },
  {
    icon: MapPinned,
    title: 'Built for the field',
    body: 'Planning, routing and on-site capture for assayers working across branches.',
  },
  {
    icon: FileCheck2,
    title: 'Verified records',
    body: 'Documents, identity checks and reports held to one standard from intake to sign-off.',
  },
];

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
    } catch {
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
    <>
      <style>{STYLES}</style>
      <div className="lg-split">

        {/* ---------- Left: what this is ---------- */}
        <aside className="lg-brand">
          <div style={{ position: 'relative', zIndex: 1 }}>
            <BrandLogo size="lg" showSubtext={false} />
          </div>

          <div style={{ position: 'relative', zIndex: 1, maxWidth: 460 }}>
            <h1 style={{
              fontFamily: 'var(--font-display)', fontSize: 38, lineHeight: 1.15, fontWeight: 800,
              color: 'var(--text-primary)', margin: '0 0 14px',
            }}>
              Field audit operations,<br />under one record.
            </h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: 15, lineHeight: 1.6, margin: '0 0 36px' }}>
              Plan the work, send the right assayer, capture what they find, and keep the evidence
              together — from the branch visit to the signed report.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
              {POINTS.map(({ icon: Icon, title, body }) => (
                <div className="lg-point" key={title}>
                  <div style={{
                    flexShrink: 0, width: 38, height: 38, borderRadius: 10,
                    background: 'rgba(216,174,71,0.14)', border: '1px solid rgba(216,174,71,0.28)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: 'var(--accent-primary)',
                  }}>
                    <Icon size={18} />
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)', marginBottom: 3 }}>
                      {title}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                      {body}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ position: 'relative', zIndex: 1, fontSize: 12, color: 'var(--text-secondary)' }}>
            Sumeru Global · Field Audit Operations
          </div>
        </aside>

        {/* ---------- Right: the sign-in ---------- */}
        <main className="lg-form-side">
          <div className="lg-form">
            {/* Shown only where the left panel is not: on a phone this is the only branding. */}
            <div style={{ marginBottom: 28 }} className="lg-compact-brand">
              <h2 style={{
                fontFamily: 'var(--font-display)', fontSize: 26, fontWeight: 800,
                color: 'var(--text-primary)', margin: '0 0 6px',
              }}>
                Sign in
              </h2>
              <p style={{ color: 'var(--text-secondary)', fontSize: 14, margin: 0 }}>
                Use the account your administrator issued you.
              </p>
            </div>

            <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>

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
                  padding: '12px 14px', borderRadius: 'var(--radius-md)',
                  fontSize: 13, lineHeight: 1.5, display: 'flex', alignItems: 'flex-start', gap: 10,
                }}>
                  <Clock size={16} style={{ flexShrink: 0, marginTop: 1, color: 'var(--accent-primary)' }} />
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

              {/* aria-live so a screen reader announces a failed sign-in it never saw appear. */}
              <div aria-live="polite">
                {error && (
                  <div style={{
                    background: 'rgba(239, 68, 68, 0.12)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    color: '#ef4444', padding: '12px 14px', borderRadius: 'var(--radius-md)',
                    fontSize: 13, lineHeight: 1.45, display: 'flex', alignItems: 'center', gap: 10,
                  }}>
                    <AlertTriangle size={16} style={{ flexShrink: 0 }} />
                    <span>{error}</span>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <label htmlFor="lg-username" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
                  Username or email
                </label>
                <input
                  id="lg-username"
                  className="lg-input"
                  type="text"
                  required
                  autoCapitalize="none"
                  autoCorrect="off"
                  // Missing before, which is why saved credentials were never offered.
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="you@sumeruglobal.in"
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <label htmlFor="lg-password" style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
                  Password
                </label>
                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                  <input
                    id="lg-password"
                    className="lg-input"
                    style={{ paddingRight: 44 }}
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                  />
                  <button
                    type="button"
                    className="lg-eye"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    title={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="btn btn-primary"
                style={{
                  padding: '13px', fontWeight: 600, fontSize: 15, marginTop: 6, width: '100%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 9,
                }}
              >
                {isLoading ? (
                  <>
                    <span style={{
                      display: 'inline-block', width: 16, height: 16,
                      border: '2px solid currentColor', borderRightColor: 'transparent',
                      borderRadius: '50%', animation: 'spin 0.75s linear infinite',
                    }} />
                    <span>Signing in…</span>
                  </>
                ) : (
                  <>
                    <span>Sign in</span>
                    <ArrowRight size={17} />
                  </>
                )}
              </button>
            </form>

            {/*
              Quick-demo login buttons stay behind the dev flag. They shipped clickable super-admin,
              ops-manager and HR-manager credentials on every build (admin/admin123 etc.) that filled
              the form with the real seeded accounts — a one-click privileged sign-in on the public
              login page.
            */}
            {import.meta.env.DEV && (
              <div style={{ marginTop: 26, paddingTop: 18, borderTop: '1px dashed var(--border-color)' }}>
                <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10, textAlign: 'center' }}>
                  Quick demo login (development only)
                </p>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
                  {/*
                    These must match the accounts the seed actually creates
                    (`infrastructure/database/seed.ts`): admin, admin2, manager, executive, validator —
                    all on `admin123`.
                  */}
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => setDemoAccount('admin', 'admin123')} style={{ fontSize: 11, padding: '4px 10px' }}>Super Admin</button>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => setDemoAccount('manager', 'admin123')} style={{ fontSize: 11, padding: '4px 10px' }}>Ops Manager</button>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => setDemoAccount('validator', 'admin123')} style={{ fontSize: 11, padding: '4px 10px' }}>Validator</button>
                </div>
              </div>
            )}
          </div>
        </main>
      </div>
    </>
  );
};
