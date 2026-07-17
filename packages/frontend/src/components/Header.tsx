import React, { useEffect, useState } from 'react';
import { Search, Bell, LogOut, ChevronDown, Building2, Server } from 'lucide-react';
import { api } from '../services/api';

interface HeaderProps {
  onLogout?: () => void;
  title?: string;
}

export const Header: React.FC<HeaderProps> = ({ onLogout, title = 'Dashboard' }) => {
  const [isLive, setIsLive] = useState(api.isLive);

  useEffect(() => {
    return api.subscribe(setIsLive);
  }, []);

  return (
    <header className="header-area" style={{ 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'space-between', 
      padding: '0 32px',
      height: '100%'
    }}>
      {/* Page Title / Context */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
        <h2 style={{ fontSize: '20px', fontWeight: 700, fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}>
          {title}
        </h2>

        {/* Database Live/Mock Mode Indicator */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 10px',
          borderRadius: 'var(--radius-full)',
          fontSize: '11px',
          fontWeight: 600,
          background: isLive ? 'var(--status-active-bg)' : 'rgba(251, 191, 36, 0.1)',
          color: isLive ? 'var(--status-active)' : 'var(--status-pending)',
          border: `1px solid ${isLive ? 'rgba(16, 185, 129, 0.2)' : 'rgba(251, 191, 36, 0.2)'}`
        }}>
          <Server size={12} />
          <span>{isLive ? 'Live Database Mode' : 'Sandbox Demo Mode'}</span>
        </div>
        
        {/* Quick Organization Selector */}
        <div style={{ 
          display: 'flex', 
          alignItems: 'center', 
          gap: '8px', 
          background: 'var(--bg-tertiary)',
          padding: '6px 12px',
          borderRadius: 'var(--radius-sm)',
          fontSize: '12px',
          fontWeight: 500,
          border: '1px solid var(--border-color)',
          color: 'var(--text-secondary)'
        }}>
          <Building2 size={14} />
          <span>Axis Bank Project</span>
          <ChevronDown size={12} />
        </div>
      </div>

      {/* Global Search & Actions Area */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '24px' }}>
        
        {/* Search Input (Part 10 §12) */}
        <div style={{ position: 'relative', width: '300px' }}>
          <Search size={16} style={{ 
            position: 'absolute', 
            left: '12px', 
            top: '50%', 
            transform: 'translateY(-50%)',
            color: 'var(--text-muted)'
          }} />
          <input 
            type="text" 
            placeholder="Search branches, assayers, projects..." 
            style={{
              width: '100%',
              padding: '8px 12px 8px 36px',
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-primary)',
              fontSize: '13px',
              outline: 'none',
              transition: 'all var(--transition-fast)'
            }}
            onFocus={(e) => {
              e.target.style.borderColor = 'var(--accent-primary)';
              e.target.style.boxShadow = 'var(--shadow-neon)';
            }}
            onBlur={(e) => {
              e.target.style.borderColor = 'var(--border-color)';
              e.target.style.boxShadow = 'none';
            }}
          />
        </div>

        {/* Action Controls */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', borderLeft: '1px solid var(--border-color)', paddingLeft: '24px' }}>
          
          {/* Notifications Bell */}
          <button style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            position: 'relative',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '6px',
            borderRadius: 'var(--radius-sm)',
            transition: 'background var(--transition-fast)'
          }}
          onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-tertiary)'}
          onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
          >
            <Bell size={18} />
            <span style={{
              position: 'absolute',
              top: '4px',
              right: '4px',
              width: '8px',
              height: '8px',
              background: 'var(--status-cancelled)',
              borderRadius: 'var(--radius-full)'
            }} />
          </button>

          {/* Logout Button */}
          <button 
            onClick={onLogout}
            style={{
              background: 'rgba(239, 68, 68, 0.1)',
              border: '1px solid rgba(239, 68, 68, 0.2)',
              color: 'var(--status-cancelled)',
              padding: '8px 12px',
              borderRadius: 'var(--radius-md)',
              fontSize: '13px',
              fontWeight: 500,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              transition: 'all var(--transition-fast)'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'var(--status-cancelled)';
              e.currentTarget.style.color = '#fff';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)';
              e.currentTarget.style.color = 'var(--status-cancelled)';
            }}
          >
            <LogOut size={14} />
            <span>Logout</span>
          </button>
        </div>

      </div>
    </header>
  );
};
