import React, { useState } from 'react';
import { formatRouteDistance, type RouteSource } from '@fapoms/shared';

export interface ExcludedCandidate {
  assayerId: string;
  displayName: string;
  reason: string;
  detail?: string;
  /**
   * Why-category from the engine. DATE = fine on another day; ONBOARDING = a real person whose
   * HR onboarding is unfinished; the rest are structural.
   */
  kind?: 'DATE' | 'ROTATION' | 'DISTANCE' | 'POLICY' | 'SKILLS' | 'ONBOARDING';
  distanceKm?: number | null;
  /**
   * How `distanceKm` was measured — 'OSRM' by road, 'ESTIMATE' as a straight line (the
   * geographic pre-filter always measures on a sphere, so its rows are always estimates).
   * Rendered as "213 km by road" or "~164 km (straight line, estimate)"; absent, hedged.
   */
  distanceSource?: RouteSource | null;
  /** First day after a blocking leave, when the engine could compute it. */
  nextAvailableDate?: string | null;
  /**
   * Whether "Assign anyway" on this row can actually succeed. Absent/true for every exclusion
   * this panel has always offered an override for. False only for a confirmed conflict-of-interest
   * distance — enforced server-side regardless of `overrideReason`, so offering the button would
   * let an operator type a considered justification and be refused for a reason never shown here.
   */
  overridable?: boolean;
}

/**
 * A suggested justification, keyed off the engine's own exclusion category (`kind`) rather than
 * the free-text `reason` sentence — `reason` carries interpolated numbers and exact policy wording
 * (see `EXCLUSION_REASONS`/`EXCLUSION_KINDS` in `recommendation.engine.ts`) that make it a poor
 * match key, while `kind` is the same small, stable set already used for the badge above.
 *
 * This only pre-fills the box (exactly as DATE-kind already did, see `startOverride` below) — it
 * is never validated against, so an operator can always edit or clear it and type their own.
 * ROTATION here is the "no repeat auditor on this branch" rule, not a weekly workload cap (this
 * codebase has no distinct capacity-exclusion kind), so its suggested phrase says what is actually
 * being waived rather than borrowing a name for a rule that doesn't exist here.
 */
const OVERRIDE_SUGGESTIONS: Partial<Record<NonNullable<ExcludedCandidate['kind']>, string>> = {
  DISTANCE: 'Distance exception approved by ops',
  ROTATION: 'Rotation rule waived for this assignment',
  SKILLS: 'Skill or certification requirement waived by ops',
  POLICY: 'Client specifically requested this assayer',
};
/** Fallback for a candidate with no `kind` at all. */
const DEFAULT_OVERRIDE_SUGGESTION = 'Client specifically requested this assayer';

const KIND_BADGE: Record<NonNullable<ExcludedCandidate['kind']>, { label: string; color: string; bg: string }> = {
  DATE: { label: 'AVAILABLE ANOTHER DAY', color: 'var(--success)', bg: 'var(--status-active-bg)' },
  // Deliberately not red: nothing is wrong with this person, their onboarding is simply
  // unfinished — and this is the row that answers "I added them, where are they?".
  ONBOARDING: { label: 'ONBOARDING INCOMPLETE', color: 'var(--warning)', bg: 'var(--status-pending-bg)' },
  ROTATION: { label: 'ROTATION RULE', color: 'var(--warning)', bg: 'var(--status-pending-bg)' },
  DISTANCE: { label: 'DISTANCE POLICY', color: 'var(--warning)', bg: 'var(--status-pending-bg)' },
  POLICY: { label: 'CLIENT POLICY', color: 'var(--danger)', bg: 'var(--status-cancelled-bg)' },
  SKILLS: { label: 'SKILLS / CERTS', color: 'var(--danger)', bg: 'var(--status-cancelled-bg)' },
};

/**
 * The next day worth proposing: not tomorrow if tomorrow is a Sunday or a public holiday.
 *
 * This used to return tomorrow flat. The offer endpoint enforces the holiday calendar, so on the
 * eve of a holiday the panel proposed a date, the operator clicked "Offer for …", and the app
 * rejected its own suggestion with "Holiday Conflict: Target date is a holiday in MAHARASHTRA" —
 * the recommender and the validator disagreeing in front of the user.
 *
 * `holidayDates` comes from the same calendar the backend validates against; when it has not
 * loaded we still skip Sundays, which removes the most common collision on its own. The server
 * remains the authority — this only stops us *suggesting* a date we know will be refused.
 */
const nextOfferableDay = (holidayDates: ReadonlySet<string>) => {
  const d = new Date();
  // A fortnight is far more than enough to clear a weekend and a holiday; past that, proposing
  // tomorrow and letting the operator correct it beats looping.
  for (let i = 0; i < 14; i++) {
    d.setDate(d.getDate() + 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (d.getDay() !== 0 && !holidayDates.has(key)) return key;
  }
  const fallback = new Date();
  fallback.setDate(fallback.getDate() + 1);
  return fallback.toISOString().slice(0, 10);
};

/**
 * Candidates the engine filtered out — and what can still be done with them.
 *
 * Exclusions are not equally final. A DATE exclusion (booked that day, on leave) is a good
 * candidate for another day, so those rows lead with a green "available another day" badge and
 * assign WITH a date picker (seeded from the day after their leave when known). Structural
 * exclusions (policy, skills) stay visible with their reason, overridable with a recorded
 * justification. Nothing eligible-adjacent is ever silently invisible.
 */
export const ExcludedCandidatesPanel: React.FC<{
  excluded: ExcludedCandidate[];
  onAssignAnyway?: (candidate: ExcludedCandidate, reason: string, scheduledDate?: string) => void | Promise<void>;
  assigningId?: string | null;
  /** Start expanded — used when the eligible list is empty and this panel IS the explanation. */
  defaultOpen?: boolean;
  /**
   * `YYYY-MM-DD` public holidays, so the date we propose is one the offer endpoint will accept.
   * Optional: without it we still avoid Sundays.
   */
  holidayDates?: ReadonlySet<string>;
}> = ({ excluded, onAssignAnyway, assigningId, defaultOpen = false, holidayDates }) => {
  const [open, setOpen] = useState(defaultOpen);
  const [overrideFor, setOverrideFor] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');
  /**
   * A refusal has to appear next to the row that was clicked.
   *
   * The workspace's message banner sits at the top of the page, but this panel is the last thing
   * on it — a rejected override (e.g. the backend refusing to bypass a qualification rule) painted
   * an error a thousand pixels above the button, off-screen, so the override looked like it had
   * silently done nothing. The banner still fires for anyone watching the top of the page; this is
   * the copy the person actually doing the work can see.
   */
  const [overrideError, setOverrideError] = useState<string | null>(null);

  if (excluded.length === 0) return null;

  const dateBound = excluded.filter((e) => e.kind === 'DATE').length;

  const startOverride = (e: ExcludedCandidate) => {
    setOverrideFor(e.assayerId);
    setOverrideError(null);
    // DATE-kind: the assignment is FOR a date — seed with the first day they're free.
    setDate(e.kind === 'DATE' ? (e.nextAvailableDate ?? nextOfferableDay(holidayDates ?? new Set())) : '');
    setReason(
      e.kind === 'DATE'
        ? 'Assigned for a date the assayer is available'
        : (e.kind ? OVERRIDE_SUGGESTIONS[e.kind] ?? DEFAULT_OVERRIDE_SUGGESTION : DEFAULT_OVERRIDE_SUGGESTION),
    );
  };

  const confirmOverride = async (candidate: ExcludedCandidate) => {
    const trimmed = reason.trim();
    if (!trimmed || !onAssignAnyway) return;
    setOverrideError(null);
    try {
      await onAssignAnyway(candidate, trimmed, date || undefined);
    } catch (err: any) {
      // Keep the form open holding what they typed, so the justification does not have to be
      // retyped to retry — and show why it was refused, right here.
      setOverrideError(err?.message || 'This override was refused. The assignment was not created.');
      return;
    }
    setOverrideFor(null);
    setReason('');
    setDate('');
  };

  return (
    <div style={{ marginTop: '10px', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-surface-2)' }}>
      <button onClick={() => setOpen(!open)}
        style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: '11.5px', fontWeight: 600, cursor: 'pointer' }}>
        <span>
          {excluded.length} assayer{excluded.length > 1 ? 's' : ''} not eligible for this date
          {dateBound > 0 && (
            <span style={{ color: 'var(--success)', fontWeight: 700 }}> — {dateBound} available another day</span>
          )}
        </span>
        <span>{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div style={{ padding: '0 10px 10px' }}>
          {excluded.map(e => {
            const isOverriding = overrideFor === e.assayerId;
            const busy = assigningId === e.assayerId;
            const badge = e.kind ? KIND_BADGE[e.kind] : null;
            const isDate = e.kind === 'DATE';
            const isOnboarding = e.kind === 'ONBOARDING';
            // Only ever false for a confirmed conflict-of-interest distance today (see the
            // `overridable` doc comment above) — but written against the flag itself, not the
            // DISTANCE kind, since that kind also covers the unlocated-home case, which IS
            // overridable and must keep its button.
            const notOverridable = e.overridable === false;
            return (
              <div key={e.assayerId} style={{ padding: '7px 0', borderTop: '1px solid var(--border-color)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                      {e.displayName}
                      {badge && (
                        <span style={{ fontSize: '9px', fontWeight: 800, padding: '1px 7px', borderRadius: '8px', background: badge.bg, color: badge.color, letterSpacing: '0.03em' }}>
                          {badge.label}
                        </span>
                      )}
                      {e.distanceKm != null && (
                        <span
                          title={e.distanceSource === 'OSRM' ? 'Measured along the road network.' : 'Straight-line distance — the road is longer, typically by 11–56 %.'}
                          style={{ fontSize: '10.5px', color: 'var(--text-muted)', fontWeight: 500 }}
                        >
                          {formatRouteDistance(e.distanceKm, e.distanceSource ?? null)}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                      {e.reason}
                      {isDate && e.nextAvailableDate && (
                        <span style={{ color: 'var(--success)', fontWeight: 600 }}> · free from {e.nextAvailableDate}</span>
                      )}
                    </div>
                    {e.detail && <div style={{ fontSize: '10.5px', color: 'var(--warning)', marginTop: '2px' }}>└─ {e.detail}</div>}
                  </div>
                  {/* No "assign anyway" for an unfinished onboarding. The other exclusions are
                      judgement calls an operator can reasonably overrule with a recorded reason;
                      this one means the person has not cleared document checks, background
                      verification or training, and dispatching them is the exact thing that
                      lifecycle exists to prevent. Link to the profile that carries the
                      transition control instead of offering a bypass. */}
                  {isOnboarding && (
                    <a
                      href={`/hr/roster?assayer=${e.assayerId}`}
                      className="btn btn-secondary"
                      style={{ padding: '3px 8px', fontSize: '10px', whiteSpace: 'nowrap', flexShrink: 0, width: 'auto', textDecoration: 'none' }}
                    >
                      Finish onboarding
                    </a>
                  )}
                  {/* No "assign anyway" here either — see `overridable` above. Unlike onboarding
                      there is no per-person fix to link to; this is a platform-wide setting, so
                      the row just says so plainly instead of offering a button that would refuse
                      every click with an error the operator had no way to predict. */}
                  {notOverridable && !isOnboarding && (
                    <span
                      title="Enforced regardless of reason. A platform admin can lift this client's minimum-distance rule in Platform Settings, for every branch at once."
                      style={{ padding: '3px 8px', fontSize: '10px', whiteSpace: 'nowrap', flexShrink: 0, color: 'var(--text-muted)', fontStyle: 'italic' }}
                    >
                      Not overridable here
                    </span>
                  )}
                  {onAssignAnyway && !isOverriding && !isOnboarding && !notOverridable && (
                    <button
                      onClick={() => startOverride(e)}
                      className="btn btn-secondary"
                      style={{ padding: '3px 8px', fontSize: '10px', whiteSpace: 'nowrap', flexShrink: 0, width: 'auto', ...(isDate ? { color: 'var(--success)', borderColor: 'var(--status-active-bg)' } : {}) }}
                    >
                      {isDate ? 'Assign another day' : 'Assign anyway'}
                    </button>
                  )}
                </div>
                {isOverriding && (
                  <div style={{ display: 'flex', gap: '6px', marginTop: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
                    {/* Earliest selectable day is the next non-Sunday. The seeded value also skips
                        known holidays (see `nextOfferableDay`); the operator may pick any later
                        date, and the offer endpoint remains the authority on what it will accept. */}
                    {isDate && (
                      <input
                        type="date"
                        value={date}
                        min={nextOfferableDay(new Set())}
                        onChange={(ev) => setDate(ev.target.value)}
                        aria-label="Date to assign the audit for"
                        style={{ fontSize: '11px', padding: '4px 7px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none' }}
                      />
                    )}
                    <input
                      autoFocus={!isDate}
                      value={reason}
                      onChange={(ev) => setReason(ev.target.value)}
                      // The value starts pre-filled with a suggested justification (see
                      // OVERRIDE_SUGGESTIONS above) that looks identical to operator-typed text
                      // once it's sitting in the box. Selecting it on focus means the first
                      // keystroke replaces it instead of appending to it or being missed — so
                      // confirming without typing still requires a deliberate Enter/click on
                      // "Confirm", not an accidental one, while anyone who agrees with the
                      // suggestion can still accept it unedited.
                      onFocus={(ev) => ev.target.select()}
                      onKeyDown={(ev) => { if (ev.key === 'Enter') void confirmOverride(e); if (ev.key === 'Escape') setOverrideFor(null); }}
                      placeholder={isDate ? 'Note (recorded)' : 'Reason for overriding this filter (recorded)'}
                      style={{ flex: 1, minWidth: '160px', fontSize: '11px', padding: '4px 7px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: '4px', color: 'var(--text-primary)', outline: 'none' }}
                    />
                    <button
                      onClick={() => confirmOverride(e)}
                      disabled={!reason.trim() || busy || (isDate && !date)}
                      className="btn btn-primary"
                      style={{ padding: '4px 9px', fontSize: '10px', width: 'auto', opacity: !reason.trim() || busy || (isDate && !date) ? 0.6 : 1 }}
                    >
                      {busy ? 'Assigning…' : isDate ? `Offer for ${date || '…'}` : 'Confirm'}
                    </button>
                    <button onClick={() => { setOverrideFor(null); setOverrideError(null); }} className="btn btn-secondary" style={{ padding: '4px 9px', fontSize: '10px', width: 'auto' }}>
                      Cancel
                    </button>
                  </div>
                )}
                {/* The refusal, next to the control that caused it — see `overrideError` above. */}
                {overrideFor === e.assayerId && overrideError && (
                  <div style={{ marginTop: '6px', padding: '5px 8px', fontSize: '10.5px', borderRadius: 'var(--radius-sm)', background: 'var(--status-cancelled-bg)', color: 'var(--danger)' }}>
                    {overrideError}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
