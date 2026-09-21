import React, { useMemo, useState } from 'react';
import { Mail, Copy, ChevronDown, ChevronRight } from 'lucide-react';
import { ROLE_DESCRIPTIONS, REGION_ORDER, REGION_LABELS, Region, roleLabel, SystemRole, type OutboundMessageReceipt } from '@fapoms/shared';
import { Modal, Select, SelectOption, AlertBanner } from '../../components/ui';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { StyledInput } from '../../components/ui/inputs';
import { DeliveryNote } from '../../components/DeliveryNote';

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

/**
 * Roles that are not what somebody adding a colleague is looking for.
 *
 * `ASSAYER` belongs to a field assayer created by the workforce pipeline, not by this form.
 * `CLIENT_USER` is somebody outside the company. Custom roles are real but rare. All three stayed
 * in one flat list of nine, so the dialog opened on a wall of text and the four roles a staff
 * account actually gets were below the fold.
 */
const UNCOMMON_ROLES = new Set(['ASSAYER', 'CLIENT_USER']);

/** The order a person reads them in: broadest first, then the desk, then the watchers. */
const ROLE_ORDER = ['ADMIN', 'DEVELOPER', 'OPERATIONS', 'DESK', 'DESK_OPERATOR', 'AUDITOR', 'PRODUCT_SUPPORT'];

function splitRoles(roles: RoleRow[]): { common: RoleRow[]; rest: RoleRow[] } {
  const common: RoleRow[] = [];
  const rest: RoleRow[] = [];
  for (const role of roles) {
    const known = ROLE_ORDER.indexOf(role.name);
    if (UNCOMMON_ROLES.has(role.name) || known === -1) rest.push(role);
    else common.push(role);
  }
  common.sort((a, b) => ROLE_ORDER.indexOf(a.name) - ROLE_ORDER.indexOf(b.name));
  return { common, rest };
}

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
  onAdded: (summary: InviteSummary) => void;
}> = ({ roles, clients, onClose, onAdded }) => {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [regions, setRegions] = useState<string[]>([]);
  const [clientId, setClientId] = useState('');
  const [usernameOverride, setUsernameOverride] = useState<string | null>(null);
  const [showUsername, setShowUsername] = useState(false);
  const [showRest, setShowRest] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const username = usernameOverride ?? suggestUsername(firstName, lastName);
  const { common, rest } = useMemo(() => splitRoles(roles), [roles]);
  const toggleRole = (id: string) => setRoleIds((prev) => (
    prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]
  ));
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
      const invite = await api.request<{ emailDelivery: OutboundMessageReceipt | null; link: string }>(
        `/users/${created.id}/send-setup-link`,
        { method: 'POST', body: JSON.stringify({ reason: 'NEW_ACCOUNT' }) },
      );
      onAdded({
        displayName: `${firstName.trim()} ${lastName.trim()}`,
        email: email.trim(),
        emailDelivery: invite?.emailDelivery ?? null,
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
      width="860px"
      asForm
      onSubmit={submit}
      footer={(
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="submit" disabled={!ready || busy} className="btn btn-primary"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '7px', whiteSpace: 'nowrap', opacity: !ready || busy ? 0.55 : 1 }}>
            <Mail size={15} /> {busy ? 'Creating…' : 'Create & send invite'}
          </button>
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <span style={{ marginLeft: 'auto', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
            They set their own password — you never see it.
          </span>
        </div>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {error && <AlertBanner type="error" message={error} onClose={() => setError(null)} />}

        {/*
          TWO COLUMNS: WHO THEY ARE, AND WHAT THEY DO.

          One flat column put four short identity fields above a wall of nine role descriptions, so
          the dialog opened on text nobody reads and the Create button sat off the bottom of the
          screen. These are two different questions and they fit side by side.
        */}
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1.1fr)', gap: '22px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <Field label="First name">
              <StyledInput value={firstName} autoFocus
                onChange={(e) => setFirstName(e.target.value)} required />
            </Field>
            <Field label="Last name">
              <StyledInput value={lastName}
                onChange={(e) => setLastName(e.target.value)} required />
            </Field>
            <Field label="Work email" hint="Where the invite goes.">
              <StyledInput type="email" value={email}
                onChange={(e) => setEmail(e.target.value)} required />
            </Field>

            {/* Derived and shown, not asked for. */}
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', minHeight: '18px' }}>
              {username && <>Signs in as <strong style={{ color: 'var(--text-secondary)' }}>{username}</strong></>}
              {!showUsername && username && (
                <button type="button" onClick={() => setShowUsername(true)}
                  style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', cursor: 'pointer', fontSize: 'var(--text-xs)', textDecoration: 'underline', marginLeft: '6px' }}>
                  change
                </button>
              )}
              {showUsername && (
                <StyledInput value={username} style={{ marginTop: '6px' }}
                  onChange={(e) => setUsernameOverride(e.target.value)} />
              )}
            </div>

            {needsClient && (
              <Field label="Which client?" hint="Client accounts see only their own work.">
                <Select
                  value={clientId}
                  onChange={setClientId}
                  options={(clients ?? []).map((c): SelectOption => ({ value: c.id, label: c.name }))}
                  placeholder="Choose a client…"
                />
              </Field>
            )}

            <Collapsible
              title="Limit to regions"
              summary={regions.length === 0 ? 'All of India' : regions.map((r) => REGION_LABELS[r as Region] ?? r).join(', ')}
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                {REGION_ORDER.map((r) => {
                  const checked = regions.includes(r);
                  return (
                    <label key={r} style={{
                      display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer',
                      fontSize: 'var(--text-xs)', padding: '4px 10px', borderRadius: 'var(--radius-full)',
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
                Empty means the whole country. Tick regions and their lists, maps and figures show
                only those.
              </p>
            </Collapsible>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', minWidth: 0 }}>
            <label className="form-label" style={{ margin: 0 }}>What will they do here?</label>
            {/* No inner scroller: one that clipped a role card mid-sentence, inside a dialog that
                scrolls anyway, read as a rendering fault. The dialog grows and scrolls as one. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {common.map((role) => <RoleChoice key={role.id} role={role} checked={roleIds.includes(role.id)} onToggle={toggleRole} />)}

              {rest.length > 0 && (
                <>
                  <button type="button" onClick={() => setShowRest(!showRest)}
                    style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 'var(--text-xs)', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                    {showRest ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    Other roles ({rest.length})
                  </button>
                  {showRest && rest.map((role) => <RoleChoice key={role.id} role={role} checked={roleIds.includes(role.id)} onToggle={toggleRole} />)}
                </>
              )}
            </div>
            {roleIds.length === 0 && (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                Pick at least one — an account with no role sees nothing.
              </span>
            )}
          </div>
        </div>
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
/** One role, as a row that says what it does — the sentence is the whole point of the redesign. */
const RoleChoice: React.FC<{ role: RoleRow; checked: boolean; onToggle: (id: string) => void }> = ({
  role, checked, onToggle,
}) => (
  <label
    style={{
      display: 'flex', gap: '9px', alignItems: 'flex-start', cursor: 'pointer',
      padding: '9px 11px', borderRadius: '8px',
      border: `1px solid ${checked ? 'var(--accent-primary)' : 'var(--border-hair)'}`,
      background: checked ? 'var(--status-pending-bg)' : 'var(--bg-surface-2)',
    }}
  >
    <input type="checkbox" checked={checked} onChange={() => onToggle(role.id)} style={{ marginTop: '2px' }} />
    <span style={{ minWidth: 0 }}>
      <span style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
        {role.displayName || roleLabel(role.name)}
      </span>
      <span style={{ display: 'block', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
        {ROLE_DESCRIPTIONS[role.name as SystemRole] ?? 'A custom role — see Roles & Permissions for what it grants.'}
      </span>
    </span>
  </label>
);

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

/**
 * What the administrator is told after asking for a password link to be emailed.
 *
 * `emailDelivery` is the queued email's receipt. The email used to be sent inside the request, so
 * the screen knew at once whether it went; now it follows the receipt — the link box appears only if
 * the email fails, exactly as before, just without the administrator waiting on the mail server.
 */
export interface InviteSummary {
  displayName: string;
  email: string;
  emailDelivery: OutboundMessageReceipt | null;
  link: string;
}

/** What the administrator is shown once the account exists. */
export const InviteResult: React.FC<{
  result: InviteSummary;
  onClose: () => void;
}> = ({ result, onClose }) => {
  const [copied, setCopied] = useState(false);
  return (
    <Modal open onClose={onClose} title={`${result.displayName} is set up`} width="520px"
      footer={<button type="button" onClick={onClose} className="btn btn-primary">Done</button>}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', fontSize: 'var(--text-sm)', lineHeight: 1.6 }}>
        {/*
          The same delivery line every other screen uses. The link appears only while the email has
          not gone: a working password link left on screen after it was delivered is a credential on
          display for no reason, and saying "invite sent" when nothing was is how somebody ends up
          waiting for a message nobody posted.
        */}
        <DeliveryNote
          receipt={result.emailDelivery}
          what="a link to choose their password"
          noAddress={`There is no email address on file, so pass this link to ${result.displayName} yourself.`}
          fallback={`Pass this link to ${result.displayName} yourself — it works once and expires in 48 hours.`}
          whenUndelivered={(
            <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
              <StyledInput readOnly value={result.link} style={{ flex: 1, fontFamily: 'monospace', fontSize: 'var(--text-xs)' }} />
              <button type="button" className="btn btn-secondary"
                onClick={() => { void navigator.clipboard?.writeText(result.link); setCopied(true); }}>
                <Copy size={14} /> {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          )}
        />
      </div>
    </Modal>
  );
};

export default AddUserDialog;
