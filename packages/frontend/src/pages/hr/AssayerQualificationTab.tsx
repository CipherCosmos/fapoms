import React from 'react';
import { Printer, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { useConfirm, StatusBadge, AlertBanner, SkeletonList } from '../../components/ui';
import { card, label, Bar, Empty, Section, Lede, LinkButton } from './hr-ui';
import { STANDING_LABELS } from './AssayerVettingTab';
import { openAssayerProfilePrintWindow } from './assayerProfilePrint';
import type { AssayerQualificationView, PartnerQualificationView, DimensionScoreView } from '@fapoms/shared';

/**
 * The Qualification tab — the roster's data synthesized into judgments.
 *
 * Everything here is computed on read from the vetting tables, so what HR just edited on the
 * Vetting or Documents tab is already reflected; nothing is cached to go stale. A number can
 * be overridden by ADMIN/OPERATIONS with a stated reason — the computed value stays visible
 * beside the human's, because an adjusted score must never be mistaken for a measured one.
 * "—" is a first-class answer meaning "not yet assessed", deliberately not zero.
 */

type QualificationPayload = AssayerQualificationView & { printSummary: Record<string, unknown> };

const toneFor = (n: number | null): string =>
  n == null ? 'var(--text-muted)'
  : n >= 80 ? 'var(--success)'
  : n >= 60 ? 'var(--accent)'
  : n >= 40 ? 'var(--warning)'
  : 'var(--danger)';

/** "This number was set by a person." Written once, because two lists on this tab say it. */
const adjustedChip: React.CSSProperties = {
  fontSize: '12px', fontWeight: 700, color: 'var(--warning)',
  textTransform: 'uppercase', letterSpacing: '.04em',
};

const ScoreChip: React.FC<{ value: number | null; small?: boolean }> = ({ value, small }) => (
  <span style={{
    fontWeight: 800, fontSize: small ? '13px' : '22px', color: toneFor(value),
    fontVariantNumeric: 'tabular-nums',
  }}>
    {value == null ? '—' : value}
  </span>
);

export const AssayerQualificationTab: React.FC<{
  assayerId: string;
  canManage: boolean;
}> = ({ assayerId, canManage }) => {
  const [data, setData] = React.useState<QualificationPayload | null>(null);
  const [partners, setPartners] = React.useState<PartnerQualificationView[] | null>(null);
  const [err, setErr] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [openPartner, setOpenPartner] = React.useState<string | null>(null);
  const { confirmWithReason, confirm, confirmDialog } = useConfirm();

  const load = React.useCallback(async () => {
    try {
      setErr(null);
      const [q, p] = await Promise.all([
        api.request<QualificationPayload>(`/assayers/${assayerId}/qualification`),
        api.request<PartnerQualificationView[]>(`/assayers/${assayerId}/qualification/partners`),
      ]);
      setData(q); setPartners(p);
    } catch (e) { setErr(userMessage(e)); }
  }, [assayerId]);

  React.useEffect(() => { load(); }, [load]);

  const setOverride = async (dimension: string, clientId?: string) => {
    const { confirmed, reason } = await confirmWithReason({
      title: `Override the ${dimension === 'overall' ? 'overall' : dimension} score`,
      message: 'The computed score stays visible beside your number, and the change is recorded on the History tab with your name. Enter the new score (0–100) followed by the reason — e.g. "85 — site visit confirmed the lapsed certificate was renewed".',
      confirmLabel: 'Set override',
      reasonPrompt: { label: 'New score and reason', placeholder: 'e.g. 85 — verified in person' },
    });
    if (!confirmed) return;
    // The dialog collects one line; the leading number is the score, the rest is the reason.
    const m = reason.match(/^\s*(\d{1,3})\s*[—–:,-]?\s*(.*)$/s);
    const value = m ? Number(m[1]) : NaN;
    const why = m && m[2] ? m[2].trim() : '';
    if (!Number.isFinite(value) || value < 0 || value > 100 || !why) {
      setErr('An override needs a score from 0 to 100 and a reason — e.g. "85 — verified in person".');
      return;
    }
    setBusy(true);
    try {
      await api.request(`/assayers/${assayerId}/qualification/override`, {
        method: 'PUT',
        body: JSON.stringify({ dimension, clientId: clientId ?? null, value, reason: why }),
      });
      await load();
    } catch (e) { setErr(userMessage(e)); }
    setBusy(false);
  };

  const clearOverride = async (overrideId: string, what: string) => {
    const ok = await confirm({
      title: 'Clear this override?',
      message: `The computed ${what} score comes back into force, and the clearance is recorded on the History tab.`,
      confirmLabel: 'Clear override',
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.request(`/assayers/qualification/override/${overrideId}`, { method: 'DELETE' });
      await load();
    } catch (e) { setErr(userMessage(e)); }
    setBusy(false);
  };

  const printProfile = async () => {
    if (!data || !partners) return;
    try {
      const dossier = await api.request<any>(`/assayers/${assayerId}/dossier`);
      const refs = dossier?.references ?? [];
      openAssayerProfilePrintWindow({
        qualification: data,
        partners,
        vetting: {
          backgroundVerdict: dossier?.currentCheck?.verdict ?? null,
          backgroundCheckedOn: dossier?.currentCheck?.checkedOn ?? null,
          cibilBand: dossier?.currentCheck?.cibilBand ?? null,
          referencesChecked: refs.filter((r: any) => r.checkedAt).length,
          referencesTotal: refs.length,
          certifications: (dossier?.onboarding ?? []).length ? undefined : undefined,
        },
      });
    } catch (e) { setErr(userMessage(e)); }
  };

  if (err && !data) return <AlertBanner type="error" message={err} />;
  // The scores are computed on read, so this wait is real; hold the shape rather than
  // replacing the tab with one line of prose.
  if (!data || !partners) return <SkeletonList rows={4} height={58} />;

  const overall = data.overall;

  return (
    <div style={{ display: 'grid', gap: '14px' }}>
      {confirmDialog}
      {/* One failure channel per screen — see AssayerRecord.tsx. */}
      <AlertBanner type="error" message={err} onClose={() => setErr(null)} />

      <Lede>
        {overall.effective == null
          ? 'How ready this person is for work, out of 100 — not yet assessable, because nothing scoreable is on their file yet.'
          : 'How ready this person is for work, out of 100, worked out fresh from their file each time this opens. '
            + 'Anything below is raised by filling the gap it names, not by editing the number.'}
      </Lede>

      {/* ── Overall ── */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
        <div style={{ textAlign: 'center', minWidth: '110px' }}>
          <div style={{ fontSize: '40px', fontWeight: 800, color: toneFor(overall.effective), lineHeight: 1 }}>
            {overall.effective == null ? '—' : overall.effective}
          </div>
          <div style={{ ...label, marginTop: '4px' }}>Overall / 100</div>
        </div>
        <div style={{ flex: 1, minWidth: '220px', fontSize: '12px', color: 'var(--text-secondary)' }}>
          {overall.effective == null
            ? 'Not yet assessed — nothing scoreable is on file. Scores appear as vetting, documents and work history are recorded.'
            : overall.override
              ? <>Adjusted from a computed {overall.computed ?? '—'} by {overall.override.setByName ?? 'staff'}: “{overall.override.reason}”
                  {canManage && <button className="btn btn-secondary" disabled={busy} onClick={() => clearOverride(overall.override!.id, 'overall')} style={{ marginLeft: '8px', fontSize: '12px', padding: '2px 8px' }}><RotateCcw size={11} /> Clear</button>}
                </>
              : 'Computed live from identity verification, record completeness, background checks, references, credentials and work history. Weights are set under Administration → Platform Settings → Assayer qualification.'}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {canManage && (
            <button className="btn btn-secondary" disabled={busy} onClick={() => setOverride('overall')} style={{ fontSize: '12px', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <SlidersHorizontal size={13} /> Override
            </button>
          )}
          {canManage && (
            <button className="btn btn-primary" disabled={busy} onClick={printProfile} style={{ fontSize: '12px', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <Printer size={13} /> Print profile
            </button>
          )}
        </div>
      </div>

      {/* ── Dimensions ── */}
      <Section title="What the score is made of">
        <div style={{ display: 'grid', gap: '12px' }}>
          {data.dimensions.map((d: DimensionScoreView) => (
            <div key={d.key}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
                <div style={{ fontSize: '13px', fontWeight: 600, flex: 1 }}>{d.label}</div>
                {d.override && (
                  <span title={`Computed ${d.computed ?? '—'} · adjusted by ${d.override.setByName ?? 'staff'}: ${d.override.reason}`}
                        style={adjustedChip}>
                    adjusted
                    {canManage && (
                      <LinkButton
                        onClick={() => clearOverride(d.override!.id, d.label)}
                        disabled={busy}
                        label={`Clear the override on ${d.label}`}
                        icon={<RotateCcw size={10} />}
                        style={{ color: 'var(--warning)', marginLeft: '4px' }}
                      />
                    )}
                  </span>
                )}
                <ScoreChip value={d.effective} small />
                {canManage && (
                  <LinkButton
                    onClick={() => setOverride(d.key)}
                    disabled={busy}
                    tone="muted"
                    label={`Override the ${d.label} score`}
                    icon={<SlidersHorizontal size={12} />}
                  />
                )}
              </div>
              <div style={{ margin: '5px 0 3px' }}><Bar pct={d.effective ?? 0} tone={toneFor(d.effective)} /></div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                {d.effective == null ? 'Not yet assessed — ' : ''}{d.basis.join(' · ')}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Partners ── */}
      <Section title="Partner qualification" count={partners.length}>
        {partners.length === 0 ? (
          <Empty>No partners on record yet. Add clients and their requirements to score against them.</Empty>
        ) : (
          <div style={{ display: 'grid', gap: '2px' }}>
            {partners.map((pt) => (
              <div key={pt.client.id} style={{ borderBottom: '1px solid var(--border-hair)', padding: '8px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
                     onClick={() => setOpenPartner(openPartner === pt.client.id ? null : pt.client.id)}>
                  <div style={{ flex: 1, fontSize: '13px', fontWeight: 600 }}>{pt.client.name}</div>
                  {pt.barred && <StatusBadge label="Barred by client" color="var(--danger)" bg="var(--status-cancelled-bg)" variant="pill" />}
                  {!pt.barred && pt.standing && (
                    /*
                      The written label, not `replace(/_/g, ' ').toLowerCase()`.

                      That was a hand-rolled de-capitaliser over an enum this codebase already has
                      words for — the same shape as the copy that once printed "blocks tDS
                      deduction". It produced "documents pending" and, for the value nobody had
                      written a label for at all, the bare word "inactive" where the standing
                      actually means "empanelled before, dormant now". One map, in
                      `STANDING_LABELS`, which now covers all eight values.
                    */
                    <StatusBadge label={STANDING_LABELS[pt.standing] ?? pt.standing} color={pt.standingCap != null ? 'var(--warning)' : 'var(--success)'} bg={pt.standingCap != null ? 'var(--status-pending-bg)' : 'var(--status-active-bg)'} variant="tag" />
                  )}
                  {pt.standingCap != null && !pt.barred && (
                    <span style={{ fontSize: '12px', color: 'var(--warning)' }} title={pt.standingReason ?? undefined}>capped at {pt.standingCap}</span>
                  )}
                  {/* The same word, the same way it is written against a dimension six lines up —
                      it was shouting in capitals here and lower case there. */}
                  {pt.override && <span style={adjustedChip}>adjusted</span>}
                  <ScoreChip value={pt.effective} small />
                  {canManage && (
                    <span onClick={(e) => e.stopPropagation()}>
                      <LinkButton
                        onClick={() => setOverride('overall', pt.client.id)}
                        disabled={busy}
                        tone="muted"
                        label={`Override the overall score for ${pt.client.name}`}
                        icon={<SlidersHorizontal size={12} />}
                      />
                    </span>
                  )}
                </div>
                {openPartner === pt.client.id && (
                  <div style={{ padding: '8px 0 4px', fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {pt.gaps.length === 0
                      ? 'Nothing outstanding for this partner.'
                      : (<>
                          <div style={{ ...label, marginBottom: '4px' }}>To raise this score</div>
                          <ul style={{ margin: 0, paddingLeft: '18px', display: 'grid', gap: '2px' }}>
                            {pt.gaps.map((g, i) => <li key={i}>{g}</li>)}
                          </ul>
                        </>)}
                    {pt.override && (
                      <div style={{ marginTop: '6px', color: 'var(--warning)' }}>
                        Adjusted to {pt.override.value} by {pt.override.setByName ?? 'staff'}: “{pt.override.reason}”
                        {canManage && <button className="btn btn-secondary" disabled={busy} onClick={() => clearOverride(pt.override!.id, pt.client.name)} style={{ marginLeft: '8px', fontSize: '12px', padding: '2px 8px' }}>Clear</button>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
};
