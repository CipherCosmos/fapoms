import React, { useEffect, useState } from 'react';
import { Shield, ToggleLeft, ToggleRight, UserPlus, Users as UsersIcon, KeyRound, Lock, LockOpen, Clock, Mail } from 'lucide-react';
import {
  REGION_ORDER, REGION_LABELS, Region, roleLabel, userStatusLabel, ROLE_DESCRIPTIONS, SystemRole,
} from '@fapoms/shared';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { LoadFailure, caughtLoad } from '../../components/LoadFailure';
import { AddUserDialog, InviteResult } from './AddUserDialog';
import { SearchInput, FilterSelect, AlertBanner, PrimaryButton, DetailDrawer, Select, SelectOption, useConfirm } from '../../components/ui';
import { useCurrentUserId } from '../../hooks/useCurrentRoles';
import { useClientOptions } from '../../hooks/useClients';
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
  /** The bank/NBFC this account is confined to when it holds CLIENT_USER; null for staff. */
  clientId: string | null;
  roles: UserRole[];
  lastLoginAt: string | null;
  failedLoginAttempts: number;
  lockedUntil: string | null;
}

/** `roles` here is the directory's canonical role list — always matched by id, never by name. */
const CLIENT_USER_ROLE_NAME = 'CLIENT_USER';

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
  const { confirm, confirmDialog } = useConfirm();
  const [users, setUsers] = useState<UserProfile[]>([]);
  /** The server's own count — not `users.length`, which is only ever the page that arrived. */
  const [usersTotal, setUsersTotal] = useState(0);
  const [roles, setRoles] = useState<UserRole[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Why the directory is empty, when it is empty because it could not be read.
   *
   * `error` is shared with every write on this panel (unlock, suspend, role change) and is meant
   * to be read and forgotten. A failed READ is not like that: it left `users` at `[]`, and the
   * table underneath then rendered "No users yet" beside an "Add User" button, over four KPI
   * tiles all reading 0 — an administrator being told this deployment has no accounts in it.
   * Kept as the error object, not a string, so the banner can tell a refusal from an outage.
   */
  const [usersLoadError, setUsersLoadError] = useState<unknown>(null);
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
  /** What to tell the administrator once the account exists — see `InviteResult`. */
  const [inviteResult, setInviteResult] = useState<{
    displayName: string; email: string; emailed: boolean; link: string;
  } | null>(null);
  /*
    The add-user form's own state moved into `AddUserDialog` with the form itself. What is left
    here is the list: who exists, and what this panel does to them.
  */

  const [editingUser, setEditingUser] = useState<UserProfile | null>(null);
  const [editFirstName, setEditFirstName] = useState('');
  const [editLastName, setEditLastName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editRegions, setEditRegions] = useState<string[]>([]);
  const [editRoleIds, setEditRoleIds] = useState<string[]>([]);
  const [editClientId, setEditClientId] = useState('');
  const { data: clientOptions } = useClientOptions();
  const [newPassword, setNewPassword] = useState('');
  const [resetting, setResetting] = useState(false);
  const [sendingLink, setSendingLink] = useState(false);
  /** Typing a password for somebody else is still possible — just not the first thing offered. */
  const [showManualReset, setShowManualReset] = useState(false);
  const [unlocking, setUnlocking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkStatus, setBulkStatus] = useState<'ACTIVE' | 'SUSPENDED' | ''>('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkReport, setBulkReport] = useState<{ target: string; succeeded: number; skipped: { id: string; current: string; reason: string }[]; failed: { id: string; reason: string }[] } | null>(null);

  useEffect(() => { void loadUsers(); void loadRoles(); }, []);

  // The dialog mounts fresh each time it opens, so there is no stale form to clear first.
  const openCreateModal = () => setShowCreateModal(true);

  /** Resolves an id from a bulk report to the person it belongs to — see the report markup. */
  const displayNameFor = (id: string): string => users.find((u) => u.id === id)?.displayName ?? 'Account no longer listed';

  const loadUsers = async () => {
    setIsLoading(true);
    setError(null);
    try {
      /*
        Without an explicit limit the API returns only the first 20 users, silently truncating the
        directory and every KPI/holder count derived from it. Pull a full working page — 2,000,
        the ceiling `GET /users` is contracted to honour, up from the 500 this used to ask for.
        500 had exactly the same silent-shortfall shape the 20-row default did, just a bigger
        number before it bit: past the 501st account, "Total Users" and the search results would
        quietly stop growing with nothing on screen to say the directory was no longer complete.
        `withMeta` is what makes that detectable — `meta.total` is the real count, independent of
        how many rows this page actually got.
      */
      const response = await api.request<{ data?: UserProfile[]; meta?: { pagination?: { total?: number } } }>(
        '/users?limit=2000',
        { withMeta: true },
      );
      const list = Array.isArray(response?.data) ? response.data : [];
      setUsers(list);
      setUsersTotal(response?.meta?.pagination?.total ?? list.length);
      setUsersLoadError(null);
      // Keep the open edit panel in sync after an action (e.g. unlock) refetches.
      setEditingUser((prev) => (prev ? list.find((u: UserProfile) => u.id === prev.id) ?? null : prev));
    } catch (err: any) {
      setUsersLoadError(err);
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

  /**
   * Whether the checked role ids include CLIENT_USER — checked against the role checklist's
   * live selection, not the account's already-saved roles, so this catches the moment CLIENT_USER
   * is first ticked, before Save is even pressed.
   *
   * A CLIENT_USER account with no client assigned is refused read access everywhere by the
   * backend (`resolveClientScope` in `global-scope.ts`) rather than defaulting to unrestricted —
   * so skipping this check does not create a data leak, only an account nobody can use until
   * someone comes back and assigns it a client by hand. Catching it here means that never happens.
   */
  const roleIdsIncludeClientUser = (roleIds: string[]): boolean =>
    roleIds.some((id) => roles.find((r) => r.id === id)?.name === CLIENT_USER_ROLE_NAME);

  const startEditUser = (user: UserProfile) => {
    setEditingUser(user);
    setEditFirstName(user.firstName);
    setEditLastName(user.lastName);
    setEditPhone(user.phone || '');
    setEditRegions(user.regions ?? []);
    setEditRoleIds(user.roles.map((r) => r.id));
    setEditClientId(user.clientId ?? '');
    setNewPassword('');
  };

  const handleUpdateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    setError(null);
    if (roleIdsIncludeClientUser(editRoleIds) && !editClientId) {
      setError('Pick which client this account belongs to — required whenever Client User is one of the roles.');
      return;
    }
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
          // Same reasoning: clearing the picker means "unassigned", sent as an explicit null
          // rather than omitted, so it actually clears a previous assignment instead of the
          // server reading a missing key as "leave it alone".
          clientId: editClientId || null,
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
      void loadUsers();
      return;
    }
    setSubmitting(false);
    setEditingUser(null);
    setNotice('Profile and roles updated.');
    void loadUsers();
  };

  const toggleUserStatus = async (user: UserProfile) => {
    const activating = user.status !== 'ACTIVE';
    // Only suspension is confirmed; re-activating is harmless and was never guarded.
    if (!activating) {
      const ok = await confirm({
        title: `Suspend ${user.displayName}?`,
        message: 'They will not be able to log in until someone activates the account again. Their work and history are kept.',
        confirmLabel: 'Suspend account',
        reversible: true,
      });
      if (!ok) return;
    }
    setError(null);
    try {
      await api.request(`/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ status: activating ? 'ACTIVE' : 'SUSPENDED' }) });
      void loadUsers();
    } catch (err: any) {
      setError(`Failed to change account status. ${userMessage(err)}`);
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
      setError(`Bulk status change failed. ${userMessage(err)}`);
    } finally {
      setBulkBusy(false);
      setBulkStatus('');
      setSelectedIds(new Set());
      void loadUsers();
    }
  };

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  /**
   * Email them a link instead of inventing a password for them.
   *
   * Reports honestly when the message did not go: a screen that says "link sent" on a deployment
   * with email switched off leaves a colleague waiting for something nobody posted. The link comes
   * back in that case, so it can still be passed on — a link is safe to hand over in a way a
   * password is not, since only its holder can spend it and only once.
   */
  const handleSendSetupLink = async () => {
    if (!editingUser) return;
    setSendingLink(true);
    setError(null);
    try {
      const res = await api.request<{ emailed: boolean; link: string }>(
        `/users/${editingUser.id}/send-setup-link`,
        { method: 'POST', body: JSON.stringify({ reason: 'RESET' }) },
      );
      if (res?.emailed) {
        setNotice(`A password link is on its way to ${editingUser.email}. It expires in 48 hours.`);
      } else {
        setInviteResult({
          displayName: editingUser.displayName,
          email: editingUser.email ?? '',
          emailed: false,
          link: res?.link ?? '',
        });
      }
    } catch (err: any) {
      setError(`Could not send the link. ${userMessage(err)}`);
    } finally {
      setSendingLink(false);
    }
  };

  const handleResetPassword = async () => {
    if (!editingUser || newPassword.length < 10) return;
    const ok = await confirm({
      title: `Reset the password for ${editingUser.displayName}?`,
      message: 'Their current password stops working straight away. They will need the new password to sign in, so make sure you can pass it on to them.',
      confirmLabel: 'Reset password',
      reversible: false,
    });
    if (!ok) return;
    setResetting(true);
    setError(null);
    try {
      await api.request(`/users/${editingUser.id}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword }) });
      setNewPassword('');
      setNotice(`Password reset for ${editingUser.displayName}.`);
      void loadUsers();
    } catch (err: any) {
      setError(`Failed to reset password. ${userMessage(err)}`);
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
      void loadUsers();
    } catch (err: any) {
      setError(`Failed to unlock account. ${userMessage(err)}`);
    } finally {
      setUnlocking(false);
    }
  };

  const isSelf = (u: UserProfile) => u.id === myId;
  const editingSelf = editingUser ? isSelf(editingUser) : false;
  const isLocked = (u: UserProfile) => u.status === 'LOCKED' || (!!u.lockedUntil && new Date(u.lockedUntil) > new Date());

  /** The two counts the header line shows — see the comment there for why the tiles went. */
  const lockedCount = users.filter(isLocked).length;
  const neverSignedIn = users.filter((u) => !u.lastLoginAt).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {confirmDialog}
      {/*
        FOUR TILES BECAME ONE LINE.

        "Total Users", "Active (shown)", "Locked Out" and "Distinct Roles" filled the top of the
        screen above the actual work, and two of them were answering questions nobody asks: the
        number of DISTINCT ROLES in use is a fact about the permission model, not about people,
        and "Active (shown)" counted whatever the search box happened to be filtering to.

        What is left is the two things that make somebody act — how many accounts there are, and
        who is stuck — and the second one is a button, because a locked-out colleague is a task.
      */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
        <span><strong style={{ color: 'var(--text-primary)' }}>{usersTotal}</strong> {usersTotal === 1 ? 'account' : 'accounts'}</span>
        {lockedCount > 0 && (
          <button
            type="button"
            onClick={() => { setFilterStatus('LOCKED'); setSearchText(''); }}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer',
              background: 'var(--status-pending-bg)', border: '1px solid var(--border-hair)',
              borderRadius: 'var(--radius-full)', padding: '4px 12px',
              color: 'var(--danger)', fontSize: 'var(--text-xs)', fontWeight: 600,
            }}
          >
            <Lock size={13} /> {lockedCount} locked out — show {lockedCount === 1 ? 'them' : 'these'}
          </button>
        )}
        {neverSignedIn > 0 && (
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            {neverSignedIn} {neverSignedIn === 1 ? 'person has' : 'people have'} not signed in yet
          </span>
        )}
      </div>

      {error && <AlertBanner type="error">{error}</AlertBanner>}
      {usersLoadError != null && (
        <LoadFailure loads={[{ label: 'the user directory', query: caughtLoad(usersLoadError, () => void loadUsers()) }]} />
      )}
      {notice && <AlertBanner type="success">{notice}</AlertBanner>}
      {/* The table below, and the KPIs beside it apart from "Total Users" itself, are drawn from
          this one loaded page — say so the moment it is not everyone. */}
      {usersTotal > users.length && (
        <AlertBanner type="error">
          Showing {users.length} of {usersTotal} accounts — refine search to reach someone not
          listed.
        </AlertBanner>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <SearchInput value={searchText} onChange={setSearchText} placeholder="Search by name, username, email..." style={{ minWidth: '200px' }} />
        <FilterSelect value={filterStatus} onChange={(v) => setFilterStatus(v as any)} options={[
          { value: 'ALL', label: 'All Status' },
          { value: 'ACTIVE', label: 'Active' },
          { value: 'SUSPENDED', label: 'Suspended' },
          { value: 'LOCKED', label: 'Locked' },
        ]} />
        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{filteredUsers.length} of {users.length} shown</span>
        <div style={{ marginLeft: 'auto' }}>
          <PrimaryButton onClick={openCreateModal} icon={<UserPlus size={16} />}>
            <span>Add User</span>
          </PrimaryButton>
        </div>
      </div>

      <div>
        <div className="glass-card" style={{ padding: '0', overflow: 'hidden' }}>
          <div style={{ padding: '16px 24px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 'var(--text-md)', fontWeight: 600 }}>Accounts</span>
            <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{filteredUsers.length} of {users.length}</span>
          </div>

          {selectedIds.size > 0 && (
            <div style={{
              display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap',
              padding: '10px 24px', borderBottom: '1px solid var(--border-color)',
              background: 'var(--status-pending-bg)',
            }}>
              <strong style={{ fontSize: 'var(--text-sm)' }}>{selectedIds.size} selected</strong>
              <ToggleRight size={13} style={{ color: 'var(--text-muted)' }} />
              <Select
                value={bulkStatus}
                onChange={(v) => setBulkStatus(v as any)}
                options={[
                  { value: 'ACTIVE', label: 'Activate' },
                  { value: 'SUSPENDED', label: 'Suspend' },
                ]}
                placeholder="Set status…"
                compact
              />
              <button onClick={runBulkStatus} disabled={!bulkStatus || bulkBusy} className="btn btn-primary" style={{ fontSize: 'var(--text-xs)', padding: '6px 12px' }}>
                {bulkBusy ? 'Applying…' : 'Apply'}
              </button>
              <button onClick={() => setSelectedIds(new Set())} className="btn btn-secondary" style={{ fontSize: 'var(--text-xs)', padding: '6px 12px', marginLeft: 'auto' }}>Clear</button>
            </div>
          )}

          {bulkReport && (
            <div style={{ margin: '10px 24px 0', padding: '12px 14px', borderRadius: '8px', fontSize: 'var(--text-xs)', background: 'var(--bg-surface-2)', border: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap', fontWeight: 600, marginBottom: '8px' }}>
                <span style={{ color: 'var(--status-active-text)' }}>{bulkReport.succeeded} moved</span>
                <span style={{ color: 'var(--text-muted)' }}>{bulkReport.skipped.length} skipped</span>
                {bulkReport.failed.length > 0 && <span style={{ color: 'var(--status-danger-text)' }}>{bulkReport.failed.length} failed</span>}
                <button onClick={() => setBulkReport(null)} className="btn btn-secondary" style={{ fontSize: 'var(--text-2xs)', padding: '2px 8px', marginLeft: 'auto' }}>Dismiss</button>
              </div>
              {bulkReport.skipped.length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>Already {userStatusLabel(bulkReport.target).toLowerCase()}:</div>
                  {bulkReport.skipped.map((s) => (
                    <div key={s.id} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                      <span>{displayNameFor(s.id)}</span>
                      <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-2xs)' }}>— {userStatusLabel(s.current)}: {s.reason}</span>
                    </div>
                  ))}
                </div>
              )}
              {bulkReport.failed.length > 0 && (
                <div style={{ marginTop: '6px' }}>
                  <div style={{ color: 'var(--text-muted)', marginBottom: '4px' }}>Failed:</div>
                  {/* Was the first eight characters of the account's UUID — an identifier nobody
                      can act on. The directory is already in memory, so name the person. */}
                  {bulkReport.failed.map((f) => (
                    <div key={f.id} style={{ display: 'flex', gap: '8px', alignItems: 'baseline' }}>
                      <span>{displayNameFor(f.id)}</span><span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-2xs)' }}>— {f.reason}</span>
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
                  <th style={{ padding: '12px 24px 12px 6px', textAlign: 'left', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>User</th>
                  <th style={{ padding: '12px 24px', textAlign: 'left', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Roles</th>
                  <th style={{ padding: '12px 24px', textAlign: 'left', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Last Login</th>
                  <th style={{ padding: '12px 24px', textAlign: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Status</th>
                  <th style={{ padding: '12px 24px 12px 6px', textAlign: 'right', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.length === 0 ? (
                  <tr><td colSpan={6} style={{ padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                      <UsersIcon size={30} style={{ opacity: 0.4 }} />
                      {/* The banner above carries the reason; this only has to stop contradicting
                          it. Offering "Add User" here would invite an administrator to create an
                          account because the directory looked empty, when it was merely unread. */}
                      <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>
                        {usersLoadError != null
                          ? 'The directory could not be loaded — see above.'
                          : searchText || filterStatus !== 'ALL' ? 'No users match your filters' : 'No users yet'}
                      </span>
                      {usersLoadError == null && !(searchText || filterStatus !== 'ALL') && (
                        <button onClick={() => setShowCreateModal(true)} className="btn btn-primary" style={{ marginTop: 6, padding: '7px 14px', fontSize: 'var(--text-xs)', display: 'flex', alignItems: 'center', gap: 6 }}>
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
                            <div style={{ fontSize: 'var(--text-base)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                              {u.displayName}
                              {self && <span style={{ fontSize: 'var(--text-3xs)', color: 'var(--accent-primary)', fontWeight: 700 }}>(you)</span>}
                              {locked && <span title={`${u.failedLoginAttempts} failed attempt(s)`}><Lock size={12} style={{ color: 'var(--danger)' }} /></span>}
                            </div>
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>@{u.username} · {u.email}</div>
                          </div>
                        </div>
                      </td>
                      <td style={{ padding: '14px 24px' }}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                          {u.roles.map((r) => (
                            <span key={r.id} style={{ fontSize: 'var(--text-3xs)', background: 'var(--status-pending-bg)', color: 'var(--accent-secondary)', padding: '2px 8px', borderRadius: 'var(--radius-full)', fontWeight: 600 }}>
                              {roleLabel(r.name)}
                            </span>
                          ))}
                          {u.roles.length === 0 && <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>No roles assigned</span>}
                        </div>
                      </td>
                      <td style={{ padding: '14px 24px', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}><Clock size={11} style={{ opacity: 0.6 }} />
                          {/* "Never" on its own reads as a fault. It usually means the invite is
                              still sitting in their inbox, which is a different thing to do about. */}
                          {u.lastLoginAt ? fmtRelative(u.lastLoginAt) : <span style={{ color: 'var(--text-muted)' }}>Invited — not signed in yet</span>}</span>
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
                        <div style={{ fontSize: 'var(--text-3xs)', color: STATUS_TONE[u.status] ?? 'var(--text-muted)', marginTop: '2px', fontWeight: 600 }}>{userStatusLabel(u.status)}</div>
                      </td>
                      <td style={{ padding: '14px 24px', textAlign: 'right' }}>
                        <button onClick={() => startEditUser(u)}
                          style={{ background: 'var(--status-pending-bg)', border: '1px solid rgba(216,174,71,0.25)', color: 'var(--accent-secondary)', padding: '6px 12px', borderRadius: 'var(--radius-md)', cursor: 'pointer', fontSize: 'var(--text-xs)', fontWeight: 500 }}>
                          Manage
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
            Edit {editingUser.displayName}{editingSelf && <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--accent-primary)', fontWeight: 700 }}>(you)</span>}
          </span>
        ) : ''}
      >
        {editingUser && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

              {isLocked(editingUser) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', marginBottom: '16px', borderRadius: '8px', background: 'var(--status-cancelled-bg)', border: '1px solid var(--status-cancelled)' }}>
                  <Lock size={15} style={{ color: 'var(--danger)', flexShrink: 0 }} />
                  <div style={{ flex: 1, fontSize: 'var(--text-xs)' }}>
                    <strong style={{ color: 'var(--danger)' }}>Locked out</strong> — {editingUser.failedLoginAttempts} failed login attempt(s).
                  </div>
                  <button type="button" onClick={handleUnlock} disabled={unlocking} className="btn btn-secondary"
                    style={{ fontSize: 'var(--text-2xs)', padding: '5px 10px', display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}>
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
                  {/*
                    WHAT THIS PERSON CAN ACTUALLY DO, IN WORDS.

                    The roles were chips — "Desk Operator", "Auditor" — and nothing anywhere on the
                    screen said what either of them lets somebody see or change. The sentences were
                    in the shared vocabulary the whole time (`ROLE_DESCRIPTIONS`); no screen had
                    ever put them in front of the person deciding.
                  */}
                  {editingUser.roles.length > 0 && (
                    <div style={{ marginBottom: '14px', padding: '12px 14px', borderRadius: '8px', background: 'var(--bg-surface-2)', border: '1px solid var(--border-hair)' }}>
                      <div style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: '6px' }}>
                        What {editingUser.firstName} can do
                      </div>
                      <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '5px' }}>
                        {editingUser.roles.map((r) => (
                          <li key={r.id} style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                            <strong style={{ color: 'var(--text-primary)' }}>{roleLabel(r.name)}</strong>
                            {' — '}
                            {ROLE_DESCRIPTIONS[r.name as SystemRole] ?? 'a custom role; see Roles & Permissions.'}
                          </li>
                        ))}
                      </ul>
                      {(editingUser.regions?.length ?? 0) > 0 && (
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: '8px' }}>
                          Only in {editingUser.regions!.map((r) => REGION_LABELS[r as Region] ?? r).join(', ')}.
                        </div>
                      )}
                    </div>
                  )}

                  <label className="form-label" style={{ marginBottom: '8px', display: 'block' }}>System Roles</label>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '180px', overflowY: 'auto', background: 'var(--bg-secondary)', padding: '12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
                    {roles.map((r) => {
                      const isChecked = editRoleIds.includes(r.id);
                      const lockedSelfAdmin = editingSelf && r.name === 'ADMIN' && isChecked;
                      return (
                        <label key={r.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: 'var(--text-sm)', cursor: lockedSelfAdmin ? 'not-allowed' : 'pointer', opacity: lockedSelfAdmin ? 0.6 : 1 }}
                          title={lockedSelfAdmin ? 'You cannot remove your own Super Administrator role' : undefined}>
                          <input type="checkbox" checked={isChecked} disabled={lockedSelfAdmin}
                            onChange={() => setEditRoleIds(isChecked ? editRoleIds.filter((id) => id !== r.id) : [...editRoleIds, r.id])} />
                          <span>{roleLabel(r.name)}</span>
                          {lockedSelfAdmin && <Lock size={11} style={{ color: 'var(--text-muted)' }} />}
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <label className="form-label" style={{ marginBottom: '4px', display: 'block' }}>Operational Regions</label>
                  <p style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginBottom: '8px' }}>
                    Confines this account to its territory on the operations desks (planning, assignments,
                    scheduling, branches, map). Leave all unticked for national desks — HR, data entry,
                    validation, finance — which see every region.
                  </p>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', background: 'var(--bg-secondary)', padding: '12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
                    {REGION_ORDER.map((r) => {
                      const isChecked = editRegions.includes(r);
                      return (
                        <label key={r} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)', cursor: 'pointer' }}>
                          <input type="checkbox" checked={isChecked}
                            onChange={() => setEditRegions(isChecked ? editRegions.filter((v) => v !== r) : [...editRegions, r])} />
                          <span>{REGION_LABELS[r]}</span>
                        </label>
                      );
                    })}
                  </div>
                  {editRegions.length > 0 && (
                    <p style={{ fontSize: 'var(--text-2xs)', color: 'var(--warning)', marginTop: '6px' }}>
                      Restricted account: the server will refuse this user data outside{' '}
                      {editRegions.map((r) => REGION_LABELS[r as Region] ?? r).join(', ')}.
                    </p>
                  )}
                </div>

                {(() => {
                  const needsClient = roleIdsIncludeClientUser(editRoleIds);
                  return (
                    <div>
                      <label className="form-label" style={{ marginBottom: '4px', display: 'block' }}>
                        Client{needsClient && <span style={{ color: 'var(--danger)' }}> *</span>}
                      </label>
                      <p style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginBottom: '8px' }}>
                        Which bank or NBFC this account belongs to. Required whenever Client User is
                        one of the roles above — an account with that role and no client assigned
                        cannot read anything at all, by design, rather than seeing every client's data.
                      </p>
                      <Select
                        value={editClientId}
                        onChange={setEditClientId}
                        options={(clientOptions ?? []).map((c): SelectOption => ({ value: c.id, label: c.name }))}
                        placeholder="No client — staff account"
                        clearable
                        error={needsClient && !editClientId}
                      />
                    </div>
                  );
                })()}

                <div style={{ display: 'flex', gap: '12px', marginTop: '4px' }}>
                  <button type="submit" disabled={submitting} style={{ flex: 1, background: 'var(--gradient-neon)', color: 'var(--on-gradient)', border: 'none', padding: '10px', borderRadius: 'var(--radius-md)', fontWeight: 600, cursor: 'pointer' }}>{submitting ? 'Saving…' : 'Save Modifications'}</button>
                  <button type="button" onClick={() => setEditingUser(null)} style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', color: 'var(--text-primary)', padding: '10px 16px', borderRadius: 'var(--radius-md)', cursor: 'pointer' }}>Cancel</button>
                </div>
              </form>

              {/*
                THE PASSWORD IS THEIRS TO CHOOSE, NOT YOURS TO INVENT.

                This used to be a box an administrator typed a password into, with a note saying
                "share it with them directly" — so the credential existed in a chat message, two
                people knew it, and it was rarely changed. The link sends them somewhere to set
                their own; typing one for them is still possible, one click further in, because a
                deployment with email switched off still has to be able to get somebody back in.
              */}
              <div style={{ marginTop: '20px', paddingTop: '18px', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                  <KeyRound size={15} style={{ color: 'var(--warning)' }} />
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Password</span>
                </div>
                <p style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginBottom: '10px' }}>
                  {editingUser.email
                    ? <>Emails {editingUser.displayName} a link to choose a new password. It works once and expires in 48 hours.</>
                    : <>{editingUser.displayName} has no email address on file, so there is nowhere to send a link. Add one above, or set a password by hand below.</>}
                </p>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <button type="button" onClick={handleSendSetupLink} disabled={sendingLink || !editingUser.email}
                    className="btn btn-primary" style={{ padding: '8px 14px', fontSize: 'var(--text-xs)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <Mail size={14} /> {sendingLink ? 'Sending…' : 'Email a password link'}
                  </button>
                  {!showManualReset && (
                    <button type="button" onClick={() => setShowManualReset(true)}
                      style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 'var(--text-xs)', textDecoration: 'underline' }}>
                      or set one by hand
                    </button>
                  )}
                </div>
                {showManualReset && (
                  <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                    <input type="text" className="form-input" placeholder="New password (min 10 characters)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} style={{ flex: 1 }} />
                    <button type="button" onClick={handleResetPassword} disabled={resetting || newPassword.length < 10}
                      className="btn btn-secondary" style={{ padding: '8px 14px', fontSize: 'var(--text-xs)', whiteSpace: 'nowrap' }}>
                      {resetting ? 'Resetting…' : 'Set it'}
                    </button>
                  </div>
                )}
              </div>

              <div style={{ marginTop: '20px', paddingTop: '18px', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: '8px' }}>Recent Activity</div>
                <UserActivityList userId={editingUser.id} />
              </div>
          </div>
        )}
      </DetailDrawer>

      {showCreateModal && (
        <AddUserDialog
          roles={roles}
          clients={clientOptions}
          onClose={() => setShowCreateModal(false)}
          onAdded={(summary) => {
            setShowCreateModal(false);
            setInviteResult(summary);
            void loadUsers();
          }}
        />
      )}

      {inviteResult && (
        <InviteResult result={inviteResult} onClose={() => setInviteResult(null)} />
      )}
    </div>
  );
};


export default DirectoryPanel;
