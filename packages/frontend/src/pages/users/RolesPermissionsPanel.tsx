import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Shield, Users as UsersIcon, Plus, Trash2, Save, Lock, Info, X } from 'lucide-react';
import { SystemRole } from '@fapoms/shared';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { Modal, AlertBanner } from '../../components/ui';
import { useCurrentRoles } from '../../hooks/useCurrentRoles';

/**
 * The RBAC model, editable.
 *
 * This panel used to be read-only, on the stated grounds that permissions "are enforced by
 * `@RequirePermissions` decorators in the backend code, not by a row a UI could toggle". That
 * conflated two different gates. `PermissionsGuard` builds its allow-set *from these very rows*
 * on every request — so toggling one genuinely changes what a role can do, and the cached
 * principal of everyone holding that role is invalidated server-side, so it applies in seconds
 * rather than at next sign-in.
 *
 * What a UI still cannot change is the *other* gate: `@Roles(SystemRole.X)` compares role
 * **names**, in 256 places, and the web app's route table lists the same names. Those names are
 * effectively code. Hence the split enforced by the API and surfaced here:
 *
 *   - Built-in roles  → permissions and description editable; name and existence are not.
 *   - Custom roles    → fully editable and deletable, but they satisfy permission-gated
 *                       endpoints only, which is stated plainly rather than left to be discovered.
 */

interface Permission { id: string; resource: string; action: string; scope: string; description: string | null }
interface RoleRow { id: string; name: string; displayName: string; description: string | null; permissions: Permission[]; isSystem?: boolean }
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
const input: React.CSSProperties = {
  width: '100%', padding: '9px', background: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)', borderRadius: '6px',
  color: 'var(--text-primary)', fontSize: '13px',
};

export const RolesPermissionsPanel: React.FC = () => {
  // Role editing is a super-administrator action, matching the API's own @Roles on these routes,
  // so an administrator never sees a control that would 403.
  const canEdit = useCurrentRoles().includes(SystemRole.SUPER_ADMINISTRATOR);

  const { data: rolesRes, isLoading, refetch } = useQuery({
    queryKey: ['users', 'roles', 'full'],
    queryFn: () => api.request<RoleRow[]>('/users/roles'),
  });
  const { data: permsRes } = useQuery({
    queryKey: ['users', 'permissions', 'catalogue'],
    queryFn: () => api.request<Permission[]>('/users/permissions'),
    enabled: canEdit,
  });
  const { data: usersRes } = useQuery({
    queryKey: ['users', 'all', 'for-role-counts'],
    // Match DirectoryPanel: the default 20-row page would undercount every role's holder tally.
    queryFn: () => api.request<UserRow[]>('/users?limit=500'),
  });

  const roles: RoleRow[] = (Array.isArray(rolesRes) ? rolesRes : (rolesRes as any)?.data) || [];
  const catalogue: Permission[] = (Array.isArray(permsRes) ? permsRes : (permsRes as any)?.data) || [];
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

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // ── Permission editing ────────────────────────────────────────────────────
  const [editingRole, setEditingRole] = useState<RoleRow | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (editingRole) setDraft(new Set((editingRole.permissions ?? []).map((p) => p.id)));
  }, [editingRole]);

  const dirty = useMemo(() => {
    if (!editingRole) return false;
    const original = new Set((editingRole.permissions ?? []).map((p) => p.id));
    if (original.size !== draft.size) return true;
    for (const id of draft) if (!original.has(id)) return true;
    return false;
  }, [editingRole, draft]);

  const grouped = useMemo(() => {
    const m = new Map<string, Permission[]>();
    for (const p of catalogue) {
      if (!m.has(p.resource)) m.set(p.resource, []);
      m.get(p.resource)!.push(p);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [catalogue]);

  const savePermissions = async () => {
    if (!editingRole) return;
    setSaving(true);
    setError(null);
    try {
      await api.request(`/users/roles/${editingRole.id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissionIds: [...draft] }),
      });
      setSuccess(`${editingRole.displayName || editingRole.name} now grants ${draft.size} permission(s). Holders pick this up within seconds.`);
      setEditingRole(null);
      refetch();
    } catch (err: any) {
      setError(`Could not save permissions ${userMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  // ── Create role ───────────────────────────────────────────────────────────
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDisplay, setNewDisplay] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const createRole = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      await api.request('/users/roles', {
        method: 'POST',
        body: JSON.stringify({ name: newName, displayName: newDisplay || newName, description: newDesc || undefined }),
      });
      setSuccess('Role created. Open it to grant permissions.');
      setShowCreate(false);
      setNewName(''); setNewDisplay(''); setNewDesc('');
      refetch();
    } catch (err: any) {
      setError(`Could not create the role ${userMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const deleteRole = async (role: RoleRow) => {
    if (!window.confirm(`Delete the "${role.displayName || role.name}" role?`)) return;
    setError(null);
    try {
      await api.request(`/users/roles/${role.id}`, { method: 'DELETE' });
      setSuccess('Role deleted.');
      refetch();
    } catch (err: any) {
      setError(`Could not delete the role ${userMessage(err)}`);
    }
  };

  if (isLoading) return <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading roles…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
        <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: 0, maxWidth: '70ch' }}>
          Every role and exactly what it grants. These are the same permission rows
          <code style={{ margin: '0 4px' }}>PermissionsGuard</code> checks on every request, so changing them
          takes effect for existing users within seconds — no re-login.
        </p>
        {canEdit && (
          <button onClick={() => setShowCreate(true)} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 14px', whiteSpace: 'nowrap' }}>
            <Plus size={14} /> New Role
          </button>
        )}
      </div>

      {error && <AlertBanner type="error">{error}</AlertBanner>}
      {success && <AlertBanner type="success">{success}</AlertBanner>}

      {!canEdit && (
        <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '11.5px', color: 'var(--text-muted)', padding: '10px 12px', borderRadius: '8px', background: 'var(--bg-surface-2)' }}>
          <Lock size={13} style={{ marginTop: 1, flexShrink: 0 }} />
          <span>Read-only — editing roles and permissions requires the Super Administrator role.</span>
        </div>
      )}

      {roles.map((role) => {
        const isOpen = expanded.has(role.id);
        const g = new Map<string, Permission[]>();
        for (const p of role.permissions ?? []) {
          if (!g.has(p.resource)) g.set(p.resource, []);
          g.get(p.resource)!.push(p);
        }
        const resources = [...g.keys()].sort();
        const holders = holderCount.get(role.id) ?? 0;

        return (
          <div key={role.id} style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '13px 16px' }}>
              <button
                onClick={() => toggle(role.id)}
                style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: 1, minWidth: 0, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'inherit', padding: 0 }}
              >
                {isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                <Shield size={16} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13.5px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
                    {role.displayName || role.name.replace(/_/g, ' ')}
                    {role.isSystem && (
                      <span title="Built-in role — the application's access rules refer to it by name" style={{ ...label, display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--text-muted)' }}>
                        <Lock size={10} /> BUILT-IN
                      </span>
                    )}
                  </div>
                  {role.description && <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '1px' }}>{role.description}</div>}
                </div>
              </button>

              <span style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11.5px', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                <UsersIcon size={12} /> {holders}
              </span>
              <span style={{ ...label, whiteSpace: 'nowrap' }}>{(role.permissions ?? []).length} grants</span>

              {canEdit && (
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    onClick={() => setEditingRole(role)}
                    title="Edit permissions"
                    style={{ padding: '4px 8px', background: 'rgba(216,174,71,0.1)', border: '1px solid rgba(216,174,71,0.3)', borderRadius: '4px', color: 'var(--accent)', cursor: 'pointer', fontSize: '11.5px', whiteSpace: 'nowrap' }}
                  >
                    Edit permissions
                  </button>
                  {!role.isSystem && (
                    <button
                      onClick={() => deleteRole(role)}
                      title={holders > 0 ? `${holders} user(s) hold this role` : 'Delete role'}
                      style={{ padding: '4px 8px', background: 'var(--status-cancelled-bg)', border: '1px solid var(--status-cancelled-bg)', borderRadius: '4px', color: 'var(--danger)', cursor: 'pointer' }}
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              )}
            </div>

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
                          {g.get(res)!.map((p) => (
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

      {/* ── Permission editor ─────────────────────────────────────────────── */}
      {editingRole && (
        <Modal
          open
          onClose={() => setEditingRole(null)}
          title={`Permissions — ${editingRole.displayName || editingRole.name}`}
          width="720px"
          closeIcon={<X size={18} />}
          footer={
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                {draft.size} of {catalogue.length} granted
                {holderCount.get(editingRole.id) ? ` · affects ${holderCount.get(editingRole.id)} user(s)` : ''}
              </span>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button type="button" onClick={() => setEditingRole(null)} className="btn btn-secondary" disabled={saving}>Cancel</button>
                <button
                  type="button"
                  onClick={savePermissions}
                  className="btn btn-primary"
                  disabled={saving || !dirty}
                  style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                >
                  <Save size={14} /> {saving ? 'Saving…' : 'Save permissions'}
                </button>
              </div>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '11.5px', color: 'var(--text-muted)', padding: '10px 12px', borderRadius: '8px', background: 'var(--bg-surface-2)' }}>
              <Info size={13} style={{ marginTop: 1, flexShrink: 0 }} />
              <span>
                Changes apply to everyone holding this role within seconds.
                {editingRole.isSystem
                  ? ' This is a built-in role: its permissions are editable, but its name is referenced by the application’s access rules and cannot change.'
                  : ' Custom roles satisfy permission-gated endpoints; pages gated by built-in role type will not open for them.'}
              </span>
            </div>

            {grouped.length === 0 ? (
              <div style={{ fontSize: '12.5px', color: 'var(--text-muted)' }}>No permissions available.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '52vh', overflowY: 'auto' }}>
                {grouped.map(([resource, perms]) => {
                  const allOn = perms.every((p) => draft.has(p.id));
                  return (
                    <div key={resource} style={{ padding: '10px 12px', borderRadius: '8px', background: 'var(--bg-surface-2)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <span style={label}>{resource.replace(/_/g, ' ')}</span>
                        <button
                          type="button"
                          onClick={() => setDraft((prev) => {
                            const next = new Set(prev);
                            for (const p of perms) allOn ? next.delete(p.id) : next.add(p.id);
                            return next;
                          })}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: '11px', fontWeight: 600 }}
                        >
                          {allOn ? 'Clear all' : 'Select all'}
                        </button>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '6px' }}>
                        {perms.map((p) => {
                          const on = draft.has(p.id);
                          return (
                            <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '11.5px', cursor: 'pointer' }}>
                              <input
                                type="checkbox"
                                checked={on}
                                onChange={() => setDraft((prev) => {
                                  const next = new Set(prev);
                                  next.has(p.id) ? next.delete(p.id) : next.add(p.id);
                                  return next;
                                })}
                              />
                              <span style={{ flex: 1 }}>{p.action}</span>
                              <span style={{ color: SCOPE_TONE[p.scope] ?? 'var(--text-muted)', fontWeight: 600 }}>{p.scope}</span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* ── Create role ───────────────────────────────────────────────────── */}
      {showCreate && (
        <Modal
          open
          onClose={() => setShowCreate(false)}
          title="New Role"
          width="480px"
          closeIcon={<X size={18} />}
          asForm
          onSubmit={createRole}
          footer={
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '10px' }}>
              <button type="button" onClick={() => setShowCreate(false)} className="btn btn-secondary" disabled={saving}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Creating…' : 'Create role'}</button>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '11.5px', color: 'var(--text-muted)', padding: '10px 12px', borderRadius: '8px', background: 'var(--bg-surface-2)' }}>
              <Info size={13} style={{ marginTop: 1, flexShrink: 0 }} />
              <span>
                A custom role grants access to everything gated by <strong>permissions</strong>. Screens gated by
                built-in role type (most operational pages) will not open for it — those need one of the
                built-in roles as well.
              </span>
            </div>
            <div>
              <label style={{ ...label, display: 'block', marginBottom: '4px' }}>Role Name</label>
              <input type="text" required placeholder="e.g. REGIONAL_AUDITOR" value={newName}
                onChange={(e) => setNewName(e.target.value)} style={input} />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Stored as UPPER_SNAKE_CASE. Cannot be changed later — the access rules refer to it by name.
              </div>
            </div>
            <div>
              <label style={{ ...label, display: 'block', marginBottom: '4px' }}>Display Name</label>
              <input type="text" placeholder="e.g. Regional Auditor" value={newDisplay}
                onChange={(e) => setNewDisplay(e.target.value)} style={input} />
            </div>
            <div>
              <label style={{ ...label, display: 'block', marginBottom: '4px' }}>Description (Optional)</label>
              <input type="text" placeholder="What this role is for" value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)} style={input} />
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default RolesPermissionsPanel;
