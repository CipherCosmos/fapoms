import React from 'react';
import { LogOut } from 'lucide-react';
import { NotificationDropdown } from './NotificationDropdown';

interface HeaderProps {
  onLogout?: () => void;
  title?: string;
}

export const Header: React.FC<HeaderProps> = ({ onLogout }) => {
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
      <div style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-secondary)' }}>
        FAPOMS
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <NotificationDropdown />
        <button
          onClick={onLogout}
          style={{
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.15)',
            color: '#ef4444',
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
