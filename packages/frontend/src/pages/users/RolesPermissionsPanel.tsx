import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Shield, Users as UsersIcon } from 'lucide-react';
import { api } from '../../services/api';

/**
 * The real RBAC model, made visible.
 *
 * Before this, assigning a role to a user was a checkbox with just a name on
 * it — nothing showed what that role actually grants. This groups each role's
 * real permission rows (resource × action × scope, as `PermissionsGuard`
 * evaluates them) so "what can this role do" has an actual answer instead of
 * requiring someone to read the migration files.
 *
 * Deliberately read-only: permissions are enforced by `@RequirePermissions`
 * decorators in the backend code, not by a row a UI could toggle at runtime —
 * offering an edit control here would show a control that changes nothing.
 */

interface Permission { id: string; resource: string; action: string; scope: string; description: string | null }
interface RoleRow { id: string; name: string; displayName: string; description: string | null; permissions: Permission[] }
interface UserRow { id: string; roles: { id: string }[] }

const SCOPE_TONE: Record<string, string> = {
  PLATFORM: 'var(--danger)', ORGANIZATION: 'var(--accent)', CLIENT: 'var(--accent)',
  SELF: 'var(--success)', ASSIGNED_RECORDS: 'var(--warning)', DEPARTMENT: 'var(--accent)', TEAM: 'var(--accent)', STATE: 'var(--accent)', REGION: 'var(--accent)',
};

const label: React.CSSProperties = {
  fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)',
};
const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)',
  borderRadius: '10px', overflow: 'hidden',
};

export const RolesPermissionsPanel: React.FC = () => {
  const { data: rolesRes, isLoading } = useQuery({
    queryKey: ['users', 'roles', 'full'],
    queryFn: () => api.request<RoleRow[]>('/users/roles'),
  });
  const { data: usersRes } = useQuery({
    queryKey: ['users', 'all', 'for-role-counts'],
    // Match DirectoryPanel: the default 20-row page would undercount every role's holder tally.
    queryFn: () => api.request<UserRow[]>('/users?limit=500'),
  });

  const roles = (Array.isArray(rolesRes) ? rolesRes : (rolesRes as any)?.data) || [];
  // Memoized so `holderCount` (a Map over every user × their roles) is rebuilt only when the user list
  // changes — not on every render, e.g. each time a role row is expanded.
  const users = useMemo(() => (Array.isArray(usersRes) ? usersRes : (usersRes as any)?.data) || [], [usersRes]);

  const holderCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const u of users) for (const r of u.roles ?? []) m.set(r.id, (m.get(r.id) ?? 0) + 1);
    return m;
  }, [users]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  if (isLoading) return <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading roles…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: 0 }}>
        Every role and exactly what it grants. This is a read view of the same permission rows
        <code style={{ margin: '0 4px' }}>PermissionsGuard</code> checks on every request — assign a role to
        change what someone can do, from the Directory tab.
      </p>

      {roles.map((role: RoleRow) => {
        const isOpen = expanded.has(role.id);
        const grouped = new Map<string, Permission[]>();
        for (const p of role.permissions ?? []) {
          if (!grouped.has(p.resource)) grouped.set(p.resource, []);
          grouped.get(p.resource)!.push(p);
        }
        const resources = [...grouped.keys()].sort();

        return (
          <div key={role.id} style={card}>
            <button
              onClick={() => toggle(role.id)}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '13px 16px',
                background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'inherit',
              }}
            >
              {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
              <Shield size={16} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13.5px', fontWeight: 700 }}>{role.displayName || role.name.replace(/_/g, ' ')}</div>
                {role.description && <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '1px' }}>{role.description}</div>}
              </div>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11.5px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                <UsersIcon size={12} /> {holderCount.get(role.id) ?? 0}
              </span>
              <span style={{ ...label, whiteSpace: 'nowrap' }}>{(role.permissions ?? []).length} grants</span>
            </button>

            {isOpen && (
              <div style={{ padding: '4px 16px 14px', borderTop: '1px solid var(--border-color)' }}>
                {resources.length === 0 ? (
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', padding: '10px 0' }}>No permissions granted.</div>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '10px', marginTop: '8px' }}>
                    {resources.map((res) => (
                      <div key={res} style={{ padding: '9px 10px', borderRadius: '8px', background: 'var(--bg-surface-2)' }}>
                        <div style={{ ...label, marginBottom: '6px' }}>{res.replace(/_/g, ' ')}</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                          {grouped.get(res)!.map((p) => (
                            <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '8px', fontSize: '11.5px' }}>
                              <span>{p.action}</span>
                              <span style={{ color: SCOPE_TONE[p.scope] ?? 'var(--text-muted)', fontWeight: 600 }}>{p.scope}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default RolesPermissionsPanel;
