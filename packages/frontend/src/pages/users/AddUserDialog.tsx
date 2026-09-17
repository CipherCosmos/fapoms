import React, { useMemo, useState } from 'react';
import { Mail, Check, AlertCircle, Copy, ChevronDown, ChevronRight } from 'lucide-react';
import { ROLE_DESCRIPTIONS, REGION_ORDER, REGION_LABELS, Region, roleLabel, SystemRole } from '@fapoms/shared';
import { Modal, Select, SelectOption, AlertBanner } from '../../components/ui';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';

/**
 * ADDING A COLLEAGUE, IN AS FEW DECISIONS AS THE JOB ACTUALLY HAS.
 *
 * The old form asked for a username, an email, a first name, a last name, and then offered a bare
 * column of checkboxes — ADMIN, DESK_OPERATOR, AUDITOR — with nothing on screen saying what any of
 * them let a person do. Whoever was adding the account had to already know the permission model to
 * use it, so in practice everyone was given the role the last person was given.
 *
 * Three things changed:
 *   1. The name is one field. The username is derived and shown, not asked for — it can still be
 *      edited, behind a link, for the rare account that needs a particular one.
 *   2. Each role is a row that SAYS what it does (`ROLE_DESCRIPTIONS`, which already existed in
 *      the shared vocabulary and which no screen had ever shown).
 *   3. No password is invented here. The person gets a link and chooses their own.
 */

interface RoleRow { id: string; name: string; displayName?: string }

const CLIENT_USER_ROLE_NAME = 'CLIENT_USER';

/** `Priya Sharma` → `priya.sharma`, the convention every existing account already follows. */
export function suggestUsername(firstName: string, lastName: string): string {
  const clean = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  const first = clean(firstName);
  const last = clean(lastName);
  if (!first && !last) return '';
  return last ? `${first}.${last}` : first;
}

export const AddUserDialog: React.FC<{
  roles: RoleRow[];
  clients: Array<{ id: string; name: string }> | undefined;
  onClose: () => void;
  onAdded: (summary: { displayName: string; email: string; emailed: boolean; link: string }) => void;
}> = ({ roles, clients, onClose, onAdded }) => {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [clientId, setClientId] = useState('');
  const [usernameOverride, setUsernameOverride] = useState<string | null>(null);
  const [showUsername, setShowUsername] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const username = usernameOverride ?? suggestUsername(firstName, lastName);
  const needsClient = useMemo(
    () => roles.filter((r) => roleIds.includes(r.id)).some((r) => r.name === CLIENT_USER_ROLE_NAME),
    [roles, roleIds],
  );
  const ready = firstName.trim() && lastName.trim() && email.trim() && username
    && roleIds.length > 0 && (!needsClient || clientId);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const created = await api.request<{ id: string }>('/users', {
        method: 'POST',
        body: JSON.stringify({
          username, email: email.trim(), firstName: firstName.trim(), lastName: lastName.trim(),
          roleIds, clientId: clientId || undefined,
          regions: regions.length > 0 ? regions : undefined,
        }),
      });
      /*
        Created, then invited — two calls, because the account must exist before there is anything
        to send a link for. If the email fails the account is still there and the link comes back
        for the administrator to pass on; a link is safe to hand over in a way a password is not,
        since only its holder can spend it and only once.
      */
      const invite = await api.request<{ emailed: boolean; link: string }>(
        `/users/${created.id}/send-setup-link`,
        { method: 'POST', body: JSON.stringify({ reason: 'NEW_ACCOUNT' }) },
      );
      onAdded({
        displayName: `${firstName.trim()} ${lastName.trim()}`,
        email: email.trim(),
        emailed: Boolean(invite?.emailed),
        link: invite?.link ?? '',
      });
    } catch (err) {
      setError(userMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Add someone to the team"
      width="620px"
      asForm
      onSubmit={submit}
      footer={(
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button type="submit" disabled={!ready || busy} className="btn btn-primary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', opacity: !ready || busy ? 0.55 : 1 }}>
            <Mail size={15} /> {busy ? 'Creating…' : 'Create and email an invite'}
          </button>
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <span style={{ marginLeft: 'auto', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
            They choose their own password — you never see it.
          </span>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
        {error && <AlertBanner type="error" message={error} onClose={() => setError(null)} />}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <Field label="First name">
            <input className="form-input" value={firstName} autoFocus
              onChange={(e) => setFirstName(e.target.value)} required />
          </Field>
          <Field label="Last name">
            <input className="form-input" value={lastName}
              onChange={(e) => setLastName(e.target.value)} required />
          </Field>
        </div>

        <Field label="Work email" hint="The invite goes here, and it is how they sign in if they forget their username.">
          <input className="form-input" type="email" value={email}
            onChange={(e) => setEmail(e.target.value)} required />
        </Field>

        {/* Derived, shown, and editable — but not a question anybody has to answer. */}
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          Username: <strong style={{ color: 'var(--text-secondary)' }}>{username || '—'}</strong>
          {!showUsername && (
            <button type="button" onClick={() => setShowUsername(true)}
              style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: 'var(--text-xs)', textDecoration: 'underline', marginLeft: '8px' }}>
              change
            </button>
          )}
          {showUsername && (
            <input className="form-input" value={username} style={{ marginTop: '6px' }}
              onChange={(e) => setUsernameOverride(e.target.value)} />
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label className="form-label" style={{ margin: 0 }}>What will they do here?</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {roles.map((role) => {
              const checked = roleIds.includes(role.id);
              const description = ROLE_DESCRIPTIONS[role.name as SystemRole];
              return (
                <label
                  key={role.id}
                  style={{
                    display: 'flex', gap: '10px', alignItems: 'flex-start', cursor: 'pointer',
                    padding: '10px 12px', borderRadius: '8px',
                    border: `1px solid ${checked ? 'var(--accent-primary)' : 'var(--border-hair)'}`,
                    background: checked ? 'var(--status-pending-bg)' : 'var(--bg-surface-2)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => setRoleIds(checked ? roleIds.filter((id) => id !== role.id) : [...roleIds, role.id])}
                    style={{ marginTop: '3px' }}
                  />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                      {role.displayName || roleLabel(role.name)}
                    </span>
                    {/* The sentence that was in the shared vocabulary all along and that no screen
                        had ever put in front of the person choosing. */}
                    <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      {description ?? 'A custom role — see Roles & Permissions for what it grants.'}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
          {roleIds.length === 0 && (
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              Pick at least one. Somebody with no role can sign in and see nothing.
            </span>
          )}
        </div>

        {needsClient && (
          <Field label="Which client do they belong to?" hint="Client accounts only ever see their own work.">
            <Select
              value={clientId}
              onChange={setClientId}
              options={(clients ?? []).map((c): SelectOption => ({ value: c.id, label: c.name }))}
              placeholder="Choose a client…"
            />
          </Field>
        )}

        <Collapsible title="Limit them to certain regions" summary={
          regions.length === 0
            ? 'All of India — the usual answer'
            : regions.map((r) => REGION_LABELS[r as Region] ?? r).join(', ')
        }>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {REGION_ORDER.map((r) => {
              const checked = regions.includes(r);
              return (
                <label key={r} style={{
                  display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer',
                  fontSize: 'var(--text-xs)', padding: '5px 10px', borderRadius: 'var(--radius-full)',
                  border: `1px solid ${checked ? 'var(--accent-primary)' : 'var(--border-hair)'}`,
                  background: checked ? 'var(--status-pending-bg)' : 'transparent',
                }}>
                  <input type="checkbox" checked={checked}
                    onChange={() => setRegions(checked ? regions.filter((v) => v !== r) : [...regions, r])} />
                  {REGION_LABELS[r as Region] ?? r}
                </label>
              );
            })}
          </div>
          <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', margin: '8px 0 0', lineHeight: 1.5 }}>
            Leave every box empty and they see the whole country. Tick one or more and they see only
            those regions — the lists, the maps and the figures all follow.
          </p>
        </Collapsible>
      </div>
    </Modal>
  );
};

/**
 * A label, its input, and the hint that belongs to it.
 *
 * `htmlFor` is not decoration: without it a screen reader announces an unlabelled box, and
 * clicking the words does not focus the field. The id is derived from the label so callers cannot
 * forget to pass one.
 */
const Field: React.FC<{ label: string; hint?: string; children: React.ReactElement }> = ({ label, hint, children }) => {
  const id = `add-user-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '5px' }}>
      <label className="form-label" htmlFor={id} style={{ margin: 0 }}>{label}</label>
      {React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })}
      {hint && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{hint}</span>}
    </div>
  );
};

/** Kept shut by default: the answer is "all of India" for almost every account. */
const Collapsible: React.FC<{ title: string; summary: string; children: React.ReactNode }> = ({ title, summary, children }) => {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ borderTop: '1px solid var(--border-hair)', paddingTop: '12px' }}>
      <button type="button" onClick={() => setOpen(!open)}
        style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', fontWeight: 600 }}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />} {title}
        <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>· {summary}</span>
      </button>
      {open && <div style={{ marginTop: '10px' }}>{children}</div>}
    </div>
  );
};

/** What the administrator is shown once the account exists. */
export const InviteResult: React.FC<{
  result: { displayName: string; email: string; emailed: boolean; link: string };
  onClose: () => void;
}> = ({ result, onClose }) => {
  const [copied, setCopied] = useState(false);
  return (
    <Modal open onClose={onClose} title={`${result.displayName} is set up`} width="520px"
      footer={<button type="button" onClick={onClose} className="btn btn-primary">Done</button>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
        {result.emailed ? (
          <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', color: 'var(--text-secondary)' }}>
            <Check size={18} style={{ color: 'var(--success)', flexShrink: 0, marginTop: '2px' }} />
            <span>
              An invite is on its way to <strong>{result.email}</strong>. They choose their own
              password from the link — it works once and expires in 48 hours.
            </span>
          </div>
        ) : (
          <>
            {/* Email is off or the send failed. Saying "invite sent" here is how somebody ends up
                waiting for a message nobody posted. */}
            <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', color: 'var(--text-secondary)' }}>
              <AlertCircle size={18} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: '2px' }} />
              <span>
                The account exists, but the email could not be sent. Pass this link to{' '}
                <strong>{result.displayName}</strong> yourself — it works once and expires in 48 hours.
              </span>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input className="form-input" readOnly value={result.link} style={{ flex: 1, fontFamily: 'monospace', fontSize: 'var(--text-xs)' }} />
              <button type="button" className="btn btn-secondary"
                onClick={() => { void navigator.clipboard?.writeText(result.link); setCopied(true); }}>
                <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default AddUserDialog;
