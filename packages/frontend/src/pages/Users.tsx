import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { UsersRound, ShieldCheck, Activity as ActivityIcon } from 'lucide-react';
import { DirectoryPanel } from './users/DirectoryPanel';
import { RolesPermissionsPanel } from './users/RolesPermissionsPanel';
import { ActivityFeed } from './users/ActivityFeed';
import { PageHeader } from '../components/ui';

/**
 * User administration, as three views of the same IAM model rather than a
 * single flat table: who has access (Directory), what each role actually
 * grants (Roles & Permissions — previously invisible), and what has actually
 * happened (Activity — a real audit trail that existed in the database the
 * whole time with no route to read it back).
 */

const TABS = [
  { key: 'directory', label: 'Directory', icon: UsersRound },
  { key: 'roles', label: 'Roles & Permissions', icon: ShieldCheck },
  { key: 'activity', label: 'Activity', icon: ActivityIcon },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export const Users: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const [fallbackTab, setFallbackTab] = useState<TabKey>('directory');
  const tab = (params.get('tab') as TabKey) || fallbackTab;
  const setTab = (t: TabKey) => { setFallbackTab(t); setParams(t === 'directory' ? {} : { tab: t }, { replace: true }); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px' }}>
      <PageHeader
        icon={<UsersRound size={20} />}
        title="User Administration"
        subtitle="Staff accounts, roles, and access — not the assayer workforce, which lives under Workforce."
      />

      <nav style={{ display: 'flex', gap: '2px', borderBottom: '1px solid var(--border-color)' }}>
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                display: 'flex', alignItems: 'center', gap: '7px', padding: '10px 16px',
                fontSize: '13px', fontWeight: 600, cursor: 'pointer', background: 'none', border: 'none',
                color: active ? 'var(--accent-primary)' : 'var(--text-muted)',
                borderBottom: `2px solid ${active ? 'var(--accent-primary)' : 'transparent'}`,
              }}
            >
              <Icon size={15} /> {t.label}
            </button>
          );
        })}
      </nav>

      {tab === 'directory' && <DirectoryPanel />}
      {tab === 'roles' && <RolesPermissionsPanel />}
      {tab === 'activity' && <ActivityFeed />}
    </div>
  );
};

export default Users;
