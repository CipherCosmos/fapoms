import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SlidersHorizontal, Mail, Clock, Wallet, Receipt, Database, Send,
  RotateCcw, Info, CheckCircle2, XCircle, Eye, EyeOff,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { useToast } from '../../components/ui';
import {
  SectionCard, SettingRow, Toggle, Pill, controlStyle,
} from '../../components/ui/settings';
import { useCurrentRoles, canAdministerPlatformSettings } from '../../hooks/useCurrentRoles';

/**
 * Platform Settings.
 *
 * The configuration that used to live in environment variables and compiled-in constants —
 * what an unpriced audit is worth, which mailbox sends, when the morning brief goes out, how
 * long movement records are kept. None of those are engineering decisions, and none of them
 * should have needed a deploy.
 *
 * Each row says where its current value comes from (saved here, from the environment, or the
 * shipped default) and when a change takes effect, because a settings screen whose "saved" and
 * "in force" mean different things is worse than no settings screen.
 */

interface Setting {
  key: string;
  label: string;
  description: string;
  group: string;
  type: 'string' | 'number' | 'boolean' | 'password' | 'select' | 'cron';
  value: any;
  source: 'saved' | 'environment' | 'default';
  isSet?: boolean;
  envVar?: string;
  secret?: boolean;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  unit?: string;
  applies: string;
  default: any;
}

interface Group { key: string; label: string; description: string }

const GROUP_ICON: Record<string, React.ElementType> = {
  email: Mail,
  schedule: Clock,
  fees: Wallet,
  billing: Receipt,
  retention: Database,
};


const APPLIES_LABEL: Record<string, string> = {
  immediately: 'Takes effect immediately',
  'next-run': 'Takes effect at the next scheduled run',
  restart: 'Needs a server restart',
};

export const PlatformSettings: React.FC = () => {
  const canEdit = canAdministerPlatformSettings(useCurrentRoles());
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [activeGroup, setActiveGroup] = useState<string>('email');
  /** Local edits, keyed by setting. Absent = showing the server's value. */
  const [drafts, setDrafts] = useState<Record<string, any>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [runningDigest, setRunningDigest] = useState(false);

  const { data: res, isLoading } = useQuery({
    queryKey: ['platform-settings'],
    queryFn: () => api.request<any>('/platform-settings'),
  });
  const payload = res ? (res as { groups: Group[]; settings: Setting[] }) : null;
  const groups = payload?.groups ?? [];
  const settings = useMemo(() => payload?.settings ?? [], [payload]);

  const { data: emailStatusRes } = useQuery({
    queryKey: ['notification-admin', 'email-status'],
    queryFn: () => api.request<any>('/notification-admin/email/status'),
  });
  const emailStatus = emailStatusRes ? (emailStatusRes as any) : null;

  const inGroup = settings.filter((s) => s.group === activeGroup);
  const savedCount = (g: string) => settings.filter((s) => s.group === g && s.source === 'saved').length;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['platform-settings'] })
    .then(() => queryClient.invalidateQueries({ queryKey: ['notification-admin'] }));

  const save = async (s: Setting, value: any) => {
    setSaving(s.key);
    try {
      await api.request(`/platform-settings/${s.key}`, { method: 'PUT', body: JSON.stringify({ value }) });
      setDrafts((d) => { const next = { ...d }; delete next[s.key]; return next; });
      await refresh();
      toast('success', `${s.label} saved.`);
    } catch (err: any) {
      // The server's message names the field and its units — far more useful than a generic one.
      toast({ type: 'error', title: 'Could not save', message: userMessage(err) });
    } finally {
      setSaving(null);
    }
  };

  const reset = async (s: Setting) => {
    const fallback = s.envVar ? `the ${s.envVar} environment variable` : 'the shipped default';
    if (!window.confirm(`Clear the saved value for "${s.label}" and go back to ${fallback}?`)) return;
    setSaving(s.key);
    try {
      await api.request(`/platform-settings/${s.key}`, { method: 'DELETE' });
      setDrafts((d) => { const next = { ...d }; delete next[s.key]; return next; });
      await refresh();
      toast('success', `${s.label} reset.`);
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not reset', message: userMessage(err) });
    } finally {
      setSaving(null);
    }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      // The route reports an SMTP refusal in its payload rather than as an HTTP error — the
      // request succeeded, the mail server declined it, and the difference matters to the
      // person reading the message.
      const r = await api.request<{ success?: boolean; error?: string }>(
        '/notification-admin/email/test',
        { method: 'POST', body: JSON.stringify({ to: testTo }) },
      );
      if (r?.success === false) toast({ type: 'error', title: 'The mail server refused it', message: r.error ?? 'Unknown error' });
      else toast('success', `Test email sent to ${testTo}.`);
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not send', message: userMessage(err) });
    } finally {
      setTesting(false);
    }
  };

  /**
   * Running the brief on demand lives here, beside the schedule and the switch that govern it,
   * rather than on the notifications screen where it used to sit next to a copy of the email
   * status. Both belonged to whoever owns "when does mail go out", which is this page.
   */
  const runDigest = async () => {
    setRunningDigest(true);
    try {
      await api.request('/notification-admin/digest/run', { method: 'POST' });
      toast('success', 'Brief queued — it reaches everyone who has something waiting.');
    } catch (err: any) {
      toast({ type: 'error', title: 'Could not queue it', message: userMessage(err) });
    } finally {
      setRunningDigest(false);
    }
  };

  const draftOf = (s: Setting) => (s.key in drafts ? drafts[s.key] : s.value);
  const isDirty = (s: Setting) => s.key in drafts && drafts[s.key] !== s.value;

  const renderControl = (s: Setting) => {
    const value = draftOf(s);
    const set = (v: any) => setDrafts((d) => ({ ...d, [s.key]: v }));
    const disabled = !canEdit || saving === s.key;

    if (s.type === 'boolean') {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Toggle checked={!!value} disabled={disabled} label={s.label} onChange={(next) => save(s, next)} />
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{value ? 'On' : 'Off'}</span>
        </div>
      );
    }

    if (s.type === 'select') {
      return (
        <select value={value ?? ''} disabled={disabled} style={controlStyle} onChange={(e) => save(s, e.target.value)}>
          {(s.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }

    if (s.type === 'password') {
      return (
        <div style={{ display: 'flex', gap: '6px' }}>
          <input
            type={revealed[s.key] ? 'text' : 'password'}
            value={s.key in drafts ? drafts[s.key] : ''}
            disabled={disabled}
            placeholder={s.isSet ? 'Saved — type to replace' : 'Not set'}
            onChange={(e) => set(e.target.value)}
            style={controlStyle}
          />
          <button
            type="button"
            className="btn btn-secondary"
            title={revealed[s.key] ? 'Hide' : 'Show what you are typing'}
            onClick={() => setRevealed((r) => ({ ...r, [s.key]: !r[s.key] }))}
            style={{ padding: '6px 9px' }}
          >
            {revealed[s.key] ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
        </div>
      );
    }

    return (
      <input
        type={s.type === 'number' ? 'number' : 'text'}
        value={value ?? ''}
        disabled={disabled}
        min={s.min}
        max={s.max}
        placeholder={s.default != null ? String(s.default) : 'Not set'}
        onChange={(e) => set(s.type === 'number' ? e.target.value : e.target.value)}
        style={controlStyle}
      />
    );
  };

  const sourceNote = (s: Setting) => {
    if (s.source === 'saved') return <Pill tone="accent">Saved here</Pill>;
    if (s.source === 'environment') return <Pill tone="muted">From {s.envVar}</Pill>;
    return <Pill tone="muted">Default</Pill>;
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <div>
        <h2 style={{ fontSize: '20px', fontWeight: 700, margin: 0, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <SlidersHorizontal style={{ color: 'var(--accent)' }} /> Platform Settings
        </h2>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
          What the platform assumes when no contract says otherwise — changeable here, without a deploy.
        </span>
      </div>

      {!canEdit && (
        <div className="glass-card" style={{ padding: '10px 14px', display: 'flex', gap: '8px', alignItems: 'center', fontSize: '12px', color: 'var(--text-secondary)' }}>
          <Info size={14} style={{ color: 'var(--text-muted)', flexShrink: 0 }} />
          You can see how the platform is configured. Changing it is limited to administrators.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(190px, 220px) minmax(0, 1fr)', gap: '18px', alignItems: 'start' }}>
        {/* ── Group nav ────────────────────────────────────────────────── */}
        <div className="glass-card" style={{ padding: '10px', position: 'sticky', top: '12px' }}>
          {groups.map((g) => {
            const Icon = GROUP_ICON[g.key] ?? SlidersHorizontal;
            const active = g.key === activeGroup;
            const saved = savedCount(g.key);
            return (
              <button
                key={g.key}
                onClick={() => setActiveGroup(g.key)}
                style={{
                  width: '100%', textAlign: 'left', display: 'flex', alignItems: 'center', gap: '9px',
                  padding: '9px 11px', marginBottom: '2px', borderRadius: '7px', cursor: 'pointer',
                  border: 'none',
                  background: active ? 'rgba(216,174,71,0.10)' : 'transparent',
                  color: active ? 'var(--accent)' : 'var(--text-secondary)',
                  fontSize: '12.5px', fontWeight: active ? 700 : 500,
                }}
              >
                <Icon size={14} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1 }}>{g.label}</span>
                {saved > 0 && <Pill tone="accent">{saved}</Pill>}
              </button>
            );
          })}
        </div>

        {/* ── Group pane ───────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', minWidth: 0 }}>
          {activeGroup === 'email' && (
            <SectionCard
              icon={emailStatus?.enabled ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
              title={emailStatus?.enabled ? `Email is working — ${emailStatus.transport === 'GMAIL' ? 'Gmail' : 'SMTP'}` : 'Email is not configured'}
              description={
                emailStatus?.enabled
                  ? `Sending as ${emailStatus.from}. Links in emails point at ${emailStatus.appPublicUrl}.`
                  : 'Notifications still reach the in-app bell, and each one records that its email was suppressed. Fill in the fields below to switch it on.'
              }
            >
              {canEdit && (
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)}
                    placeholder="Send a test to…" style={{ ...controlStyle, width: '260px' }}
                  />
                  <button
                    className="btn btn-secondary" disabled={testing || !testTo || !emailStatus?.enabled}
                    onClick={sendTest}
                    style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 14px' }}
                  >
                    <Send size={13} /> {testing ? 'Sending…' : 'Send test'}
                  </button>
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    The only way to know the credentials work is to use them.
                  </span>
                  <Link
                    to="/admin/notifications"
                    style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--accent)', textDecoration: 'none', marginLeft: 'auto' }}
                  >
                    Which events send email →
                  </Link>
                </div>
              )}
            </SectionCard>
          )}

          {activeGroup === 'schedule' && canEdit && (
            <SectionCard
              icon={<Send size={16} />}
              title="Send the morning brief now"
              description="Useful after changing what it covers, or to see what it looks like. It reaches only people with something actually waiting — a quiet morning sends nothing."
            >
              <button
                className="btn btn-secondary" disabled={runningDigest} onClick={runDigest}
                style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '8px 14px' }}
              >
                <Send size={13} /> {runningDigest ? 'Queueing…' : 'Run it now'}
              </button>
            </SectionCard>
          )}

          <SectionCard
            title={groups.find((g) => g.key === activeGroup)?.label ?? 'Settings'}
            description={groups.find((g) => g.key === activeGroup)?.description}
          >
            {isLoading ? (
              <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>
            ) : (
              inGroup.map((s, i) => (
                <SettingRow
                  key={s.key}
                  last={i === inGroup.length - 1}
                  label={
                    <span style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
                      {s.label}
                      {s.unit && <span style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 500 }}>({s.unit})</span>}
                      {sourceNote(s)}
                    </span>
                  }
                  description={s.description}
                  control={renderControl(s)}
                  footnote={
                    <span style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                      <span>{APPLIES_LABEL[s.applies] ?? s.applies}</span>
                      {s.type !== 'boolean' && s.type !== 'select' && s.default != null && (
                        <span>· default {String(s.default)}</span>
                      )}
                    </span>
                  }
                  aside={
                    <div style={{ display: 'flex', gap: '5px' }}>
                      {canEdit && (isDirty(s) || (s.type === 'password' && drafts[s.key])) && (
                        <button
                          className="btn btn-primary"
                          disabled={saving === s.key}
                          onClick={() => save(s, drafts[s.key])}
                          style={{ padding: '6px 12px', fontSize: '11.5px', whiteSpace: 'nowrap' }}
                        >
                          {saving === s.key ? 'Saving…' : 'Save'}
                        </button>
                      )}
                      {canEdit && s.source === 'saved' && !isDirty(s) && (
                        <button
                          className="btn btn-secondary" title="Clear the saved value"
                          disabled={saving === s.key} onClick={() => reset(s)}
                          style={{ padding: '6px 9px' }}
                        >
                          <RotateCcw size={12} />
                        </button>
                      )}
                    </div>
                  }
                />
              ))
            )}
          </SectionCard>

          {activeGroup === 'fees' && (
            <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '0 4px' }}>
              <Info size={13} style={{ flexShrink: 0, marginTop: '1px' }} />
              <span>
                These are the last resort. An assayer's contracted fee and a client's rate card both win over them,
                and travel is priced from the <Link to="/transport-costs" style={{ color: 'var(--accent)', fontWeight: 600 }}>transport rate card</Link> when
                one covers the branch's state.
              </span>
            </div>
          )}
          {activeGroup === 'billing' && (
            <div style={{ fontSize: '11.5px', color: 'var(--text-muted)', display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '0 4px' }}>
              <Info size={13} style={{ flexShrink: 0, marginTop: '1px' }} />
              <span>
                Applies to payables and claims created from now on. Every payable records the rate it was booked at,
                so changing this never restates money already owed.
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default PlatformSettings;
