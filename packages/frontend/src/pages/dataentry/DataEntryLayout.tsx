import React from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { LayoutDashboard, Inbox, ClipboardCheck, MessagesSquare } from 'lucide-react';

/**
 * The shell the data-entry & validation pages sit in.
 *
 * One page used to hold the whole desk inline — every packet, every case, every
 * control — which stops working the moment the desk holds more rows than a screen.
 * The desk is now a small app: an Overview of aggregates (each number linking into
 * the queue it summarises), server-paginated Packets and Reviews queues, and the
 * cross-case Clarifications worklist. The case workspace lives on its own URL
 * (/data-entry/case/:branchId) so any row anywhere can deep-link to it. Authority
 * (who may assign, decide, submit) is enforced per page and in the workspace.
 */

const PAGES = [
  { to: '/data-entry', end: true, label: 'Overview', icon: LayoutDashboard },
  { to: '/data-entry/packets', label: 'Packets', icon: Inbox },
  { to: '/data-entry/reviews', label: 'Reviews', icon: ClipboardCheck },
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
