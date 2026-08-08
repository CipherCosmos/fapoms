import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { LayoutList, MessagesSquare } from 'lucide-react';

/**
 * The shell the data-entry & validation pages sit in.
 *
 * Three roles — data-entry head, validation manager, validator — used to share one
 * undifferentiated board. Each concern is now a page with its own URL. The board itself remains
 * the intake/processing view; the clarifications worklist is the cross-case queue the board
 * never had. Authority within a case (who may approve vs submit to the client) is enforced in
 * the case workspace, so every role can reach these pages but sees the controls its role allows.
 */

const PAGES = [
  { to: '/data-entry', end: true, label: 'Board', icon: LayoutList },
  { to: '/data-entry/clarifications', label: 'Clarifications', icon: MessagesSquare },
] as const;

export const DataEntryLayout: React.FC = () => (
  <div style={{ padding: '20px 24px', maxWidth: 1500 }}>
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Data Entry & Validation</h1>
      <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Received audits, OCR processing, and the assayer chat.</span>
    </div>

    <nav style={{ display: 'flex', gap: 4, margin: '18px 0', flexWrap: 'wrap', borderBottom: '1px solid var(--border-color)' }}>
      {PAGES.map((p) => {
        const Icon = p.icon;
        return (
          <NavLink
            key={p.to}
            to={p.to}
            end={'end' in p ? p.end : false}
            style={({ isActive }) => ({
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '9px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer', textDecoration: 'none',
              borderBottom: `2px solid ${isActive ? 'var(--accent)' : 'transparent'}`,
              color: isActive ? 'var(--accent)' : 'var(--text-muted)',
            })}
          >
            <Icon size={14} /> {p.label}
          </NavLink>
        );
      })}
    </nav>

    <Outlet />
  </div>
);
