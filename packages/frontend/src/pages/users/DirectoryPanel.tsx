import React, { useEffect, useState } from 'react';
import { Shield, ToggleLeft, ToggleRight, UserPlus, Users as UsersIcon, UserCheck, KeyRound, Lock, LockOpen, Clock } from 'lucide-react';
import { REGION_ORDER, REGION_LABELS, Region } from '@fapoms/shared';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { SearchInput, FilterSelect, AlertBanner, PrimaryButton, Modal, DetailDrawer } from '../../components/ui';
import { useCurrentUserId } from '../../hooks/useCurrentRoles';
import { UserActivityList } from './ActivityFeed';

interface UserRole {
  id: string;
  name: string;
}

interface UserProfile {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
  phone: string | null;
  departmentId: string | null;
  status: 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'LOCKED' | 'DISABLED' | 'ARCHIVED';
  /** Operational region assignment; null/empty = national (sees every region). */
  regions: string[] | null;
  roles: UserRole[];
  lastLoginAt: string | null;
  failedLoginAttempts: number;
  lockedUntil: string | null;
}

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'var(--status-active)', INVITED: 'var(--accent)', SUSPENDED: 'var(--warning)',
  LOCKED: 'var(--danger)', DISABLED: 'var(--text-muted)', ARCHIVED: 'var(--text-muted)',
};

const fmtRelative = (iso: string | null): string => {
  if (!iso) return 'Never';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

/**
 * Users administration — the Directory tab.
 *
 * This used to be the whole page. It could not help anyone reset a forgotten
 * password (no such endpoint existed), it let an admin deactivate their own
 * account or strip their own SUPER_ADMINISTRATOR role with no confirmation, it
 * sent a status value that isn't a real one, and it had no visibility at all
 * into login activity or lockouts — `failedLoginAttempts` and `lockedUntil`
 * exist on the user record and were stripped from every response.
 */
export const DirectoryPanel: React.FC = () => {
  const myId = useCurrentUserId();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [roles, setRoles] = useState<UserRole[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [searchText, setSearchText] = useState('');
  const [filterStatus, setFilterStatus] = useState<'ALL' | 'ACTIVE' | 'SUSPENDED' | 'LOCKED'>('ALL');

  const filteredUsers = users.filter((u) => {
    if (searchText) {
      const q = searchText.toLowerCase();
      if (!u.displayName.toLowerCase().includes(q) && !u.username.toLowerCase().includes(q) && !u.email.toLowerCase().includes(q)) return false;
    }
    if (filterStatus !== 'ALL' && u.status !== filterStatus) return false;
    return true;
  });

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);

  const [editingUser, setEditingUser] = useState<UserProfile | null>(null);
  const [editFirstName, setEditFirstName] = useState('');
  const [editLastName, setEditLastName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editRegions, setEditRegions] = useState<string[]>([]);
  const [editRoleIds, setEditRoleIds] = useState<string[]>([]);
  const [newPassword, setNewPassword] = useState('');
  const [resetting, setResetting] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<'ACTIVE' | 'SUSPENDED' | ''>('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkReport, setBulkReport] = useState<{ target: string; succeeded: number; skipped: { id: string; current: string; reason: string }[]; failed: { id: string; reason: string }[] } | null>(null);

  useEffect(() => { loadUsers(); loadRoles(); }, []);

  const loadUsers = async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Without an explicit limit the API returns only the first 20 users, silently truncating the
      // directory and every KPI/holder count derived from it. Pull a full working page.
      const response = await api.request<UserProfile[]>('/users?limit=500');
      const list = response ?? [];
      setUsers(list);
      // Keep the open edit panel in sync after an action (e.g. unlock) refetches.
      setEditingUser((prev) => (prev ? list.find((u: UserProfile) => u.id === prev.id) ?? null : prev));
    } catch (err: any) {
      setError(`Failed to retrieve users ${userMessage(err)}`);
    } finally {
      setIsLoading(false);
    }
  };

  const loadRoles = async () => {
    try {
      const response = await api.request<UserRole[]>('/users/roles');
      setRoles(response ?? []);
    } catch {
      // Non-fatal: the role checklist is just empty until this loads.
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.request('/users', {
        method: 'POST',
        body: JSON.stringify({ username, email, password, firstName, lastName, roleIds: selectedRoleIds }),
      });
      setShowCreateModal(false);
      setUsername(''); setEmail(''); setPassword(''); setFirstName(''); setLastName(''); setSelectedRoleIds([]);
      loadUsers();
    } catch (err: any) {
      setError(`Failed to create user ${userMessage(err)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const startEditUser = (user: UserProfile) => {
    setEditingUser(user);
    setEditFirstName(user.firstName);
    setEditLastName(user.lastName);
    setEditPhone(user.phone || '');
    setEditRegions(user.regions ?? []);
    setEditRoleIds(user.roles.map((r) => r.id));
    setNewPassword('');
  };

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setError(null);
    setSubmitting(true);
    try {
      await api.request(`/users/${editingUser.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          firstName: editFirstName,
          lastName: editLastName,
          phone: editPhone || undefined,
          // [] is sent as null: "no assignment" and "assigned to nothing" must be the same
          // state, or an account could be accidentally locked out of every region.
          regions: editRegions.length > 0 ? editRegions : null,
        }),
      });
    } catch (err: any) {
      setError(`Failed to update the profile — roles were not touched. ${userMessage(err)}`);
      setSubmitting(false);
      return;
    }
    try {
      await api.request(`/users/${editingUser.id}/roles`, { method: 'PUT', body: JSON.stringify({ roleIds: editRoleIds }) });
    } catch (err: any) {
      setError(`Profile saved, but role changes failed: ${userMessage(err)}`);
      setSubmitting(false);
      loadUsers();
      return;
    }
    setSubmitting(false);
    setEditingUser(null);
    setNotice('Profile and roles updated.');
    loadUsers();
  };

  const toggleUserStatus = async (user: UserProfile) => {
    const activating = user.status !== 'ACTIVE';
    if (!activating && !window.confirm(`Suspend ${user.displayName}? They will not be able to log in until reactivated.`)) return;
    setError(null);
    try {
      await api.request(`/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ status: activating ? 'ACTIVE' : 'SUSPENDED' }) });
      loadUsers();
    } catch (err: any) {
      setError(`Failed to change account status ${userMessage(err)}`);
    }
  };

  const runBulkStatus = async () => {
    if (!bulkStatus || selectedIds.size === 0) return;
    setBulkBusy(true);
    setBulkReport(null);
    setError(null);
    try {
      const res = await api.request<{ succeeded: { id: string }[]; skipped: { id: string; current: string; reason: string }[]; failed: { id: string; reason: string }[] }>('/users/bulk/status', {
        method: 'POST',
        body: JSON.stringify({ ids: [...selectedIds], status: bulkStatus }),
      });
      const { succeeded, skipped, failed } = res ?? { succeeded: [], skipped: [], failed: [] };
      setBulkReport({ target: bulkStatus, succeeded: succeeded.length, skipped, failed });
      setNotice(`${succeeded.length} user(s) ${bulkStatus === 'ACTIVE' ? 'activated' : 'suspended'}.`);
    } catch (err: any) {
      setError(`Bulk status change failed ${userMessage(err)}`);
    } finally {
      setBulkBusy(false);
      setBulkStatus('');
      setSelectedIds(new Set());
      loadUsers();
    }
  };

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const handleResetPassword = async () => {
    if (!editingUser || newPassword.length < 8) return;
    if (!window.confirm(`Reset the password for ${editingUser.displayName}? They'll need the new password to sign in.`)) return;
    setResetting(true);
    setError(null);
    try {
      await api.request(`/users/${editingUser.id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword }) });
      setNewPassword('');
      setNotice(`Password reset for ${editingUser.displayName}.`);
      loadUsers();
    } catch (err: any) {
      setError(`Failed to reset password ${userMessage(err)}`);
    } finally {
      setResetting(false);
    }
  };

  const handleUnlock = async () => {
    if (!editingUser) return;
    setUnlocking(true);
    setError(null);
    try {
      await api.request(`/users/${editingUser.id}/unlock`, { method: 'POST' });
      setNotice(`${editingUser.displayName}'s account unlocked — password unchanged.`);
      loadUsers();
    } catch (err: any) {
      setError(`Failed to unlock account ${userMessage(err)}`);
    } finally {
      setUnlocking(false);
    }
  };

  const isSelf = (u: UserProfile) => u.id === myId;
  const editingSelf = editingUser ? isSelf(editingUser) : false;
  const isLocked = (u: UserProfile) => u.status === 'LOCKED' || (!!u.lockedUntil && new Date(u.lockedUntil) > new Date());

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '14px' }}>
        <Kpi icon={<UsersIcon size={20} />} tone="var(--accent-primary)" value={filteredUsers.length} label="Total Users" />
        <Kpi icon={<UserCheck size={20} />} tone="var(--status-active)" value={filteredUsers.filter((u) => u.status === 'ACTIVE').length} label="Active" />
        <Kpi icon={<Lock size={20} />} tone="var(--danger)" value={users.filter(isLocked).length} label="Locked Out" />
        <Kpi icon={<Shield size={20} />} tone="var(--accent)" value={new Set(users.flatMap((u) => u.roles.map((r) => r.name))).size} label="Distinct Roles" />
      </div>

      {error && <AlertBanner type="error">{error}</AlertBanner>}
      {notice && <AlertBanner type="success">{notice}</AlertBanner>}

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <SearchInput value={searchText} onChange={setSearchText} placeholder="Search by name, username, email..." style={{ minWidth: '200px' }} />
        <FilterSelect value={filterStatus} onChange={(v) => setFilterStatus(v as any)} options={[
          { value: 'ALL', label: 'All Status' },
          { value: 'ACTIVE', label: 'Active' },
          { value: 'SUSPENDED', label: 'Suspended' },
          { value: 'LOCKED', label: 'Locked' },
        ]} />
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{filteredUsers.length} of {users.length} users</span>
        <div style={{ marginLeft: 'auto' }}>
          <PrimaryButton onClick={() => setShowCreateModal(true)} icon={<UserPlus size={16} />}>
            <span>Add User</span>
          </PrimaryButton>
        </div>
      </div>

      <div>
        <div className="glass-card" style={{ padding: '0', overflow: 'hidden' }}>
          <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '15px', fontWeight: 600 }}>Accounts</span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{filteredUsers.length} of {users.length}</span>
          </div>

          {selectedIds.size > 0 && (
            <div style={{
              display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap',
              padding: '10px 24px', borderBottom: '1px solid var(--border-color)',
              background: 'var(--status-pending-bg)',
            }}>
              <strong style={{ fontSize: '13px' }}>{selectedIds.size} selected</strong>
              <ToggleRight size={13} style={{ color: 'var(--text-muted)' }} />
              <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value as any)}
                style={{ padding: '6px 10px', fontSize: '12px', borderRadius: '6px', background: 'var(--bg-page)', color: 'inherit', border: '1px solid var(--border-color)' }}>
                <option value="">Set status…</option>
                <option value="ACTIVE">Activate</option>
                <option value="SUSPENDED">Suspend</option>
              </select>
              <button onClick={runBulkStatus} disabled={!bulkStatus || bulkBusy} className="btn btn-primary" style={{ fontSize: '12px', padding: '6px 12px' }}>
                {bulkBusy ? 'Applying…' : 'Apply'}
              </button>
              <button onClick={() => setSelectedIds(new Set())} className="btn btn-secondary" style={{ fontSize: '12px', padding: '6px 12px', marginLeft: 'auto' }}>Clear</button>
            </div>
          )}

          {bulkReport && (
            <div style={{ margin: '10px 24px 0', padding: '12px 14px', borderRadius: '8px', fontSize: '12px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', fontWeight: 600, marginBottom: '8px' }}>
                <span style={{ color: 'var(--status-active-text)' }}>{bulkReport.succeeded} moved</span>
                <span style={{ color: 'var(--text-muted)' }}>{bulkReport.skipped.length} skipped</span>
                {bulkReport.failed.length > 0 && <span style={{ color: 'var(--status-danger-text)' }}>{bulkReport.failed.length} failed</span>}
                <button onClick={() => setBulkReport(null)} className="btn btn-secondary" style={{ fontSize: '11px', padding: '2px 8px', marginLeft: 'auto' }}>Dismiss</button>
              </div>
              {bulkReport.skipped.length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>Already at {bulkReport.target}:</div>
                  {bulkReport.skipped.map((s) => (
                    <div key={s.id} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                      <span>{s.current}</span><span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>— {s.reason}</span>
                    </div>
                  ))}
                </div>
              )}
              {bulkReport.failed.length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>Failed:</div>
                  {bulkReport.failed.map((f) => (
                    <div key={f.id} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                      <span>{f.id.slice(0, 8)}</span><span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>— {f.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {isLoading ? (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading users list...</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
            <table className="planning-table" style={{ width: '100%', minWidth: '720px', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                  <th style={{ padding: '12px 6px 12px 24px', width: '28px' }}>
                    <input type="checkbox" checked={selectedIds.size > 0 && selectedIds.size === filteredUsers.length}
                      onChange={(e) => setSelectedIds(e.target.checked ? new Set(filteredUsers.map((u) => u.id)) : new Set())} style={{ cursor: 'pointer' }} />
                  </th>
                  <th style={{ padding: '12px 24px 12px 6px', textAlign: 'left', fontSize: '12px', color: 'var(--text-muted)' }}>User</th>
                  <th style={{ padding: '12px 24px', textAlign: 'left', fontSize: '12px', color: 'var(--text-muted)' }}>Roles</th>
                  <th style={{ padding: '12px 24px', textAlign: 'left', fontSize: '12px', color: 'var(--text-muted)' }}>Last Login</th>
                  <th style={{ padding: '12px 24px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>Status</th>
                  <th style={{ padding: '12px 24px 12px 6px', textAlign: 'right', fontSize: '12px', color: 'var(--text-muted)' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.length === 0 ? (
                  <tr><td colSpan={6} style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                      <UsersIcon size={30} style={{ opacity: 0.4 }} />
                      <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{searchText || filterStatus !== 'ALL' ? 'No users match your filters' : 'No users yet'}</span>
                      {!(searchText || filterStatus !== 'ALL') && (
                        <button onClick={() => setShowCreateModal(true)} className="btn btn-primary" style={{ marginTop: 6, padding: '7px 14px', fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <UserPlus size={13} /> Add User
                        </button>
                      )}
                    </div>
                  </td></tr>
                ) : (filteredUsers.map((u) => {
                  const self = isSelf(u);
                  const locked = isLocked(u);
                  return (
                    <tr key={u.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '14px 6px 14px 24px' }}>
                        <input type="checkbox" checked={selectedIds.has(u.id)} disabled={self}
                          onChange={() => toggleSelect(u.id)} title={self ? 'You cannot change your own account status' : undefined}
                          style={{ cursor: self ? 'not-allowed' : 'pointer' }} />
                      </td>
                      <td style={{ padding: '14px 24px 14px 6px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-primary)', fontWeight: 600, flexShrink: 0 }}>
                            {u.firstName[0]}{u.lastName[0]}
                          </div>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '14px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                              {u.displayName}
                              {self && <span style={{ fontSize: '10px', color: 'var(--accent-primary)', fontWeight: 700 }}>(you)</span>}
                              {locked && <span title={`${u.failedLoginAttempts} failed attempt(s)`}><Lock size={12} style={{ color: 'var(--danger)' }} /></span>}
                            </div>
                            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>@{u.username} · {u.email}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: '14px 24px' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {u.roles.map((r) => (
                            <span key={r.id} style={{ fontSize: '10px', background: 'var(--status-pending-bg)', color: 'var(--accent-secondary)', padding: '2px 8px', borderRadius: 'var(--radius-full)', fontWeight: 600 }}>
                              {r.name.replace(/_/g, ' ')}
                            </span>
                          ))}
                          {u.roles.length === 0 && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No roles assigned</span>}
                        </div>
                      </td>
                      <td style={{ padding: '14px 24px', fontSize: '12.5px', color: 'var(--text-secondary)' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><Clock size={11} style={{ opacity: 0.6 }} /> {fmtRelative(u.lastLoginAt)}</span>
                      </td>
                      <td style={{ padding: '14px 24px', textAlign: 'center' }}>
                        <button
                          onClick={() => toggleUserStatus(u)}
                          disabled={self}
                          title={self ? 'You cannot change your own account status' : u.status === 'ACTIVE' ? 'Suspend this account' : 'Reactivate this account'}
                          style={{ background: 'none', border: 'none', cursor: self ? 'not-allowed' : 'pointer', display: 'inline-flex', color: self ? 'var(--text-muted)' : (STATUS_TONE[u.status] ?? 'var(--text-muted)'), opacity: self ? 0.4 : 1 }}
                        >
                          {u.status === 'ACTIVE' ? <ToggleRight size={24} /> : <ToggleLeft size={24} />}
                        </button>
                        <div style={{ fontSize: '9.5px', color: STATUS_TONE[u.status] ?? 'var(--text-muted)', marginTop: '2px', fontWeight: 600 }}>{u.status}</div>
                      </td>
                      <td style={{ padding: '14px 24px', textAlign: 'right' }}>
                        <button onClick={() => startEditUser(u)}
                          style={{ background: 'var(--status-pending-bg)', border: '1px solid rgba(216,174,71,0.25)', color: 'var(--accent-secondary)', padding: '6px 12px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: '12px', fontWeight: 500 }}>
                          Edit / Map
                        </button>
                      </td>
                    </tr>
                  );
                }))}
              </tbody>
            </table>
            </div>
          )}
        </div>

      </div>

      {/* Edit / roles / reset / activity — a slide-in drawer instead of a side panel that used
          to squeeze the accounts table to half width. */}
      <DetailDrawer
        open={!!editingUser}
        onClose={() => setEditingUser(null)}
        width={520}
        title={editingUser ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <Shield size={16} style={{ color: 'var(--accent-primary)' }} />
            Edit {editingUser.displayName}{editingSelf && <span style={{ fontSize: 11, color: 'var(--accent-primary)', fontWeight: 700 }}>(you)</span>}
          </span>
        ) : ''}
      >
        {editingUser && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

              {isLocked(editingUser) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', marginBottom: '16px', borderRadius: '8px', background: 'var(--status-cancelled-bg)', border: '1px solid var(--status-cancelled)' }}>
                  <Lock size={15} style={{ color: 'var(--danger)', flexShrink: 0 }} />
                  <div style={{ flex: 1, fontSize: '12px' }}>
                    <strong style={{ color: 'var(--danger)' }}>Locked out</strong> — {editingUser.failedLoginAttempts} failed login attempt(s).
                  </div>
                  <button type="button" onClick={handleUnlock} disabled={unlocking} className="btn btn-secondary"
                    style={{ fontSize: '11.5px', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}>
                    <LockOpen size={12} /> {unlocking ? 'Unlocking…' : 'Unlock'}
                  </button>
                </div>
              )}

              <form onSubmit={handleUpdateUser} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px' }}>
                  <div><label className="form-label">First Name</label><input type="text" className="form-input" value={editFirstName} onChange={(e) => setEditFirstName(e.target.value)} required /></div>
                  <div><label className="form-label">Last Name</label><input type="text" className="form-input" value={editLastName} onChange={(e) => setEditLastName(e.target.value)} required /></div>
                </div>
                <div><label className="form-label">Phone Number</label><input type="text" className="form-input" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} /></div>

                <div>
                  <label className="form-label" style={{ marginBottom: '8px', display: 'block' }}>System Roles</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '180px', overflowY: 'auto', background: 'var(--bg-secondary)', padding: '12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
                    {roles.map((r) => {
                      const isChecked = editRoleIds.includes(r.id);
                      const lockedSelfAdmin = editingSelf && r.name === 'SUPER_ADMINISTRATOR' && isChecked;
                      return (
                        <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', cursor: lockedSelfAdmin ? 'not-allowed' : 'pointer', opacity: lockedSelfAdmin ? 0.6 : 1 }}
                          title={lockedSelfAdmin ? 'You cannot remove your own SUPER_ADMINISTRATOR role' : undefined}>
                          <input type="checkbox" checked={isChecked} disabled={lockedSelfAdmin}
                            onChange={() => setEditRoleIds(isChecked ? editRoleIds.filter((id) => id !== r.id) : [...editRoleIds, r.id])} />
                          <span>{r.name.replace(/_/g, ' ')}</span>
                          {lockedSelfAdmin && <Lock size={11} style={{ color: 'var(--text-muted)' }} />}
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="form-label" style={{ marginBottom: '4px', display: 'block' }}>Operational Regions</label>
                  <p style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                    Confines this account to its territory on the operations desks (planning, assignments,
                    scheduling, branches, map). Leave all unticked for national desks — HR, data entry,
                    validation, finance — which see every region.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', background: 'var(--bg-secondary)', padding: '12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
                    {REGION_ORDER.map((r) => {
                      const isChecked = editRegions.includes(r);
                      return (
                        <label key={r} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
                          <input type="checkbox" checked={isChecked}
                            onChange={() => setEditRegions(isChecked ? editRegions.filter((v) => v !== r) : [...editRegions, r])} />
                          <span>{REGION_LABELS[r]}</span>
                        </label>
                      );
                    })}
                  </div>
                  {editRegions.length > 0 && (
                    <p style={{ fontSize: '11.5px', color: 'var(--warning)', marginTop: '6px' }}>
                      Restricted account: the server will refuse this user data outside{' '}
                      {editRegions.map((r) => REGION_LABELS[r as Region] ?? r).join(', ')}.
                    </p>
                  )}
                </div>

                <div style={{ display: 'flex', gap: '12px', marginTop: '4px' }}>
                  <button type="submit" disabled={submitting} style={{ flex: 1, background: 'var(--gradient-neon)', color: 'var(--on-gradient)', border: 'none', padding: '10px', borderRadius: 'var(--radius-md)', fontWeight: 600, cursor: 'pointer' }}>{submitting ? 'Saving…' : 'Save Modifications'}</button>
                  <button type="button" onClick={() => setEditingUser(null)} style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '10px 16px', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>Cancel</button>
                </div>
              </form>

              <div style={{ marginTop: '20px', paddingTop: '18px', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                  <KeyRound size={15} style={{ color: 'var(--warning)' }} />
                  <span style={{ fontSize: '13px', fontWeight: 600 }}>Reset Password</span>
                </div>
                <p style={{ fontSize: '11.5px', color: 'var(--text-muted)', marginBottom: '10px' }}>
                  Sets a new password immediately — there is no email flow, so share it with {editingUser.displayName} directly.
                </p>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input type="text" className="form-input" placeholder="New password (min 8 characters)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={{ flex: 1 }} />
                  <button type="button" onClick={handleResetPassword} disabled={resetting || newPassword.length < 8}
                    className="btn btn-secondary" style={{ padding: '8px 14px', fontSize: '12px', whiteSpace: 'nowrap' }}>
                    {resetting ? 'Resetting…' : 'Reset'}
                  </button>
                </div>
              </div>

              <div style={{ marginTop: '20px', paddingTop: '18px', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px' }}>Recent Activity</div>
                <UserActivityList userId={editingUser.id} />
              </div>
          </div>
        )}
      </DetailDrawer>

      {showCreateModal && (
        <Modal open onClose={() => setShowCreateModal(false)} title="Add User Profile" width="480px" asForm onSubmit={handleCreateUser}
          footer={
            <div style={{ display: 'flex', gap: '12px', marginTop: '12px' }}>
              <button type="submit" disabled={submitting} style={{ flex: 1, background: 'var(--gradient-neon)', color: 'var(--on-gradient)', border: 'none', padding: '10px', borderRadius: 'var(--radius-md)', fontWeight: 600, cursor: 'pointer' }}>{submitting ? 'Creating…' : 'Create Profile'}</button>
              <button type="button" onClick={() => setShowCreateModal(false)} style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '10px 16px', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>Cancel</button>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div><label className="form-label">Username</label><input type="text" className="form-input" value={username} onChange={(e) => setUsername(e.target.value)} required /></div>
            <div><label className="form-label">Email Address</label><input type="email" className="form-input" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
            <div><label className="form-label">Initial Password</label><input type="password" className="form-input" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '12px' }}>
              <div><label className="form-label">First Name</label><input type="text" className="form-input" value={firstName} onChange={(e) => setFirstName(e.target.value)} required /></div>
              <div><label className="form-label">Last Name</label><input type="text" className="form-input" value={lastName} onChange={(e) => setLastName(e.target.value)} required /></div>
            </div>
            <div>
              <label className="form-label">Assign Initial Roles</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', maxHeight: '100px', overflowY: 'auto', background: 'var(--bg-secondary)', padding: '10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
                {roles.map((r) => {
                  const isChecked = selectedRoleIds.includes(r.id);
                  return (
                    <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' }}>
                      <input type="checkbox" checked={isChecked} onChange={() => setSelectedRoleIds(isChecked ? selectedRoleIds.filter((id) => id !== r.id) : [...selectedRoleIds, r.id])} />
                      <span>{r.name.replace(/_/g, ' ')}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

const Kpi: React.FC<{ icon: React.ReactNode; tone: string; value: React.ReactNode; label: string }> = ({ icon, tone, value, label }) => (
  <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
    <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'var(--status-pending-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: tone }}>{icon}</div>
    <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{value}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{label}</div></div>
  </div>
);

export default DirectoryPanel;
