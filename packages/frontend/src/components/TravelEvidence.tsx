import React from 'react';
import { MapPin, ShieldAlert, ShieldCheck, EyeOff, HelpCircle } from 'lucide-react';
import { getTravelVerification, TravelVerification, TravelVerdict } from '../services/expenses';

/**
 * What the movement trail says about a travel claim, shown where the claim is decided.
 *
 * The tone is chosen as carefully as the maths behind it. This sits next to an Approve button, and
 * an approver reading it is deciding about a colleague's pay — so it presents evidence and never a
 * recommendation, and it is emphatic about what the data *cannot* establish. A thin trail says so
 * plainly rather than looking like a mild version of a shortfall; only a well-observed window ever
 * gets the warning colour. Rural signal, bank basements and dead batteries are the normal case,
 * and a screen that shaded them amber would train reviewers to distrust honest people.
 */

const VERDICT_STYLE: Record<
  TravelVerdict,
  { label: string; colour: string; background: string; Icon: typeof MapPin }
> = {
  CONSISTENT: {
    label: 'Consistent with the trail',
    colour: 'var(--success, #16a34a)',
    background: 'var(--status-active-bg, rgba(22,163,74,0.09))',
    Icon: ShieldCheck,
  },
  SHORTFALL: {
    label: 'Less movement than claimed',
    colour: 'var(--warning, #b45309)',
    background: 'var(--status-pending-bg, rgba(180,83,9,0.09))',
    Icon: ShieldAlert,
  },
  IMPLAUSIBLE: {
    label: 'Trail cannot be trusted',
    colour: 'var(--danger, #b91c1c)',
    background: 'var(--status-cancelled-bg, rgba(185,28,28,0.09))',
    Icon: ShieldAlert,
  },
  // Both "we could not see" outcomes stay neutral. They are not weak evidence of wrongdoing;
  // they are the absence of evidence, and the copy says so.
  INSUFFICIENT_COVERAGE: {
    label: 'Not enough was observed to judge',
    colour: 'var(--text-muted)',
    background: 'var(--bg-surface-2, rgba(127,127,127,0.08))',
    Icon: HelpCircle,
  },
  NO_DATA: {
    label: 'No movement recorded',
    colour: 'var(--text-muted)',
    background: 'var(--bg-surface-2, rgba(127,127,127,0.08))',
    Icon: EyeOff,
  },
};

const km = (n: number | null | undefined) => (n == null ? '—' : `${Number(n).toFixed(1)} km`);

export const TravelEvidence: React.FC<{ assignmentId: string }> = ({ assignmentId }) => {
  const [data, setData] = React.useState<TravelVerification | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getTravelVerification(assignmentId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: any) => { if (!cancelled) setError(e?.message ?? 'Could not load the movement trail.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [assignmentId]);

  if (loading) {
    return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Checking the movement trail…</div>;
  }
  if (error) {
    return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Movement trail unavailable: {error}</div>;
  }
  if (!data) return null;

  // No check-in means no confirmed arrival to measure a journey against — stated, not implied.
  if (!data.assessment) {
    return (
      <div style={wrap('var(--bg-surface-2, rgba(127,127,127,0.08))')}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-muted)', fontWeight: 600, fontSize: 12 }}>
          <HelpCircle size={14} /> No journey to compare
        </div>
        <p style={body}>{data.unavailableReason ?? 'This assignment has no recorded arrival.'}</p>
      </div>
    );
  }

  const { verdict, summary, track, observedRatio } = data.assessment;
  const style = VERDICT_STYLE[verdict] ?? VERDICT_STYLE.NO_DATA;
  const { Icon } = style;

  return (
    <div style={wrap(style.background)}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: style.colour, fontWeight: 700, fontSize: 12 }}>
        <Icon size={14} /> {style.label}
      </div>

      <p style={body}>{summary}</p>

      <dl style={grid}>
        <Stat label="Movement recorded" value={km(track.observedDistanceKm)} />
        <Stat
          label="Distance quoted"
          value={km(data.expectedDistanceKm)}
          // The quoted distance is recomputed from the assayer's current home address because it
          // was never stored. A reviewer comparing two numbers should know one is reconstructed.
          note={data.expectedIsRecomputed ? 'recomputed from home address' : undefined}
        />
        <Stat label="Window observed" value={`${Math.round(track.coverage * 100)}%`} />
        <Stat label="Longest gap" value={`${track.longestGapMinutes} min`} />
        {observedRatio != null && <Stat label="Observed vs quoted" value={`${Math.round(observedRatio * 100)}%`} />}
        <Stat label="Positions" value={String(track.fixCount)} />
      </dl>

      {!data.trackingEnabled && (
        <p style={{ ...body, color: 'var(--text-muted)' }}>
          Location sharing is switched off for this assayer, so there may be no trail to compare
          regardless of the journey taken.
        </p>
      )}

      {(track.mockedFixCount > 0 || track.segmentsImplausible > 0) && (
        <p style={{ ...body, color: 'var(--danger, #b91c1c)' }}>
          {track.mockedFixCount > 0 && `${track.mockedFixCount} position(s) came from a mock provider. `}
          {track.segmentsImplausible > 0 && `${track.segmentsImplausible} impossible jump(s) were excluded. `}
          Confirm the device before drawing a conclusion either way.
        </p>
      )}

      <p style={{ ...body, color: 'var(--text-muted)', fontStyle: 'italic' }}>
        Evidence only — this does not approve or reject the claim.
      </p>
    </div>
  );
};

const Stat: React.FC<{ label: string; value: string; note?: string }> = ({ label, value, note }) => (
  <div>
    <dt style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
      {label}
    </dt>
    <dd style={{ margin: 0, fontSize: 13, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
      {value}
      {note && <span style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)' }}> ({note})</span>}
    </dd>
  </div>
);

const wrap = (background: string): React.CSSProperties => ({
  background,
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-sm, 6px)',
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
});

const body: React.CSSProperties = { margin: 0, fontSize: 12, lineHeight: 1.5 };

const grid: React.CSSProperties = {
  margin: 0,
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(115px, 1fr))',
  gap: '8px 14px',
};
