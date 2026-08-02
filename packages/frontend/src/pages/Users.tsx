import React, { useEffect, useState } from 'react';
import { User, Shield, ToggleLeft, ToggleRight, UserPlus, Users as UsersIcon, UserCheck, UserX, KeyRound, Lock } from 'lucide-react';
import { api } from '../services/api';
import { SearchInput, FilterSelect, AlertBanner, PrimaryButton, Modal } from '../components/ui';
import { useCurrentUserId } from '../hooks/useCurrentRoles';

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
  roles: UserRole[];
}

const STATUS_TONE: Record<string, string> = {
  ACTIVE: 'var(--status-active)', INVITED: '#60a5fa', SUSPENDED: '#f59e0b',
  LOCKED: '#ef4444', DISABLED: '#6b7280', ARCHIVED: '#6b7280',
};

/**
 * Users administration.
 *
 * Three real gaps here, not cosmetic ones: this page could not help anyone reset
 * a forgotten password (no such endpoint existed at all), it let an admin
 * deactivate their own account or strip their own SUPER_ADMINISTRATOR role with
 * one click and no confirmation, and it sent a `status` value ("INACTIVE") that
 * does not exist in the real UserStatus enum — the backend now rejects that
 * outright, and the two lockout paths are blocked server-side, but this page
 * should not offer either as if they were fine.
 */
export const Users: React.FC = () => {
  const myId = useCurrentUserId();
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [roles, setRoles] = useState<UserRole[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [searchText, setSearchText] = useState('');
  const [filterStatus, setFilterStatus] = useState<'ALL' | 'ACTIVE' | 'SUSPENDED'>('ALL');

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
  const [editRoleIds, setEditRoleIds] = useState<string[]>([]);
  const [newPassword, setNewPassword] = useState('');
  const [resetting, setResetting] = useState(false);

  useEffect(() => { loadUsers(); loadRoles(); }, []);

  const loadUsers = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.request<UserProfile[]>('/users');
      setUsers(Array.isArray(response) ? response : (response as any)?.data ?? []);
    } catch (err: any) {
      setError(err?.message || 'Failed to retrieve users');
    } finally {
      setIsLoading(false);
    }
  };

  const loadRoles = async () => {
    try {
      const response = await api.request<UserRole[]>('/users/roles');
      setRoles(Array.isArray(response) ? response : (response as any)?.data ?? []);
    } catch {
      // Non-fatal: the role checklist is just empty until this loads.
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.request('/users', {
        method: 'POST',
        body: JSON.stringify({ username, email, password, firstName, lastName, roleIds: selectedRoleIds }),
      });
      setShowCreateModal(false);
      setUsername(''); setEmail(''); setPassword(''); setFirstName(''); setLastName(''); setSelectedRoleIds([]);
      loadUsers();
    } catch (err: any) {
      setError(err?.message || 'Failed to create user');
    }
  };

  const startEditUser = (user: UserProfile) => {
    setEditingUser(user);
    setEditFirstName(user.firstName);
    setEditLastName(user.lastName);
    setEditPhone(user.phone || '');
    setEditRoleIds(user.roles.map((r) => r.id));
    setNewPassword('');
  };

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setError(null);
    try {
      await api.request(`/users/${editingUser.id}`, {
        method: 'PUT',
        body: JSON.stringify({ firstName: editFirstName, lastName: editLastName, phone: editPhone || undefined }),
      });
    } catch (err: any) {
      setError(err?.message || 'Failed to update the profile — roles were not touched.');
      return;
    }
    try {
      await api.request(`/users/${editingUser.id}/roles`, { method: 'PUT', body: JSON.stringify({ roleIds: editRoleIds }) });
    } catch (err: any) {
      setError(`Profile saved, but role changes failed: ${err?.message || 'unknown error'}`);
      loadUsers();
      return;
    }
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
      setError(err?.message || 'Failed to change account status');
    }
  };

  const handleResetPassword = async () => {
    if (!editingUser || newPassword.length < 8) return;
    setResetting(true);
    setError(null);
    try {
      await api.request(`/users/${editingUser.id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword }) });
      setNewPassword('');
      setNotice(`Password reset for ${editingUser.displayName}.`);
    } catch (err: any) {
      setError(err?.message || 'Failed to reset password');
    } finally {
      setResetting(false);
    }
  };

  const isSelf = (u: UserProfile) => u.id === myId;
  const editingSelf = editingUser ? isSelf(editingUser) : false;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', padding: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ fontSize: '20px', fontWeight: 700 }}>User Administration</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Staff accounts, roles, and access — not the assayer workforce, which lives under Workforce.</p>
        </div>
        <PrimaryButton onClick={() => setShowCreateModal(true)} icon={<UserPlus size={16} />}>
          <span>Add New User</span>
        </PrimaryButton>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' }}>
        <Kpi icon={<UsersIcon size={20} />} tone="var(--accent-primary)" value={filteredUsers.length} label="Total Users" />
        <Kpi icon={<UserCheck size={20} />} tone="var(--status-active)" value={filteredUsers.filter((u) => u.status === 'ACTIVE').length} label="Active" />
        <Kpi icon={<UserX size={20} />} tone="#ef4444" value={users.filter((u) => u.status !== 'ACTIVE').length} label="Not Active" />
        <Kpi icon={<Shield size={20} />} tone="#8b5cf6" value={new Set(users.flatMap((u) => u.roles.map((r) => r.name))).size} label="Distinct Roles" />
      </div>

      {error && <AlertBanner type="error">{error}</AlertBanner>}
      {notice && <AlertBanner type="success">{notice}</AlertBanner>}

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <SearchInput value={searchText} onChange={setSearchText} placeholder="Search by name, username, email..." style={{ minWidth: '200px' }} />
        <FilterSelect value={filterStatus} onChange={(v) => setFilterStatus(v as any)} options={[
          { value: 'ALL', label: 'All Status' },
          { value: 'ACTIVE', label: 'Active' },
          { value: 'SUSPENDED', label: 'Suspended' },
        ]} />
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{filteredUsers.length} of {users.length} users</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: '24px', alignItems: 'start' }}>
        <div className="glass-card" style={{ padding: '0', overflow: 'hidden' }}>
          <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '15px', fontWeight: 600 }}>Accounts</span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{filteredUsers.length} of {users.length}</span>
          </div>

          {isLoading ? (
            <div style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading users list...</div>
          ) : (
            <table className="planning-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-color)' }}>
                  <th style={{ padding: '12px 24px', textAlign: 'left', fontSize: '12px', color: 'var(--text-muted)' }}>User</th>
                  <th style={{ padding: '12px 24px', textAlign: 'left', fontSize: '12px', color: 'var(--text-muted)' }}>Email</th>
                  <th style={{ padding: '12px 24px', textAlign: 'left', fontSize: '12px', color: 'var(--text-muted)' }}>Roles</th>
                  <th style={{ padding: '12px 24px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>Status</th>
                  <th style={{ padding: '12px 24px', textAlign: 'right', fontSize: '12px', color: 'var(--text-muted)' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.length === 0 ? (
                  <tr><td colSpan={5} style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>No users match filters.</td></tr>
                ) : (filteredUsers.map((u) => {
                  const self = isSelf(u);
                  return (
                    <tr key={u.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                      <td style={{ padding: '14px 24px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-primary)', fontWeight: 600 }}>
                            {u.firstName[0]}{u.lastName[0]}
                          </div>
                          <div>
                            <div style={{ fontSize: '14px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                              {u.displayName}
                              {self && <span style={{ fontSize: '10px', color: 'var(--accent-primary)', fontWeight: 700 }}>(you)</span>}
                            </div>
                            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>@{u.username}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: '14px 24px', fontSize: '13px', color: 'var(--text-secondary)' }}>{u.email}</td>
                      <td style={{ padding: '14px 24px' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {u.roles.map((r) => (
                            <span key={r.id} style={{ fontSize: '10px', background: 'rgba(99, 102, 241, 0.15)', color: 'var(--accent-secondary)', padding: '2px 8px', borderRadius: 'var(--radius-full)', fontWeight: 600 }}>
                              {r.name.replace(/_/g, ' ')}
                            </span>
                          ))}
                          {u.roles.length === 0 && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>No roles assigned</span>}
                        </div>
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
                          style={{ background: 'rgba(99, 102, 241, 0.1)', border: '1px solid rgba(99, 102, 241, 0.2)', color: 'var(--accent-secondary)', padding: '6px 12px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: '12px', fontWeight: 500 }}>
                          Edit / Map
                        </button>
                      </td>
                    </tr>
                  );
                }))}
              </tbody>
            </table>
          )}
        </div>

        <div>
          {editingUser ? (
            <div className="glass-card" style={{ padding: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '18px' }}>
                <Shield size={18} style={{ color: 'var(--accent-primary)' }} />
                <h4 style={{ fontSize: '16px', fontWeight: 600 }}>Edit {editingUser.displayName}{editingSelf && <span style={{ fontSize: '11px', color: 'var(--accent-primary)', fontWeight: 700, marginLeft: '6px' }}>(you)</span>}</h4>
              </div>

              <form onSubmit={handleUpdateUser} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
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

                <div style={{ display: 'flex', gap: '12px', marginTop: '4px' }}>
                  <button type="submit" style={{ flex: 1, background: 'var(--gradient-neon)', color: '#fff', border: 'none', padding: '10px', borderRadius: 'var(--radius-md)', fontWeight: 600, cursor: 'pointer' }}>Save Modifications</button>
                  <button type="button" onClick={() => setEditingUser(null)} style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '10px 16px', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>Cancel</button>
                </div>
              </form>

              <div style={{ marginTop: '20px', paddingTop: '18px', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                  <KeyRound size={15} style={{ color: '#f59e0b' }} />
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
            </div>
          ) : (
            <div className="glass-card" style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
              <User size={32} style={{ marginBottom: '12px', color: 'var(--accent-primary)', opacity: 0.7 }} />
              <h4 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>Profile Editor</h4>
              <p style={{ fontSize: '12px' }}>Select an account from the left to edit their profile, roles, or reset their password.</p>
            </div>
          )}
        </div>
      </div>

      {showCreateModal && (
        <Modal open onClose={() => setShowCreateModal(false)} title="Add User Profile" width="480px" asForm onSubmit={handleCreateUser}
          footer={
            <div style={{ display: 'flex', gap: '12px', marginTop: '12px' }}>
              <button type="submit" style={{ flex: 1, background: 'var(--gradient-neon)', color: '#fff', border: 'none', padding: '10px', borderRadius: 'var(--radius-md)', fontWeight: 600, cursor: 'pointer' }}>Create Profile</button>
              <button type="button" onClick={() => setShowCreateModal(false)} style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '10px 16px', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>Cancel</button>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div><label className="form-label">Username</label><input type="text" className="form-input" value={username} onChange={(e) => setUsername(e.target.value)} required /></div>
            <div><label className="form-label">Email Address</label><input type="email" className="form-input" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
            <div><label className="form-label">Initial Password</label><input type="password" className="form-input" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} /></div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
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
    <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(99,102,241,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: tone }}>{icon}</div>
    <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{value}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{label}</div></div>
  </div>
);

export default Users;
