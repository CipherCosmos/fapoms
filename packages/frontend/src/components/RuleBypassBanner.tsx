import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, ArrowRight } from 'lucide-react';
import { BYPASSABLE_RULE_INFO, BypassableRule, INACTIVE_BYPASS, RuleBypassState } from '@fapoms/shared';
import { api } from '../services/api';
import { useCurrentRoles, canManageRuleBypass } from '../hooks/useCurrentRoles';

/**
 * The strip that says the platform's controls are currently off.
 *
 * Shown to **everyone**, not just administrators, and that is the entire point. A bypass window
 * that only its author can see is a trap: the operator building tomorrow's plan, and the assayer
 * checking in from their sofa, are the people who most need to know the record they are about to
 * create is a test record. Hiding it would leave them producing work they believe is real.
 *
 * It is deliberately loud and cannot be dismissed. A quieter treatment invites the failure this
 * is guarding against — the window that stays open for three weeks because it stopped being
 * noticeable after the first hour.
 */
export const RuleBypassBanner: React.FC = () => {
  const isAdmin = canManageRuleBypass(useCurrentRoles());

  const { data, refetch } = useQuery({
    queryKey: ['rule-bypass', 'state'],
    queryFn: () => api.request<RuleBypassState>('/admin/rule-bypass'),
    // Polled rather than fetched once: a window opened or revoked by another administrator has to
    // reach this screen without a reload. The cadence is adaptive — while a window is active it is
    // tracked tightly enough to catch a manual revoke; while inactive (the overwhelmingly common
    // state, and every user sees this component) it polls gently, since a bypass being *opened* is
    // not urgent to the second and react-query still refetches on window focus. Expiry is handled
    // by the local timer below, so no poll is needed merely to notice the clock run out.
    refetchInterval: (query) => (query.state.data?.active ? 20_000 : 60_000),
    staleTime: 15_000,
    enabled: Boolean(localStorage.getItem('fapoms_token')),
    retry: false,
  });

  const state = data ?? INACTIVE_BYPASS;

  // Drop the banner the instant the window lapses, instead of leaving a stale "controls are off"
  // warning up until the next poll. One timer to the exact expiry, re-armed if the window moves.
  React.useEffect(() => {
    if (!state.active || !state.expiresAt) return;
    const ms = new Date(state.expiresAt).getTime() - Date.now();
    if (ms <= 0) { void refetch(); return; }
    const timer = setTimeout(() => { void refetch(); }, ms + 500);
    return () => clearTimeout(timer);
  }, [state.active, state.expiresAt, refetch]);

  if (!state.active) return null;

  const rules = state.rules.map((r) => BYPASSABLE_RULE_INFO[r as BypassableRule]).filter(Boolean);
  const evidential = rules.filter((r) => r.evidential);

  const expiresIn = (() => {
    if (!state.expiresAt) return null;
    const ms = new Date(state.expiresAt).getTime() - Date.now();
    if (ms <= 0) return 'expiring now';
    const mins = Math.round(ms / 60_000);
    return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
  })();

  return (
    <div role="alert" style={{ background: 'var(--danger)', color: '#fff' }}>
      <div style={{
        padding: '7px 16px', display: 'flex', alignItems: 'center', gap: '9px', flexWrap: 'wrap',
        fontSize: '12.5px', fontWeight: 600, lineHeight: 1.45,
      }}>
        <AlertOctagon size={16} style={{ flexShrink: 0 }} />
        <span style={{ fontWeight: 800, letterSpacing: '0.03em', flexShrink: 0 }}>TEST MODE</span>

        <span style={{ fontWeight: 500, flexShrink: 0 }}>
          {rules.length} rule{rules.length === 1 ? '' : 's'} suspended
          {expiresIn ? ` · ends in ${expiresIn}` : ''}
          {state.enabledByName ? ` · by ${state.enabledByName}` : ''}
        </span>

        {/* Each rule as its own pill rather than a comma-separated run-on — with twelve possible
            rules a parenthetical CSV wraps into an unreadable line. A pill breaks cleanly and
            still lets someone scan "is the one I care about in this list?" at a glance. */}
        <span style={{ display: 'flex', gap: '5px', flexWrap: 'wrap' }}>
          {rules.map((r) => (
            <span
              key={r.rule}
              title={r.protects}
              style={{
                fontSize: '11px', fontWeight: 700, padding: '1px 8px', borderRadius: '10px',
                background: 'rgba(255,255,255,0.16)', whiteSpace: 'nowrap', cursor: 'help',
              }}
            >
              {r.label}
            </span>
          ))}
        </span>

        {/* The reason exists for exactly this audience — the people who did NOT open the
            window and are the ones who most need to know why it's open. It was previously
            visible only on the admin panel, which nobody outside admin ever opens. */}
        {state.reason && (
          <span
            title={state.reason}
            style={{
              fontWeight: 500, opacity: 0.9, overflow: 'hidden', textOverflow: 'ellipsis',
              whiteSpace: 'nowrap', maxWidth: '260px', flexShrink: 1,
            }}
          >
            — “{state.reason}”
          </span>
        )}

        {evidential.length > 0 && (
          <span style={{ fontWeight: 700, background: 'rgba(0,0,0,0.22)', padding: '2px 8px', borderRadius: '10px', flexShrink: 0 }}>
            Records created now are not valid audit evidence
          </span>
        )}

        {/* A one-click way for the person who can actually turn it off to get there — without
            this, "I saw the banner" and "I could do something about it" were two different
            journeys through the sidebar for the only role that can act on it. */}
        {isAdmin && (
          <Link
            to="/admin/rule-bypass"
            style={{
              marginLeft: 'auto', flexShrink: 0, color: '#fff', fontWeight: 700, fontSize: '11.5px',
              display: 'inline-flex', alignItems: 'center', gap: '3px', textDecoration: 'none',
              background: 'rgba(255,255,255,0.18)', padding: '3px 9px', borderRadius: '999px',
            }}
          >
            Manage <ArrowRight size={12} />
          </Link>
        )}
      </div>
    </div>
  );
};
