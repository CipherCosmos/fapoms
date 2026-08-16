import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Shield, Users as UsersIcon, Plus, Trash2, Lock, Info, X, ChevronRight, Search } from 'lucide-react';
import { SystemRole } from '@fapoms/shared';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { Modal, AlertBanner } from '../../components/ui';
import { useCurrentRoles } from '../../hooks/useCurrentRoles';
import {
  PERMISSION_AREAS, resourceLabel, actionLabel, scopeQualifier, areaForResource,
} from '../../config/permission-labels';

/**
 * What each role can do, and the place to change it.
 *
 * The first version of this screen was confusing for reasons worth recording, because they were
 * all self-inflicted:
 *
 *   - A role row had eight competing controls, and *two* ways into the same information —
 *     expand-in-place (read-only) and an Edit button (the same data, as checkboxes). Now a role
 *     is one click that opens one panel, which reads or edits according to what you may do.
 *   - Permissions were listed under 22 raw resource headings in enum case. They are grouped into
 *     six areas matching the sidebar, in plain language.
 *   - Every row printed its scope, which is ORGANIZATION for ~50 of the 67 — noise against
 *     which the two genuinely restrictive scopes disappeared. Only those are shown now.
 *   - The help text referred to `PermissionsGuard`. Nobody administering staff accounts knows
 *     or should need to know what that is.
 *
 * The substance is unchanged: these rows are what the API checks on every request, so an edit
 * here changes what people can do within seconds, without anyone signing out.
 */

interface Permission { id: string; resource: string; action: string; scope: string; description: string | null }
interface RoleRow { id: string; name: string; displayName: string; description: string | null; permissions: Permission[]; isSystem?: boolean }
interface UserRow { id: string; roles: { id: string }[] }

const label: React.CSSProperties = {
  fontSize: '10.5px', fontWeight: 700, textTransform: 'uppercase',
  letterSpacing: '0.05em', color: 'var(--text-muted)',
};
const input: React.CSSProperties = {
  width: '100%', padding: '9px', background: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)', borderRadius: '6px',
  color: 'var(--text-primary)', fontSize: '13px',
};

export const RolesPermissionsPanel: React.FC = () => {
  // Mirrors the API's gate on these routes, so nobody is shown a control that would 403.
  // Administrators are included: they can already grant themselves any role from the Directory
  // tab, so locking this screen to the super administrator only made it inert, not safer.
  const roles_ = useCurrentRoles();
  const canEdit =
    roles_.includes(SystemRole.SUPER_ADMINISTRATOR) || roles_.includes(SystemRole.ADMINISTRATOR);

  const { data: rolesRes, isLoading, refetch } = useQuery({
    queryKey: ['users', 'roles', 'full'],
    queryFn: () => api.request<RoleRow[]>('/users/roles'),
  });
  const { data: permsRes } = useQuery({
    queryKey: ['users', 'permissions', 'catalogue'],
    queryFn: () => api.request<Permission[]>('/users/permissions'),
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

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // ── One panel per role: reads when you may not edit, edits when you may ───
  const [openRole, setOpenRole] = useState<RoleRow | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (openRole) {
      setDraft(new Set((openRole.permissions ?? []).map((p) => p.id)));
      setFilter('');
    }
  }, [openRole]);

  const dirty = useMemo(() => {
    if (!openRole) return false;
    const original = new Set((openRole.permissions ?? []).map((p) => p.id));
    if (original.size !== draft.size) return true;
    for (const id of draft) if (!original.has(id)) return true;
    return false;
  }, [openRole, draft]);

  /** Catalogue arranged as area → resource → permissions, honouring the search box. */
  const byArea = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const match = (p: Permission) =>
      !q ||
      resourceLabel(p.resource).toLowerCase().includes(q) ||
      actionLabel(p.action).toLowerCase().includes(q);

    return PERMISSION_AREAS.map((area) => {
      const resources = new Map<string, Permission[]>();
      for (const p of catalogue) {
        if (areaForResource(p.resource) !== area.key || !match(p)) continue;
        if (!resources.has(p.resource)) resources.set(p.resource, []);
        resources.get(p.resource)!.push(p);
      }
      const all = [...resources.values()].flat();
      return {
        ...area,
        resources: [...resources.entries()].sort((a, b) => resourceLabel(a[0]).localeCompare(resourceLabel(b[0]))),
        total: all.length,
        granted: all.filter((p) => draft.has(p.id)).length,
      };
    }).filter((a) => a.total > 0);
  }, [catalogue, draft, filter]);

  const savePermissions = async () => {
    if (!openRole) return;
    setSaving(true);
    setError(null);
    try {
      await api.request(`/users/roles/${openRole.id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissionIds: [...draft] }),
      });
      const holders = holderCount.get(openRole.id) ?? 0;
      setSuccess(
        `Saved. ${openRole.displayName || openRole.name} now has ${draft.size} of ${catalogue.length} permissions` +
        (holders ? ` — this applies to ${holders} ${holders === 1 ? 'person' : 'people'} within seconds.` : '.'),
      );
      setOpenRole(null);
      refetch();
    } catch (err: any) {
      setError(`Could not save permissions. ${userMessage(err)}`);
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
      setSuccess('Role created. Open it to choose what it can do.');
      setShowCreate(false);
      setNewName(''); setNewDisplay(''); setNewDesc('');
      refetch();
    } catch (err: any) {
      setError(`Could not create the role. ${userMessage(err)}`);
    } finally {
      setSaving(false);
    }
  };

  const deleteRole = async (role: RoleRow, e: React.MouseEvent) => {
    e.stopPropagation(); // the row itself opens the role
    if (!window.confirm(`Delete the "${role.displayName || role.name}" role?`)) return;
    setError(null);
    try {
      await api.request(`/users/roles/${role.id}`, { method: 'DELETE' });
      setSuccess('Role deleted.');
      refetch();
    } catch (err: any) {
      setError(`Could not delete the role. ${userMessage(err)}`);
    }
  };

  const toggleMany = (perms: Permission[], on: boolean) =>
    setDraft((prev) => {
      const next = new Set(prev);
      for (const p of perms) (on ? next.add(p.id) : next.delete(p.id));
      return next;
    });

  if (isLoading) return <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading roles…</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
        <p style={{ fontSize: '12.5px', color: 'var(--text-muted)', margin: 0, maxWidth: '68ch' }}>
          A role is a bundle of things a person is allowed to do. Open one to see or change it —
          changes reach everyone holding that role within seconds, without them signing out.
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
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', fontSize: '11.5px', color: 'var(--text-muted)', padding: '9px 12px', borderRadius: '8px', background: 'var(--bg-surface-2)' }}>
          <Lock size={13} style={{ flexShrink: 0 }} />
          <span>You can review roles here. Changing them requires an Administrator role.</span>
        </div>
      )}

      {/* One row per role. The whole row is the target — no competing controls. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {roles.map((role) => {
          const holders = holderCount.get(role.id) ?? 0;
          const grants = (role.permissions ?? []).length;
          return (
            <div
              key={role.id}
              onClick={() => setOpenRole(role)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenRole(role); } }}
              style={{
                display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px',
                background: 'var(--bg-card)', border: '1px solid var(--border-color)',
                borderRadius: '10px', cursor: 'pointer',
              }}
            >
              <Shield size={17} style={{ color: 'var(--accent-primary)', flexShrink: 0 }} />

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '13.5px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
                  {role.displayName || role.name.replace(/_/g, ' ')}
                  {role.isSystem && (
                    <span title="Built-in role — its name is used by the system, so it cannot be renamed or removed" style={{ ...label, display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                      <Lock size={10} /> BUILT-IN
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '2px' }}>
                  {role.description
                    ? role.description
                    : `${grants} ${grants === 1 ? 'permission' : 'permissions'}`}
                </div>
              </div>

              {/* Two numbers only: who holds it, and how much it grants. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexShrink: 0 }}>
                <span title={`${holders} staff hold this role`} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '12px', color: 'var(--text-muted)' }}>
                  <UsersIcon size={13} /> {holders}
                </span>
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)', minWidth: '54px', textAlign: 'right' }}>
                  {grants}/{catalogue.length || '—'}
                </span>
                {canEdit && !role.isSystem && (
                  <button
                    aria-label={`Delete ${role.displayName || role.name}`}
                    onClick={(e) => deleteRole(role, e)}
                    style={{ padding: '4px 7px', background: 'transparent', border: '1px solid var(--border-color)', borderRadius: '5px', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex' }}
                  >
                    <Trash2 size={12} />
                  </button>
                )}
                <ChevronRight size={15} style={{ color: 'var(--text-muted)' }} />
              </div>
            </div>
          );
        })}
      </div>

      {/* ── The one panel: read or edit ───────────────────────────────────── */}
      {openRole && (
        <Modal
          open
          onClose={() => setOpenRole(null)}
          title={openRole.displayName || openRole.name.replace(/_/g, ' ')}
          width="760px"
          closeIcon={<X size={18} />}
          footer={
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
                {draft.size} of {catalogue.length} permissions
                {holderCount.get(openRole.id) ? ` · ${holderCount.get(openRole.id)} staff affected` : ''}
              </span>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button type="button" onClick={() => setOpenRole(null)} className="btn btn-secondary" disabled={saving}>
                  {canEdit ? 'Cancel' : 'Close'}
                </button>
                {canEdit && (
                  <button type="button" onClick={savePermissions} className="btn btn-primary" disabled={saving || !dirty}>
                    {saving ? 'Saving…' : dirty ? 'Save changes' : 'No changes'}
                  </button>
                )}
              </div>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {openRole.description && (
              <div style={{ fontSize: '12.5px', color: 'var(--text-secondary)' }}>{openRole.description}</div>
            )}

            {!canEdit && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '11.5px', color: 'var(--text-muted)', padding: '9px 12px', borderRadius: '8px', background: 'var(--bg-surface-2)' }}>
                <Lock size={13} style={{ marginTop: 1, flexShrink: 0 }} />
                <span>
                  Viewing only — changing what a role can do requires an Administrator role.
                </span>
              </div>
            )}

            {/* Only said when it changes what the admin should expect. */}
            {canEdit && !openRole.isSystem && (
              <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '11.5px', color: 'var(--text-muted)', padding: '9px 12px', borderRadius: '8px', background: 'var(--bg-surface-2)' }}>
                <Info size={13} style={{ marginTop: 1, flexShrink: 0 }} />
                <span>
                  This is a custom role. It grants the permissions ticked below, but the main
                  operational screens also check for a built-in role — so give people one of those
                  as well if they need those pages.
                </span>
              </div>
            )}

            <div style={{ position: 'relative' }}>
              <Search size={14} style={{ position: 'absolute', left: 10, top: 11, color: 'var(--text-muted)' }} />
              <input
                type="text"
                placeholder="Find a permission…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{ ...input, paddingLeft: '30px' }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {byArea.length === 0 ? (
                <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', padding: '16px 0', textAlign: 'center' }}>
                  Nothing matches “{filter}”.
                </div>
              ) : byArea.map((area) => {
                const areaPerms = area.resources.flatMap(([, ps]) => ps);
                const allOn = areaPerms.every((p) => draft.has(p.id));
                return (
                  <div key={area.key} style={{ border: '1px solid var(--border-color)', borderRadius: '9px', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', background: 'var(--bg-surface-2)' }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '12.5px', fontWeight: 700 }}>{area.label}</div>
                        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{area.hint}</div>
                      </div>
                      <span style={{ fontSize: '11.5px', color: area.granted ? 'var(--accent)' : 'var(--text-muted)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {area.granted}/{area.total}
                      </span>
                      {canEdit && (
                        <button
                          type="button"
                          onClick={() => toggleMany(areaPerms, !allOn)}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: '11px', fontWeight: 600, whiteSpace: 'nowrap' }}
                        >
                          {allOn ? 'Clear' : 'Select all'}
                        </button>
                      )}
                    </div>

                    <div style={{ padding: '4px 12px 10px' }}>
                      {area.resources.map(([resource, perms]) => (
                        <div key={resource} style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', padding: '9px 0', borderBottom: '1px solid var(--border-hair)' }}>
                          <div style={{ width: '150px', flexShrink: 0, fontSize: '12.5px', paddingTop: '3px' }}>
                            {resourceLabel(resource)}
                          </div>
                          <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                            {perms.map((p) => {
                              const on = draft.has(p.id);
                              const qualifier = scopeQualifier(p.scope);
                              return (
                                <button
                                  key={p.id}
                                  type="button"
                                  disabled={!canEdit}
                                  title={p.description || undefined}
                                  onClick={() => setDraft((prev) => {
                                    const next = new Set(prev);
                                    next.has(p.id) ? next.delete(p.id) : next.add(p.id);
                                    return next;
                                  })}
                                  style={{
                                    display: 'inline-flex', alignItems: 'center', gap: '5px',
                                    padding: '4px 10px', borderRadius: '999px', fontSize: '11.5px',
                                    cursor: canEdit ? 'pointer' : 'default',
                                    border: `1px solid ${on ? 'var(--accent)' : 'var(--border-color)'}`,
                                    background: on ? 'rgba(216,174,71,0.14)' : 'transparent',
                                    color: on ? 'var(--accent)' : 'var(--text-muted)',
                                    fontWeight: on ? 600 : 500,
                                    opacity: canEdit ? 1 : 0.85,
                                  }}
                                >
                                  {actionLabel(p.action)}
                                  {qualifier && (
                                    <span style={{ fontSize: '10px', opacity: 0.85, fontWeight: 500 }}>({qualifier})</span>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
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
            <div>
              <label style={{ ...label, display: 'block', marginBottom: '4px' }}>Name</label>
              <input type="text" required placeholder="Regional Auditor" value={newDisplay}
                onChange={(e) => { setNewDisplay(e.target.value); if (!newName) setNewName(e.target.value); }} style={input} />
            </div>
            <div>
              <label style={{ ...label, display: 'block', marginBottom: '4px' }}>System reference</label>
              <input type="text" required placeholder="REGIONAL_AUDITOR" value={newName}
                onChange={(e) => setNewName(e.target.value)} style={input} />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                Saved in capitals. This cannot be changed afterwards.
              </div>
            </div>
            <div>
              <label style={{ ...label, display: 'block', marginBottom: '4px' }}>Description <span style={{ fontWeight: 400, textTransform: 'none' }}>(optional)</span></label>
              <input type="text" placeholder="What this role is for" value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)} style={input} />
            </div>
            <div style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>
              You'll choose what it can do next.
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default RolesPermissionsPanel;
