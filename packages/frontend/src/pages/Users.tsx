import React, { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { UsersRound, ShieldCheck, Activity as ActivityIcon } from 'lucide-react';
import { DirectoryPanel } from './users/DirectoryPanel';
import { RolesPermissionsPanel } from './users/RolesPermissionsPanel';
import { ActivityFeed } from './users/ActivityFeed';
import { canReadAuditLog, useCurrentRoles } from '../hooks/useCurrentRoles';
import { PageHeader } from '../components/ui';
import { Page } from '../components/ui/Page';

/**
 * User administration, as three views of the same IAM model rather than a
 * single flat table: who has access (Directory), what each role actually
 * grants (Roles & Permissions — previously invisible), and what has actually
 * happened (Activity — a real audit trail that existed in the database the
 * whole time with no route to read it back).
 */

const TABS = [
  { key: 'directory', label: 'Staff list', icon: UsersRound },
  { key: 'roles', label: 'Roles & Permissions', icon: ShieldCheck },
  { key: 'activity', label: 'Activity', icon: ActivityIcon },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export const Users: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const [fallbackTab, setFallbackTab] = useState<TabKey>('directory');
  // The Activity tab reads `/audit-log/*` (ADMIN, AUDITOR by name). A custom role granted user:view
  // opens this page; the tab it could only get a 403 from is not offered to it.
  const canAudit = canReadAuditLog(useCurrentRoles());
  const tabs = TABS.filter((t) => t.key !== 'activity' || canAudit);
  const requested = (params.get('tab') as TabKey) || fallbackTab;
  const tab: TabKey = tabs.some((t) => t.key === requested) ? requested : 'directory';
  const setTab = (t: TabKey) => { setFallbackTab(t); setParams(t === 'directory' ? {} : { tab: t }, { replace: true }); };

  return (
    <Page>
      {/*
        One band, not three. The title, its explanation and the tabs used to stack into roughly a
        third of the screen before a single account appeared — `compact` is the density the rest of
        the product's consoles already use, and the subtitle says what this page is NOT (the
        assayer workforce lives elsewhere), which is worth one short line rather than two.
      */}
      <PageHeader
        compact
        icon={<UsersRound size={18} />}
        title="People & access"
        subtitle="Staff accounts and what they can do. The assayer workforce lives under Workforce."
      />

      <nav style={{ display: 'flex', gap: '2px', borderBottom: '1px solid var(--border-color)' }}>
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          const title = t.key === 'directory'
            ? 'View and manage internal staff user accounts, statuses, and permissions'
            : t.key === 'roles'
            ? 'Inspect role definitions, assigned capabilities, and access rights'
            : 'Review chronological system audit trail and user access history';
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              title={title}
              style={{
                display: 'flex', alignItems: 'center', gap: '7px', padding: '10px 16px',
                fontSize: 'var(--text-sm)', fontWeight: 600, cursor: 'pointer', background: 'none', border: 'none',
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
    </Page>
  );
};

export default Users;
