import React from 'react';
import { Lock } from 'lucide-react';
import { BrandLogo } from '../../components/BrandLogo';

/**
 * THE FRAME EVERY PAGE A STRANGER SEES IS DRAWN IN.
 *
 * Lived inside `PublicRegistration.tsx` while the candidate form was the only page reachable
 * without signing in. When staff gained an emailed "choose your password" link — a second page
 * with no account behind it — the choice was to copy the masthead and the stylesheet, or to move
 * them here. Two copies of a company header is how two headers start to differ.
 */

export const FORM_CSS = `
.pub-reg-root input::placeholder,
.pub-reg-root textarea::placeholder {
  color: var(--text-muted) !important;
  opacity: 1 !important;
}
.pub-reg-root input,
.pub-reg-root select,
.pub-reg-root textarea {
  border-color: var(--border-color) !important;
  color: var(--text-primary) !important;
  background: var(--bg-input) !important;
}
.pub-reg-root input:focus,
.pub-reg-root select:focus,
.pub-reg-root textarea:focus {
  border-color: var(--accent) !important;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent) !important;
}
.reg-input:focus {
  border-color: var(--accent) !important;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent) !important;
}
.reg-code-input {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace !important;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.4em;
  text-indent: 0.4em;
  text-align: center;
  font-weight: 700;
  border-width: 2px !important;
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border-color)) !important;
  background: var(--bg-surface) !important;
}
.reg-code-input:disabled {
  opacity: 0.7;
}
.reg-cat-card {
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  cursor: pointer;
  text-align: left;
  width: 100%;
  background: var(--bg-surface-2) !important;
  border: 1.5px solid var(--border-color) !important;
}
.reg-cat-card:hover {
  border-color: var(--accent) !important;
  transform: translateY(-1px);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
}
.reg-cat-selected {
  border-color: var(--accent) !important;
  background: rgba(245, 158, 11, 0.12) !important;
  box-shadow: 0 0 0 2px var(--accent) !important;
}
`;

export const PublicMasthead: React.FC = () => (
  <header className="pub-reg-header">
    <div className="pub-reg-header-inner">
      <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
        <BrandLogo size="md" showSubtext={false} />
        <div style={{ borderLeft: '1px solid var(--border-hair)', paddingLeft: '14px', display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 'var(--text-xs)', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--accent)' }}>
            Appraiser Onboarding Portal
          </span>
          <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)' }}>
            Sumeru Global &middot; Bullion &amp; Collateral Verification
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'var(--bg-surface-2)', padding: '5px 10px', borderRadius: '6px', fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)' }}>
          <Lock size={12} style={{ color: 'var(--success)' }} />
          <span>Secure Session</span>
        </div>
      </div>
    </div>
  </header>
);

/** The whole frame: stylesheet, masthead, and a centred column to put a card in. */
export const PublicShell: React.FC<{ children: React.ReactNode; maxWidth?: string }> = ({
  children, maxWidth = '760px',
}) => (
  <div className="pub-reg-root">
    <style>{FORM_CSS}</style>
    <PublicMasthead />
    <div className="pub-reg-container" style={{ maxWidth }}>
      {children}
    </div>
  </div>
);

export default PublicShell;
