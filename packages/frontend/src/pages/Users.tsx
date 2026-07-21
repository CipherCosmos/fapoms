import React, { useState, useEffect } from 'react';
import { User, Shield, ToggleLeft, ToggleRight, UserPlus } from 'lucide-react';
import { api } from '../services/api';

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
  status: 'ACTIVE' | 'INACTIVE';
  roles: UserRole[];
}

export const Users: React.FC = () => {
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [roles, setRoles] = useState<UserRole[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New User Form State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [selectedRoleIds, setSelectedRoleIds] = useState<string[]>([]);

  // Edit / Role Map Form State
  const [editingUser, setEditingUser] = useState<UserProfile | null>(null);
  const [editFirstName, setEditFirstName] = useState('');
  const [editLastName, setEditLastName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editStatus, setEditStatus] = useState<'ACTIVE' | 'INACTIVE'>('ACTIVE');
  const [editRoleIds, setEditRoleIds] = useState<string[]>([]);

  useEffect(() => {
    loadUsers();
    loadRoles();
  }, []);

  const loadUsers = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.request<UserProfile[]>('/users');
      setUsers(response);
    } catch (err: any) {
      setError(err?.message || 'Failed to retrieve users');
    } finally {
      setIsLoading(false);
    }
  };

  const loadRoles = async () => {
    try {
      const response = await api.request<UserRole[]>('/users/roles');
      setRoles(response);
    } catch (err) {
      console.error('Failed to load roles list');
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.request('/users', {
        method: 'POST',
        body: JSON.stringify({
          username,
          email,
          password,
          firstName,
          lastName,
          phone: phone || undefined,
          departmentId: departmentId || undefined,
          roleIds: selectedRoleIds,
        }),
      });
      setShowCreateModal(false);
      // Reset fields
      setUsername('');
      setEmail('');
      setPassword('');
      setFirstName('');
      setLastName('');
      setPhone('');
      setDepartmentId('');
      setSelectedRoleIds([]);
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
    setEditStatus(user.status);
    setEditRoleIds(user.roles.map((r) => r.id));
  };

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setError(null);
    try {
      // 1. Update basic profile status
      await api.request(`/users/${editingUser.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          firstName: editFirstName,
          lastName: editLastName,
          phone: editPhone || undefined,
          status: editStatus,
        }),
      });

      // 2. Assign new roles
      await api.request(`/users/${editingUser.id}/roles`, {
        method: 'PUT',
        body: JSON.stringify({
          roleIds: editRoleIds,
        }),
      });

      setEditingUser(null);
      loadUsers();
    } catch (err: any) {
      setError(err?.message || 'Failed to update user profile');
    }
  };

  const toggleUserStatus = async (user: UserProfile) => {
    const nextStatus = user.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      await api.request(`/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          status: nextStatus,
        }),
      });
      loadUsers();
    } catch (err: any) {
      setError(err?.message || 'Failed to toggle user status');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', padding: '16px' }}>
      
      {/* Header Panel */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h3 style={{ fontSize: '20px', fontWeight: 700 }}>User Administration</h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Configure organization users, permissions, and security roles.</p>
        </div>
        <button 
          onClick={() => setShowCreateModal(true)}
          style={{
            background: 'var(--gradient-neon)',
            border: 'none',
            color: '#fff',
            padding: '10px 18px',
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            boxShadow: 'var(--shadow-neon)'
          }}
        >
          <UserPlus size={16} />
          <span>Add New User</span>
        </button>
      </div>

      {error && (
        <div style={{
          background: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid rgba(239, 68, 68, 0.2)',
          color: '#f87171',
          padding: '12px 16px',
          borderRadius: 'var(--radius-md)',
          fontSize: '13px'
        }}>
          {error}
        </div>
      )}

      {/* Main Grid View */}
      <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: '24px', alignItems: 'start' }}>
        
        {/* User Table Card */}
        <div className="glass-card" style={{ padding: '0', overflow: 'hidden' }}>
          <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '15px', fontWeight: 600 }}>Active Users Directory</span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{users.length} registered accounts</span>
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
                {users.map((u) => (
                  <tr key={u.id} style={{ borderBottom: '1px solid var(--border-color)' }}>
                    <td style={{ padding: '14px 24px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent-primary)', fontWeight: 600 }}>
                          {u.firstName[0]}{u.lastName[0]}
                        </div>
                        <div>
                          <div style={{ fontSize: '14px', fontWeight: 600 }}>{u.displayName}</div>
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
                        style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', color: u.status === 'ACTIVE' ? 'var(--status-active)' : 'var(--text-muted)' }}
                      >
                        {u.status === 'ACTIVE' ? <ToggleRight size={24} /> : <ToggleLeft size={24} />}
                      </button>
                    </td>
                    <td style={{ padding: '14px 24px', textAlign: 'right' }}>
                      <button 
                        onClick={() => startEditUser(u)}
                        style={{
                          background: 'rgba(99, 102, 241, 0.1)',
                          border: '1px solid rgba(99, 102, 241, 0.2)',
                          color: 'var(--accent-secondary)',
                          padding: '6px 12px',
                          borderRadius: 'var(--radius-md)',
                          cursor: 'pointer',
                          fontSize: '12px',
                          fontWeight: 500
                        }}
                      >
                        Edit / Map
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Dynamic Action / Edit Form Card */}
        <div>
          {editingUser ? (
            <div className="glass-card" style={{ padding: '24px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '18px' }}>
                <Shield size={18} style={{ color: 'var(--accent-primary)' }} />
                <h4 style={{ fontSize: '16px', fontWeight: 600 }}>Edit Profile & Role Assignment</h4>
              </div>

              <form onSubmit={handleUpdateUser} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label className="form-label">First Name</label>
                    <input 
                      type="text" 
                      className="form-input" 
                      value={editFirstName} 
                      onChange={(e) => setEditFirstName(e.target.value)} 
                      required 
                    />
                  </div>
                  <div>
                    <label className="form-label">Last Name</label>
                    <input 
                      type="text" 
                      className="form-input" 
                      value={editLastName} 
                      onChange={(e) => setEditLastName(e.target.value)} 
                      required 
                    />
                  </div>
                </div>

                <div>
                  <label className="form-label">Phone Number</label>
                  <input 
                    type="text" 
                    className="form-input" 
                    value={editPhone} 
                    onChange={(e) => setEditPhone(e.target.value)} 
                  />
                </div>

                <div>
                  <label className="form-label">Account Status</label>
                  <select 
                    className="form-input" 
                    value={editStatus} 
                    onChange={(e: any) => setEditStatus(e.target.value)}
                  >
                    <option value="ACTIVE">Active (Unrestricted)</option>
                    <option value="INACTIVE">Inactive (Suspended)</option>
                  </select>
                </div>

                <div>
                  <label className="form-label" style={{ marginBottom: '8px', display: 'block' }}>Map System Roles</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '180px', overflowY: 'auto', background: 'var(--bg-secondary)', padding: '12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
                    {roles.map((r) => {
                      const isChecked = editRoleIds.includes(r.id);
                      return (
                        <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px', cursor: 'pointer' }}>
                          <input 
                            type="checkbox" 
                            checked={isChecked} 
                            onChange={() => {
                              if (isChecked) {
                                setEditRoleIds(editRoleIds.filter(id => id !== r.id));
                              } else {
                                setEditRoleIds([...editRoleIds, r.id]);
                              }
                            }}
                          />
                          <span>{r.name.replace(/_/g, ' ')}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
                  <button 
                    type="submit" 
                    style={{
                      flex: 1,
                      background: 'var(--gradient-neon)',
                      color: '#fff',
                      border: 'none',
                      padding: '10px',
                      borderRadius: 'var(--radius-md)',
                      fontWeight: 600,
                      cursor: 'pointer'
                    }}
                  >
                    Save Modifications
                  </button>
                  <button 
                    type="button" 
                    onClick={() => setEditingUser(null)}
                    style={{
                      background: 'var(--bg-tertiary)',
                      border: '1px solid var(--border-color)',
                      color: 'var(--text-primary)',
                      padding: '10px 16px',
                      borderRadius: 'var(--radius-md)',
                      cursor: 'pointer'
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </div>
          ) : (
            <div className="glass-card" style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>
              <User size={32} style={{ marginBottom: '12px', color: 'var(--accent-primary)', opacity: 0.7 }} />
              <h4 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>Profile Editor</h4>
              <p style={{ fontSize: '12px' }}>Select an account directory item from the left table view to assign roles, change status, or edit profile names.</p>
            </div>
          )}
        </div>

      </div>

      {/* User Creation Modal */}
      {showCreateModal && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          background: 'rgba(0,0,0,0.7)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 1000
        }}>
          <div className="glass-card" style={{ width: '480px', padding: '24px' }}>
            <h4 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '16px' }}>Add User Profile</h4>
            <form onSubmit={handleCreateUser} style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              
              <div>
                <label className="form-label">Username</label>
                <input 
                  type="text" 
                  className="form-input" 
                  value={username} 
                  onChange={(e) => setUsername(e.target.value)} 
                  required 
                />
              </div>

              <div>
                <label className="form-label">Email Address</label>
                <input 
                  type="email" 
                  className="form-input" 
                  value={email} 
                  onChange={(e) => setEmail(e.target.value)} 
                  required 
                />
              </div>

              <div>
                <label className="form-label">Initial Password</label>
                <input 
                  type="password" 
                  className="form-input" 
                  value={password} 
                  onChange={(e) => setPassword(e.target.value)} 
                  required 
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label className="form-label">First Name</label>
                  <input 
                    type="text" 
                    className="form-input" 
                    value={firstName} 
                    onChange={(e) => setFirstName(e.target.value)} 
                    required 
                  />
                </div>
                <div>
                  <label className="form-label">Last Name</label>
                  <input 
                    type="text" 
                    className="form-input" 
                    value={lastName} 
                    onChange={(e) => setLastName(e.target.value)} 
                    required 
                  />
                </div>
              </div>

              <div>
                <label className="form-label">Assign Initial Roles</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', maxHeight: '100px', overflowY: 'auto', background: 'var(--bg-secondary)', padding: '10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
                  {roles.map((r) => {
                    const isChecked = selectedRoleIds.includes(r.id);
                    return (
                      <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', cursor: 'pointer' }}>
                        <input 
                          type="checkbox" 
                          checked={isChecked} 
                          onChange={() => {
                            if (isChecked) {
                              setSelectedRoleIds(selectedRoleIds.filter(id => id !== r.id));
                            } else {
                              setSelectedRoleIds([...selectedRoleIds, r.id]);
                            }
                          }}
                        />
                        <span>{r.name.replace(/_/g, ' ')}</span>
                      </label>
                    );
                  })}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '12px', marginTop: '12px' }}>
                <button 
                  type="submit" 
                  style={{
                    flex: 1,
                    background: 'var(--gradient-neon)',
                    color: '#fff',
                    border: 'none',
                    padding: '10px',
                    borderRadius: 'var(--radius-md)',
                    fontWeight: 600,
                    cursor: 'pointer'
                  }}
                >
                  Create Profile
                </button>
                <button 
                  type="button" 
                  onClick={() => setShowCreateModal(false)}
                  style={{
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border-color)',
                    color: 'var(--text-primary)',
                    padding: '10px 16px',
                    borderRadius: 'var(--radius-md)',
                    cursor: 'pointer'
                  }}
                >
                  Cancel
                </button>
              </div>

            </form>
          </div>
        </div>
      )}

    </div>
  );
};
