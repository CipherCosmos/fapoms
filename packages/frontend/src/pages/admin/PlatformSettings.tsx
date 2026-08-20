import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SlidersHorizontal, Mail, Clock, Wallet, Receipt, Database, Send, Sliders,
  RotateCcw, Info, CheckCircle2, XCircle, Eye, EyeOff, AlertTriangle,
} from 'lucide-react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { useToast, Select, useConfirm } from '../../components/ui';
import {
  SectionCard, SettingRow, Toggle, Pill, controlStyle,
} from '../../components/ui/settings';
import { useCurrentRoles, canAdministerPlatformSettings, canAdministerDataReset, canManagePlanningRules, canReadTravelSettings } from '../../hooks/useCurrentRoles';
import { DangerZoneSection } from './DangerZone/DangerZoneSection';
import { RulesSection } from '../Rules';
import { TransportCostsSection } from '../TransportCosts';

/**
 * Client-side-only nav entry — the data-reset domains have no corresponding "setting group" on
 * the server (they aren't a saved-value/environment/default setting at all), so unlike every
 * other row in `groups` this one is never fetched, just appended.
 */
const DANGER_ZONE_GROUP = { key: 'dangerZone', label: 'Danger zone', description: 'Clear accumulated test data — everything here is destructive.' };

/**
 * Eligibility rules, folded in from the page that used to live at `/rules`.
 *
 * Like the danger zone this is not a saved-value/environment/default setting, so it is appended
 * client-side rather than fetched. It sits directly under Planning because the two answer one
 * question between them — who may be sent to a job, and how the engine spreads work across the
 * people who may.
 */
const RULES_GROUP = {
  key: 'rules',
  label: 'Who can be assigned',
  description: 'Skills, certificates, territories and assignment limits that decide which assayers a job may be offered to.',
};

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
  dangerZone: AlertTriangle,
  rules: Sliders,
  planning: Sliders,
};


const APPLIES_LABEL: Record<string, string> = {
  immediately: 'Takes effect immediately',
  'next-run': 'Takes effect at the next scheduled run',
  restart: 'Needs a server restart',
};

export const PlatformSettings: React.FC = () => {
  const roles = useCurrentRoles();
  const canEdit = canAdministerPlatformSettings(roles);
  const canWipeData = canAdministerDataReset(roles);
  /**
   * Operations reach this screen for one section only.
   *
   * They owned `/rules` and hold the write permission on it, so folding that page in here must
   * not cost them the feature — nor hand them the mailbox password, the company's tax details
   * and the data-reset tool on the way. Everything but the rules section stays
   * administrator-only.
   */
  const canManageRules = canManagePlanningRules(roles);
  const canSeeTravel = canReadTravelSettings(roles);
  const settingsAdmin = canAdministerPlatformSettings(roles);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { confirm, confirmDialog } = useConfirm();

  /**
   * Which section is open, kept in the URL.
   *
   * So a link can point at one — `/rules` now redirects to `?group=rules`, and anything else
   * that used to send people to a settings page can name the section instead of dropping them
   * on email delivery and letting them hunt.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const setActiveGroup = (key: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('group', key);
      return next;
    }, { replace: true });
  };
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
  /**
   * The server's groups, with the two client-side sections placed where they belong.
   *
   * Rules go directly after Planning rather than on the end: between them they answer one
   * question — who may be sent to a job, and how the engine spreads work across the people who
   * may — and they were previously on two different screens under two different nav headings.
   */
  const groups = useMemo(() => {
    const fromServer = payload?.groups ?? [];
    if (!settingsAdmin) {
      // Everyone else reaches only the sections their own permission covers.
      const travel = fromServer.filter((g) => g.key === 'transport');
      return [
        ...(canManageRules ? [RULES_GROUP] : []),
        ...(canSeeTravel ? travel : []),
      ];
    }
    /**
     * Planning has no nav entry of its own: its one setting — how many offers before someone
     * counts as well used — is a scoring rule, and it sat on a separate heading from the rules
     * deciding who is eligible to be scored at all. It renders inside that section instead.
     */
    const planningAt = fromServer.findIndex((g) => g.key === 'planning');
    const withoutPlanning = fromServer.filter((g) => g.key !== 'planning');
    const at = planningAt === -1 ? withoutPlanning.length : planningAt;
    const withRules = [...withoutPlanning.slice(0, at), RULES_GROUP, ...withoutPlanning.slice(at)];
    return [...withRules, ...(canWipeData ? [DANGER_ZONE_GROUP] : [])];
  }, [payload, canWipeData, settingsAdmin, canManageRules, canSeeTravel]);
  const settings = useMemo(() => payload?.settings ?? [], [payload]);

  /**
   * The open section, clamped to what this account may actually see.
   *
   * Operations reach only the rules section and auditors only the travel one, so a bare
   * `/admin/settings` — or a stale link naming a section they cannot open — lands them on their
   * first available section rather than on an empty panel.
   */
  const requested = searchParams.get('group');
  const activeGroup = requested && groups.some((g) => g.key === requested)
    ? requested
    : (groups[0]?.key ?? 'email');

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
    // Wording preserved — it already named both the setting and what it falls back to.
    // Resetting is re-settable, so no typed-name step; the note says so plainly.
    const ok = await confirm({
      title: `Clear the saved value for "${s.label}"?`,
      message: `The setting goes back to ${fallback}.`,
      confirmLabel: 'Clear saved value',
      reversible: true,
    });
    if (!ok) return;
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
        <Select
          value={value ?? ''}
          disabled={disabled}
          style={controlStyle}
          onChange={(v) => save(s, v)}
          options={(s.options ?? []).map((o) => ({ value: o.value, label: o.label }))}
        />
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

  /**
   * One group's settings as rows.
   *
   * Extracted so the eligibility-rules section can show the rotation setting above its rule
   * list: "how many offers before someone counts as well used" is a scoring rule, and it sat on
   * a separate nav entry from the rules that decide who is eligible in the first place.
   */
  const settingRows = (list: Setting[]) => list.map((s, i) => (
                <SettingRow
                  key={s.key}
                  last={i === list.length - 1}
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
  ));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      {confirmDialog}
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
          You can see how the platform is configured. Changing it is limited to super administrators.
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

          {activeGroup === 'rules' ? (
            <>
              {/* The scoring dial first — it applies to everyone — then the rules that carve
                  out who is eligible in the first place. */}
              {settings.some((s) => s.group === 'planning') && (
                <SectionCard
                  title="Spreading work around"
                  description="How the recommendation engine shares jobs across the people who are eligible for them."
                >
                  {settingRows(settings.filter((s) => s.group === 'planning'))}
                </SectionCard>
              )}
              <SectionCard title={RULES_GROUP.label} description={RULES_GROUP.description}>
                <div style={{ padding: '16px' }}>
                  <RulesSection />
                </div>
              </SectionCard>
            </>
          ) : activeGroup === 'dangerZone' ? (
            <DangerZoneSection />
          ) : (
          <SectionCard
            title={groups.find((g) => g.key === activeGroup)?.label ?? 'Settings'}
            description={groups.find((g) => g.key === activeGroup)?.description}
          >
            {isLoading ? (
              <div style={{ padding: '30px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>
            ) : (
              settingRows(inGroup)
            )}
          </SectionCard>
          )}

          {activeGroup === 'transport' && (
            <SectionCard
              title="What travel costs"
              description="The rate card the dials above read. Offers quote their travel from these rates — the most specific scope wins."
            >
              <div style={{ padding: '16px' }}>
                <TransportCostsSection />
              </div>
            </SectionCard>
          )}

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
