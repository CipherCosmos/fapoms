import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  User, MapPin, CreditCard, FileText, Users, ClipboardCheck,
  Check, ChevronLeft, ChevronRight, X, AlertTriangle, Plus, Phone,
} from 'lucide-react';
import { Modal, AlertBanner, useToast } from '../../../components/ui';
import { PinCoordinateControl } from '../../../components/PinCoordinateControl';
import { useWorkforceVocabulary } from '../../../hooks/useWorkforceVocabulary';
import { api } from '../../../services/api';
import { userMessage } from '../../../services/errors';
import { useViewParam } from '../hr-ui';
import { useCurrentRoles, canManageAssayers } from '../../../hooks/useCurrentRoles';
import {
  renderFormField, useManagerOptions, resolvePincode, addressConflict, type FieldDef,
} from '../AssayerForms';
import { isSensitiveKey } from '../assayer-shared';
import { SensitiveValue } from '../SensitiveValue';
import {
  REGISTRATION_FIELDS, RATE_FIELDS, REGISTRATION_STEPS, REGISTRATION_STEP_KEYS,
  STEP_FIELDS, activationGaps, firstIncompleteStep, validateStep,
  type RegistrationStepKey,
} from './steps';
import { useDossier, useRegistration, type DossierReference } from './useRegistration';
import { DocumentsStep } from './DocumentsStep';

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
 */

const STEP_ICONS: Record<RegistrationStepKey, React.ReactNode> = {
  person: <User size={14} />,
  address: <MapPin size={14} />,
  identity: <CreditCard size={14} />,
  documents: <FileText size={14} />,
  people: <Users size={14} />,
  review: <ClipboardCheck size={14} />,
};

const fieldsMap = new Map<string, FieldDef>(
  [...REGISTRATION_FIELDS, ...RATE_FIELDS].map((f) => [f.key, f]),
);

const gridStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '14px',
};

const blockTitleStyle: React.CSSProperties = {
  fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '2px',
};
const blockNoteStyle: React.CSSProperties = {
  fontSize: '12px', color: 'var(--text-muted)', marginBottom: '10px',
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
 */
const StepRail: React.FC<{
  current: RegistrationStepKey;
  furthest: number;
  onGo: (key: RegistrationStepKey) => void;
  disabledAfterFirst: boolean;
}> = ({ current, furthest, onGo, disabledAfterFirst }) => {
  const currentIndex = REGISTRATION_STEP_KEYS.indexOf(current);
  return (
    <nav aria-label="Registration steps" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
      {REGISTRATION_STEPS.map((step, i) => {
        const active = step.key === current;
        const done = i < furthest;
        const locked = disabledAfterFirst && i > 0;
        return (
          <button
            key={step.key}
            type="button"
            onClick={() => onGo(step.key)}
            disabled={locked}
            aria-current={active ? 'step' : undefined}
            title={locked ? 'Save their name and state first — the rest is filed against their record.' : step.caption}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: '6px',
              padding: '6px 12px', fontSize: '12px', fontWeight: active ? 700 : 600,
              borderRadius: 'var(--radius-full)', cursor: locked ? 'not-allowed' : 'pointer',
              border: `1px solid ${active ? 'var(--accent)' : 'var(--border-color)'}`,
              background: active ? 'var(--status-pending-bg)' : 'var(--bg-surface-2)',
              color: active ? 'var(--accent)' : done ? 'var(--success)' : 'var(--text-secondary)',
              opacity: locked ? 0.5 : 1,
            }}
          >
            <span aria-hidden style={{ display: 'inline-flex' }}>
              {done && !active ? <Check size={14} /> : STEP_ICONS[step.key]}
            </span>
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
 * Kept as its own immediate action rather than folded into the step's save, because a reference
 * is a row of its own (`POST /assayers/:id/reference`) and a clerk adding three of them needs to
 * see each land. Nobody has rung them yet — that is a separate, attested act on the record — and
 * the copy says so, because "reference added" reading as "reference checked" is the whole risk.
 */
const ReferencesBlock: React.FC<{
  assayerId: string | null;
  references: DossierReference[];
  onChanged: () => void;
}> = ({ assayerId, references, onChanged }) => {
  const [draft, setDraft] = useState({ fullName: '', relationship: '', phone: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const add = async () => {
    if (!assayerId || !draft.fullName.trim()) {
      setError('A reference needs at least a name.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.request(`/assayers/${assayerId}/reference`, {
        method: 'POST',
        body: JSON.stringify({
          fullName: draft.fullName.trim(),
          relationship: draft.relationship || undefined,
          phone: draft.phone.trim() || undefined,
        }),
      });
      toast({ type: 'success', title: 'Reference added', message: `${draft.fullName.trim()} is on file. Nobody has rung them yet.` });
      setDraft({ fullName: '', relationship: '', phone: '' });
      onChanged();
    } catch (e) { setError(userMessage(e)); } finally { setSaving(false); }
  };

  const inputStyle: React.CSSProperties = {
    padding: '9px 11px', fontSize: '13px', background: 'var(--bg-page)',
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
          {references.map((r) => (
            <li key={r.id} style={{ fontSize: '13px', color: 'var(--text-secondary)', display: 'flex', gap: '8px', alignItems: 'center' }}>
              <Phone size={13} style={{ color: 'var(--text-muted)', flexShrink: 0 }} aria-hidden />
              <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{r.fullName}</span>
              {r.relationship && <span>· {r.relationship}</span>}
              {r.phone && <span>· {r.phone}</span>}
              <span style={{ color: r.checkedAt ? 'var(--success)' : 'var(--text-muted)', fontSize: '12px' }}>
                {r.checkedAt ? '· spoken to' : '· not rung yet'}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '10px', alignItems: 'end' }}>
        <input
          value={draft.fullName}
          onChange={(e) => setDraft({ ...draft, fullName: e.target.value })}
          placeholder="Their name"
          aria-label="Name of the person who can vouch for them"
          style={inputStyle}
        />
        <input
          value={draft.relationship}
          onChange={(e) => setDraft({ ...draft, relationship: e.target.value })}
          placeholder="How they know them"
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
        <button
          type="button"
          onClick={() => void add()}
          disabled={saving || !assayerId}
          className="btn btn-secondary"
          style={{ fontSize: '12px', padding: '9px 14px', display: 'inline-flex', alignItems: 'center', gap: '6px', width: 'auto' }}
        >
          <Plus size={13} /> {saving ? 'Adding…' : 'Add this person'}
        </button>
      </div>
      {error && <div style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '6px' }}>{error}</div>}
    </div>
  );
};

/** The last page: what is on file, what is not, and what each blank one actually costs. */
const ReviewStep: React.FC<{
  record: Parameters<typeof activationGaps>[0];
  scannedCount: number;
  requirementCount: number;
  onGo: (step: RegistrationStepKey) => void;
}> = ({ record, scannedCount, requirementCount, onGo }) => {
  const gaps = activationGaps(record);
  const name = [record?.firstName, record?.lastName].filter(Boolean).join(' ').trim();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{
        ...cardish,
        borderColor: 'var(--success)',
      }}>
        <div style={{ fontSize: '13px', fontWeight: 700, color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '7px' }}>
          <Check size={15} /> {name || 'This person'} is on the roster
        </div>
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '6px' }}>
          Their code is <strong style={{ fontFamily: 'var(--font-mono, monospace)' }}>{record?.assayerCode || '—'}</strong>.
          {' '}They are waiting to be taken through onboarding on their record, where the stage is moved by hand.
        </div>
      </div>

      <div style={cardish}>
        <div style={blockTitleStyle}>Papers on file</div>
        <div style={{ fontSize: '13px', color: scannedCount > 0 ? 'var(--text-secondary)' : 'var(--warning)' }}>
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
                <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{gap.label}</span>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>blocks {gap.why}</span>
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
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
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
  color: 'var(--accent-primary)', fontSize: '12px', fontWeight: 600, textDecoration: 'underline',
};

export const RegistrationWizard: React.FC<{
  onClose: () => void;
  /** Called once the clerk finishes, so the roster behind can pick the new person up. */
  onCreated: () => void;
  /** Reopen an interrupted registration on the record it already created. */
  resumeAssayerId?: string;
}> = ({ onClose, onCreated, resumeAssayerId }) => {
  const reg = useRegistration(resumeAssayerId);
  // The same pair the `sensitive/:field` route admits, so the reveal control is offered only to
  // somebody whose click can succeed. This flow is already gated on the roster, but a control that
  // hands out a KYC identifier should ask the question itself rather than inherit the answer.
  const canManage = canManageAssayers(useCurrentRoles());
  const { dossier, dossierError, reloadDossier } = useDossier(reg.assayerId);
  const [step, setStep] = useViewParam<RegistrationStepKey>(REGISTRATION_STEP_KEYS, 'person');
  const [stepProblems, setStepProblems] = useState<string[]>([]);
  const [addrNote, setAddrNote] = useState<{ message: string; blocking: boolean } | null>(null);
  const [addrLookup, setAddrLookup] = useState(false);
  const [docBusy, setDocBusy] = useState(false);
  const { skills, languages, certifications } = useWorkforceVocabulary();
  const vocabulary = { skills, languages, certifications };
  const managerOpts = useManagerOptions(step === 'people', reg.assayerId ?? undefined);
  const { toast } = useToast();

  const stepIndex = REGISTRATION_STEP_KEYS.indexOf(step);
  const [furthest, setFurthest] = useState(0);
  useEffect(() => { setFurthest((f) => Math.max(f, stepIndex)); }, [stepIndex]);

  /**
   * A resumed registration opens where the work stopped, not at page one.
   *
   * Run once, and only when the URL did not already name a step — a link somebody pasted to a
   * particular page of somebody's registration has to win over this, or the deep link is useless.
   */
  const [jumped, setJumped] = useState(false);
  const [params] = useSearchParams();
  useEffect(() => {
    if (jumped || !resumeAssayerId || !reg.record || params.get('view')) return;
    setJumped(true);
    setStep(firstIncompleteStep(reg.record));
    // `setStep` writes the query string; including it would re-run this on its own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumped, resumeAssayerId, reg.record]);

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

  const renderOne = (field: FieldDef) => renderFormField(
    field,
    reg.form,
    formSetter,
    vocabulary,
    (key) => { if (key === 'pincode') void applyPincodeLookup(reg.form.pincode || ''); },
    field.people ? { options: managerOpts.people, failed: managerOpts.failed, incomplete: managerOpts.incomplete } : undefined,
  );

  /**
   * The identity boxes, which cannot open on a number that is already on file.
   *
   * A resumed registration used to prefill these from the record. The record now hands out masked
   * identifiers, so the box would have opened holding `••••••234F` — and a clerk who corrected one
   * character of that would have saved the mask over a real PAN, leaving something that reads
   * plausibly on every screen afterwards and can never be told apart from the truth.
   *
   * So a field with a number already on file shows it masked with a deliberate, recorded reveal
   * beside it, and only turns back into a box once it has been uncovered. A field with nothing on
   * file is an ordinary box — there is nothing to protect and nothing to reveal.
   */
  const renderIdentity = (field: FieldDef) => {
    const key = field.key;
    const stored = (reg.record as Record<string, unknown> | null)?.[key];
    if (!isSensitiveKey(key) || !reg.assayerId || !stored) return renderOne(field);
    return (
      <div key={key}>
        <div style={{ ...blockTitleStyle, fontSize: '12px', marginBottom: '4px' }}>{field.label}</div>
        <SensitiveValue
          assayerId={reg.assayerId}
          fieldKey={key}
          masked={String(stored)}
          canReveal={canManage}
          onRevealed={(full) => reg.reveal(key, full)}
          renderRevealed={() => renderOne(field)}
        />
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
    const problems = validateStep(step, reg.form);
    if (problems.length > 0) { setStepProblems(problems); return false; }
    setStepProblems([]);
    if (step === 'documents' || step === 'review') return true;
    // A state the postal directory places in another state is the one address answer that cannot
    // be saved as typed; the district disagreement below it is normal and saves fine.
    if (step === 'address' && addrNote?.blocking) return false;
    return reg.commit();
  };

  const goTo = async (target: RegistrationStepKey) => {
    if (target === step) return;
    const targetIndex = REGISTRATION_STEP_KEYS.indexOf(target);
    // Going back never has to pass validation — the whole point of a rail is being able to look.
    if (targetIndex < stepIndex) { setStepProblems([]); setStep(target); return; }
    if (await leaveStep()) setStep(target);
  };

  const next = async () => {
    if (await leaveStep()) setStep(REGISTRATION_STEP_KEYS[Math.min(stepIndex + 1, REGISTRATION_STEP_KEYS.length - 1)]);
  };

  const finish = async () => {
    if (!(await leaveStep())) return;
    toast({
      type: 'success',
      title: 'Registered',
      message: `${[reg.form.firstName, reg.form.lastName].filter(Boolean).join(' ').trim() || 'This person'} is on the roster. Move them through onboarding from their record.`,
    });
    onCreated();
  };

  const scannedCount = useMemo(
    () => (dossier?.onboarding ?? []).filter((d) => d.filePaths.length > 0).length,
    [dossier],
  );

  const busy = reg.busy || docBusy;
  const current = REGISTRATION_STEPS[stepIndex];

  return (
    <Modal
      open
      onClose={onClose}
      width="820px"
      height="min(720px, 88vh)"
      closeIcon={<X size={18} />}
      title={<><User size={18} style={{ color: 'var(--accent-primary)' }} aria-hidden /> Register an assayer</>}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', gap: '10px', flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={() => void goTo(REGISTRATION_STEP_KEYS[Math.max(stepIndex - 1, 0)])}
            disabled={stepIndex === 0}
            className="btn btn-secondary"
            style={{ padding: '9px 16px', fontSize: '13px', display: 'inline-flex', alignItems: 'center', gap: '6px', visibility: stepIndex === 0 ? 'hidden' : 'visible' }}
          >
            <ChevronLeft size={15} aria-hidden /> Back
          </button>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
              Step {stepIndex + 1} of {REGISTRATION_STEPS.length}
            </span>
            <button type="button" onClick={onClose} className="btn btn-secondary" style={{ padding: '9px 16px', fontSize: '13px' }}>
              {reg.assayerId ? 'Close — their record is saved' : 'Cancel'}
            </button>
            {step === 'review' ? (
              <button type="button" onClick={() => void finish()} disabled={busy} className="btn btn-primary" style={{ padding: '9px 20px', fontSize: '13px', display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
                <Check size={15} aria-hidden /> {busy ? 'Saving…' : 'Finish'}
              </button>
            ) : (
              <button type="button" onClick={() => void next()} disabled={busy} className="btn btn-primary" style={{ padding: '9px 20px', fontSize: '13px', display: 'inline-flex', alignItems: 'center', gap: '7px' }}>
                {busy ? 'Saving…' : step === 'person' && !reg.assayerId ? 'Save and continue' : 'Continue'}
                <ChevronRight size={15} aria-hidden />
              </button>
            )}
          </div>
        </div>
      }
    >
      <StepRail
        current={step}
        furthest={furthest}
        onGo={(k) => void goTo(k)}
        disabledAfterFirst={!reg.assayerId}
      />

      <div>
        <h2 style={{ fontSize: '15px', fontWeight: 700, margin: 0, color: 'var(--text-primary)' }}>{current.title}</h2>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: '4px 0 0' }}>{current.caption}</p>
      </div>

      {reg.loadError && (
        <AlertBanner type="error" message={`That registration could not be opened. ${reg.loadError}`} />
      )}
      {stepProblems.length > 0 && (
        <AlertBanner type="error">
          Before this can be saved, it needs {stepProblems.join(', ').replace(/, ([^,]*)$/, ' and $1')}.
        </AlertBanner>
      )}
      {reg.error && <AlertBanner type="error" message={reg.error} onClose={reg.dismissError} />}

      {reg.loading ? (
        <div style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Opening their record…</div>
      ) : step === 'person' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <Block
            title="Who they are"
            note="Their name is the only thing on this page we cannot do without."
            keys={['firstName', 'lastName', 'assayerCode', 'dateOfBirth', 'qualification']}
            render={renderOne}
          />
          <Block
            title="How to reach them"
            note="All optional. Somebody with no mobile phone and no email address is registered exactly the same way — offers reach them as a call task for the desk instead."
            keys={['phone', 'alternatePhone', 'email']}
            render={renderOne}
          />
          <Block
            title="Where and how they work"
            note="The state is what makes somebody plannable at all. The rest can be changed at any time."
            keys={['state', 'engagementType', 'employmentType', 'department', 'joiningDate']}
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
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Looking the pincode up…</div>
          )}
          {addrNote && (
            <div style={{
              padding: '10px 13px', borderRadius: 'var(--radius-md)', fontSize: '13px',
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
            {reg.assayerId ? (
              <>
                <PinCoordinateControl target="assayer" id={reg.assayerId} onPinned={() => void reg.refresh()} />
                {/*
                  * A geocoded coordinate is not a pin, and saying so matters.
                  *
                  * Creating the record geocodes the address, so this line is never empty — a person
                  * entered with nothing but a state comes back holding that state's centroid. An
                  * earlier version of this copy read "Pinned at 10.850500, 76.271100 — this will
                  * not be overwritten", which is the promise `geo_source = 'manual'` carries and
                  * this is not: it is a guess accurate to the state, it WILL be replaced by the
                  * next re-geocode, and dressed up as a pin it stops anybody placing the real one.
                  */}
                {(() => {
                  const pinned = reg.record?.geoSource === 'manual';
                  const at = reg.record?.latitude
                    ? `${Number(reg.record.latitude).toFixed(6)}, ${Number(reg.record.longitude).toFixed(6)}`
                    : null;
                  return (
                    <div style={{ fontSize: '12px', color: pinned ? 'var(--success)' : 'var(--text-muted)', marginTop: '8px' }}>
                      {pinned
                        ? `Pinned by hand at ${at}. No later import or re-geocode will overwrite it.`
                        : at
                          ? `The only location on file is ${at}, worked out from the address — so it is the town, not their door. Pin the exact spot if you know it.`
                          : 'No location on file at all. Until one is pinned, the distance check passes everybody, so this person looks near enough to every branch.'}
                    </div>
                  );
                })()}
              </>
            ) : (
              <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                Available once their record is saved.
              </div>
            )}
          </div>
        </div>
      ) : step === 'identity' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <Block
            title="Their identity numbers"
            note="Typed from the cards themselves. A number that does not look right is flagged as you type, and the server checks it again when this page is saved. Anything already on file is kept in full and encrypted, and shows here as its last few digits only."
            keys={['panNumber', 'aadhaarNumber', 'vstsCode']}
            render={renderIdentity}
          />
          <Block
            title="Where their money goes"
            note="Needed before this person can be paid. Nothing here has to be filled in to register them."
            keys={['bankAccountNumber', 'ifscCode', 'bankName']}
            render={renderIdentity}
          />
        </div>
      ) : step === 'documents' ? (
        <DocumentsStep
          assayerId={reg.assayerId}
          dossier={dossier}
          dossierError={dossierError}
          onChanged={() => { reloadDossier(); void reg.refresh(); }}
          onBusy={setDocBusy}
        />
      ) : step === 'people' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <Block
            title="If something happens while they are out"
            note="Who this company rings if a person in the field is hurt or does not come back. This is the one thing on this page with a real cost when it is blank."
            keys={['emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation']}
            render={renderOne}
          />
          <ReferencesBlock
            assayerId={reg.assayerId}
            references={dossier?.references ?? []}
            onChanged={reloadDossier}
          />
          <Block
            title="What they can do"
            note="Picked from lists the roster already uses. Typing a skill that is not on the list would make a capability nobody holds, so the person would quietly look unassignable."
            keys={['skills', 'languages', 'certifications', 'experienceYears']}
            render={renderOne}
          />
          <Block
            title="When they can work"
            note="Leave blank if there is no limit. These are what stop the planner offering somebody more work than they agreed to."
            keys={['workingHoursStart', 'workingHoursEnd', 'maxDailyWorkload', 'maxWeeklyWorkload']}
            render={renderOne}
          />
          <Block
            title="What they are paid"
            note="Leave every box empty if the rates are not agreed yet — nothing is filed and they can be set later. Rates are saved together with this page, and if they fail you will be told exactly that rather than losing them."
            keys={RATE_FIELDS.map((f) => f.key)}
            render={renderOne}
          />
          <Block
            title="Who looks after them here"
            note="Optional. The reporting line and any numbers your own payroll or HR system knows them by."
            keys={['managerId', 'hrOwnerName', 'employeeId', 'employeeCode']}
            render={renderOne}
          />
          <Block title="Anything else" note="Notes about this person, for whoever opens their record next." keys={['notes']} render={renderOne} />
        </div>
      ) : (
        <ReviewStep
          record={reg.record}
          scannedCount={scannedCount}
          requirementCount={dossier?.onboarding.length ?? 0}
          onGo={(k) => void goTo(k)}
        />
      )}
    </Modal>
  );
};

/**
 * The name the roster has always opened this by.
 *
 * Kept so the entry point reads the same as it did, and because "create" is still what the button
 * does — it is the shape of the thing behind it that changed.
 */
export const CreateAssayerModal = RegistrationWizard;
