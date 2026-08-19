import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Bell, Mail, RotateCcw, Save, Eye, FileText, Info } from 'lucide-react';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { Modal, AlertBanner, useToast, Select, useConfirm } from '../../components/ui';
import { useCurrentRoles, canAdministerNotifications } from '../../hooks/useCurrentRoles';

/**
 * Notification & Email Management.
 *
 * Everything about how the platform speaks to people, in one place: whether mail can leave the
 * building at all, which events reach whom on which channel, and the exact words each one uses.
 *
 * The shipped catalog in the backend stays the default. This screen writes *overrides* — so
 * "Reset" is a real restoration rather than a guess, and an event nobody has touched keeps
 * following the defaults as they improve. Every row shows which fields have been customised.
 */

type Channel = 'IN_APP' | 'PUSH' | 'EMAIL';

interface CatalogType {
  type: string;
  category: string;
  priority: string;
  roles: string[];
  special?: string[];
  channels: Channel[];
  title: string;
  body: string;
  link?: string;
  emailSubject?: string | null;
  emailBody?: string | null;
  enabled: boolean;
  overridden: string[];
  notes: string | null;
  placeholders: string[];
  collapse?: { windowSeconds: number };
  defaults: { channels: string[]; priority: string; roles: string[]; title: string; body: string; link?: string };
}

interface CatalogResponse {
  types: CatalogType[];
  channels: string[];
  priorities: string[];
  categories: string[];
  roles: string[];
}

interface EmailStatus {
  enabled: boolean;
  transport: 'GMAIL' | 'SMTP' | null;
  account: string | null;
  from: string | null;
  appPublicUrl: string;
  digestCron: string;
  digestTimeZone: string;
  hint: string | null;
}

const CHANNELS: Channel[] = ['IN_APP', 'PUSH', 'EMAIL'];
const CHANNEL_LABEL: Record<Channel, string> = { IN_APP: 'In-app', PUSH: 'Push', EMAIL: 'Email' };

const PRIORITY_TONE: Record<string, string> = {
  CRITICAL: 'var(--danger)',
  HIGH: 'var(--warning)',
  NORMAL: 'var(--text-secondary)',
  LOW: 'var(--text-muted)',
};


const input: React.CSSProperties = {
  width: '100%', padding: '8px 10px', background: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)', borderRadius: '6px',
  color: 'var(--text-primary)', fontSize: '13px', boxSizing: 'border-box',
};

export const NotificationAdmin: React.FC = () => {
  const canAdminister = canAdministerNotifications(useCurrentRoles());
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { confirm, confirmDialog } = useConfirm();
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<CatalogType | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Kept only to tell the reader whether email is actually reaching anyone; configuring it
  // lives in Platform Settings, which is where the link below goes.
  const { data: statusRes } = useQuery({
    queryKey: ['notification-admin', 'email-status'],
    queryFn: () => api.request<any>('/notification-admin/email/status'),
  });
  const status: EmailStatus | null = statusRes ? (statusRes as EmailStatus) : null;

  const { data: catalogRes, isLoading: loadingCatalog } = useQuery({
    queryKey: ['notification-admin', 'catalog'],
    queryFn: () => api.request<any>('/notification-admin/catalog'),
  });
  const catalog: CatalogResponse | null = catalogRes ? (catalogRes as CatalogResponse) : null;

  const types = useMemo(() => {
    const all = catalog?.types ?? [];
    const q = search.trim().toLowerCase();
    return all.filter(
      (t) =>
        (categoryFilter === 'ALL' || t.category === categoryFilter) &&
        (!q || t.type.toLowerCase().includes(q) || t.title.toLowerCase().includes(q)),
    );
  }, [catalog, categoryFilter, search]);

  const counts = useMemo(() => {
    const all = catalog?.types ?? [];
    return {
      total: all.length,
      emailing: all.filter((t) => t.enabled && t.channels.includes('EMAIL')).length,
      disabled: all.filter((t) => !t.enabled).length,
      customised: all.filter((t) => t.overridden.length > 0).length,
    };
  }, [catalog]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['notification-admin'] });

  const saveType = async (type: string, patch: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api.request(`/notification-admin/catalog/${type}`, { method: 'PUT', body: JSON.stringify(patch) });
      refresh();
      return true;
    } catch (err: any) {
      setError(userMessage(err));
      toast({ type: 'error', title: 'Could not save', message: userMessage(err) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggleChannel = async (t: CatalogType, channel: Channel) => {
    const next = t.channels.includes(channel)
      ? t.channels.filter((c) => c !== channel)
      : [...t.channels, channel];
    if (next.length === 0) {
      toast({
        type: 'error',
        title: 'That would reach nobody',
        message: 'Leave at least one channel on, or switch the event off entirely.',
      });
      return;
    }
    await saveType(t.type, { channels: next });
  };

  const resetType = async (t: CatalogType) => {
    // Names the notification by its human title, not by `t.type` — the raw catalog key
    // (ASSIGNMENT_SLA_BREACHED and friends) is what the row is keyed on, not what the
    // administrator recognises it as.
    const ok = await confirm({
      title: `Reset "${t.title}" to its shipped default?`,
      message: 'Every customisation made to this notification — its wording, channels and recipients — is removed and the original comes back.',
      confirmLabel: 'Reset to default',
      reversible: false,
      tone: 'danger',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.request(`/notification-admin/catalog/${t.type}`, { method: 'DELETE' });
      toast('success', 'Reset to the shipped default.');
      refresh();
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not reset', message: userMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {confirmDialog}
      <div>
        <h2 style={{ fontSize: '20px', fontWeight: 700, margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Bell style={{ color: 'var(--accent)' }} /> Notification Rules
        </h2>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          Which events the platform raises, who receives them, on which channels, and in what words.
          Email delivery itself is configured under Platform Settings.
        </span>
      </div>

      {error && <AlertBanner type="error">{error}</AlertBanner>}


      <>
          {/**
            * One place per concern.
            *
            * Whether email works at all — the mailbox, the credentials, the address links point
            * at, when the morning brief goes out — is configuration, and it lives in Platform
            * Settings with the rest of it. This page owns something different: which events
            * exist, who receives them, on which channels, and in what words. The two used to
            * overlap, and a screen showing the same switch twice teaches people that neither
            * copy can be trusted.
            */}
          <div className="glass-card" style={{ padding: '11px 14px', display: 'flex', gap: '9px', alignItems: 'center', flexWrap: 'wrap' }}>
            <Mail size={14} style={{ color: status?.enabled ? 'var(--success, #34a853)' : 'var(--warning)', flexShrink: 0 }} />
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              {status?.enabled
                ? <>Email is working — sending as <strong>{status.from}</strong>.</>
                : <>Email is not configured, so nothing marked &ldquo;Email&rdquo; below is actually sent. Notifications still reach the bell.</>}
            </span>
            <Link to="/admin/settings" style={{ fontSize: '12px', fontWeight: 700, color: 'var(--accent)', textDecoration: 'none', marginLeft: 'auto' }}>
              {status?.enabled ? 'Email settings →' : 'Set it up →'}
            </Link>
          </div>

          {/* ── Event catalog ───────────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search events…"
              style={{ ...input, width: '240px' }}
            />
            <Select
              value={categoryFilter}
              onChange={setCategoryFilter}
              options={[{ value: 'ALL', label: 'All categories' }, ...(catalog?.categories ?? []).map((c) => ({ value: c, label: c }))]}
            />
            <div style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text-muted)' }}>
              {counts.emailing} emailing · {counts.customised} customised · {counts.disabled} off
            </div>
          </div>

          <div className="glass-card" style={{ padding: '18px' }}>
            {loadingCatalog ? (
              <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>Loading…</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="table" style={{ width: '100%' }}>
                  <thead>
                    <tr>
                      <th>Event</th>
                      <th>Recipients</th>
                      {CHANNELS.map((c) => <th key={c} style={{ textAlign: 'center' }}>{CHANNEL_LABEL[c]}</th>)}
                      <th style={{ textAlign: 'center' }}>On</th>
                      {canAdminister && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {types.map((t) => (
                      <tr key={t.type} style={{ opacity: t.enabled ? 1 : 0.5 }}>
                        <td>
                          <div style={{ fontWeight: 600, fontSize: '12px' }}>{t.title}</div>
                          <div style={{ fontSize: '10px', color: 'var(--text-muted)', display: 'flex', gap: '6px', alignItems: 'center' }}>
                            <span>{t.type}</span>
                            <span style={{ color: PRIORITY_TONE[t.priority] }}>{t.priority}</span>
                            {t.overridden.length > 0 && (
                              <span style={{ color: 'var(--accent)', fontWeight: 700 }} title={`Customised: ${t.overridden.join(', ')}`}>
                                CUSTOMISED
                              </span>
                            )}
                          </div>
                        </td>
                        <td style={{ fontSize: '10px', color: 'var(--text-muted)', maxWidth: '200px' }}>
                          {[...t.roles, ...(t.special ?? [])].join(', ') || '—'}
                        </td>
                        {CHANNELS.map((c) => (
                          <td key={c} style={{ textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={t.channels.includes(c)}
                              disabled={!canAdminister || busy || !t.enabled}
                              onChange={() => toggleChannel(t, c)}
                              title={
                                c === 'EMAIL' && !t.channels.includes(c)
                                  ? 'Turning email on for a frequent event floods inboxes — prefer it for events that force a decision.'
                                  : undefined
                              }
                            />
                          </td>
                        ))}
                        <td style={{ textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={t.enabled}
                            disabled={!canAdminister || busy}
                            onChange={() => saveType(t.type, { enabled: !t.enabled })}
                            title={t.enabled ? 'Switch this event off entirely' : 'Switch this event back on'}
                          />
                        </td>
                        {canAdminister && (
                          <td>
                            <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
                              <button className="btn btn-secondary" title="Edit wording, recipients, priority"
                                onClick={() => setEditing(t)} style={{ padding: '5px 8px' }}>
                                <FileText size={13} />
                              </button>
                              {t.overridden.length > 0 && (
                                <button className="btn btn-secondary" title="Reset to shipped default"
                                  onClick={() => resetType(t)} style={{ padding: '5px 8px' }}>
                                  <RotateCcw size={13} />
                                </button>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: 'flex', gap: '8px', marginTop: '12px', fontSize: '11px', color: 'var(--text-muted)', alignItems: 'flex-start' }}>
              <Info size={12} style={{ flexShrink: 0, marginTop: '2px' }} />
              <span>
                Changes take effect on the next event — no deploy. Events not customised keep following the shipped
                defaults, including improvements in later releases. Email reaches internal staff only; assayers are
                reached in the mobile app.
              </span>
            </div>
          </div>
      </>

      {editing && (
        <TemplateEditor
          type={editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); refresh(); }}
          allRoles={catalog?.roles ?? []}
          priorities={catalog?.priorities ?? []}
        />
      )}
    </div>
  );
};

/**
 * The template editor.
 *
 * Preview comes from the server, rendered by the very function the pipeline uses — including
 * its habit of deleting sentence fragments left by missing values, which is the behaviour
 * authors are most often surprised by. A local approximation would be a different renderer,
 * and the whole point is to show what will actually be sent.
 */
const TemplateEditor: React.FC<{
  type: CatalogType;
  allRoles: string[];
  priorities: string[];
  onClose: () => void;
  onSaved: () => void;
}> = ({ type, allRoles, priorities, onClose, onSaved }) => {
  const { toast } = useToast();
  const [title, setTitle] = useState(type.title);
  const [body, setBody] = useState(type.body);
  const [link, setLink] = useState(type.link ?? '');
  const [emailSubject, setEmailSubject] = useState(type.emailSubject ?? '');
  const [emailBody, setEmailBody] = useState(type.emailBody ?? '');
  const [priority, setPriority] = useState(type.priority);
  const [roles, setRoles] = useState<string[]>(type.roles);
  const [notes, setNotes] = useState(type.notes ?? '');
  const [preview, setPreview] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  /** Sample values so the preview reads like a real notification rather than placeholders. */
  const samplePayload = useMemo(() => {
    const sample: Record<string, string> = {};
    for (const key of type.placeholders) {
      sample[key] = /count|hours|days|amount|fee|number/i.test(key) ? '3' : `Sample ${key}`;
    }
    return sample;
  }, [type.placeholders]);

  const runPreview = async () => {
    try {
      const res: any = await api.request('/notification-admin/preview', {
        method: 'POST',
        body: JSON.stringify({ title, body, link: link || undefined, emailSubject: emailSubject || undefined, emailBody: emailBody || undefined, payload: samplePayload }),
      });
      setPreview((res as any));
    } catch (err: any) {
      toast({ type: 'error', title: 'Preview failed', message: userMessage(err) });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      // Null clears an override back to the default; a string sets one. Sending the unchanged
      // value as null keeps the row honest about what was actually customised.
      await api.request(`/notification-admin/catalog/${type.type}`, {
        method: 'PUT',
        body: JSON.stringify({
          titleTemplate: title === type.defaults.title ? null : title,
          bodyTemplate: body === type.defaults.body ? null : body,
          linkTemplate: link === (type.defaults.link ?? '') ? null : link || null,
          emailSubjectTemplate: emailSubject || null,
          emailBodyTemplate: emailBody || null,
          priority: priority === type.defaults.priority ? null : priority,
          roles: JSON.stringify(roles) === JSON.stringify(type.defaults.roles) ? null : roles,
          notes: notes || null,
        }),
      });
      toast('success', 'Saved. It applies from the next event.');
      onSaved();
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not save', message: userMessage(err) });
    } finally {
      setSaving(false);
    }
  };

  const insertPlaceholder = (setter: (v: string) => void, current: string, key: string) =>
    setter(`${current}\${${key}}`);

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit — ${type.type}`}
      width="820px"
      maxHeight="90vh"
      // Pinned, not inline: rendering a preview grows the body, and the Save button scrolling
      // out of reach at the moment you want it is the whole reason this slot exists.
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
          <button className="btn btn-secondary" onClick={runPreview} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Eye size={13} /> Preview
          </button>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={saving} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Save size={13} /> {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', overflowY: 'auto', paddingRight: '4px' }}>
        {type.placeholders.length > 0 && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Available values — click to insert into the title:{' '}
            {type.placeholders.map((p) => (
              <button
                key={p} onClick={() => insertPlaceholder(setTitle, title, p)}
                style={{
                  margin: '2px', padding: '2px 7px', fontSize: '10px', cursor: 'pointer',
                  background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
                  borderRadius: '10px', color: 'var(--accent)',
                }}
              >
                {'${' + p + '}'}
              </button>
            ))}
          </div>
        )}

        <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          In-app / push title
          <input value={title} onChange={(e) => setTitle(e.target.value)} style={{ ...input, marginTop: '4px' }} />
        </label>

        <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          In-app / push body
          <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={2}
            style={{ ...input, marginTop: '4px', resize: 'vertical' }} />
        </label>

        <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          Click-through route
          <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="/assignments?id=${assignmentId}"
            style={{ ...input, marginTop: '4px' }} />
        </label>

        <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
          <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Mail size={13} /> Email wording <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: '11px' }}>— leave blank to reuse the text above</span>
          </div>
          <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Subject
            <input value={emailSubject} onChange={(e) => setEmailSubject(e.target.value)}
              placeholder={type.title} style={{ ...input, marginTop: '4px' }} />
          </label>
          <label style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'block', marginTop: '10px' }}>
            Body — an inbox has room for context a lock screen does not
            <textarea value={emailBody} onChange={(e) => setEmailBody(e.target.value)} rows={4}
              placeholder={type.body} style={{ ...input, marginTop: '4px', resize: 'vertical' }} />
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
          <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Priority
            <Select
              value={priority}
              onChange={setPriority}
              options={priorities.map((p) => ({ value: p, label: p }))}
              style={{ ...input, marginTop: '4px' }}
            />
          </label>
          <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Why this was changed
            <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Ops asked for branch code in the subject"
              style={{ ...input, marginTop: '4px' }} />
          </label>
        </div>

        <div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '6px' }}>
            Recipient roles {type.special?.length ? `(plus ${type.special.join(', ')})` : ''}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
            {allRoles.map((r) => (
              <button
                key={r}
                onClick={() => setRoles(roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r])}
                style={{
                  padding: '3px 8px', fontSize: '10px', cursor: 'pointer', borderRadius: '10px',
                  background: roles.includes(r) ? 'rgba(216,174,71,0.15)' : 'var(--bg-secondary)',
                  border: `1px solid ${roles.includes(r) ? 'var(--accent)' : 'var(--border-color)'}`,
                  color: roles.includes(r) ? 'var(--accent)' : 'var(--text-muted)',
                }}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {preview && (
          <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '12px' }}>
            <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '8px' }}>Preview — with sample values</div>
            <div style={{ padding: '10px 12px', background: 'var(--bg-secondary)', borderRadius: '6px', marginBottom: '8px' }}>
              <div style={{ fontSize: '12px', fontWeight: 700 }}>{preview.title}</div>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{preview.body}</div>
              {preview.link && <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>→ {preview.link}</div>}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>As an email:</div>
            <div style={{ border: '1px solid var(--border-color)', borderRadius: '6px', overflow: 'hidden' }}>
              <iframe title="Email preview" srcDoc={preview.emailHtml} style={{ width: '100%', height: '260px', border: 'none', background: '#fff' }} />
            </div>
          </div>
        )}

      </div>
    </Modal>
  );
};

export default NotificationAdmin;
