import React from 'react';

interface PageHeaderProps {
  /** Optional page glyph, shown in a tinted chip to the left of the title. */
  icon?: React.ReactNode;
  title: string;
  /** One plain sentence saying what the page is for. Kept short. */
  subtitle?: string;
  /** Right-aligned action cluster (Refresh, Add…, etc.). */
  actions?: React.ReactNode;
}

/**
 * The one page header used across the app.
 *
 * Every page used to hand-roll its own title block — 24px display here, 20px there, a 16px h3
 * somewhere else, some with an icon, some not — so moving between pages felt like moving between
 * apps. This gives them all one shape: a tinted icon chip, the title in the display face, a short
 * subtitle, and the page's actions on the right. Consistent, and quieter than the dashboard hero,
 * which stays special.
 */
export const PageHeader: React.FC<PageHeaderProps> = ({ icon, title, subtitle, actions }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 14 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      {icon && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 36, height: 36,
          borderRadius: 'var(--radius-md)', color: 'var(--accent)', flexShrink: 0,
          background: 'color-mix(in srgb, var(--accent) 13%, transparent)',
        }}>{icon}</span>
      )}
      <div style={{ minWidth: 0 }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, fontFamily: 'var(--font-display)', lineHeight: 1.15, letterSpacing: '-0.3px' }}>
          {title}
        </h1>
        {subtitle && (
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '3px 0 0', lineHeight: 1.45 }}>{subtitle}</p>
        )}
      </div>
    </div>
    {actions && <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>{actions}</div>}
  </div>
);

export default PageHeader;
