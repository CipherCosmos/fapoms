import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  APPLICATION_REFERENCES_MAX, bankAccountConfirmProblem, referenceEmailProblem, referencePhoneForDisplay,
  isRegistrationSecretField, looksMasked,
} from '@fapoms/shared';
import {
  User, MapPin, CreditCard, FileText, Users, Building2, ClipboardCheck,
  Check, ChevronLeft, ChevronRight, AlertTriangle, Plus, Phone,
} from 'lucide-react';
import { AlertBanner, Select, StatusBadge, PageHeader, useToast, useConfirm } from '../../../components/ui';
import { PinCoordinateControl } from '../../../components/PinCoordinateControl';
import { useWorkforceVocabulary } from '../../../hooks/useWorkforceVocabulary';
import {
  renderFormField, resolvePincode, addressConflict, resolveIfsc, useHrOwnerOptions,
  type FieldDef, type IfscInfo, type DuplicateMatch,
} from '../AssayerForms';
import {
  REGISTRATION_FIELDS, RATE_FIELDS, REGISTRATION_STEPS, REGISTRATION_STEP_KEYS,
  STEP_FIELDS, isPlannableForSomeone, stepOfField, validateStep,
  mappedFieldsFromError, type RegistrationStepKey,
} from './steps';
import { useRegistration } from './useRegistration';
import { useDuplicateCheck, type DuplicateCheckKey } from './useDuplicateCheck';
import { ApplicationDocumentsStep } from './ApplicationDocumentsStep';
import { ClientsStep, type DraftStanding } from './ClientsStep';
import { relationshipOptions } from '../reference-vocabulary';
import {
  EMPTY_REFERRAL, SourceReferralFields, referralDraftFrom, referralPayload, type SourceReferralDraft,
} from '../../../components/SourceReferralFields';
import { Page } from '../../../components/ui/Page';

/**
 * Collapses the vertical step rail to a horizontal scroller once the page cannot hold rail and
 * content side by side — the same pattern `Projects.tsx` already uses for its own table/detail
 * split, copied rather than re-invented.
 */
const useIsNarrow = (max = 880): boolean => {
  const [narrow, setNarrow] = useState(
    typeof window !== 'undefined' ? window.innerWidth <= max : false,
  );
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${max}px)`);
    const handler = () => setNarrow(mq.matches);
    handler();
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [max]);
  return narrow;
};

/** The three boxes this step checks against the roster as the clerk types them. */
const DUPLICATE_CHECK_FIELDS: readonly DuplicateCheckKey[] = ['phone', 'panNumber', 'aadhaarNumber'];

/**
 * Registering an assayer, from the desk, end to end.
 *
 * The owner's requirement is one sentence: *every assayer does not have a smartphone, so HR must
 * be able to register them end to end from their side*. That rules out every design where some
 * part of the record can only be supplied by the person themselves — so there is no step here
 * that needs a device, an account, a login or even a phone number, and the last page says so in
 * as many words rather than leaving a clerk to discover it.
 *
 * What replaced what: this is not a re-skin of the old "⚡ Express / 📋 Advanced (6 Tabs)" modal.
 * That was a mode switch — the same flat set of boxes, twice, ending in one `POST /assayers` —
 * and the parts of a registration that are not boxes had no place in it at all. The pin control
 * existed and was mounted only on Branches; the document upload existed and lived two tabs deep
 * on a record; the pay rates were a second, unwatched request whose failure left a real person on
 * the roster with no rates behind a toast that said "Could not create assayer".
 *
 * The one structural decision everything else follows from: **the record is created at the end of
 * step 1**, because the map pin, the scans and the references all post to routes that need an id.
 * From that moment the wizard is a view over a real row, every step saves what moved, and an
 * interrupted registration is simply a person on the roster with blanks left — reopenable, by
 * this same flow, at the first thing still missing.
 *
 * The second thing it produced, which took a roster to notice: **a complete record that could not
 * be given a single job.** Nothing here asked which banks had accepted the person, and planning
 * refuses anybody with no empanelment standing — 245 of the 548 people who are ACTIVE today are
 * unplannable for that one reason. `ClientsStep` is that question, and the Review step says out
 * loud what it costs to skip it rather than leaving the flow to end on a green tick.
 */

const STEP_ICONS: Record<RegistrationStepKey, React.ReactNode> = {
  person: <User size={14} />,
  address: <MapPin size={14} />,
  identity: <CreditCard size={14} />,
  documents: <FileText size={14} />,
  people: <Users size={14} />,
  clients: <Building2 size={14} />,
  review: <ClipboardCheck size={14} />,
};

const fieldsMap = new Map<string, FieldDef>(
  [...REGISTRATION_FIELDS, ...RATE_FIELDS].map((f) => [f.key, f]),
);

const gridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px',
};

const blockTitleStyle: React.CSSProperties = {
  fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '2px',
};
const blockNoteStyle: React.CSSProperties = {
  fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: '10px',
};

/**
 * A sub-heading, one line saying what it is for, and its boxes.
 *
 * Every block carries a note. A registration form is read by people who did not design it, and a
 * heading like "Emergency contact" answers what the boxes are called, not why anyone is being
 * asked — which is the question that decides whether the boxes get filled in honestly or at all.
 */
const Block: React.FC<{
  title: string;
  note: string;
  keys: readonly string[];
  render: (field: FieldDef) => React.ReactNode;
  children?: React.ReactNode;
}> = ({ title, note, keys, render, children }) => (
  <div>
    <div style={blockTitleStyle}>{title}</div>
    <div style={blockNoteStyle}>{note}</div>
    <div style={gridStyle}>
      {keys.map((key) => { const f = fieldsMap.get(key); return f ? render(f) : null; })}
    </div>
    {children}
  </div>
);

/**
 * The progress rail: where you are, what is behind you, and what is still to come.
 *
 * The screen this replaces had a Previous/Next pair and nothing else — no indication of how many
 * steps there were, which one you were on, or whether the one you were leaving had saved. Each
 * step here is a real button with its own name, so it is reachable directly and readable by a
 * screen reader as what it is; the tick means the record has been saved past that point, not that
 * the step is "complete", because almost nothing in a registration is compulsory.
 *
 * Every step is reachable the moment the page opens. It used to disable every button past the
 * first until the record existed, on the reasoning that there was nothing there yet to look at —
 * but LOOKING at "Papers and scans" or "Who they can work for" costs nothing, and a clerk who
 * wanted to see what was coming, or who arrived here from a link to a step they had already
 * started, met a wall of greyed-out buttons and a tooltip instead. What still waits on the record
 * existing is SAVING one of these steps, not reading it — see `SAVES_TO_RECORD` and the inline
 * note each such step shows for itself.
 */
const StepRail: React.FC<{
  current: RegistrationStepKey;
  furthest: number;
  onGo: (key: RegistrationStepKey) => void;
  /** Vertical list on a normal-width screen; a horizontal scroller once it cannot fit beside the content. */
  narrow: boolean;
}> = ({ current, furthest, onGo, narrow }) => {
  const currentIndex = REGISTRATION_STEP_KEYS.indexOf(current);
  return (
    <nav
      aria-label="Registration steps"
      style={{
        display: 'flex', gap: '6px', flexShrink: 0,
        flexDirection: narrow ? 'row' : 'column',
        overflowX: narrow ? 'auto' : 'visible',
        paddingBottom: narrow ? '4px' : 0,
        width: narrow ? '100%' : '230px',
        // Pinned to the top of the page's own scroll area on a normal-width screen, so the
        // rail — the only way to see which step you're on or jump to another — stays in view
        // while a long step (21 documents, say) scrolls past beside it. Left out on the narrow
        // layout: there it is a horizontal strip ABOVE the content, not a sidebar beside it, and
        // pinning it there would permanently claim a strip of a phone's much scarcer height.
        ...(narrow ? {} : { position: 'sticky' as const, top: 0 }),
      }}
    >
      {REGISTRATION_STEPS.map((step, i) => {
        const active = step.key === current;
        const done = i < furthest;
        return (
          <button
            key={step.key}
            type="button"
            onClick={() => onGo(step.key)}
            aria-current={active ? 'step' : undefined}
            title={step.caption}
            style={{
              display: 'flex', alignItems: 'center', gap: '8px', textAlign: 'left',
              padding: narrow ? '9px 14px' : '10px 12px', fontSize: 'var(--text-sm)', fontWeight: active ? 700 : 600,
              borderRadius: 'var(--radius-md)', cursor: 'pointer',
              border: `1px solid ${active ? 'var(--accent)' : 'var(--border-color)'}`,
              background: active ? 'var(--status-pending-bg)' : 'var(--bg-surface-2)',
              color: active ? 'var(--accent)' : done ? 'var(--success)' : 'var(--text-secondary)',
              flexShrink: 0, whiteSpace: narrow ? 'nowrap' : 'normal', width: narrow ? 'auto' : '100%',
            }}
          >
            {done && !active ? (
              <StatusBadge
                variant="tag"
                size="sm"
                color="var(--success)"
                bg="color-mix(in srgb, var(--success) 16%, transparent)"
                icon={<Check size={11} aria-hidden />}
                title="Saved"
                style={{ padding: '4px', minHeight: 'auto', boxShadow: 'none', border: 'none' }}
              />
            ) : (
              <span aria-hidden style={{ display: 'inline-flex', flexShrink: 0 }}>{STEP_ICONS[step.key]}</span>
            )}
            <span>{i + 1}. {step.title}</span>
          </button>
        );
      })}
      <span aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
        Step {currentIndex + 1} of {REGISTRATION_STEPS.length}: {REGISTRATION_STEPS[currentIndex]?.title}
      </span>
    </nav>
  );
};

/**
 * People who can vouch for this person, added one at a time against the real record.
 *
 * Held with the application rather than written as its own row, because there is no person to
 * hang a row on yet: `applyExtendedProfile` replays them through `rosterRecords.saveReference` at
 * approval, which is the same call this used to make directly. Nobody has rung them either way —
 * that is a separate, attested act on the record — and the copy says so, because "reference added"
 * reading as "reference checked" is the whole risk.
 */
export interface DraftReference {
  fullName: string;
  relationship?: string;
  phone?: string;
  email?: string;
}

const ReferencesBlock: React.FC<{
  references: DraftReference[];
  onChange: (next: DraftReference[]) => void;
}> = ({ references, onChange }) => {
  const [draft, setDraft] = useState({ fullName: '', relationship: '', phone: '', email: '' });
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const saving = false;

  const add = () => {
    if (!draft.fullName.trim()) {
      setError('A reference needs at least a name.');
      return;
    }
    // Same ceiling the candidate's own form and the server enforce — a fourth name has
    // nowhere to go, so it is refused here rather than dropped on save.
    if (references.length >= APPLICATION_REFERENCES_MAX) {
      setError(`Only ${APPLICATION_REFERENCES_MAX} references are needed.`);
      return;
    }
    if (draft.email.trim() && referenceEmailProblem(draft.email.trim().toLowerCase())) {
      setError('That email does not look right.');
      return;
    }
    setError(null);
    onChange([...references, {
      fullName: draft.fullName.trim(),
      relationship: draft.relationship || undefined,
      phone: draft.phone.trim() || undefined,
      email: draft.email.trim().toLowerCase() || undefined,
    }]);
    toast({ type: 'success', title: 'Reference added', message: `${draft.fullName.trim()} is on file. Nobody has rung them yet.` });
    setDraft({ fullName: '', relationship: '', phone: '', email: '' });
  };

  const inputStyle: React.CSSProperties = {
    // `--bg-input`, not `--bg-page` — the two render identically in the dark themes, which is
    // why this box used to be invisible against the page it sits directly on.
    padding: '9px 11px', fontSize: 'var(--text-sm)', background: 'var(--bg-input)',
    border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
    color: 'var(--text-primary)', outline: 'none', width: '100%', boxSizing: 'border-box',
  };

  return (
    <div>
      <div style={blockTitleStyle}>People who can vouch for them</div>
      <div style={blockNoteStyle}>
        Optional, and adding one here does not mean anybody has rung them — that is recorded
        separately, on their record, by whoever makes the call.
      </div>
      {references.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 10px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {references.map((r, i) => (
              <li key={`${r.fullName}-${i}`} style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', display: 'flex', gap: '8px', alignItems: 'center' }}>
                <Phone size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} aria-hidden />
                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{r.fullName}</span>
                {r.relationship && <span>· {r.relationship}</span>}
                {r.phone && <span>· {referencePhoneForDisplay(r.phone)}</span>}
                {r.email && <span>· {r.email}</span>}
                {/* Nobody can have been rung yet: this person does not exist to be a reference FOR
                    until the application is approved. */}
                <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>· not rung yet</span>
                {/* Without this a mistyped name could only be lived with — and with a ceiling of
                    three, one typo left the clerk unable to add the reference they meant. */}
                <button
                  type="button"
                  onClick={() => onChange(references.filter((_, j) => j !== i))}
                  aria-label={`Remove reference ${r.fullName}`}
                  className="btn btn-secondary"
                  style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', padding: '3px 10px' }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      {references.length >= APPLICATION_REFERENCES_MAX ? (
        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          Three references is the most an application takes — remove one to change them.
        </div>
      ) : (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', alignItems: 'end' }}>
        <input
          value={draft.fullName}
          onChange={(e) => setDraft({ ...draft, fullName: e.target.value })}
          placeholder="Their name"
          aria-label="Name of the person who can vouch for them"
          style={inputStyle}
        />
        {/*
          A fixed list, not free text — this posts to the same `relationship` column the vetting
          tab corrects later (`AssayerReferenceEntity.relationship`, a plain varchar with no FK),
          and free text on it is exactly how one relationship became "Ex-manager", "ex manager"
          and "Former Manager" with nothing usable to show for the 1,983 references already on
          file. See `reference-vocabulary.ts` for the shared list both screens render.
        */}
        <Select
          value={draft.relationship}
          onChange={(v) => setDraft({ ...draft, relationship: String(v) })}
          options={relationshipOptions(draft.relationship)}
          aria-label="How the reference knows this person"
          style={inputStyle}
        />
        <input
          value={draft.phone}
          onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
          placeholder="Their phone number"
          aria-label="Phone number of the reference"
          style={inputStyle}
        />
        <input
          value={draft.email}
          onChange={(e) => setDraft({ ...draft, email: e.target.value })}
          placeholder="Their email (optional)"
          aria-label="Email of the reference"
          type="email"
          style={inputStyle}
        />
        <button
          type="button"
          onClick={() => void add()}
          disabled={saving}
          className="btn btn-secondary"
          style={{ fontSize: 'var(--text-xs)', padding: '9px 14px', display: 'inline-flex', alignItems: 'center', gap: '6px', width: 'auto' }}
        >
          <Plus size={13} /> {saving ? 'Adding…' : 'Add this person'}
        </button>
      </div>
      )}
      {error && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginTop: '6px' }}>{error}</div>}
    </div>
  );
};

/** The last page: what is on file, what is not, and what each blank one actually costs. */
const ReviewStep: React.FC<{
  name: string;
  /**
   * The server's own gap list for this application — `missingRegistrationFields` over the merged
   * view of its columns and its extended profile.
   *
   * It used to be recomputed here from the assayer record this form had already created. There is
   * no record now, and asking the application is better anyway: the same list HR sees on the
   * review screen, so the desk and the reviewer cannot disagree about what is outstanding.
   */
  gaps: Array<{ key: string; label: string; blocks: string }>;
  scannedCount: number;
  requirementCount: number;
  standings: DraftStanding[];
  onGo: (step: RegistrationStepKey) => void;
}> = ({ name, gaps: rawGaps, scannedCount, requirementCount, standings, onGo }) => {
  const gaps = rawGaps.map((g) => ({ ...g, why: g.blocks, step: stepOfField(g.key) }));
  const plannable = isPlannableForSomeone(standings);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{
        ...cardish,
        borderColor: 'var(--success)',
      }}>
        <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '7px' }}>
          {/*
            Not "is on the roster". They are not, and that claim is what made the rest of the
            pipeline look optional: the form announced a hire it had performed itself, three
            approvals ahead of anybody deciding to make one.
          */}
          <Check size={15} /> {name || 'This person'}'s application is filled in
        </div>
        {/*
          * Named once, in the exact words the desk is meant to trust it in.
          *
          * Everywhere above this line "the name" is whatever reads best in a sentence — "Ramesh
          * Iyer's application is filled in" — right for a headline and wrong for a check: nothing
          * on this page, until now, said in so many words that what was typed IS what the bank
          * and TDS filings will be checked against. One labelled row, once, is that confirmation.
          */}
        {name && (
          <div style={{ marginTop: '8px' }}>
            <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Full name (as on Aadhaar/PAN)
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)', fontWeight: 600 }}>{name}</div>
          </div>
        )}
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: '6px' }}>
          {/*
            No code to print, and that is the honest part. A code is allocated when the record is
            created, which happens when somebody approves this — so a code here would be a number
            for a person who does not exist yet. This page used to print one, because the wizard
            had already made them.
          */}
          Nothing is on the roster yet. Send them their link so they can confirm their number and
          accept the declaration, then this comes to HR as an application to approve.
        </div>
      </div>

      {/*
        * The one thing on this page that is a sentence rather than an item in a list.
        *
        * Being on the roster and being givable work are two different states, and the gap between
        * them is invisible: `planning.eligibility.noEmpanelmentRow` defaults to BLOCK, so a person
        * with no standing is dropped from every client's candidate list with a reason that never
        * reaches the desk. 245 of the 548 people currently ACTIVE are in that state, and every one
        * of them looks finished on this page.
        *
        * So it is said, not iconified. A warning triangle beside a phrase like "no client
        * standing" is read as a nag about paperwork; "cannot be given work for any client" is read
        * as what it is. Not a blocker either — RECOMMENDED and "waiting on paperwork" are honest
        * pre-vetting states and HR must be able to enrol somebody before a bank has cleared them.
        */}
      <div style={{
        ...cardish,
        borderColor: plannable ? 'var(--success)' : 'var(--danger)',
        borderWidth: plannable ? '1px' : '2px',
      }}>
        <div style={{ ...blockTitleStyle, color: plannable ? 'var(--text-primary)' : 'var(--danger)' }}>
          {plannable ? 'Who they can work for' : 'They cannot be given work yet'}
        </div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          {plannable
            ? `${standings.length} client ${standings.length === 1 ? 'standing' : 'standings'} recorded, `
              + 'which are filed against them when the application is approved.'
            : `${name || 'This person'} cannot be given work for any client until a client standing is set. `
              + 'No bank is ever offered somebody they have not accepted, so until then they will '
              + 'not appear on any planning screen however complete the rest of this record is.'}
        </div>
        <button type="button" onClick={() => onGo('clients')} style={linkButtonStyle}>
          {plannable ? 'Change who they can work for' : 'Set it now'}
        </button>
      </div>

      <div style={cardish}>
        <div style={blockTitleStyle}>Papers on file</div>
        <div style={{ fontSize: 'var(--text-sm)', color: scannedCount > 0 ? 'var(--text-secondary)' : 'var(--warning)' }}>
          {scannedCount} of {requirementCount} documents have a scan attached.
          {scannedCount === 0 && ' Nothing has been scanned, so nobody can check this person’s identity against a document later.'}
        </div>
        <button type="button" onClick={() => onGo('documents')} style={linkButtonStyle}>
          Go back and add scans
        </button>
      </div>

      <div style={cardish}>
        <div style={blockTitleStyle}>{gaps.length === 0 ? 'Nothing is missing' : 'Still missing'}</div>
        <div style={blockNoteStyle}>
          {gaps.length === 0
            ? 'Every detail this company needs before somebody can be paid or sent to a site is on the record.'
            : 'None of these stop you finishing now. Each one stops something else until it is filled in.'}
        </div>
        {gaps.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {gaps.map((gap) => (
              <li key={gap.key} style={{ display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                <AlertTriangle size={13} style={{ color: 'var(--warning)', flexShrink: 0 }} aria-hidden />
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>{gap.label}</span>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>blocks {gap.why}</span>
                {gap.step && (
                  <button type="button" onClick={() => onGo(gap.step!)} style={linkButtonStyle}>
                    Fill it in
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/*
        * Said out loud, on the last page, because it is the thing the desk gets wrong.
        *
        * Nothing in this system requires an assayer to hold credentials or to have ever logged
        * in: the planner's deployability gate reads `isActive && status === 'ACTIVE'` and nothing
        * else. A clerk who believes otherwise leaves people half-registered waiting for an app
        * account that was never needed — which is exactly how a person with no smartphone ends up
        * unregistrable.
        */}
      <div style={{ ...cardish, background: 'var(--bg-surface-2)' }}>
        <div style={blockTitleStyle}>They do not need a phone or the app</div>
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          This registration is complete without a mobile number, an email address, a password or
          the app. Giving somebody app access is a separate thing you can do later from their
          record, and no stage of onboarding waits on it.
        </div>
      </div>
    </div>
  );
};

const cardish: React.CSSProperties = {
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--bg-card)',
  padding: '14px 16px',
};

const linkButtonStyle: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--accent-primary)', fontSize: 'var(--text-xs)', fontWeight: 600, textDecoration: 'underline',
};

/**
 * `?step=` on this page, replaying `hr-ui.tsx`'s `useViewParam` against a param name of its own
 * rather than importing it. That file's version is hard-coded to `?view=`, which every OTHER HR
 * page's chip strip already owns; a second consumer of the same key would have this flow jump to
 * whatever chip a colleague had last open on an entirely different screen sharing the URL by
 * coincidence. `?step=` is this flow's own vocabulary, so a deep link into a particular page of
 * somebody's registration — the audit's `firstIncompleteStep` jump among them — cannot collide
 * with anything else in the section.
 */
function useStepParam<K extends string>(keys: readonly K[], fallback: K): [K, (k: K) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('step') as K | null;
  const value = raw && keys.includes(raw) ? raw : fallback;
  const set = (k: K) => {
    const next = new URLSearchParams(params);
    next.set('step', k);
    setParams(next, { replace: true });
  };
  return [value, set];
}

/** The sticky app header is 56px (see Header.tsx); a little air on top of it. */
const SCROLL_CLEARANCE_PX = 72;

export const RegistrationWizard: React.FC<{
  /** Leaving the page — the header's back-link. Confirmed first when the current step is dirty. */
  onClose: () => void;
  /** Called once the clerk finishes, so the roster behind can pick the new person up. */
  onCreated: () => void;
  /**
   * The application being filled in. Always present: this form no longer creates anything — an
   * application exists because somebody passed an interview, and this is the desk typing into it
   * on the candidate's behalf.
   */
  applicationId: string;
}> = ({ onClose, onCreated, applicationId }) => {
  const reg = useRegistration(applicationId);
  const navigate = useNavigate();
  const narrow = useIsNarrow();
  const { confirm, confirmDialog } = useConfirm();
  // The same pair the `sensitive/:field` route admits, so the reveal control is offered only to
  // somebody whose click can succeed. This flow is already gated on the roster, but a control that
  // hands out a KYC identifier should ask the question itself rather than inherit the answer.
  /**
   * The standings typed so far, held on the application until approval files them. Local state
   * mirrored from the server's copy, because the clients step now edits a list rather than
   * writing a row per click — see `ClientsStep`.
   */
  const [standings, setStandings] = useState<DraftStanding[]>([]);
  const [references, setReferences] = useState<DraftReference[]>([]);
  // Who referred them. Carried from the interview onto the application, and from the application
  // onto their record at approval — but this form never showed it, so a desk registration had no
  // way to record one and the record page read "Nobody recorded" for everybody made here.
  const [referral, setReferral] = useState<SourceReferralDraft>(EMPTY_REFERRAL);
  useEffect(() => {
    setStandings((reg.application?.extendedProfile?.empanelments ?? []) as DraftStanding[]);
    setReferences((reg.application?.extendedProfile?.references ?? []) as unknown as DraftReference[]);
    setReferral(referralDraftFrom(reg.application?.extendedProfile?.sourceReferral));
  }, [reg.application]);
  const [step, setStep] = useStepParam<RegistrationStepKey>(REGISTRATION_STEP_KEYS, 'person');
  // Loaded only on the step that shows `hrOwnerName` — see `useHrOwnerOptions`.
  const hrOwnerOpts = useHrOwnerOptions(step === 'people');
  const [stepProblems, setStepProblems] = useState<string[]>([]);
  /**
   * The account number typed a second time, when the clerk has typed a NEW one. Local only — it is
   * compared, never saved. An untouched account (shown masked, as its last digits) needs no second
   * typing: it was confirmed when it was saved.
   */
  const [accountConfirm, setAccountConfirm] = useState('');
  const accountTypedNow = reg.isDirty(['bankAccountNumber']) && !!(reg.form.bankAccountNumber || '').trim();
  const accountUnconfirmed = accountTypedNow
    && !!bankAccountConfirmProblem(reg.form.bankAccountNumber || '', accountConfirm);
  /**
   * The noun phrase the "Before this can be saved, it needs …" banner reads. No comma in it: the
   * banner joins its list by turning the last comma into "and", which would rewrite this sentence.
   */
  const ACCOUNT_CONFIRM_NEEDED = 'the bank account number typed a second time to match the first';
  const [addrNote, setAddrNote] = useState<{ message: string; blocking: boolean } | null>(null);
  const [addrLookup, setAddrLookup] = useState(false);
  /** The last resolved IFSC code's bank/branch details — see `applyIfscLookup`. */
  const [ifscInfo, setIfscInfo] = useState<IfscInfo | null>(null);
  const [stepBusy, setStepBusy] = useState(false);
  const { skills, languages, certifications } = useWorkforceVocabulary();
  const vocabulary = { skills, languages, certifications };
  const { toast } = useToast();
  const dup = useDuplicateCheck(null);

  const stepIndex = REGISTRATION_STEP_KEYS.indexOf(step);
  const [furthest, setFurthest] = useState(0);
  useEffect(() => { setFurthest((f) => Math.max(f, stepIndex)); }, [stepIndex]);

  /**
   * Put the failure where the clerk is looking.
   *
   * The banner renders at the very top of the wizard, and the app header is sticky and 56px tall.
   * A clerk who has scrolled down to the phone field, typed something the server rejects and
   * pressed Save saw *nothing happen*: the banner appeared off-screen above them, and where the
   * page did happen to be near the top the header painted straight over it —
   * `document.elementFromPoint` at the banner's own coordinates returned the header. The request
   * had failed with a perfectly good message and there was no way to know.
   *
   * `scrollMarginTop` is what keeps it clear of the header; browsers honour it for
   * `scrollIntoView`, which is exactly the case a plain `block: 'start'` gets wrong under any
   * sticky chrome. The clearance is the header's own height plus a little air.
   */
  const errorBannerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!reg.error) return;
    // Guarded, because this scroll exists to REVEAL an error and must never become one. jsdom has
    // no `scrollIntoView` at all, and an embedding that lacks it would otherwise throw during the
    // render that is trying to tell somebody their save failed — losing the message entirely,
    // which is the exact defect this effect was added to fix.
    const el = errorBannerRef.current;
    if (typeof el?.scrollIntoView !== 'function') return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [reg.error]);

  /**
   * Did the clerk try to move past THIS step? Read by every field on it to decide whether an
   * empty critical box has earned red ink yet — see `FieldRenderExtras.advanceAttempted` in
   * AssayerForms.tsx. Reset the moment the step actually changes, so arriving fresh at a new step
   * never opens already looking like a failed attempt.
   */
  const [advanceAttempted, setAdvanceAttempted] = useState(false);
  useEffect(() => { setAdvanceAttempted(false); }, [step]);

  /** Set by a "Go to field" click, so the field can claim focus once its step has actually mounted. */
  const [focusField, setFocusField] = useState<string | null>(null);
  useEffect(() => {
    if (!focusField) return undefined;
    const id = `assayer-field-${focusField}`;
    const raf = requestAnimationFrame(() => { document.getElementById(id)?.focus(); });
    setFocusField(null);
    return () => cancelAnimationFrame(raf);
  }, [focusField, step]);

  /**
   * A resumed registration opens where the work stopped, not at page one.
   *
   * Run once, and only when the URL did not already name a step — a link somebody pasted to a
   * particular page of somebody's registration has to win over this, or the deep link is useless.
   */
  const [jumped, setJumped] = useState(false);
  const [params] = useSearchParams();
  useEffect(() => {
    if (jumped || !reg.application || params.get('step')) return;
    setJumped(true);
    // The gap list the server computes for this application, mapped to the step that can close
    // the first one — the same `stepOfField` the error banner's "Go to field" links use.
    const firstGap = reg.gaps[0];
    const target = firstGap ? stepOfField(firstGap.key) : null;
    if (target) setStep(target);
    // `setStep` writes the query string; including it would re-run this on its own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumped, reg.application, reg.gaps]);

  const formSetter = (next: Record<string, string>) => reg.merge(next);

  /**
   * On leaving the pincode box: fill in what the operator has not typed, warn only about a real
   * contradiction. Filling blanks rather than demanding them is the point — a pincode is six
   * digits the office always has, and state and district follow from it.
   */
  const applyPincodeLookup = async (pincode: string) => {
    const clean = (pincode || '').trim();
    if (!/^\d{6}$/.test(clean)) { setAddrNote(null); return; }
    setAddrLookup(true);
    const po = await resolvePincode(clean);
    setAddrLookup(false);
    if (!po) { setAddrNote(null); return; }
    reg.merge({
      state: reg.form.state || po.state,
      district: reg.form.district || po.district,
      city: reg.form.city || po.district,
    });
    setAddrNote(addressConflict(po, clean, reg.form.state, reg.form.district));
  };

  /**
   * On leaving the IFSC box: fill `bankName` when the code resolves, say nothing when it does
   * not. A malformed or unknown code is a normal, mid-typing state for this field — `resolveIfsc`
   * already returns `null` for both rather than throwing, so there is nothing here to catch.
   */
  const applyIfscLookup = async (code: string) => {
    const result = await resolveIfsc(code);
    setIfscInfo(result);
    if (result) reg.merge({ bankName: result.bankName });
  };

  /** Leaving the record's own record open in a new tab, offered from a duplicate-match card. */
  const openDuplicateMatch = async (match: DuplicateMatch) => {
    if (reg.isDirty(STEP_FIELDS[step])) {
      const ok = await confirm({
        title: 'Leave without saving?',
        message: `Opening ${match.displayName}'s record now leaves whatever has been typed on this `
          + 'page unsaved.',
        confirmLabel: 'Leave without saving',
      });
      if (!ok) return;
    }
    void navigate(`/hr/roster/${match.id}`);
  };

  /** What a field needs beyond its own value — the wizard's attempt flag, and its own duplicate card. */
  const fieldExtras = (key: string) => ({
    advanceAttempted,
    ...(DUPLICATE_CHECK_FIELDS.includes(key as DuplicateCheckKey) ? {
      duplicateMatches: dup.matchesFor(key as DuplicateCheckKey),
      onOpenDuplicate: (m: DuplicateMatch) => void openDuplicateMatch(m),
      onDismissDuplicate: () => dup.dismiss(key as DuplicateCheckKey),
    } : {}),
  });

  // No `people` argument: the reporting-manager picker is the one field type this flow used it
  // for, and that field is no longer offered at admission — see `NEVER_KEPT` in `steps.ts`. It
  // took a fetch of the whole roster with it. `hrOwnerName` is still offered here, so its own
  // picker's candidate list is threaded through.
  const renderOne = (field: FieldDef) => renderFormField(
    field,
    reg.form,
    formSetter,
    vocabulary,
    (key, value) => {
      // The CLEANED value, handed straight over rather than re-read from `reg.form` — a pincode
      // normalised from "682 001" to "682001" on the same blur would otherwise be looked up before
      // the state update carrying that clean-up had actually landed, and `resolvePincode` refuses
      // anything that is not exactly six digits.
      if (key === 'pincode') void applyPincodeLookup(value);
      if (key === 'ifscCode') void applyIfscLookup(value);
      if (key === 'phone' || key === 'panNumber' || key === 'aadhaarNumber') {
        dup.check(key as DuplicateCheckKey, value);
      }
    },
    undefined,
    { options: hrOwnerOpts.people, failed: hrOwnerOpts.failed },
    ifscInfo,
    fieldExtras(field.key),
  );

  /*
    THE IDENTITY BOXES CANNOT OPEN ON A NUMBER ALREADY ON FILE.

    The application keeps PAN, Aadhaar and the bank account sealed, and every staff read returns
    them as their last four (`••••••234F`). A box holding that mask invited a clerk to correct one
    character and save the mask over the real number. So a masked value is shown read-only with a
    Replace action: Replace empties the box to type the number afresh from the card, and Keep puts
    the saved value back. Until a new number is typed nothing is sent for it (`withSecretsKept`).
  */
  const [replacing, setReplacing] = useState<Record<string, boolean>>({});
  const renderIdentity = (field: FieldDef) => {
    const savedValue = reg.saved?.[field.key] ?? '';
    const onFileMasked = isRegistrationSecretField(field.key) && looksMasked(savedValue);
    if (!onFileMasked || replacing[field.key]) {
      if (!onFileMasked) return renderOne(field);
      return (
        <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {renderOne(field)}
          <button
            type="button"
            className="btn btn-ghost"
            style={{ alignSelf: 'flex-start', fontSize: 'var(--text-xs)', padding: '2px 6px' }}
            onClick={() => { reg.set(field.key, savedValue); setReplacing((r) => ({ ...r, [field.key]: false })); }}
            title="Keep the number already on file"
          >
            Keep the number on file
          </button>
        </div>
      );
    }
    return (
      <div key={field.key} data-testid={`masked-${field.key}`}>
        <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>{field.label}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <span style={{ fontFamily: 'monospace', fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }} title="On file, shown as its last digits only">
            {savedValue}
          </span>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ fontSize: 'var(--text-xs)', padding: '4px 10px' }}
            onClick={() => { reg.set(field.key, ''); setReplacing((r) => ({ ...r, [field.key]: true })); }}
            title={`Type a new ${field.label} in place of the one on file`}
          >
            Replace
          </button>
        </div>
      </div>
    );
  };

  /**
   * Leave this step, saving what moved.
   *
   * A step is refused only for something the SERVER would refuse — the three `@IsNotEmpty()`
   * fields on the create DTO — or because a save actually failed, in which case the server's own
   * message is what the clerk reads. Inventing extra rules here is how a form ends up unable to
   * record a legitimate person.
   */
  const leaveStep = async (): Promise<boolean> => {
    setAdvanceAttempted(true);
    const problems = validateStep(step, reg.form);
    // Typed twice, because nothing else catches a wrong digit — account numbers carry no check digit.
    if (step === 'identity' && accountUnconfirmed) problems.push(ACCOUNT_CONFIRM_NEEDED);
    if (problems.length > 0) { setStepProblems(problems); return false; }
    setStepProblems([]);
    // Papers write through their own route as they go, and the summary owns nothing. `clients`
    // used to be on this list for the same reason — it wrote a row per click — and is not any
    // more: the standings it holds are part of this step's own save.
    if (step === 'documents' || step === 'review') return true;
    // A state the postal directory places in another state is the one address answer that cannot
    // be saved as typed; the district disagreement below it is normal and saves fine.
    if (step === 'address' && addrNote?.blocking) return false;
    /**
     * Nothing to file yet. The rail is unlocked end to end (see `StepRail`), so a clerk can reach
     * "ID and bank" or "Contacts and pay" before the record existed at all, because the record was
     * created by step one. There is no such moment now: the application exists before this form
     * opens — an interview PASS made it — so every step has somewhere to save to from the first
     * click, and the half of this function that handled "not yet" is gone with the condition.
     *
     * The two lists ride with the step that owns them: standings with `clients`, references with
     * `people`. They are sent on every save rather than only when they change, because they are
     * replaced wholesale on the application and a diff over an array is a bigger promise than it
     * is worth here.
     */
    return reg.commit({
      ...(step === 'clients' ? { empanelments: standings } : {}),
      ...(step === 'people' ? {
        references: references as unknown as Array<Record<string, unknown>>,
        sourceReferral: referralPayload(referral) as Record<string, string> | null,
      } : {}),
    });
  };

  /** Would a save actually do anything right now, on the step being left? */
  const canSaveCurrentStep = (): boolean => {
    // Documents write through their own route as they go; the review page has nothing of its own.
    // `clients` DOES have something now — the standings it holds are sent with this step's save.
    if (step === 'documents' || step === 'review') return false;
    if (step === 'address' && addrNote?.blocking) return false; // an unresolved state/pincode conflict
    if (step === 'person') return validateStep('person', reg.form).length === 0; // needs a name and a state
    return true; // the application already exists; every step has somewhere to write
  };

  /**
   * The rail: go anywhere, in either direction, always. Backward never needed validating —
   * the comment this replaced already said as much — and forward is the same now: a rail click
   * is "let me look at X", not "I am finished with this step", so step one's three required boxes
   * must not be able to trap a clerk who only wanted to browse ahead. It still saves whatever IS
   * already valid on the way out, exactly as the footer's Continue would, so nothing typed is
   * lost by using the rail instead — it just never REFUSES the move the way Continue does.
   */
  const goTo = async (target: RegistrationStepKey) => {
    if (target === step) return;
    const targetIndex = REGISTRATION_STEP_KEYS.indexOf(target);
    setStepProblems([]);
    /*
      The one thing the rail does not wave through: a forward move saves the step, and saving an
      account number that has not been typed twice is the exact slip this is here to catch. Going
      back saves nothing, so it stays free.
    */
    if (targetIndex >= stepIndex && step === 'identity' && accountUnconfirmed) {
      setStepProblems([ACCOUNT_CONFIRM_NEEDED]);
      return;
    }
    if (targetIndex >= stepIndex && canSaveCurrentStep()) await reg.commit();
    setStep(target);
  };

  /**
   * A server error named a field on a DIFFERENT step than the one it was reported on — possible
   * now that every step is reachable before the record exists, so a clerk can type into three
   * steps' worth of boxes before the first save that actually sends any of them. Unconditional,
   * like a rail click backwards: the point is fixing what the banner just named, not re-running
   * the validation that produced it.
   */
  const jumpToField = (key: string, target: RegistrationStepKey) => {
    setStepProblems([]);
    setStep(target);
    setFocusField(key);
  };

  const next = async () => {
    if (await leaveStep()) setStep(REGISTRATION_STEP_KEYS[Math.min(stepIndex + 1, REGISTRATION_STEP_KEYS.length - 1)]);
  };

  /**
   * Finishing says what was actually achieved, which is not always "registered".
   *
   * A green "Registered" on somebody who cannot be offered a single assignment is the exact
   * confusion this flow was producing: the record is genuinely complete and the person is
   * genuinely unusable, and only the second half is surprising. The step is not blocked — see
   * `ClientsStep` for why — so the confirmation carries the caveat instead.
   */
  const finish = async () => {
    if (!(await leaveStep())) return;
    const who = (reg.form.fullName || '').trim() || 'This person';
    /*
      Nobody is registered, and saying so is the point.

      This used to announce "Registered" and hand the clerk a person on the roster, which is
      precisely what made the rest of the pipeline look optional. What has happened is that a
      candidate's application has been filled in: they still have to confirm their own number and
      accept the declaration through their link, and HR still has to approve it. Two of those three
      are somebody else's to do, so the message names the one the clerk can do next.
    */
    toast({
      type: 'success',
      title: 'Saved',
      message: `${who}'s application is filled in. Send them their link so they can confirm their `
        + 'number and accept the declaration — then it comes to HR to approve.',
    });
    onCreated();
  };

  const scannedCount = useMemo(
    () => reg.documents.filter((d) => d.filePaths.length > 0).length,
    [reg.documents],
  );

  const busy = reg.busy || stepBusy;
  const current = REGISTRATION_STEPS[stepIndex];
  const typedName = (reg.form.fullName || '').trim();

  /**
   * "← Back to People", confirmed only when leaving would actually lose something. Checked
   * against THIS step's own fields, not the whole form — a save on step three does not make
   * typing on step five any less current, but it also should not make step three's own, already
   * long-committed boxes look dirty forever.
   */
  const handleBack = async () => {
    if (reg.isDirty(STEP_FIELDS[step])) {
      const ok = await confirm({
        title: 'Leave without saving?',
        message: 'This page has changes that have not been saved yet. Leave without saving them?',
        confirmLabel: 'Leave without saving',
      });
      if (!ok) return;
    }
    onClose();
  };

  return (
    <Page style={{
      // The shell pads and caps this already (`.page-scroll` / `.page-container`); all that is
      // left here is the floor below.
      // Tall enough to fill the visible page even on a short step (an empty "Who they can work
      // for" is a handful of lines) — otherwise the footer below has nothing to push it down to
      // the bottom and sits wherever the short content happens to end, which read as the footer
      // "floating" partway up the screen instead of staying in the same place step to step.
      // 146px is the app shell above and below this scroll area, not a guess: the 56px header
      // (Header.tsx) plus the scroll container's own 20px top / 70px bottom padding
      // (Layout.tsx). A step long enough to need scrolling still grows past this and scrolls
      // exactly as before — this only fills in the SHORT case.
      //
      // Tuning this number WIDER (subtracting more) does not make a borderline step safer — it
      // was tried and made things worse: shrinking the floor let one step's genuine content
      // exceed it, which made the page scrollable and put that step back into the sticky-bottom-
      // footer-overlaps-content case (task_c64403e9) instead of the plain-too-short case this
      // fixes. That is a real, separate bug in `position: sticky; bottom: 0` itself whenever a
      // step's content is taller than one screen — this constant should stay derived from the
      // actual chrome above/below it, not padded to paper over that other bug.
      minHeight: 'calc(100vh - 146px)',
    }}>
      {confirmDialog}

      <div style={{ flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <div>
        <button
          type="button"
          onClick={() => void handleBack()}
          style={{
            ...linkButtonStyle, textDecoration: 'none', color: 'var(--text-muted)',
            display: 'inline-flex', alignItems: 'center', gap: '4px', marginBottom: '10px', fontWeight: 600,
          }}
        >
          <ChevronLeft size={14} aria-hidden /> Back to People
        </button>
        <PageHeader
          icon={<User size={20} />}
          title={`Filling in ${typedName || 'their'} registration`}
          subtitle="Typed at the desk on the candidate's behalf. They still confirm their own number and accept the declaration through their link, and HR still approves it — nothing here puts anybody on the roster." 
        />
      </div>

      <div style={{ display: 'flex', flexDirection: narrow ? 'column' : 'row', gap: '22px', alignItems: 'flex-start' }}>
        <StepRail current={step} furthest={furthest} onGo={(k) => void goTo(k)} narrow={narrow} />

        <div style={{ flex: '1 1 0%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div>
        <h2 style={{ fontSize: 'var(--text-md)', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>{current.title}</h2>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', margin: '4px 0 0' }}>{current.caption}</p>
      </div>

      {reg.loadError && (
        <AlertBanner type="error" message={`That registration could not be opened. ${reg.loadError}`} />
      )}
      {stepProblems.length > 0 && (
        <AlertBanner type="error">
          Before this can be saved, it needs {stepProblems.join(', ').replace(/, ([^,]*)$/, ' and $1')}.
        </AlertBanner>
      )}
      {reg.error && (
        /*
          The banner still says exactly what the server said — `userMessage()` (services/errors.ts,
          outside this track) already passes a human-written server message through untouched and
          reserves the generic "Someone else changed this record…" 409 wording for the case where
          the server sent nothing readable, so an identifier-conflict message that actually names
          the clash keeps reading as itself. What is added here is a way IN: a server validation
          array collapses to "N fields need attention: A, B" with no structure left for a screen to
          read, so `mappedFieldsFromError` replays the same collapsing rule against every box this
          flow owns and offers each recovered one as its own jump, landing on the right step with
          the box focused rather than leaving the clerk to hunt for what "Aadhaar Number" means here.
          `AppError` keeps the server's own field keys now, so that reverse-engineering is the
          fallback rather than the only path — see `fieldErrorKeys` in services/errors.ts.
        */
        <AlertBanner type="error" onClose={reg.dismissError}>
          <div ref={errorBannerRef} style={{ scrollMarginTop: SCROLL_CLEARANCE_PX, whiteSpace: 'pre-line' }}>{reg.error}</div>
          {mappedFieldsFromError(reg.error, reg.errorFields).length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px', marginTop: '8px' }}>
              {mappedFieldsFromError(reg.error, reg.errorFields).map((f) => (
                <button key={f.key} type="button" onClick={() => jumpToField(f.key, f.step)} style={linkButtonStyle}>
                  {f.label} — Go to field
                </button>
              ))}
            </div>
          )}
        </AlertBanner>
      )}
      {reg.loading ? (
        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Opening their record…</div>
      ) : step === 'person' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          {/*
            THESE KEYS HAD DRIFTED FROM THE STEP'S OWN DECLARATION. `STEP_FIELDS.person` says this
            step collects gender and "Freelancer or proprietor"; the Blocks below asked for neither,
            and asked instead for four keys — code, engagement, employment type, joining date — that
            are not in the field map, which `Block` drops without a word. So the desk could never set
            whether somebody is a freelancer or a proprietor: the one answer that decides which
            documents they are asked for, and that the application refuses to submit without.
            `registration-step-fields.spec` now fails for any key a step declares and does not draw.
          */}
          <Block
            title="Who they are"
            note="Their full name — exactly as printed on their Aadhaar or PAN — is the one thing here we cannot do without."
            keys={['fullName', 'dateOfBirth', 'gender', 'qualification']}
            render={renderOne}
          />
          <Block
            title="How to reach them"
            note="The mobile they were invited on is filled in already — change it only if it is wrong. All optional: somebody with no mobile phone and no email address is registered exactly the same way — offers reach them as a call task for the desk instead."
            keys={['phone', 'alternatePhone', 'email']}
            render={renderOne}
          />
          <Block
            title="Where and how they work"
            note="The state is what makes somebody plannable. Freelancer or proprietor decides which documents they are asked for."
            keys={['state', 'employmentCategory']}
            render={renderOne}
          />
        </div>
      ) : step === 'address' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <Block
            title="Their address"
            note="Type the pincode first and the city, district and state fill themselves in."
            keys={STEP_FIELDS.address}
            render={renderOne}
          />
          {addrLookup && (
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Looking the pincode up…</div>
          )}
          {addrNote && (
            <div style={{
              padding: '10px 13px', borderRadius: 'var(--radius-md)', fontSize: 'var(--text-sm)',
              background: addrNote.blocking ? 'var(--status-cancelled-bg)' : 'var(--status-pending-bg)',
              color: addrNote.blocking ? 'var(--danger)' : 'var(--warning)',
              display: 'flex', gap: '8px', alignItems: 'center',
            }}>
              <AlertTriangle size={15} aria-hidden /> {addrNote.message}
            </div>
          )}
          <div>
            <div style={blockTitleStyle}>The exact spot on the map</div>
            <div style={blockNoteStyle}>
              An address alone reaches the locality, roughly a kilometre out. Travel costs, the
              distance filter and the day planner all read the coordinate — and when there is none,
              the distance check passes everybody, so somebody four states away looks near enough.
              Find their home on the map, right-click it, and paste what it gives you.
            </div>
            {/*
              Collected, not pinned.

              There is no assayer to pin — `/geo/precision/assayer/:id/pin` needs a record, and one
              does not exist until this application is approved. But `latitude` and `longitude` are
              on the registration allow-list precisely so an application can carry them, and
              promotion applies them through the same guarded update, so the coordinate is worth
              taking now while somebody knows it. `onPicked` hands it back instead of writing it.
            */}
            <PinCoordinateControl
              target="assayer"
              id={reg.applicationId}
              onPicked={(latitude, longitude) => {
                reg.merge({ latitude: String(latitude), longitude: String(longitude) });
                toast({ type: 'success', title: 'Location taken', message: 'It is filed with them when the application is approved.' });
              }}
            />
            {(() => {
              const at = reg.form.latitude && reg.form.longitude
                ? `${Number(reg.form.latitude).toFixed(6)}, ${Number(reg.form.longitude).toFixed(6)}`
                : null;
              return (
                <div style={{ fontSize: 'var(--text-xs)', color: at ? 'var(--success)' : 'var(--text-muted)', marginTop: '8px' }}>
                  {at
                    ? `Their exact spot is ${at}. It is filed against them when this is approved, and no later re-geocode will overwrite it.`
                    : 'No exact location yet. Their address is geocoded when they are approved, which reaches the town rather than the door — and until a real one is on file the distance check passes everybody, so this person looks near enough to every branch.'}
                </div>
              );
            })()}
          </div>
        </div>
      ) : step === 'identity' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <Block
            title="Their identity numbers"
            note="Typed from the cards themselves. A number that does not look right is flagged as you type, and the server checks it again when this page is saved. Anything already on file is kept in full and encrypted, and shows here as its last few digits only."
            keys={['panNumber', 'aadhaarNumber']}
            render={renderIdentity}
          />
          <Block
            title="Where their money goes"
            note="Needed before this person can be paid. Nothing here has to be filled in to register them."
            keys={['bankAccountNumber', 'ifscCode', 'bankName']}
            render={renderIdentity}
          />
          {accountTypedNow && (
            <div style={{ maxWidth: '360px' }}>
              <label htmlFor="reg-wizard-account-confirm" style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>
                Re-enter account number
              </label>
              <input
                id="reg-wizard-account-confirm"
                value={accountConfirm}
                inputMode="numeric"
                autoComplete="off"
                placeholder="Type it again, from the passbook"
                onChange={(e) => setAccountConfirm(e.target.value.replace(/[^\d\s-]/g, '').slice(0, 24))}
                // A pasted copy repeats the slip it is meant to catch.
                onPaste={(e) => e.preventDefault()}
                aria-invalid={!!accountConfirm.trim() && accountUnconfirmed}
                style={{
                  width: '100%', padding: '9px 11px', fontSize: 'var(--text-sm)', fontFamily: 'monospace',
                  background: 'var(--bg-surface-2)', color: 'var(--text-primary)', boxSizing: 'border-box',
                  border: `1px solid ${accountConfirm.trim() && accountUnconfirmed ? 'var(--danger)' : 'var(--border-color)'}`,
                  borderRadius: 'var(--radius-sm)',
                }}
              />
              <div style={{ fontSize: 'var(--text-xs)', marginTop: '4px', color: accountConfirm.trim() && accountUnconfirmed ? 'var(--danger)' : 'var(--text-muted)' }}>
                {accountConfirm.trim()
                  ? (bankAccountConfirmProblem(reg.form.bankAccountNumber || '', accountConfirm) ?? 'Matches.')
                  : 'Typed rather than pasted — it is the only check that catches a wrong digit.'}
              </div>
            </div>
          )}
        </div>
      ) : step === 'documents' ? (
        <ApplicationDocumentsStep
          applicationId={reg.applicationId}
          requested={reg.documentsRequested}
          documents={reg.documents}
          onChanged={() => { void reg.refresh(); }}
          onBusy={setStepBusy}
        />
      ) : step === 'people' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <Block
            title="If something happens while they are out"
            note="Who this company rings if a person in the field is hurt or does not come back. This is the one thing on this page with a real cost when it is blank."
            keys={['emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation']}
            render={renderOne}
          />
          <ReferencesBlock references={references} onChange={setReferences} />
          <div style={cardish}>
            <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)', marginBottom: '4px' }}>Who referred them</div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: '10px' }}>
              The person who brought them to us — not one of the referees above. Shown on their record once approved.
            </div>
            <SourceReferralFields value={referral} onChange={setReferral} idPrefix="desk-referral" />
          </div>
          <Block
            title="What they have done before"
            note="Their experience, where they are working now, and what they are good at. All of it travels onto their record when they are approved."
            keys={['experienceYears', 'currentEmployer', 'expertise', 'availability']}
            render={renderOne}
          />
          <Block
            title="What they are paid"
            note="Leave every box empty if the rates are not agreed yet — nothing is filed and they can be set later. Rates are saved together with this page, and if they fail you will be told exactly that rather than losing them."
            keys={RATE_FIELDS.map((f) => f.key)}
            render={renderOne}
          />
          {/*
            Where the employment terms went.

            A joining date, an engagement type, a workload ceiling, a reporting line and a region
            are not things a candidate answers — they are what the company decides when it hires
            somebody. They were asked for here, a week before anybody had decided, and they are
            asked for at APPROVAL now, on the screen where somebody with the authority to hire is
            looking at the person. A step that simply lost five boxes reads as five things nobody
            collects any more.
          */}
          <div style={{ ...cardish, background: 'var(--bg-surface-2)' }}>
            <div style={blockTitleStyle}>Joining date, workload and reporting line</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              Set when this application is approved, not here — they are the company's decisions
              rather than the candidate's answers, and the approval screen asks for all of them.
            </div>
          </div>

          {/*
            * Said here because this is where the boxes used to be.
            *
            * Skills, languages, certificates, working hours and the regions somebody will travel
            * to were all collected on this page and are blank on every one of the 1,163 people on
            * the roster — which is what happens when a clerk is asked, at the counter, for facts
            * the person themselves keeps up to date from their phone and can overwrite the next
            * day. The capability is untouched; the question has moved to whoever can answer it. A
            * step that simply lost five boxes would be read as five things now uncollected.
            */}
          <div style={{ ...cardish, background: 'var(--bg-surface-2)' }}>
            <div style={blockTitleStyle}>What they can do, and when they will work</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
              Skills, languages, certificates, working hours and the regions they will travel to
              are not asked for here. The assayer keeps those up to date themselves from the app,
              and you can add a skill or a certificate — with its expiry date — on the Skills tab
              of their record at any time.
            </div>
          </div>
        </div>
      ) : step === 'clients' ? (
        <ClientsStep standings={standings} onChange={setStandings} />
      ) : (
        <ReviewStep
          name={(reg.form.fullName || '').trim()}
          gaps={reg.gaps}
          scannedCount={scannedCount}
          requirementCount={reg.documentsRequested.length}
          standings={standings}
          onGo={(k) => void goTo(k)}
        />
      )}
        </div>
      </div>
      </div>

      {/*
        Back / where you are / Continue — the whole footer, now that the page's own back-link
        above carries what the old modal's separate "Close — their record is saved" / "Cancel"
        button used to. Sticky, not fixed: it travels with this page's own content rather than
        floating over the app shell's sidebar and header the way a fixed bar would.
        `marginTop: auto` pins it to the bottom of the page on short steps (a short step has
        nothing for `position: sticky` to stick against, so without this the footer floats up
        to wherever the content ends); the container's own bottom padding stays small so the
        footer actually reaches the bottom instead of hovering above a dead gap.
      */}
      <div style={{
        position: 'sticky', bottom: 0, marginTop: 'auto', zIndex: 1,
        background: 'var(--bg-page)', borderTop: '1px solid var(--border-color)',
        padding: '14px 4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        gap: '10px', flexWrap: 'wrap',
      }}>
        <button
          type="button"
          onClick={() => void goTo(REGISTRATION_STEP_KEYS[Math.max(stepIndex - 1, 0)])}
          disabled={stepIndex === 0}
          className="btn btn-secondary"
          style={{ padding: '9px 16px', fontSize: 'var(--text-sm)', display: 'inline-flex', alignItems: 'center', gap: '6px', visibility: stepIndex === 0 ? 'hidden' : 'visible' }}
        >
          <ChevronLeft size={15} aria-hidden /> Back
        </button>
        <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Step {stepIndex + 1} of {REGISTRATION_STEPS.length}
          </span>
          {step === 'review' ? (
            <button type="button" onClick={() => void finish()} disabled={busy} className="btn btn-primary" style={{ padding: '9px 20px', fontSize: 'var(--text-sm)', display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
              <Check size={15} aria-hidden /> {busy ? 'Saving…' : 'Finish'}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void next()}
              disabled={busy}
              className="btn btn-primary"
              style={{ padding: '9px 20px', fontSize: 'var(--text-sm)', display: 'inline-flex', alignItems: 'center', gap: '7px' }}
            >
              {busy ? 'Saving…' : 'Continue'}
              <ChevronRight size={15} aria-hidden />
            </button>
          )}
        </div>
      </div>
    </Page>
  );
};

/**
 * The name the roster has always opened this by.
 *
 * Kept so the entry point reads the same as it did, and because "create" is still what the button
 * does — it is the shape of the thing behind it that changed. What it renders is a page now, not a
 * modal — see `RegistrationPage.tsx`, the route this name is actually mounted under.
 */
export const CreateAssayerModal = RegistrationWizard;
