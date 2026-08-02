import React from 'react';
import { useLocation } from 'react-router-dom';
import { LogOut, Wifi, WifiOff } from 'lucide-react';
import { NotificationDropdown } from './NotificationDropdown';
import { ThemePicker } from './ThemePicker';
import { useSocketConnection } from '../hooks/useSocketConnection';

interface HeaderProps {
  onLogout?: () => void;
  title?: string;
}

const BREADCRUMBS: { prefix: string; category: string; label: string }[] = [
  { prefix: '/dashboard', category: 'Overview', label: 'Dashboard' },
  { prefix: '/executive-map', category: 'Overview', label: 'Command Room' },
  { prefix: '/projects', category: 'Operations', label: 'Projects' },
  { prefix: '/planning', category: 'Operations', label: 'Stage 1: Planning' },
  { prefix: '/scheduling', category: 'Operations', label: 'Stage 2: Schedule Dispatch' },
  { prefix: '/assignments', category: 'Operations', label: 'Stage 3: Field Execution' },
  { prefix: '/clients', category: 'Management', label: 'Clients' },
  { prefix: '/billing', category: 'Management', label: 'Billing' },
  { prefix: '/branches', category: 'Management', label: 'Branches' },
  { prefix: '/hr', category: 'Management', label: 'Workforce' },
  { prefix: '/documents', category: 'Management', label: 'Documents' },
  { prefix: '/data-entry', category: 'Management', label: 'Data Entry & Validation' },
  { prefix: '/holidays', category: 'Administration', label: 'Holiday Calendar' },
  { prefix: '/rules', category: 'Administration', label: 'Rule Engine' },
  { prefix: '/users', category: 'Administration', label: 'User Management' },
];

export const Header: React.FC<HeaderProps> = ({ onLogout, title }) => {
  const location = useLocation();
  const live = useSocketConnection();

  const match = BREADCRUMBS.find((b) => location.pathname.startsWith(b.prefix));

  return (
    <header style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 24px',
      height: '48px',
      borderBottom: '1px solid var(--border-color)',
      background: 'var(--bg-secondary)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, overflow: 'hidden' }}>
        {match ? (
          <>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>{match.category}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>/</span>
            <span style={{ fontSize: '13px', fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--accent)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {title || match.label}
            </span>
          </>
        ) : (
          <span style={{ fontSize: '15px', fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--accent)', whiteSpace: 'nowrap' }}>
            Sumeru Audit Suite
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <div
          title={live ? 'Live updates connected' : 'Live updates disconnected'}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '4px 8px', borderRadius: 'var(--radius-full)',
            fontSize: '11px', fontWeight: 600,
            background: live ? 'var(--status-active-bg)' : 'var(--status-cancelled-bg)',
            color: live ? 'var(--success)' : 'var(--danger)',
            whiteSpace: 'nowrap',
          }}
        >
          {live ? <Wifi size={12} /> : <WifiOff size={12} />}
          {live ? 'Live' : 'Offline'}
        </div>
        <ThemePicker />
        <NotificationDropdown />
        <button
          onClick={onLogout}
          style={{
            background: 'var(--status-cancelled-bg)',
            border: '1px solid var(--border-color)',
            color: 'var(--danger)',
            padding: '6px 10px',
            borderRadius: 'var(--radius-sm)',
            fontSize: '12px',
            fontWeight: 500,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          <LogOut size={12} />
          <span>Logout</span>
        </button>
      </div>
    </header>
  );
};
