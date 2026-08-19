import React, { useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, ShieldCheck, Clock, Unlock, ShieldAlert } from 'lucide-react';
import {
  BypassableRule, BypassableRuleInfo, RuleBypassState,
  INACTIVE_BYPASS, MAX_BYPASS_HOURS, DEFAULT_BYPASS_HOURS,
} from '@fapoms/shared';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { useConfirm } from '../../components/ui';

/**
 * Where an administrator suspends operational rules for testing.
 *
 * The screen is written to make the decision hard to take casually rather than to make it
 * convenient. Each rule is listed with what it *protects*, not just what it blocks; the ones
 * whose absence changes what a completed audit record means are grouped and marked separately;
 * the reason is required; and the window is bounded and shown counting down.
 *
 * That is deliberate. The feature exists because reaching the fifth screen of a workflow
 * otherwise means driving to a branch — a real cost, worth removing. But the same switch, left
 * on, produces a month of audit records with the controls off and no way to tell which. The
 * friction here is aimed squarely at that second outcome.
 */

const card: React.CSSProperties = {
  background: 'var(--bg-card)', border: '1px solid var(--border-color)',
  borderRadius: '10px', padding: '16px',
};

const DURATION_PRESETS = [1, 2, 4, 8, 24];

/** "in 1h 58m" / "in 12 min" / "expiring now", for a moment already in the future. */
function formatCountdown(iso: string | null): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'expiring now';
  const mins = Math.round(ms / 60_000);
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export const RuleBypassPanel: React.FC = () => {
  const queryClient = useQueryClient();
  const { confirm, confirmDialog } = useConfirm();
  const [selected, setSelected] = useState<Set<BypassableRule>>(new Set());
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(DEFAULT_BYPASS_HOURS);
  const [error, setError] = useState<string | null>(null);
  /**
   * What's stopping submission right now, shown next to the button rather than only inferred
   * from a disabled state. A plain `disabled` attribute on the submit button gave no feedback
   * at all — the button's own label already shows "Suspend 7 rules for 2h" once rules are
   * picked, so a short reason left it looking ready while quietly refusing every click, with
   * nothing on screen explaining why.
   */
  const [guidance, setGuidance] = useState<string | null>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  const ruleListRef = useRef<HTMLDivElement>(null);

  const { data: state } = useQuery({
    queryKey: ['rule-bypass', 'state'],
    queryFn: () => api.request<RuleBypassState>('/admin/rule-bypass'),
    refetchInterval: 30_000,
  });
  const { data: catalogue, isLoading: catalogueLoading } = useQuery({
    queryKey: ['rule-bypass', 'catalogue'],
    queryFn: () => api.request<{ rules: BypassableRuleInfo[] }>('/admin/rule-bypass/catalogue'),
    staleTime: Infinity,
  });

  const current = state ?? INACTIVE_BYPASS;
  const rules = catalogue?.rules ?? [];
  const byRule = useMemo(() => new Map(rules.map((r) => [r.rule, r])), [rules]);

  // Evidential controls surfaced first and labelled separately — these are the ones where
  // suspending changes what a FINISHED audit record means, not just what can be scheduled.
  // Splitting the flat list of twelve into two purposeful groups is what makes it scannable
  // instead of a wall of near-identical checkboxes.
  const evidentialRules = rules.filter((r) => r.evidential);
  const operationalRules = rules.filter((r) => !r.evidential);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['rule-bypass'] });

  const enable = useMutation({
    mutationFn: () =>
      api.request('/admin/rule-bypass', {
        method: 'POST',
        body: JSON.stringify({ rules: [...selected], reason, hours }),
      }),
    onSuccess: () => { setError(null); setSelected(new Set()); setReason(''); refresh(); },
    onError: (e) => setError(userMessage(e)),
  });

  const disable = useMutation({
    mutationFn: () => api.request('/admin/rule-bypass', { method: 'DELETE' }),
    onSuccess: () => { setError(null); refresh(); },
    onError: (e) => setError(userMessage(e)),
  });

  const toggle = (rule: BypassableRule) => {
    if (guidance) setGuidance(null);
    setSelected((s) => {
      const next = new Set(s);
      next.has(rule) ? next.delete(rule) : next.add(rule);
      return next;
    });
  };

  const toggleGroup = (group: BypassableRuleInfo[]) => {
    const allOn = group.every((r) => selected.has(r.rule));
    setSelected((s) => {
      const next = new Set(s);
      group.forEach((r) => (allOn ? next.delete(r.rule) : next.add(r.rule)));
      return next;
    });
  };

  const evidentialSelected = rules.filter((r) => selected.has(r.rule) && r.evidential);
  const reasonOk = reason.trim().length >= 10;
  const activeRuleInfos = current.rules.map((r) => byRule.get(r)).filter((r): r is BypassableRuleInfo => Boolean(r));

  const RuleGroup: React.FC<{ title: string; hint: string; items: BypassableRuleInfo[] }> = ({ title, hint, items }) => {
    if (items.length === 0) return null;
    const allOn = items.length > 0 && items.every((r) => selected.has(r.rule));
    const someOn = items.some((r) => selected.has(r.rule));
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
          <div>
            <span style={{ fontSize: '11.5px', fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-muted)' }}>
              {title}
            </span>
            <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px' }}>{hint}</span>
          </div>
          <button
            onClick={() => toggleGroup(items)}
            style={{ background: 'none', border: 'none', color: 'var(--accent-primary)', fontSize: '11px', fontWeight: 700, cursor: 'pointer', padding: '2px 4px' }}
          >
            {allOn ? 'Clear' : someOn ? 'Select rest' : 'Select all'}
          </button>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {items.map((r) => (
            <label
              key={r.rule}
              style={{
                display: 'flex', gap: '10px', alignItems: 'flex-start', padding: '9px 10px',
                borderRadius: '7px', cursor: 'pointer',
                background: selected.has(r.rule) ? 'var(--bg-surface-2)' : 'transparent',
                border: `1px solid ${selected.has(r.rule) ? 'var(--border-color)' : 'transparent'}`,
              }}
            >
              <input
                type="checkbox"
                checked={selected.has(r.rule)}
                onChange={() => toggle(r.rule)}
                style={{ marginTop: '3px' }}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: '13px', fontWeight: 600 }}>{r.label}</span>
                <span style={{ display: 'flex', alignItems: 'flex-start', gap: '5px', fontSize: '11.5px', color: 'var(--text-muted)', marginTop: '3px' }}>
                  <Unlock size={12} style={{ flexShrink: 0, marginTop: '1.5px' }} />
                  {r.blocks}
                </span>
                <span style={{ display: 'flex', alignItems: 'flex-start', gap: '5px', fontSize: '11.5px', color: 'var(--warning)', marginTop: '2px' }}>
                  <ShieldAlert size={12} style={{ flexShrink: 0, marginTop: '1.5px' }} />
                  {r.protects}
                </span>
              </span>
            </label>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxWidth: '900px' }}>
      {confirmDialog}
      <div>
        <h2 style={{ fontSize: '19px', fontWeight: 700, margin: 0 }}>Rule bypass</h2>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '5px 0 0', lineHeight: 1.55 }}>
          Suspend named operational rules so a workflow can be tested end to end without
          travelling to a branch or fabricating reference data. Every suspension is recorded
          against the records it affects, announced across the whole product while it is on, and
          expires on its own.
        </p>
      </div>

      {current.active ? (
        <div style={{ ...card, borderColor: 'var(--danger)', background: 'var(--status-cancelled-bg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--danger)', fontWeight: 800, fontSize: '14px' }}>
            <AlertOctagon size={17} /> Rules are suspended right now
          </div>
          <div style={{ fontSize: '13px', marginTop: '10px', lineHeight: 1.7 }}>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '4px' }}>
              <strong style={{ flexShrink: 0 }}>Suspended:</strong>
              {/* Human labels, not the raw rule keys ("CHECK_IN_GEOFENCE") the previous version
                  showed here — this is the one place in the product an admin comes to check
                  exactly what is off, and it should read like the checklist they chose it from. */}
              {activeRuleInfos.map((r) => (
                <span
                  key={r.rule}
                  title={r.protects}
                  style={{
                    fontSize: '11px', fontWeight: 700, padding: '1px 8px', borderRadius: '10px',
                    background: r.evidential ? 'rgba(0,0,0,0.12)' : 'var(--bg-surface-2)',
                    color: r.evidential ? 'var(--danger)' : 'var(--text-primary)',
                    border: r.evidential ? '1px solid var(--danger)' : '1px solid var(--border-color)',
                    cursor: 'help',
                  }}
                >
                  {r.label}
                </span>
              ))}
            </div>
            <div><strong>Reason:</strong> {current.reason}</div>
            <div><strong>Turned on by:</strong> {current.enabledByName ?? current.enabledBy}</div>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', marginTop: '3px' }}>
              <Clock size={13} />
              {current.expiresAt && <>Expires {formatCountdown(current.expiresAt)} ({new Date(current.expiresAt).toLocaleString()})</>}
            </div>
          </div>
          {/*
            Restoring is the safe direction — it puts the controls back — but it is not a
            no-op, and it fired on a single click. Anyone mid-test loses the window they set
            up (the suspension cannot be resumed; it has to be requested again, with a reason,
            from scratch), and the button sits immediately under the countdown people come to
            this screen just to read, so a click aimed at the banner ended someone else's test
            run. One dialog naming what comes back on is enough; no typed phrase, because
            nothing is destroyed and re-suspending is always possible.
          */}
          <button
            onClick={async () => {
              const names = activeRuleInfos.map((r) => r.label).join(', ');
              const ok = await confirm({
                title: 'Turn all rules back on now?',
                message: (
                  <>
                    Enforcement resumes immediately for {activeRuleInfos.length} suspended rule
                    {activeRuleInfos.length === 1 ? '' : 's'}
                    {names ? <> — {names}</> : null}. Anyone testing right now will start being blocked by them again.
                  </>
                ),
                confirmLabel: 'Restore all rules',
                reversibleNote: 'To suspend them again you have to pick the rules and give a reason afresh.',
              });
              if (!ok) return;
              disable.mutate();
            }}
            disabled={disable.isPending}
            className="btn btn-primary"
            style={{ marginTop: '12px', padding: '7px 14px', fontSize: '13px', fontWeight: 700 }}
          >
            {disable.isPending ? 'Restoring…' : 'Restore all rules now'}
          </button>
        </div>
      ) : (
        <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '9px', color: 'var(--success)', fontWeight: 700, fontSize: '13.5px' }}>
          <ShieldCheck size={17} /> All rules are being enforced.
        </div>
      )}

      <div style={card} ref={ruleListRef}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>Choose the rules to suspend</div>
          {selected.size > 0 && (
            <span style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--accent-primary)', background: 'var(--bg-surface-2)', padding: '2px 9px', borderRadius: '10px' }}>
              {selected.size} selected
            </span>
          )}
        </div>

        {catalogueLoading ? (
          <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', padding: '8px 0' }}>Loading the rule catalogue…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
            <RuleGroup
              title="Audit-evidence controls"
              hint="— suspending these changes what a finished record means"
              items={evidentialRules}
            />
            <RuleGroup
              title="Operational controls"
              hint="— these only affect what can be scheduled"
              items={operationalRules}
            />
          </div>
        )}
      </div>

      <div style={card}>
        <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, marginBottom: '5px' }}>
          Why (recorded against every record produced while these rules are off)
        </label>
        <input
          ref={reasonRef}
          value={reason}
          onChange={(e) => { setReason(e.target.value); if (guidance) setGuidance(null); }}
          placeholder="e.g. Testing the mobile check-in flow before the RBL pilot"
          style={{
            width: '100%', padding: '8px 10px', fontSize: '13px', background: 'var(--bg-primary)',
            border: `1px solid ${reason.length > 0 && !reasonOk ? 'var(--danger)' : 'var(--border-color)'}`,
            borderRadius: '6px', color: 'var(--text-primary)', outline: 'none',
          }}
        />
        {/* Silent disabling told nobody WHY the button wouldn't click. This says so, and turns
            green the moment it stops being true. */}
        <div style={{ fontSize: '11px', marginTop: '4px', color: reasonOk ? 'var(--success)' : 'var(--text-muted)' }}>
          {reasonOk ? '✓ Good to go' : `${reason.trim().length}/10 characters minimum`}
        </div>

        <label style={{ display: 'block', fontSize: '12px', fontWeight: 700, margin: '14px 0 6px' }}>
          For how long (max {MAX_BYPASS_HOURS}h — it switches itself back on)
        </label>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          {DURATION_PRESETS.map((h) => (
            <button
              key={h}
              onClick={() => setHours(h)}
              style={{
                padding: '5px 12px', borderRadius: '999px', fontSize: '12px', fontWeight: 700, cursor: 'pointer',
                border: `1px solid ${hours === h ? 'transparent' : 'var(--border-color)'}`,
                background: hours === h ? 'var(--accent)' : 'transparent',
                color: hours === h ? 'var(--on-accent)' : 'var(--text-secondary)',
              }}
            >
              {h}h
            </button>
          ))}
          <span style={{ fontSize: '11.5px', color: 'var(--text-muted)', margin: '0 2px' }}>or</span>
          <input
            type="number" min={1} max={MAX_BYPASS_HOURS} value={hours}
            onChange={(e) => setHours(Math.min(MAX_BYPASS_HOURS, Math.max(1, Number(e.target.value) || 1)))}
            aria-label="Custom duration in hours"
            style={{ width: '64px', padding: '6px 8px', fontSize: '12.5px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '6px', color: 'var(--text-primary)', outline: 'none' }}
          />
          <span style={{ fontSize: '11.5px', color: 'var(--text-muted)' }}>hours</span>
        </div>

        {evidentialSelected.length > 0 && (
          <div style={{ marginTop: '14px', padding: '10px 12px', borderRadius: '7px', background: 'var(--status-cancelled-bg)', color: 'var(--danger)', fontSize: '12.5px', lineHeight: 1.55 }}>
            <strong>{evidentialSelected.length} of these are audit-evidence controls.</strong> Any
            audit completed while they are suspended is a test record — the platform will mark it
            as one, and it should not be delivered to a client.
          </div>
        )}

        {error && <div style={{ marginTop: '10px', fontSize: '12.5px', color: 'var(--danger)' }}>{error}</div>}
        {guidance && (
          <div style={{ marginTop: '10px', fontSize: '12.5px', color: 'var(--warning)', fontWeight: 600 }}>
            {guidance}
          </div>
        )}

        <button
          onClick={async () => {
            /**
             * The button is never HTML-`disabled` for a missing selection or a short reason —
             * only while a request is actually in flight. Everything else is validated here, on
             * click, because a silently disabled button gives no signal at all about what is
             * wrong: the label already reads "Suspend 7 rules for 2h" the moment rules are
             * picked, so a reason two characters short looked identical to a working button that
             * simply did nothing when pressed. This guides the person to the exact field instead.
             */
            if (selected.size === 0) {
              setGuidance('Choose at least one rule above before suspending.');
              ruleListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              return;
            }
            if (!reasonOk) {
              setGuidance(`Add a reason of at least 10 characters — ${reason.trim().length}/10 so far.`);
              reasonRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              reasonRef.current?.focus();
              return;
            }
            setGuidance(null);
            /*
              The last guard before the controls come off used the browser's own dialog — the
              one that looks identical to the pop-ups office staff are trained to dismiss
              unread, whose buttons say only "OK" and "Cancel", and where Enter confirms. That
              is the weakest possible gate on the one action that changes what every audit
              record produced in the next few hours means. Same wording, same decision, in the
              in-app dialog, which names the action on its button and says plainly that this
              cannot be undone for records already created.
            */
            const chosen = rules.filter((r) => selected.has(r.rule));
            const ok = await confirm({
              title: `Suspend ${chosen.length} rule${chosen.length === 1 ? '' : 's'} for ${hours}h?`,
              message: (
                <>
                  These checks stop being enforced for the next {hours} hour{hours === 1 ? '' : 's'}:
                  <ul style={{ margin: '6px 0 0', paddingLeft: '18px' }}>
                    {chosen.map((r) => (
                      <li key={r.rule}>{r.label}</li>
                    ))}
                  </ul>
                  <div style={{ marginTop: '8px' }}>
                    Every record created while they are off is marked as produced without them.
                  </div>
                </>
              ),
              confirmLabel: `Suspend for ${hours}h`,
              reversibleNote: 'You can restore the rules at any time, but records already created while they were off stay marked.',
              tone: 'danger',
            });
            if (!ok) return;
            enable.mutate();
          }}
          disabled={enable.isPending}
          className="btn btn-primary"
          style={{
            marginTop: '14px', padding: '8px 16px', fontSize: '13px', fontWeight: 700,
            opacity: selected.size === 0 || !reasonOk ? 0.7 : 1,
            cursor: enable.isPending ? 'default' : 'pointer',
          }}
        >
          {enable.isPending ? 'Suspending…' : `Suspend ${selected.size || 'no'} rule${selected.size === 1 ? '' : 's'} for ${hours}h`}
        </button>
      </div>
    </div>
  );
};
