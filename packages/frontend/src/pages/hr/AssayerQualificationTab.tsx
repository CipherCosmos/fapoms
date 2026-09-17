import React from 'react';
import { ChevronDown, ChevronUp, Printer, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { api } from '../../services/api';
import { userMessage } from '../../services/errors';
import { LoadFailure, caughtLoad } from '../../components/LoadFailure';
import { useConfirm, StatusBadge, AlertBanner, SkeletonList } from '../../components/ui';
import { card, label, Bar, Empty, Section, Lede, LinkButton, Field, fieldInput, Editor } from './hr-ui';
import { STANDING_LABELS, standingStance, STANDING_STANCE_TONE } from './AssayerVettingTab';
import { openAssayerProfilePrintWindow } from './assayerProfilePrint';
import type { Assayer } from './assayer-shared';
import type { AssayerQualificationView, PartnerQualificationView, DimensionScoreView } from '@fapoms/shared';

/**
 * The Profile score tab (the API still calls it "qualification") — the roster's data synthesized
 * into judgments. On screen it is never "qualification": that word already names a person's
 * education on the same record, and one word for two things is how a clerk edits the wrong one.
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
  fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--warning)',
};

/**
 * A score as typed into the change dialog: a whole number from 0 to 100, or null.
 *
 * The dialog used to be one free-text line — "85 — verified in person" — split by a regex after
 * the clerk pressed the button, so a typo was only found out once the dialog had already closed.
 * Two boxes, checked as they are typed, and the button stays off until both are right.
 */
const parseScore = (raw: string): number | null => {
  const t = raw.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n <= 100 ? n : null;
};

/** The score being changed by hand while its dialog is open. */
interface ScoreChangeDraft {
  dimension: string;
  clientId?: string;
  /** How the dialog names the score: "the profile score", "the “Background check” score". */
  what: string;
  value: string;
  reason: string;
  /** The save's own failure, shown inside the dialog so the typing is not lost behind it. */
  error: string | null;
}

const ScoreChip: React.FC<{ value: number | null; small?: boolean }> = ({ value, small }) => (
  <span style={{
    fontWeight: 800, fontSize: small ? 'var(--text-sm)' : 'var(--text-xl)', color: toneFor(value),
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
  /** The read's failure, kept as the error itself so the banner can classify it (refusal vs outage). */
  const [loadErr, setLoadErr] = React.useState<unknown>(null);
  const [busy, setBusy] = React.useState(false);
  const [openPartner, setOpenPartner] = React.useState<string | null>(null);
  /** The per-part worksheet is detail most visits do not need; the one-line summary is the answer. */
  const [showParts, setShowParts] = React.useState(false);
  const [draft, setDraft] = React.useState<ScoreChangeDraft | null>(null);
  const { confirm, confirmDialog } = useConfirm();

  const load = React.useCallback(async () => {
    try {
      setErr(null);
      setLoadErr(null);
      const [q, p] = await Promise.all([
        api.request<QualificationPayload>(`/assayers/${assayerId}/qualification`),
        api.request<PartnerQualificationView[]>(`/assayers/${assayerId}/qualification/partners`),
      ]);
      setData(q); setPartners(p);
    } catch (e) { setLoadErr(e); }
  }, [assayerId]);

  React.useEffect(() => { void load(); }, [load]);

  const setOverride = (dimension: string, what: string, clientId?: string) => {
    setDraft({ dimension, clientId, what, value: '', reason: '', error: null });
  };

  const saveOverride = async () => {
    if (!draft) return;
    const value = parseScore(draft.value);
    const reason = draft.reason.trim();
    if (value == null || !reason) return;
    setBusy(true);
    try {
      await api.request(`/assayers/${assayerId}/qualification/override`, {
        method: 'PUT',
        body: JSON.stringify({ dimension: draft.dimension, clientId: draft.clientId ?? null, value, reason }),
      });
      setDraft(null);
      await load();
    } catch (e) {
      const message = userMessage(e);
      setDraft((d) => (d ? { ...d, error: message } : d));
    }
    setBusy(false);
  };

  const clearOverride = async (overrideId: string, what: string) => {
    const ok = await confirm({
      title: 'Undo this change?',
      message: `The ${what} score goes back to the one the system worked out. This is saved on the History tab.`,
      confirmLabel: 'Undo change',
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
      // `dossier.onboarding` is the joining-paperwork checklist (soft/hard copy, verification
      // status per requirement) — a different shape entirely from a certificate, and not
      // something this printed profile should read certifications out of. What the profile
      // means by "Certifications" is what the person actually holds, which lives on the assayer
      // record itself (`Assayer.certifications`, the same array `heldCredentials()` on the
      // backend reads when it scores this person's qualification). That is not part of either
      // response this tab already fetches, so it is a small third request, made only when
      // Print profile is actually pressed.
      const [dossier, assayer] = await Promise.all([
        api.request<any>(`/assayers/${assayerId}/dossier`),
        api.request<Pick<Assayer, 'certifications'>>(`/assayers/${assayerId}`),
      ]);
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
          certifications: assayer?.certifications ?? undefined,
        },
      });
    } catch (e) { setErr(userMessage(e)); }
  };

  /**
   * A bare red line with the raw sentence in it said "something went wrong" and no more. The
   * scores on this tab gate who gets offered work, so the difference between "your role is not
   * shown these" and "the scoring service is down" is the difference between raising a ticket and
   * waiting five minutes. Checked before the skeleton, which otherwise spins on a refusal forever.
   */
  if (loadErr != null) {
    return <LoadFailure loads={[{ label: 'their profile score', query: caughtLoad(loadErr, () => { void load(); }) }]} />;
  }
  // The scores are computed on read, so this wait is real; hold the shape rather than
  // replacing the tab with one line of prose.
  if (!data || !partners) return <SkeletonList rows={4} height={58} />;

  const overall = data.overall;
  const draftScore = draft ? parseScore(draft.value) : null;
  const draftScoreTypedWrong = !!draft && draft.value.trim() !== '' && draftScore == null;

  return (
    <div style={{ display: 'grid', gap: '14px' }}>
      {confirmDialog}
      {/* One failure channel per screen — see AssayerRecord.tsx. */}
      <AlertBanner type="error" message={err} onClose={() => setErr(null)} />

      {draft && (
        <Editor
          title={`Change ${draft.what}`}
          intro="The score the system worked out stays on screen next to yours. Your change and your reason are saved with your name on the History tab."
          onCancel={() => setDraft(null)}
          onSave={() => { void saveOverride(); }}
          saveLabel="Save score"
          busy={busy}
          saveDisabled={draftScore == null || !draft.reason.trim()}
          width={440}
        >
          <Field title="New score (0 to 100)">
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={100}
              step={1}
              aria-label="New score"
              aria-invalid={draftScoreTypedWrong || undefined}
              value={draft.value}
              onChange={(e) => setDraft({ ...draft, value: e.target.value, error: null })}
              placeholder="For example 85"
              style={fieldInput}
            />
            {draftScoreTypedWrong && (
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginTop: '4px' }}>
                Enter a whole number from 0 to 100.
              </div>
            )}
          </Field>
          <Field title="Why are you changing it?" wide>
            <textarea
              aria-label="Reason for the change"
              rows={3}
              value={draft.reason}
              onChange={(e) => setDraft({ ...draft, reason: e.target.value, error: null })}
              placeholder="For example: checked their renewed certificate in person"
              style={{ ...fieldInput, resize: 'vertical' }}
            />
          </Field>
          {draft.error && <AlertBanner type="error" message={draft.error} style={{ flex: '1 1 100%' }} />}
        </Editor>
      )}

      {/*
        One line carries what to do; the Overall card beside it already says what the number is.
        The old two-sentence version restated the card's own "out of 100, worked out fresh" line
        before getting to the point.
      */}
      <Lede>
        {overall.effective == null
          ? 'No profile score yet — there is nothing on their file to score.'
          : 'To raise a low score, fill in what is missing on their file rather than changing the number by hand.'}
      </Lede>

      {/* ── Overall ── */}
      <div style={{ ...card, display: 'flex', alignItems: 'center', gap: '20px', flexWrap: 'wrap' }}>
        <div style={{ textAlign: 'center', minWidth: '110px' }}>
          <div style={{ fontSize: 'var(--text-3xl)', fontWeight: 800, color: toneFor(overall.effective), lineHeight: 1 }}>
            {overall.effective == null ? '—' : overall.effective}
          </div>
          <div style={{ ...label, marginTop: '4px' }}>Profile score out of 100</div>
        </div>
        <div style={{ flex: 1, minWidth: '220px', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
          {overall.effective == null
            ? 'No score yet. It appears once their identity papers, background checks and work history are on file.'
            : overall.override
              ? <>Changed by hand by {overall.override.setByName ?? 'staff'} (the system worked out {overall.computed ?? '—'}): “{overall.override.reason}”
                  {canManage && <button className="btn btn-secondary" disabled={busy} onClick={() => clearOverride(overall.override!.id, 'profile')} style={{ marginLeft: '8px', fontSize: 'var(--text-xs)', padding: '2px 8px' }}><RotateCcw size={11} /> Undo change</button>}
                </>
              : 'Worked out from their identity papers, how complete their record is, background checks, references, certificates and work history. An administrator sets how much each part counts.'}
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          {canManage && (
            <button className="btn btn-secondary" disabled={busy} onClick={() => setOverride('overall', 'the profile score')} style={{ fontSize: 'var(--text-xs)', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <SlidersHorizontal size={13} /> Change score
            </button>
          )}
          {canManage && (
            <button className="btn btn-primary" disabled={busy} onClick={printProfile} style={{ fontSize: 'var(--text-xs)', display: 'flex', gap: '6px', alignItems: 'center' }}>
              <Printer size={13} /> Print profile
            </button>
          )}
        </div>
      </div>

      {/* ── Dimensions ── collapsed by default: the summary above is the answer, this is the working. */}
      <Section
        title="Parts of the score"
        action={(
          <button
            type="button"
            className="btn btn-secondary"
            aria-expanded={showParts}
            aria-controls="profile-score-parts"
            onClick={() => setShowParts((v) => !v)}
            style={{ fontSize: 'var(--text-xs)', display: 'flex', gap: '6px', alignItems: 'center', padding: '4px 10px' }}
          >
            {showParts ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            {showParts ? 'Hide details' : 'See what makes up this score'}
          </button>
        )}
      >
        {showParts && (
          <div id="profile-score-parts" style={{ display: 'grid', gap: '12px' }}>
            {data.dimensions.map((d: DimensionScoreView) => (
              <div key={d.key}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px' }}>
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, flex: 1 }}>{d.label}</div>
                  {d.override && (
                    <span style={adjustedChip}>
                      Changed by hand
                      {canManage && (
                        <LinkButton
                          onClick={() => clearOverride(d.override!.id, d.label)}
                          disabled={busy}
                          label={`Undo the change to ${d.label}`}
                          icon={<RotateCcw size={10} />}
                          style={{ color: 'var(--warning)', marginLeft: '4px' }}
                        />
                      )}
                    </span>
                  )}
                  <ScoreChip value={d.effective} small />
                  {canManage && (
                    <LinkButton
                      onClick={() => setOverride(d.key, `the “${d.label}” score`)}
                      disabled={busy}
                      tone="muted"
                      label={`Change the ${d.label} score`}
                      icon={<SlidersHorizontal size={12} />}
                    />
                  )}
                </div>
                <div style={{ margin: '5px 0 3px' }}><Bar pct={d.effective ?? 0} tone={toneFor(d.effective)} /></div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                  {d.effective == null ? 'No score yet — ' : ''}{d.basis.join(' · ')}
                </div>
                {d.override && (
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--warning)', marginTop: '2px' }}>
                    Changed by hand by {d.override.setByName ?? 'staff'} (the system worked out {d.computed ?? '—'}): “{d.override.reason}”
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── Partners ── */}
      <Section title="Score for each bank" count={partners.length}>
        {partners.length === 0 ? (
          <Empty>No banks on record yet. A score for each bank appears here once its requirements are added.</Empty>
        ) : (
          <div style={{ display: 'grid', gap: '2px' }}>
            {partners.map((pt) => (
              <div key={pt.client.id} style={{ borderBottom: '1px solid var(--border-hair)', padding: '8px 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer' }}
                     onClick={() => setOpenPartner(openPartner === pt.client.id ? null : pt.client.id)}>
                  <div style={{ flex: 1, fontSize: 'var(--text-sm)', fontWeight: 600 }}>{pt.client.name}</div>
                  {pt.barred && <StatusBadge label="Barred by this bank" color="var(--danger)" bg="var(--status-cancelled-bg)" variant="pill" />}
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
                    /*
                      Coloured by `standingStance`, the same rule the Summary strip and the
                      Vetting table use — NOT by whether a cap happens to apply. Colouring on
                      `pt.standingCap != null` instead meant a standing with no cap read as green
                      regardless of what it actually was, so a REJECTED or DOCUMENTS_PENDING
                      partner with nothing capping its score (there is nothing left to cap) sat
                      here in the same green as ACTIVE, disagreeing with the red/amber the other
                      two surfaces already show for that exact standing.
                    */
                    <StatusBadge
                      label={STANDING_LABELS[pt.standing] ?? pt.standing}
                      color={STANDING_STANCE_TONE[standingStance(pt.standing)].fg}
                      bg={STANDING_STANCE_TONE[standingStance(pt.standing)].bg}
                      variant="tag"
                    />
                  )}
                  {/* The same word, the same way it is written against a dimension above —
                      it was shouting in capitals here and lower case there. */}
                  {pt.override && <span style={adjustedChip}>Changed by hand</span>}
                  <ScoreChip value={pt.effective} small />
                  {canManage && (
                    <span onClick={(e) => e.stopPropagation()}>
                      <LinkButton
                        onClick={() => setOverride('overall', `the score for ${pt.client.name}`, pt.client.id)}
                        disabled={busy}
                        tone="muted"
                        label={`Change the score for ${pt.client.name}`}
                        icon={<SlidersHorizontal size={12} />}
                      />
                    </span>
                  )}
                </div>
                {/*
                  Why the number stops where it does, said on the row. It used to be the words
                  "capped at 40" with the reason only in a hover title — which a tablet never shows.
                */}
                {pt.standingCap != null && !pt.barred && (
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--warning)', marginTop: '2px' }}>
                    Held at {pt.standingCap} or below because of this bank’s standing
                    {pt.standingReason ? <>: “{pt.standingReason}”</> : '.'}
                  </div>
                )}
                {openPartner === pt.client.id && (
                  <div style={{ padding: '8px 0 4px', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                    {pt.gaps.length === 0
                      ? 'Nothing missing for this bank.'
                      : (<>
                          <div style={{ ...label, marginBottom: '4px' }}>To raise this score</div>
                          <ul style={{ margin: 0, paddingLeft: '18px', display: 'grid', gap: '2px' }}>
                            {pt.gaps.map((g, i) => <li key={i}>{g}</li>)}
                          </ul>
                        </>)}
                    {pt.override && (
                      <div style={{ marginTop: '6px', color: 'var(--warning)' }}>
                        Changed by hand to {pt.override.value} by {pt.override.setByName ?? 'staff'}: “{pt.override.reason}”
                        {canManage && <button className="btn btn-secondary" disabled={busy} onClick={() => clearOverride(pt.override!.id, pt.client.name)} style={{ marginLeft: '8px', fontSize: 'var(--text-xs)', padding: '2px 8px' }}>Undo change</button>}
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
