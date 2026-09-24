import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, Loader2, Phone, ShieldCheck, ArrowLeft, CheckCircle2, AlertCircle, User, Briefcase, CreditCard, FileCheck, MapPin, Landmark, Users, Info, HelpCircle, Award, UserPlus, MinusCircle, ChevronRight, PauseCircle,
} from 'lucide-react';
import {
  ApplicationStatus, EmploymentCategory, ONBOARDING_DOCUMENT_LABELS,
  DOCUMENT_REJECTION_GUIDANCE, APPLICATION_REFERENCES_MAX, referenceSubmitProblem, referencePhoneForDisplay, referenceEmailProblem, bankAccountConfirmProblem, REGISTRATION_REQUIRED_DOCUMENTS,
  uploadSizeProblem, isValidIfsc, normalisePhone, normaliseIdentifierOnBlur, scanMimeType, storedScanFileName,
  SCAN_UPLOAD_IMAGE_ACCEPT,
  inferRegistrationStep, registrationStepProblems, resumableRegistrationStep, REGISTRATION_CONDITIONAL_DOCUMENTS,
  type ApplicationInfoRequestItem, readApplicationInfoRequests, applicationFieldStep,
  type RegistrationFormField, type RegistrationFormValues, type RegistrationProblem,
  normalizeSourceReferral, candidateMayEditSourceReferral, sourceReferralLine, type SourceReferral,
  CANDIDATE_JOURNEY_WORDS, candidateJourney, readCandidateJourneyProgress, type CandidateJourneyProgress,
} from '@fapoms/shared';
import {
  SourceReferralFields, EMPTY_REFERRAL, referralDraftFrom, referralPayload, type SourceReferralDraft,
} from '../components/SourceReferralFields';
import { Select } from '../components/ui/Select';
import { ScanOrAttach } from '../components/scanner/ScanOrAttach';
import { AlertBanner } from '../components/ui/AlertBanner';
import { useConfirm } from '../components/ui/ConfirmDialog';
import { AppError, userMessage } from '../services/errors';
import { fmtDate } from '../utils/dates';
import { identityFormatHint, normaliseIdentityOnBlur } from '../config/identity-fields';
import {
  STATE_OPTIONS, GENDER_OPTIONS, EXPERIENCE_OPTIONS,
  RELATION_OPTIONS, OTHER_SENTINEL, isOtherValue,
  resolvePincode, pincodeStateConflict, resolveIfsc,
  mobileHint, normaliseMobile, DOB_MIN, dobMaxToday,
  isSixDigitPin, FIELD_LIMITS,
} from '../config/registration-options';
import {
  hydrateRegistration, requestRegistrationOtp, verifyRegistrationOtp, updateRegistrationDraft,
  checkRegistrationPhoneConflict,
  acceptRegistrationConsent,
  withdrawRegistrationConsent,
  type RegistrationHydrateResult, uploadRegistrationDocument, submitRegistration, isOtpVerificationLost,
  removeRegistrationDocumentFile, isUploadRejected,
  OTP_BEFORE_SEND_WORDS, otpSentWords,
  getRegistrationDocumentFileBlob,
  type RegistrationApplication, type RegistrationApplicationDocument, type UpdateRegistrationDraftInput,
} from '../services/public-registration';
import { DocumentPreviewModal, type DocumentPreviewItem } from '../components/DocumentPreviewModal';
import { LocationPicker } from '../components/LocationPicker';
import PrimaryButton from './registration/PrimaryButton';
// The masthead and the stylesheet moved out when a second public page needed them.
import { FORM_CSS, PublicMasthead } from './registration/PublicShell';
import ConsentGate from './registration/ConsentGate';
import { DocumentThumb } from './registration/DocumentThumb';
import { CandidateAsks, CandidateJourneySteps } from './registration/CandidateJourney';
import { blobBytes } from '../components/scanner/jpeg-pages-to-pdf';

/**
 * Appraiser self-registration — public, reachable by the emailed invite link alone.
 *
 * A candidate who passed an interview gets `https://<app>/register/<token>` and opens it from
 * whatever device is in their hand, with no app and no account: verify a mobile number by OTP,
 * fill in a profile, attach a few scans, tick a consent box, submit for HR review. Everything this
 * page calls lives under `/public/registration/:token/...` and carries no auth of any kind besides
 * that token.
 *
 * Which fields are dropdowns and which are text is the DATA MODEL's decision, not this page's:
 * state, relation, experience range and employment category are enumerated in shared/backend, so
 * they are picks. Qualification, employer, expertise and availability are free text ON PURPOSE
 * (the roster holds 104 distinct qualifications; forcing an enum would lose detail), so they stay
 * text — with the desk wizard's own placeholders — while the error-prone identifiers (pincode,
 * IFSC, phones, PAN/Aadhaar) are automated and validated instead.
 *
 * Form contract: every completed field is PATCHed to `/draft` on blur/select, and the patch
 * shape (`fieldPatch`/`wholeFormPatch`) is exactly what the backend allow-lists — picks store the
 * same plain strings the old text boxes stored, so the server needs no change.
 */

const SECTION_TITLE_STYLE: React.CSSProperties = {
  fontSize: 'var(--text-md)',
  fontWeight: 700,
  color: 'var(--text-primary)',
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
};

const SECTION_NOTE_STYLE: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  color: 'var(--text-secondary)',
  lineHeight: 1.55,
};

const LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--text-xs)',
  fontWeight: 600,
  color: 'var(--text-primary)',
  marginBottom: '6px',
};

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  fontSize: 'var(--text-md)',
  minHeight: '48px',
  fontFamily: 'inherit',
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-sm, 8px)',
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
};

const INPUT_ERROR_STYLE: React.CSSProperties = {
  ...INPUT_STYLE,
  borderColor: 'var(--danger)',
};

const FIELD_GRID_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: '16px',
};

const HINT_STYLE: React.CSSProperties = {
  fontSize: 'var(--text-2xs)',
  color: 'var(--text-secondary)',
  marginTop: '5px',
  lineHeight: 1.45,
};

const AUTO_NOTE_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '6px',
  fontSize: 'var(--text-2xs)',
  color: 'var(--accent)',
  marginTop: '6px',
  lineHeight: 1.45,
};

const ERROR_TEXT_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  fontSize: 'var(--text-2xs)',
  color: 'var(--danger)',
  marginTop: '5px',
  lineHeight: 1.4,
  fontWeight: 600,
};

/**
 * Focus ring, input placeholders, and card interaction styles.
 *
 * WRITTEN FOR A GROUND THIS PAGE DOES NOT HAVE. These rules used to set near-white placeholders
 * and borders — `rgba(247, 239, 231, 0.48)` and `rgba(255, 236, 220, 0.22)` — which suit a dark
 * page. App.tsx returns this screen early, with no account and no session, so the app never
 * applies a theme and it always renders on the default LIGHT palette: white on white. The
 * one-time-code box had no visible outline and no visible placeholder, so there was nothing on
 * screen to type into. Everything here draws from the palette now, and `PublicRegistration.otp.
 * spec.ts` refuses a near-white literal creeping back.
 *
 * Kept out of the template literal below on purpose: a comment inside it is shipped to every
 * candidate as part of the stylesheet.
 */

const FieldHint: React.FC<{ field: string; value: string }> = ({ field, value }) => {
  const hint = identityFormatHint(field, value);
  if (!hint) return null;
  return (
    <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--warning)', marginTop: '4px', lineHeight: 1.4 }}>
      {hint}
    </div>
  );
};

const FieldError: React.FC<{ message?: string | null; id?: string }> = ({ message, id }) => {
  if (!message) return null;
  return (
    <div id={id} role="alert" style={ERROR_TEXT_STYLE}>
      <AlertCircle size={12} style={{ flexShrink: 0 }} />
      <span>{message}</span>
    </div>
  );
};

/**
 * People who can vouch for the candidate — up to three, at least one with a number.
 *
 * Each row saves with the draft as it is added or removed, the same as every other answer on
 * this form. Submit refuses without a ringable one (see `referenceSubmitProblem`), so the
 * error here names the rule before the candidate reaches the last step.
 *
 * Exported for its spec: three rows, a cap, and the rule are the whole contract.
 */
export const ReferencesEditor: React.FC<{
  references: CandidateReference[];
  error: string | null;
  onChange: (next: CandidateReference[]) => void;
}> = ({ references, error, onChange }) => {
  const [draft, setDraft] = useState({ fullName: '', phone: '', relationship: '', email: '' });
  const [localError, setLocalError] = useState<string | null>(null);

  const add = () => {
    if (!draft.fullName.trim()) {
      setLocalError('Give a name for this reference.');
      return;
    }
    if (references.length >= APPLICATION_REFERENCES_MAX) {
      setLocalError(`Only ${APPLICATION_REFERENCES_MAX} references are needed.`);
      return;
    }
    if (draft.email.trim() && referenceEmailProblem(draft.email.trim().toLowerCase())) {
      setLocalError('That email does not look right.');
      return;
    }
    setLocalError(null);
    onChange([...references, {
      fullName: draft.fullName.trim(),
      phone: draft.phone.replace(/\D/g, '').slice(0, 15),
      relationship: draft.relationship.trim(),
      email: draft.email.trim().toLowerCase(),
    }]);
    setDraft({ fullName: '', phone: '', relationship: '', email: '' });
  };

  const remove = (index: number) => onChange(references.filter((_, i) => i !== index));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      {references.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {references.map((r, i) => (
            <li
              key={`${r.fullName}-${i}`}
              style={{
                display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap',
                padding: '8px 12px', borderRadius: '8px',
                background: 'var(--bg-surface)', border: '1px solid var(--border-hair)',
                fontSize: 'var(--text-xs)',
              }}
            >
              <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.fullName}</span>
              {r.relationship && <span style={{ color: 'var(--text-secondary)' }}>· {r.relationship}</span>}
              {r.phone && <span style={{ color: 'var(--text-secondary)' }}>· {referencePhoneForDisplay(r.phone)}</span>}
              {r.email && <span style={{ color: 'var(--text-secondary)' }}>· {r.email}</span>}
              <button
                type="button"
                onClick={() => remove(i)}
                aria-label={`Remove reference ${r.fullName}`}
                className="btn btn-secondary"
                style={{ fontSize: 'var(--text-2xs)', padding: '3px 10px', marginLeft: 'auto' }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {references.length < APPLICATION_REFERENCES_MAX ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '10px', alignItems: 'end' }}>
          <div>
            <label htmlFor="reg-ref-name-input" style={LABEL_STYLE}>Their name *</label>
            <input
              id="reg-ref-name-input"
              value={draft.fullName}
              onChange={(e) => setDraft({ ...draft, fullName: e.target.value })}
              placeholder="Former employer or colleague"
              autoComplete="off"
              maxLength={200}
              className="reg-input"
              style={INPUT_STYLE}
            />
          </div>
          <div>
            <label htmlFor="reg-ref-phone-input" style={LABEL_STYLE}>Their phone number</label>
            <PhoneInput
              id="reg-ref-phone-input"
              value={draft.phone}
              onChange={(v) => setDraft({ ...draft, phone: v })}
              onBlur={() => setDraft((d) => ({ ...d, phone: d.phone.replace(/\D/g, '').slice(0, 15) }))}
              placeholder="10-digit mobile"
              invalid={Boolean(draft.phone) && !normalisePhone(draft.phone)}
            />
          </div>
          <div>
            <label htmlFor="reg-ref-relation-input" style={LABEL_STYLE}>How they know you</label>
            <input
              id="reg-ref-relation-input"
              value={draft.relationship}
              onChange={(e) => setDraft({ ...draft, relationship: e.target.value })}
              placeholder="e.g. Former manager"
              autoComplete="off"
              maxLength={100}
              className="reg-input"
              style={INPUT_STYLE}
            />
          </div>
          <div>
            <label htmlFor="reg-ref-email-input" style={LABEL_STYLE}>Their email (optional)</label>
            <input
              id="reg-ref-email-input"
              type="email"
              value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
              placeholder="name@example.com"
              autoComplete="off"
              maxLength={255}
              className="reg-input"
              style={INPUT_STYLE}
            />
          </div>
          <div>
            <PrimaryButton onClick={add} title="Add this person as a reference">
              Add reference
            </PrimaryButton>
          </div>
        </div>
      ) : (
        <div style={HINT_STYLE}>Three references is the most this form takes — remove one to change them.</div>
      )}
      <FieldError message={localError ?? error} />
    </div>
  );
};

/** Phone box with a fixed +91 prefix so candidates stop typing it (and re-typing it wrong). */
const PhoneInput: React.FC<{
  id: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  title?: string;
}> = ({ id, value, onChange, onBlur, placeholder, disabled, invalid, describedBy, title }) => (
  <div style={{ position: 'relative' }}>
    <span
      aria-hidden
      style={{
        position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)',
        color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', fontWeight: 600, pointerEvents: 'none',
      }}
    >
      +91
    </span>
    <input
      id={id}
      value={value}
      title={title}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      inputMode="tel"
      autoComplete="tel"
      maxLength={16}
      placeholder={placeholder ?? '10-digit mobile number'}
      disabled={disabled}
      aria-invalid={Boolean(invalid)}
      aria-describedby={describedBy}
      className="reg-input"
      style={{ ...(invalid ? INPUT_ERROR_STYLE : INPUT_STYLE), paddingLeft: '48px' }}
    />
  </div>
);

/** The same answers the phone app's registration holds — the rules over them live in shared. */
type FormState = RegistrationFormValues;

interface CandidateReference {
  fullName: string;
  phone: string;
  relationship: string;
  email: string;
}

/** Who referred them, as stored on the application — HR's entry or their own. */
const readSourceReferral = (app: RegistrationApplication | null | undefined): SourceReferral | null =>
  ((app?.extendedProfile as { sourceReferral?: SourceReferral } | null)?.sourceReferral) ?? null;

const readCandidateReferences = (app: RegistrationApplication): CandidateReference[] => {
  const raw = (app.extendedProfile as { references?: unknown } | null)?.references;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
    .map((r) => ({
      fullName: String(r.fullName ?? ''),
      phone: String(r.phone ?? ''),
      relationship: String(r.relationship ?? ''),
      email: String(r.email ?? ''),
    }))
    .filter((r) => r.fullName.trim() !== '' || r.phone.trim() !== '' || r.email.trim() !== '');
};

export const RECORD_KEYS = [
  'panNumber', 'aadhaarNumber', 'bankAccountNumber', 'ifscCode', 'bankName',
  'qualification', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
  'alternatePhone', 'district',
] as const;

const seedForm = (app: RegistrationApplication): FormState => ({
  fullName: app.fullName ?? '',
  email: app.email ?? '',
  dateOfBirth: app.dateOfBirth ? app.dateOfBirth.slice(0, 10) : '',
  gender: app.gender ?? '',
  address: app.address ?? '',
  state: app.state ?? '',
  city: app.city ?? '',
  pincode: app.pincode ?? '',
  experienceYears: app.experienceYears != null ? String(app.experienceYears) : '',
  currentEmployer: app.currentEmployer ?? '',
  expertise: app.expertise ?? '',
  availability: app.availability ?? '',
  employmentCategory: app.employmentCategory ?? '',
  ...Object.fromEntries(
    RECORD_KEYS.map((k) => [k, String(app.extendedProfile?.fields?.[k] ?? '')]),
  ) as Pick<FormState, typeof RECORD_KEYS[number]>,
  // What is already saved counts as confirmed: it was typed twice when it was saved. Only a number
  // typed NOW has to be typed again.
  bankAccountNumberConfirm: String(app.extendedProfile?.fields?.bankAccountNumber ?? ''),
});

function fieldPatch(key: keyof FormState, value: string): UpdateRegistrationDraftInput {
  // The second typing of the account number exists only on this screen, to be compared. Never sent:
  // the API refuses properties it does not know, so leaking it would fail every whole-form save.
  if (key === 'bankAccountNumberConfirm') return {};
  const trimmed = (value ?? '').trim();

  if (key === 'dateOfBirth') {
    return { dateOfBirth: trimmed };
  }
  if (key === 'experienceYears') {
    if (trimmed === '') return { experienceYears: null };
    const years = Number(trimmed);
    return Number.isNaN(years) ? {} : { experienceYears: years };
  }
  if (key === 'employmentCategory') {
    return trimmed ? { employmentCategory: trimmed as EmploymentCategory } : {};
  }
  if ((RECORD_KEYS as readonly string[]).includes(key as string)) {
    return { record: { [key]: trimmed } };
  }
  return { [key]: trimmed } as UpdateRegistrationDraftInput;
}

function wholeFormPatch(f: FormState): UpdateRegistrationDraftInput {
  const patch: UpdateRegistrationDraftInput = {};
  const record: Record<string, string> = {};
  for (const key of Object.keys(f) as (keyof FormState)[]) {
    const one = fieldPatch(key, String(f[key] ?? ''));
    if (one.record) Object.assign(record, one.record);
    else Object.assign(patch, one);
  }
  if (Object.keys(record).length > 0) patch.record = record;
  return patch;
}

const CATEGORY_CARDS: Array<{
  value: EmploymentCategory;
  title: string;
  desc: string;
  docs: string;
}> = [
  {
    value: EmploymentCategory.FREELANCER,
    title: 'Freelancer',
    desc: 'You work independently and take valuation assignments as scheduled.',
    docs: 'Required scan: Experience Certificate / Letter',
  },
  {
    value: EmploymentCategory.PROPRIETOR,
    title: 'Proprietor',
    desc: 'You own or run a registered jewellery shop or assaying firm.',
    docs: 'Required scans: Shop Establishment Proof + Association Letter',
  },
];

/**
 * What a finished application says — one heading and at most one line (owner, 2026-09-24: "keep
 * things simple"). The same four outcomes, in the same words where they carry weight, as the phone
 * app's `RegistrationStatus`; withdrawn is neutral there too, not a green tick.
 *
 * Submitted and approved say no more than their heading here: the road ahead — the steps and the
 * one sentence about what happens next — is `candidateJourney`'s, drawn under the heading.
 */
const STATUS_VIEW: Partial<Record<ApplicationStatus, (app: RegistrationApplication) => {
  tone: 'success' | 'danger' | 'neutral';
  title: string;
  body: string | null;
}>> = {
  [ApplicationStatus.PENDING_VALIDATION]: () => ({
    tone: 'success', title: 'Submitted. HR will call you.', body: null,
  }),
  [ApplicationStatus.APPROVED]: (app) => ({
    tone: 'success',
    title: `Approved${app.fullName ? ` — welcome, ${app.fullName}` : ''}.`,
    body: null,
  }),
  [ApplicationStatus.REJECTED]: (app) => ({
    tone: 'danger',
    title: 'Not approved this time.',
    body: app.reviewNotes ? `Note from HR: ${app.reviewNotes}` : null,
  }),
  [ApplicationStatus.WITHDRAWN]: () => ({
    tone: 'neutral',
    title: 'Application withdrawn',
    body: 'You withdrew this application. What you gave us has been deleted, apart from the record '
      + 'that an application was made and withdrawn. If you change your mind, ask the office that '
      + 'invited you for a new link.',
  }),
};

/** The reference a candidate quotes on the phone. */
const applicationRef = (id: string | null | undefined): string => `APP-${(id || '').slice(0, 8).toUpperCase()}`;

// PrimaryButton now lives in ./registration/PrimaryButton — the consent screen uses it too.

/** The phone app's step names, word for word — one registration, two surfaces. */
const WIZARD_STEPS = [
  { id: 1, title: 'Personal & contact', icon: User },
  { id: 2, title: 'Experience & address', icon: Briefcase },
  { id: 3, title: 'ID & bank', icon: CreditCard },
  { id: 4, title: 'Documents & submit', icon: FileCheck },
] as const;

/** When a conditional document is needed — the whole explanation, in the row's one badge. */
const CONDITIONAL_BADGE: Record<string, string> = {
  RENT_AGREEMENT: 'Only if your address differs from Aadhaar',
  ELECTRICITY_BILL: 'Only if the shop is rented',
};

/** The one line a row says under its name, where it needs one at all. */
const DOCUMENT_NOTE: Record<string, string> = {
  PHOTOGRAPH: 'Clear face photo, for your ID card.',
  BANK_PASSBOOK: 'The page with your name, account number and IFSC. A cancelled cheque is fine too.',
};

/**
 * Pages in a PDF this page has just built or been handed, for the thumbnail. Counts page objects,
 * which is exact for the scanner's own PDFs; a PDF that hides its pages in compressed object
 * streams answers null, and the thumbnail then just says "PDF".
 */
async function pdfPageCount(file: File): Promise<number | null> {
  try {
    const text = new TextDecoder('latin1').decode(await blobBytes(file));
    const count = (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
    return count > 0 ? count : null;
  } catch {
    return null;
  }
}

const CONDITIONAL_DOCS = new Set(REGISTRATION_CONDITIONAL_DOCUMENTS);

type StepErrors = Record<string, string>;

/**
 * The sentence for each problem the shared step rules report. The rules — what is required, what
 * shape an answer must have — are `registrationStepProblems`, which the phone app runs too.
 */
const STEP_MESSAGES: Partial<Record<RegistrationFormField, Partial<Record<RegistrationProblem['code'], string>>>> = {
  fullName: {
    required: 'Enter your full name exactly as on your Aadhaar or PAN.',
    tooShort: 'That name looks too short — enter your full legal name.',
  },
  email: { invalid: 'That email address does not look right.' },
  dateOfBirth: { required: 'Enter your date of birth as printed on your Aadhaar or PAN.' },
  pincode: { required: 'Enter your 6-digit postal pincode.', invalid: 'A pincode is exactly 6 digits.' },
  state: { required: 'Select your state.' },
  city: { required: 'Enter your city or town.' },
  address: {
    required: 'Enter your full residential street address (flat/house no., building, street).',
    tooShort: 'Please enter a complete street address so we can locate you accurately.',
  },
  employmentCategory: { required: 'Choose Freelancer or Proprietor — it decides which documents we ask for.' },
  panNumber: { invalid: 'A PAN looks like ABCDE1234F — five letters, four digits, one letter.' },
  aadhaarNumber: { invalid: 'An Aadhaar number is 12 digits — check it against the card.' },
  ifscCode: { invalid: 'An IFSC code looks like HDFC0001234 — four letters, a zero, then six characters.' },
  bankAccountNumber: { invalid: 'A bank account number is 9–18 digits.' },
  alternatePhone: { invalid: 'That number does not look like a valid 10-digit mobile number.' },
  emergencyContactPhone: { invalid: 'That number does not look like a valid 10-digit mobile number.' },
};

function problemMessage(field: RegistrationFormField, problem: RegistrationProblem): string {
  if (problem.code === 'tooLong') return `Keep this under ${problem.max} characters (${problem.length} now).`;
  if (problem.code === 'outOfRange') return `Choose between ${problem.min} and ${problem.max}.`;
  if (problem.code === 'dateOfBirth' || problem.code === 'mismatch') return problem.message;
  return STEP_MESSAGES[field]?.[problem.code] ?? 'Check this answer.';
}


/** The step a box is on — for jumping to it from HR's "Fix" list. */
const stepShowing = (field: string): number => applicationFieldStep(field);

function validateRegistrationStep(step: number, f: FormState): StepErrors {
  const errs: StepErrors = {};
  // The shared rules, the same ones the phone app runs — this page adds no rule of its own.
  for (const [field, problem] of Object.entries(registrationStepProblems(step, f))) {
    if (problem) errs[field] = problemMessage(field as RegistrationFormField, problem);
  }
  return errs;
}

export const PublicRegistration: React.FC<{ token: string }> = ({ token }) => {
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [application, setApplication] = useState<RegistrationApplication | null>(null);
  const [documents, setDocuments] = useState<RegistrationApplicationDocument[]>([]);
  const [documentsRequested, setDocumentsRequested] = useState<string[]>([]);
  /**
   * People who can vouch for the candidate — up to three, at least one with a number.
   * Saved with the draft like every other answer; submit refuses without a ringable one.
   */
  const [references, setReferences] = useState<CandidateReference[]>([]);
  const [referencesError, setReferencesError] = useState<string | null>(null);
  /** Who referred them — theirs to fill only while HR has not recorded it. */
  const [referral, setReferral] = useState<SourceReferralDraft>(EMPTY_REFERRAL);
  const [referralError, setReferralError] = useState<string | null>(null);
  /**
   * Exactly what HR asked for — the to-do list this link renders instead of one free-text
   * banner. Entries clear themselves as the candidate fixes each item.
   */
  const [infoRequests, setInfoRequests] = useState<ApplicationInfoRequestItem[]>([]);
  /** Where an approved candidate has got to since, and what HR has asked of them — from the server. */
  const [journeyProgress, setJourneyProgress] = useState<CandidateJourneyProgress | null>(null);
  const [form, setForm] = useState<FormState | null>(null);

  /*
    WHERE TO REOPEN IS DECIDED BY WHAT IS SAVED, NOT BY THIS BROWSER.

    The page used to keep its own step in localStorage and in a `#step-N` hash, and preferred those
    to what the server held — so the same link opened on a different step on the phone app than in
    a browser, and a candidate switching devices was put somewhere else each time. Both surfaces
    now ask the shared rules (`inferRegistrationStep` → `resumableRegistrationStep`) in `load`.
  */
  const [activeStep, setActiveStep] = useState<number>(1);
  const [maxStepVisited, setMaxStepVisited] = useState<number>(1);
  const [stepErrors, setStepErrors] = useState<StepErrors>({});
  const [stepAttempted, setStepAttempted] = useState(false);

  const [phone, setPhone] = useState('');
  const [otpVerified, setOtpVerified] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpInfo, setOtpInfo] = useState<string | null>(null);
  const [otpSentTo, setOtpSentTo] = useState<string | null>(null);
  const [otpCooldown, setOtpCooldown] = useState<number>(0);
  const [phoneConflict, setPhoneConflict] = useState<string | null>(null);
  const [checkingPhone, setCheckingPhone] = useState(false);

  const [savingDraft, setSavingDraft] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);

  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [uploadErrors, setUploadErrors] = useState<Record<string, string | undefined>>({});
  /** Rows whose last file the server refused — they offer "Take again" rather than "Take photo". */
  const [uploadRefused, setUploadRefused] = useState<Record<string, boolean>>({});
  const [removing, setRemoving] = useState<Record<string, boolean>>({});
  /** Page counts of PDFs sent this session, by stored key — for the thumbnail. */
  const [pdfPages, setPdfPages] = useState<Record<string, number>>({});

  const [consentBusy, setConsentBusy] = useState(false);
  /** The versioned notice the API serves; the form does not exist until it has been accepted. */
  const [consentNotice, setConsentNotice] = useState<RegistrationHydrateResult['consentNotice'] | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);

  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [relationOtherOpen, setRelationOtherOpen] = useState(false);
  /** "Someone referred me" — opened by the candidate, or already open when there is an answer. */
  const [referralOpen, setReferralOpen] = useState(false);
  const { confirmWithReason, confirmDialog } = useConfirm();

  // Optional map pin — stored in the draft's record fields.
  const [pinLatitude, setPinLatitude] = useState<number | null>(
    application?.extendedProfile?.fields?.latitude != null
      ? Number(application.extendedProfile.fields.latitude)
      : null,
  );
  const [pinLongitude, setPinLongitude] = useState<number | null>(
    application?.extendedProfile?.fields?.longitude != null
      ? Number(application.extendedProfile.fields.longitude)
      : null,
  );

  const [pincodeState, setPincodeState] = useState<'idle' | 'looking' | 'found' | 'notfound' | 'unavailable'>('idle');
  const [pincodeNote, setPincodeNote] = useState<string | null>(null);
  /** What the directory holds when it disagrees with what is already typed — offered, never forced. */
  const [pincodeOffer, setPincodeOffer] = useState<{ state: string; district: string; city: string | null } | null>(null);

  const [ifscState, setIfscState] = useState<'idle' | 'looking' | 'found' | 'notfound'>('idle');
  const [ifscNote, setIfscNote] = useState<string | null>(null);
  const [bankLocked, setBankLocked] = useState(false);
  const lastResolvedBank = useRef<string>('');
  const lookupSeq = useRef(0);
  const formRef = useRef<FormState | null>(null);

  // Scan preview modal state
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewItems, setPreviewItems] = useState<DocumentPreviewItem[]>([]);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const previewUrlsRef = useRef<string[]>([]);
  const revokePreviewUrls = useCallback(() => {
    previewUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    previewUrlsRef.current = [];
  }, []);

  const onVerificationLost = useCallback((err: unknown) => {
    if (isOtpVerificationLost(err)) {
      setOtpVerified(false);
      setCodeSent(false);
      setOtpSentTo(null);
      setOtpError('Your verification has expired. Request a new code to continue.');
    }
  }, []);

  const load = useCallback(async () => {
    try {
      setLoadState('loading');
      setLoadError(null);
      const result = await hydrateRegistration(token);
      setApplication(result.application);
      setConsentNotice(result.consentNotice);
      setDocumentsRequested(result.documentsRequested);
      setDocuments(result.documents);
      setInfoRequests(result.infoRequests ?? []);
      // Not on the service's declared shape: read through the shared reader, which answers null
      // for a server that sends none.
      setJourneyProgress(readCandidateJourneyProgress((result as { journey?: unknown }).journey));
      const seeded = seedForm(result.application);
      setForm(seeded);
      setReferences(readCandidateReferences(result.application));
      setReferral(referralDraftFrom(readSourceReferral(result.application)));
      if (referralPayload(referralDraftFrom(readSourceReferral(result.application)))) setReferralOpen(true);
      setReferencesError(null);
      setPhone(result.application.mobile ?? '');
      if (result.otpVerified) {
        setOtpVerified(true);
      }

      const fields = result.application?.extendedProfile?.fields;
      if (fields?.latitude != null && fields.latitude !== '') {
        setPinLatitude(Number(fields.latitude));
      }
      if (fields?.longitude != null && fields.longitude !== '') {
        setPinLongitude(Number(fields.longitude));
      }

      // The same rule the phone app reopens with: the furthest step started, pulled back to the
      // first one that still has a problem.
      const finalStep = resumableRegistrationStep(inferRegistrationStep(result.application, result.documents), seeded);
      setActiveStep(finalStep);
      setMaxStepVisited((prev) => Math.max(prev, finalStep));

      setLoadState('loaded');
    } catch (err) {
      setLoadError(userMessage(err));
      setLoadState('error');
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { formRef.current = form; }, [form]);

  const refreshDocumentChecklist = useCallback(async () => {
    try {
      const result = await hydrateRegistration(token);
      setDocumentsRequested(result.documentsRequested);
      setDocuments(result.documents);
      setInfoRequests(result.infoRequests ?? []);
      setApplication((prev) => (prev ? { ...prev, ...result.application } : result.application));
      if (result.otpVerified) {
        setOtpVerified(true);
      }
      return result;
    } catch {
      return null;
    }
  }, [token]);

  const currentPhone = useCallback(() => normaliseMobile(phone), [phone]);

  /**
   * The code box takes the cursor the moment it appears.
   *
   * The candidate has just left the page for their email and come back holding six digits; asking
   * them to find and click the box first is a step that exists only because nobody removed it.
   */
  const codeRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (codeSent && !otpVerified) codeRef.current?.focus();
  }, [codeSent, otpVerified]);

  useEffect(() => {
    if (otpCooldown <= 0) return;
    const timer = setInterval(() => {
      setOtpCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [otpCooldown]);

  /**
   * Asks the server whether this number is free, and returns the sentence it gave — not a boolean.
   *
   * A boolean left each caller to invent its own wording, and `handleSendCode` did: it reached for
   * `phoneConflict` (state, one render behind, so null on the first press) and fell back to a
   * hard-coded "already registered with someone else". The candidate then saw the clash described
   * twice, in two different sentences, one of them the server's and one of them not.
   */
  const checkPhoneConflictFn = useCallback(async (phoneValue: string): Promise<string | null> => {
    const norm = normalisePhone(phoneValue);
    if (!norm) {
      setPhoneConflict(null);
      return null;
    }
    setCheckingPhone(true);
    try {
      const res = await checkRegistrationPhoneConflict(token, norm);
      const message = res.conflict
        ? (res.message ?? 'That number cannot be used here. Contact the office and they can sort it out.')
        : null;
      setPhoneConflict(message);
      return message;
    } catch {
      // A check that could not run is not a refusal: let the send attempt answer for itself.
      setPhoneConflict(null);
      return null;
    } finally {
      setCheckingPhone(false);
    }
  }, [token]);

  const handleSendCode = async () => {
    setOtpError(null);
    setOtpInfo(null);
    const trimmed = currentPhone();
    const norm = normalisePhone(trimmed);
    if (norm === null) {
      setOtpError('Enter a valid 10-digit mobile number first.');
      return;
    }
    if (trimmed !== phone) setPhone(trimmed);
    setOtpBusy(true);
    try {
      // The clash is already shown under the number itself, which is where it belongs and where
      // the candidate is looking. Repeating it under the button said the same thing twice.
      if (await checkPhoneConflictFn(norm)) return;
      const delivery = await requestRegistrationOtp(token, trimmed);
      setCodeSent(true);
      setOtpSentTo(trimmed);
      setOtpInfo(otpSentWords(delivery));
      setOtpCooldown(delivery.cooldownSeconds ?? 60);
    } catch (err) {
      setOtpError(userMessage(err));
    } finally {
      setOtpBusy(false);
    }
  };

  const handleVerifyCode = async (submitted?: string) => {
    setOtpError(null);
    const entered = (submitted ?? code).trim();
    const trimmed = currentPhone();
    if (!/^\d{6}$/.test(entered)) {
      setOtpError('Enter the 6-digit code you received.');
      return;
    }
    const sentTo = otpSentTo ?? trimmed;
    if (trimmed !== sentTo) {
      setOtpError(
        `That code was sent for +91 ${sentTo}, but the number above now reads +91 ${trimmed}. `
        + 'Change it back, or press Resend code for the new number.',
      );
      return;
    }
    setOtpBusy(true);
    try {
      await verifyRegistrationOtp(token, sentTo, entered);
      setOtpVerified(true);
      setOtpInfo(null);
      if (sentTo !== phone) setPhone(sentTo);
    } catch (err) {
      setOtpError(userMessage(err));
    } finally {
      setOtpBusy(false);
    }
  };

  const saveDraft = useCallback(async (patch: UpdateRegistrationDraftInput) => {
    if (Object.keys(patch).length === 0) return;
    setSavingDraft(true);
    setDraftError(null);
    setDraftSaved(false);
    try {
      const saved = await updateRegistrationDraft(token, patch);
      setApplication(saved);
      // The server drops an ask the moment its field actually changes; read the list back so the
      // "HR has asked you to fix these" box shrinks as they fix things, the same way a re-uploaded scan does.
      if ('infoRequests' in (saved as object)) {
        setInfoRequests(readApplicationInfoRequests((saved as { infoRequests?: unknown }).infoRequests));
      }
      setDraftSaved(true);
    } catch (err) {
      setDraftError(userMessage(err));
      onVerificationLost(err);
    } finally {
      setSavingDraft(false);
    }
  }, [token, onVerificationLost]);

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setDraftSaved(false);
  };

  const commitField = (key: keyof FormState) => (
    e?: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (!form) return;
    const raw = typeof e?.target?.value === 'string' ? e.target.value : (form[key] as string);
    const cleaned = typeof raw === 'string' ? normaliseIdentityOnBlur(key as string, raw) : null;
    if (cleaned !== null && cleaned !== raw) updateField(key, cleaned as FormState[keyof FormState]);
    else if (raw !== form[key]) updateField(key, raw as FormState[keyof FormState]);
    void saveDraft(fieldPatch(key, cleaned ?? raw));
  };

  const commitSelect = (key: keyof FormState, value: string) => {
    updateField(key, value as FormState[keyof FormState]);
    void saveDraft(fieldPatch(key, value));
  };

  // ── Automations (live directories, advisory — never blocking) ────────────

  const runPincodeLookup = useCallback(async (pincode: string) => {
    const clean = (pincode || '').trim();
    if (!isSixDigitPin(clean)) {
      setPincodeState('idle');
      setPincodeNote(null);
      return;
    }
    const seq = ++lookupSeq.current;
    setPincodeState('looking');
    setPincodeNote(null);
    setPincodeOffer(null);
    const answer = await resolvePincode(token, clean);
    if (seq !== lookupSeq.current) return;
    if (answer.status !== 'found') {
      /*
        Two different failures, two different sentences. "Check the digits" is right when the
        directory has answered and has no such pincode; it is wrong — and was what everybody saw —
        when the lookup itself could not run, because the deployed container could not reach the
        postal API at all. Neither blocks: the address below is always typeable.
      */
      setPincodeState(answer.status === 'not-found' ? 'notfound' : 'unavailable');
      setPincodeNote(answer.status === 'not-found'
        ? `There is no ${clean} in the postal directory — check the six digits, or just fill the address in below.`
        : 'We could not check that pincode just now. Fill in the state, district and town below — nothing is held up by this.');
      return;
    }
    const place = answer.place;
    setPincodeState('found');
    const current = formRef.current;
    const patch: UpdateRegistrationDraftInput = {};
    const filled: string[] = [];
    const next: Partial<FormState> = {};
    if (current && !current.state.trim() && place.state) {
      next.state = place.state;
      patch.state = place.state;
      filled.push(place.state);
    }
    if (current && !current.district.trim() && place.district) {
      next.district = place.district;
      patch.record = { ...(patch.record ?? {}), district: place.district };
      filled.push(`${place.district} district`);
    }
    if (current && !current.city.trim() && place.city) {
      next.city = place.city;
      patch.city = place.city;
      filled.push(place.city);
    }
    if (Object.keys(next).length > 0) {
      setForm((prev) => (prev ? { ...prev, ...next } : prev));
      /*
        WHERE IT CAME FROM IS PART OF THE ANSWER. India Post defines what a pincode means, so a
        `directory` fill is stated plainly. The map is only standing in when the directory cannot
        be reached, and it is wrong often enough on the wrong side of a border — it reads 160017
        as Punjab where the directory reads Chandigarh — that saying so and asking for a glance is
        the difference between a checked address and a confidently wrong one.
      */
      setPincodeNote(place.source === 'directory'
        ? `Filled in from the postal directory: ${filled.join(' · ')}. Change any of it below if it is not right.`
        : `The postal directory did not answer just now, so this came from the map: ${filled.join(' · ')}. Please check the state and district are right before you continue.`);
      void saveDraft(patch);
    } else {
      // Everything was already typed. Say what the directory holds and offer it in one press,
      // rather than announcing a "verified match" the candidate cannot act on.
      const held = [place.city, place.district, place.state].filter(Boolean).join(' · ');
      const differs = !!current
        && ((place.state && current.state.trim() && current.state.trim() !== place.state)
          || (place.district && current.district.trim() && current.district.trim() !== place.district)
          || (place.city && current.city.trim() && current.city.trim() !== place.city));
      const register = place.source === 'directory' ? 'The postal directory has' : 'The map has';
      setPincodeNote(differs
        ? `${register} ${clean} as ${held}. Yours reads differently — keep it if you know better, or use theirs.`
        : place.source === 'directory'
          ? `${clean} is ${held} in the postal directory.`
          : `${clean} looks like ${held} on the map — the postal directory did not answer, so please check it yourself.`);
      setPincodeOffer(differs ? place : null);
    }
  }, [token, saveDraft]);

  const runIfscLookup = useCallback(async (code: string) => {
    const clean = (code || '').trim().toUpperCase();
    if (!clean) {
      setIfscState('idle');
      setIfscNote(null);
      return;
    }
    if (!isValidIfsc(clean)) {
      setIfscState('idle');
      setIfscNote(null);
      return;
    }
    const seq = ++lookupSeq.current;
    setIfscState('looking');
    setIfscNote(null);
    const found = await resolveIfsc(token, clean);
    if (seq !== lookupSeq.current) return;
    if (!found) {
      setIfscState('notfound');
      setIfscNote('We could not recognise this IFSC code — check it against your passbook, or type the bank name below.');
      setBankLocked(false);
      return;
    }
    setIfscState('found');
    const previousResolved = lastResolvedBank.current;
    lastResolvedBank.current = found.bankName;
    const currentBank = (formRef.current?.bankName ?? '').trim();
    if (currentBank && currentBank !== previousResolved && currentBank !== found.bankName) {
      setBankLocked(false);
      setIfscNote(
        `Belongs to ${found.bankName}${found.branchName ? `, ${found.branchName}` : ''} — retaining your entered "${currentBank}".`,
      );
      return;
    }
    setBankLocked(true);
    setIfscNote(
      `Belongs to ${found.bankName}${found.branchName ? `, ${found.branchName}` : ''}${found.city ? ` (${found.city})` : ''} — auto-populated below.`,
    );
    updateField('bankName', found.bankName);
    void saveDraft({ record: { bankName: found.bankName } });
  }, [token, saveDraft]);

  const handlePincodeBlur = () => {
    if (!form) return;
    const cleaned = normaliseIdentityOnBlur('pincode', form.pincode);
    const value = cleaned ?? form.pincode;
    if (cleaned !== null) updateField('pincode', cleaned);
    void saveDraft(fieldPatch('pincode', value));
    void runPincodeLookup(value);
  };

  const handleIfscBlur = () => {
    if (!form) return;
    const cleaned = normaliseIdentityOnBlur('ifscCode', form.ifscCode);
    const value = (cleaned ?? form.ifscCode).toUpperCase();
    if (value !== form.ifscCode) updateField('ifscCode', value);
    void saveDraft(fieldPatch('ifscCode', value));
    void runIfscLookup(value);
  };

  // ── Per-step validation (blocks Continue, never blocks typing) ───────────

  const validateStep = useCallback(
    (step: number, f: FormState): StepErrors => validateRegistrationStep(step, f),
    [],
  );

  const scrollToFirstError = (errs: StepErrors) => {
    const first = Object.keys(errs)[0];
    if (!first) return;
    requestAnimationFrame(() => {
      document.getElementById(`reg-${first}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      (document.getElementById(`reg-${first}-input`) as HTMLElement | null)?.focus?.();
    });
  };

  const attemptGoToStep = (step: number) => {
    if (form && step > activeStep) {
      const errs = validateStep(activeStep, form);
      setStepErrors(errs);
      setStepAttempted(true);
      if (Object.keys(errs).length > 0) {
        scrollToFirstError(errs);
        return;
      }
      const patch = wholeFormPatch(form);
      if (pinLatitude != null && pinLongitude != null) {
        patch.record = {
          ...(patch.record ?? {}),
          latitude: pinLatitude,
          longitude: pinLongitude,
        };
      }
      void saveDraft(patch);
    } else {
      setStepErrors({});
      setStepAttempted(false);
    }
    setActiveStep(step);
    setMaxStepVisited((prev) => Math.max(prev, step));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const goToStep = (step: number) => {
    if (form && step > activeStep) {
      attemptGoToStep(step);
      return;
    }
    setStepErrors({});
    setStepAttempted(false);
    setActiveStep(step);
    setMaxStepVisited((prev) => Math.max(prev, step));
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleEmploymentCategoryChange = async (value: string) => {
    if (!form) return;
    const next: FormState = { ...form, employmentCategory: (value as EmploymentCategory) || '' };
    setForm(next);
    setStepErrors((prev) => {
      if (!prev.employmentCategory) return prev;
      const rest = { ...prev };
      delete rest.employmentCategory;
      return rest;
    });
    setSavingDraft(true);
    setDraftError(null);
    try {
      const saved = await updateRegistrationDraft(token, fieldPatch('employmentCategory', value));
      setApplication(saved);
      setDraftSaved(true);
      const refreshed = await refreshDocumentChecklist();
      if (refreshed) {
        const stillAsked = refreshed.documentsRequested;
        const orphaned = refreshed.documents
          .filter((d) => d.filePaths.length > 0 && !stillAsked.includes(d.requirement))
          .map((d) => ONBOARDING_DOCUMENT_LABELS[d.requirement as keyof typeof ONBOARDING_DOCUMENT_LABELS] ?? d.requirement);
        setDraftError(orphaned.length === 0 ? null : (
          `What you have already sent for ${orphaned.join(' and ')} is not asked for as a `
          + `${value.toLowerCase()}. It stays on your application, and HR can still review it.`
        ));
      }
    } catch (err) {
      setDraftError(userMessage(err));
      onVerificationLost(err);
    } finally {
      setSavingDraft(false);
    }
  };

  /**
   * `replace` is "Retake": the new file takes the place of what the row holds, rather than joining
   * it. A refusal from the server (`UPLOAD_REJECTED`) is shown in its own plain words, and the row
   * offers to take it again.
   */
  const handleUpload = async (requirement: string, file: File, replace = false) => {
    const problem = uploadSizeProblem(file);
    if (problem) {
      setUploadErrors((prev) => ({ ...prev, [requirement]: problem }));
      setUploadRefused((prev) => ({ ...prev, [requirement]: true }));
      return;
    }
    setUploadErrors((prev) => ({ ...prev, [requirement]: undefined }));
    setUploadRefused((prev) => ({ ...prev, [requirement]: false }));
    setUploading((prev) => ({ ...prev, [requirement]: true }));
    try {
      const row = await uploadRegistrationDocument(token, requirement, file, { replace });
      setDocuments((prev) => [...prev.filter((d) => d.requirement !== requirement), row]);
      if (file.type === 'application/pdf') {
        const pages = await pdfPageCount(file);
        const stored = row?.filePaths?.[row.filePaths.length - 1];
        if (pages && stored) setPdfPages((prev) => ({ ...prev, [stored]: pages }));
      }
      // The fresh scan answers its own send-back: drop the ask so the to-do list shrinks now,
      // not on the next reload. (The server clears its copy the same way.)
      setInfoRequests((prev) => prev.filter((i) => !(i.kind === 'document' && i.key === requirement)));
    } catch (err) {
      const refused = isUploadRejected(err);
      setUploadErrors((prev) => ({
        ...prev,
        [requirement]: refused && err instanceof AppError ? err.userMessage : userMessage(err),
      }));
      setUploadRefused((prev) => ({ ...prev, [requirement]: refused }));
      onVerificationLost(err);
    } finally {
      setUploading((prev) => ({ ...prev, [requirement]: false }));
    }
  };

  /** One file off a row — the × on its thumbnail. */
  const handleRemoveFile = async (requirement: string, index: number) => {
    setRemoving((prev) => ({ ...prev, [requirement]: true }));
    setUploadErrors((prev) => ({ ...prev, [requirement]: undefined }));
    try {
      const row = await removeRegistrationDocumentFile(token, requirement, index);
      setDocuments((prev) => [...prev.filter((d) => d.requirement !== requirement), ...(row ? [row] : [])]);
    } catch (err) {
      setUploadErrors((prev) => ({ ...prev, [requirement]: userMessage(err) }));
      onVerificationLost(err);
    } finally {
      setRemoving((prev) => ({ ...prev, [requirement]: false }));
    }
  };

  const openDocumentPreview = async (requirement: string, filePaths: string[], startAt = 0) => {
    if (previewLoading) return;
    revokePreviewUrls();
    setPreviewLoading(requirement);
    try {
      const items: DocumentPreviewItem[] = [];
      for (let i = 0; i < filePaths.length; i++) {
        const filePath = filePaths[i];
        // Named after the document, not the key: keys are opaque now (see object-key.ts).
        const fileName = storedScanFileName(
          ONBOARDING_DOCUMENT_LABELS[requirement as keyof typeof ONBOARDING_DOCUMENT_LABELS] ?? requirement,
          filePath,
          filePaths.length > 1 ? i + 1 : undefined,
        );
        const blob = await getRegistrationDocumentFileBlob(token, requirement, i);
        /*
          Re-typed from the filename before it becomes a URL. The route streams the bytes with no
          usable `Content-Type`, so `blob.type` is empty and the viewer — which decides what to
          render from exactly that — offered a download for every scan a candidate tried to check.
        */
        const type = scanMimeType(fileName);
        const url = URL.createObjectURL(type ? new Blob([blob], { type }) : blob);
        previewUrlsRef.current.push(url);
        items.push({
          title: `${ONBOARDING_DOCUMENT_LABELS[requirement as keyof typeof ONBOARDING_DOCUMENT_LABELS] ?? requirement}${filePaths.length > 1 ? ` (File ${i + 1} of ${filePaths.length})` : ''}`,
          url,
          fileName,
          mimeType: type ?? blob.type,
        });
      }
      setPreviewItems(items);
      setPreviewIndex(Math.min(startAt, Math.max(0, items.length - 1)));
      setPreviewOpen(true);
    } catch (err) {
      setUploadErrors((prev) => ({ ...prev, [requirement]: `Could not open scan preview: ${userMessage(err)}` }));
    } finally {
      setPreviewLoading(null);
    }
  };

  const handleClosePreview = () => {
    setPreviewOpen(false);
    revokePreviewUrls();
    setPreviewItems([]);
  };

  const handleAcceptConsent = async () => {
    if (!consentNotice || application?.consentAcceptedAt) return;
    setConsentBusy(true);
    setConsentError(null);
    try {
      // The version the API served, never one written into this page: what the row records and
      // what the person read have to be the same thing.
      const saved = await acceptRegistrationConsent(token, consentNotice.version);
      setApplication(saved);
    } catch (err) {
      setConsentError(userMessage(err));
      onVerificationLost(err);
    } finally {
      setConsentBusy(false);
    }
  };

  /**
   * Taking it back. Asks once in plain words, because it erases what they have given us and the
   * application cannot go ahead afterwards — but it asks ONCE: a right buried under three
   * confirmations is a right in name only. The reason is optional, and says so.
   */
  const handleWithdraw = async () => {
    const { confirmed, reason } = await confirmWithReason({
      title: 'Withdraw your application?',
      message: 'This stops your application and deletes what you have given us.',
      confirmLabel: 'Withdraw',
      cancelLabel: 'Keep my application',
      tone: 'danger',
      reversible: false,
      reasonPrompt: { label: 'Why? (optional)', optional: true },
    });
    if (!confirmed) return;
    setWithdrawing(true);
    try {
      const saved = await withdrawRegistrationConsent(token, reason.trim() || undefined);
      setApplication(saved);
    } catch (err) {
      setConsentError(userMessage(err));
    } finally {
      setWithdrawing(false);
    }
  };

  const handleSubmit = async () => {
    setSubmitBusy(true);
    setSubmitError(null);
    try {
      // Checked here too, so the candidate is taken to the document rather than told by the server.
      const missingDoc = REGISTRATION_REQUIRED_DOCUMENTS.find(
        (req) => documentsRequested.includes(req)
          && !documents.some((d) => d.requirement === req && d.filePaths.length > 0),
      );
      if (missingDoc) {
        const label = ONBOARDING_DOCUMENT_LABELS[missingDoc as keyof typeof ONBOARDING_DOCUMENT_LABELS] ?? missingDoc;
        setSubmitError(`Upload your ${label.toLowerCase()} before submitting — the page showing your name, account number and IFSC.`);
        goToStep(4);
        window.setTimeout(() => {
          document.getElementById(`doc-req-${missingDoc}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 150);
        return;
      }
      const problem = referenceSubmitProblem(references);
      if (problem) {
        setReferencesError(problem);
        setSubmitError(`${problem} Add them in step 2 (Experience & address).`);
        goToStep(2);
        return;
      }
      const saved = await submitRegistration(token);
      setApplication(saved);
    } catch (err) {
      setSubmitError(userMessage(err));
      onVerificationLost(err);
    } finally {
      setSubmitBusy(false);
    }
  };

  const consentAccepted = Boolean(application?.consentAcceptedAt);
  const hasPhotograph = Boolean(
    documents.find((d) => d.requirement === 'PHOTOGRAPH')?.filePaths?.length,
  );
  const canSubmit = useMemo(
    () => Boolean(form?.fullName.trim()) && Boolean(form?.employmentCategory) && consentAccepted && otpVerified && hasPhotograph,
    [form, consentAccepted, otpVerified, hasPhotograph],
  );

  const scrollToDocument = (requirement: string) => {
    goToStep(4);
    window.setTimeout(() => {
      document.getElementById(`doc-req-${requirement}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 150);
  };

  /** What stands between them and Submit — only what is missing, each with the way to it. */
  const stillNeeded: Array<{ key: string; label: string; go: () => void }> = [];
  if (form) {
    if (!otpVerified) stillNeeded.push({ key: 'otp', label: 'Verify your mobile number', go: () => goToStep(1) });
    if (!form.fullName.trim()) stillNeeded.push({ key: 'name', label: 'Your full name', go: () => goToStep(1) });
    if (!form.employmentCategory) stillNeeded.push({ key: 'category', label: 'Freelancer or proprietor', go: () => goToStep(3) });
    if (documentsRequested.includes('PHOTOGRAPH' as never) && !hasPhotograph) {
      stillNeeded.push({ key: 'photo', label: 'Your photo', go: () => scrollToDocument('PHOTOGRAPH') });
    }
    for (const req of REGISTRATION_REQUIRED_DOCUMENTS) {
      if (documentsRequested.includes(req as never) && !documents.some((d) => d.requirement === req && d.filePaths.length > 0)) {
        const docLabel = ONBOARDING_DOCUMENT_LABELS[req as keyof typeof ONBOARDING_DOCUMENT_LABELS] ?? req;
        stillNeeded.push({ key: `doc-${req}`, label: docLabel, go: () => scrollToDocument(req) });
      }
    }
    if (referenceSubmitProblem(references)) {
      stillNeeded.push({ key: 'references', label: 'A reference with a phone number', go: () => goToStep(2) });
    }
  }

  const relationSelectValue = form
    ? (!form.emergencyContactRelation.trim()
      ? ''
      : RELATION_OPTIONS.some((o) => o.value === form.emergencyContactRelation)
        ? form.emergencyContactRelation
        : OTHER_SENTINEL)
    : '';
  const showRelationOther = Boolean(
    relationOtherOpen
    || (form && form.emergencyContactRelation.trim()
      && isOtherValue(form.emergencyContactRelation, RELATION_OPTIONS)),
  );

  const handleRelationSelect = (v: string) => {
    if (v === OTHER_SENTINEL) {
      setRelationOtherOpen(true);
      updateField('emergencyContactRelation', '');
      void saveDraft(fieldPatch('emergencyContactRelation', ''));
      return;
    }
    setRelationOtherOpen(false);
    commitSelect('emergencyContactRelation', v);
  };

  const circleConflict = form ? pincodeStateConflict(form.pincode, form.state) : null;

  // ── Loading, a link that does not work, and a finished application ────────
  //
  // Each is one heading and at most one line (owner, 2026-09-24: "keep things simple and
  // straightforward") — plus, for a submitted or approved application, the short list of steps
  // still ahead. The phone app's `RegistrationStatus` says the same things.
  const shortScreen = (body: React.ReactNode, tone?: 'success' | 'danger' | 'neutral') => (
    <div className="pub-reg-root">
      <style>{FORM_CSS}</style>
      <PublicMasthead title="Registration" />
      <div className="pub-reg-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <div
          className="pub-reg-card"
          style={{
            maxWidth: '480px', width: '100%', textAlign: 'center', padding: '32px 24px', alignItems: 'center',
            borderColor: tone === 'danger' ? 'var(--danger)' : tone === 'success' ? 'var(--success)' : undefined,
          }}
        >
          {body}
        </div>
      </div>
    </div>
  );

  if (loadState === 'loading') {
    return shortScreen(
      <>
        <Loader2 size={32} className="spin" style={{ color: 'var(--accent)' }} />
        <div style={{ fontSize: 'var(--text-md)', fontWeight: 700, color: 'var(--text-primary)' }}>
          Opening your form…
        </div>
      </>,
    );
  }

  if (loadState === 'error' || !application || !form) {
    return shortScreen(
      <>
        <AlertCircle size={32} style={{ color: 'var(--danger)' }} />
        <h1 style={{ fontSize: 'var(--text-md)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
          Link not working — ask HR for a new one.
        </h1>
        {loadError && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{loadError}</div>
        )}
      </>,
      'danger',
    );
  }

  /*
    THE ROAD AHEAD, UNDER THE HEADING.

    Submitted and approved applications also show the steps still to come and the one sentence
    about what happens next (`candidateJourney`, shared with the phone app). Anything HR has asked
    of an approved candidate goes first. A paused joiner is told only that, in the same words
    whatever paused them — the link is not the place to learn how a check or an approval went.
  */
  const journey = candidateJourney(application.status, journeyProgress);
  const baseStatusView = STATUS_VIEW[application.status]?.(application);
  const statusView = baseStatusView && journey?.paused
    ? { tone: 'neutral' as const, title: CANDIDATE_JOURNEY_WORDS.pausedTitle, body: CANDIDATE_JOURNEY_WORDS.pausedBody }
    : baseStatusView;
  if (statusView) {
    const withdrawn = application.status === ApplicationStatus.WITHDRAWN;
    const colour = statusView.tone === 'danger' ? 'var(--danger)' : statusView.tone === 'success' ? 'var(--success)' : 'var(--text-muted)';
    const Icon = statusView.tone === 'danger' ? AlertCircle
      : withdrawn ? MinusCircle
        : journey?.paused ? PauseCircle
          : application.status === ApplicationStatus.APPROVED ? Award : CheckCircle2;
    return shortScreen(
      <>
        {journey && journey.asks.length > 0 && <CandidateAsks asks={journey.asks} />}
        <Icon size={40} style={{ color: colour }} />
        <h1 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
          {statusView.title}
        </h1>
        {statusView.body && (
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6, margin: 0 }}>
            {statusView.body}
          </p>
        )}
        {journey && !journey.paused && <CandidateJourneySteps view={journey} />}
        {/* A withdrawn application has nothing left to quote: its details were deleted. */}
        {!withdrawn && (
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
            Reference <strong style={{ color: 'var(--text-primary)', fontFamily: 'monospace' }}>#{applicationRef(application.id)}</strong>
          </div>
        )}
      </>,
      statusView.tone,
    );
  }

  /*
    THE NOTICE COMES FIRST.

    Not a step inside the wizard — a gate in front of it. The server refuses every write until this
    has been accepted, so a form rendered here would only be able to collect rejections.
  */
  if (consentNotice && !application.consentAcceptedAt) {
    return (
      <div className="pub-reg-root">
        <style>{FORM_CSS}</style>
        <PublicMasthead title="Registration" />
        <div className="pub-reg-container" style={{ maxWidth: '760px' }}>
          <ConsentGate
            notice={consentNotice}
            candidateName={application.fullName}
            busy={consentBusy}
            error={consentError}
            onAccept={() => void handleAcceptConsent()}
          />
        </div>
      </div>
    );
  }

  const stepErrorCount = Object.keys(stepErrors).length;

  return (
    <div className="pub-reg-root">
      <style>{FORM_CSS}</style>
      <PublicMasthead title="Registration" />

      <div className="pub-reg-container">
        <div className="pub-reg-grid">
          {/* ══════════════════════════════════════════════════════════════════════
              LEFT INSTITUTIONAL SIDEBAR (Desktop Sticky)
             ══════════════════════════════════════════════════════════════════════ */}
          <aside className="pub-reg-sidebar">
            <div className="pub-reg-sidebar-sticky">
              {/*
                ONE PANEL, ONE PROGRESS.

                This rail carried four cards: who you are, a roadmap with a progress bar and a
                percentage, document guidelines, and a help note — while the column beside it
                repeated the step, the percentage and the bar a second time. Progress was stated
                three times on one screen and the form itself started below all of it. What a
                candidate needs here is: this is my application, this is where I am, this is who to
                ask. Three things, one panel each for the first two.
              */}
              <div className="pub-reg-card pub-reg-rail-card">
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div className="pub-reg-avatar">
                    {(form.fullName.trim() || application.fullName || 'A').slice(0, 2).toUpperCase()}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="pub-reg-eyebrow">Your application</div>
                    <div className="pub-reg-rail-name">
                      {form.fullName.trim() || application.fullName || 'New applicant'}
                    </div>
                  </div>
                </div>

                <div className="pub-reg-rail-steps">
                  {WIZARD_STEPS.map((s) => {
                    const isCurrent = activeStep === s.id;
                    const isCompleted = activeStep > s.id;
                    const isClickable = s.id <= maxStepVisited;
                    const IconComp = s.icon;

                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => isClickable && goToStep(s.id)}
                        disabled={!isClickable}
                        title={`Go to step ${s.id}: ${s.title}`}
                        className={`pub-reg-roadmap-item ${isCurrent ? 'is-active' : ''} ${isCompleted ? 'is-completed' : ''}`}
                        aria-current={isCurrent ? 'step' : undefined}
                        style={{ cursor: isClickable ? 'pointer' : 'default' }}
                      >
                        <div className="pub-reg-roadmap-icon">
                          {isCompleted ? <Check size={14} strokeWidth={3} /> : <IconComp size={15} />}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className={`pub-reg-rail-step-title ${isCurrent ? 'is-active' : ''}`}>{s.title}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* The quiet facts: the reference to quote, and whether their typing is safe. */}
                <div className="pub-reg-rail-foot">
                  <span>Ref #{applicationRef(application.id)}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                    <span className={`pub-reg-pulse-dot ${savingDraft ? 'is-saving' : 'is-active'}`} />
                    {savingDraft ? 'Saving…' : draftSaved ? 'Saved' : 'Saves as you type'}
                  </span>
                </div>
              </div>

              <div className="pub-reg-card pub-reg-rail-card">
                <div className="pub-reg-rail-head">
                  <HelpCircle size={16} style={{ color: 'var(--accent)' }} />
                  <span>If you get stuck</span>
                </div>
                <p className="pub-reg-rail-body">
                  Contact the HR coordinator who sent you this link — they can change your registered
                  phone number, resend the link, or tell you which document is still outstanding.
                </p>
              </div>
            </div>
          </aside>

          {/* ══════════════════════════════════════════════════════════════════════
              RIGHT COLUMN: STEP WIZARD FORM
             ══════════════════════════════════════════════════════════════════════ */}
          <main className="pub-reg-main">
            {/*
              The compact header, and ONLY where the rail is not.

              Below 1080px the sidebar collapses away, so the step and the progress have to be said
              here. Above it they are already in the rail two inches to the left — this used to say
              them anyway: a second progress bar, a second percentage and a second row of step
              buttons, stacked above a form that then started below the fold.
            */}
            <div className="pub-reg-card pub-reg-compact-head">
              <div className="pub-reg-compact-row">
                <span className="pub-reg-step-pill">Step {activeStep} of {WIZARD_STEPS.length}</span>
                <span className="pub-reg-compact-title">{WIZARD_STEPS[activeStep - 1]?.title}</span>
              </div>
              <div className="pub-reg-progress" role="progressbar" aria-valuemin={1} aria-valuemax={WIZARD_STEPS.length} aria-valuenow={activeStep}>
                <div className="pub-reg-progress-fill" style={{ width: `${(activeStep / WIZARD_STEPS.length) * 100}%` }} />
              </div>
            </div>

            {application.status === ApplicationStatus.AWAITING_INFO && (
              <div
                role="alert"
                style={{
                  padding: '14px 16px', borderRadius: '10px',
                  background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
                  border: '1px solid var(--warning)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: infoRequests.length > 0 ? '8px' : 0 }}>
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    minWidth: '22px', height: '22px', padding: '0 6px', borderRadius: '999px',
                    background: 'var(--warning)', color: '#fff',
                    fontSize: 'var(--text-xs)', fontWeight: 700,
                  }}>
                    {infoRequests.length > 0 ? infoRequests.length : '!'}
                  </span>
                  {/* HR's ask in HR's voice — the phone app's form says the same words. */}
                  <span style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {infoRequests.length > 0 ? CANDIDATE_JOURNEY_WORDS.fixHeading : 'Action needed'}
                  </span>
                </div>
                {infoRequests.length > 0 ? (
                  <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {infoRequests.map((item) => (
                      <li key={`${item.kind}:${item.key}`} style={{ fontSize: 'var(--text-xs)', color: 'var(--text-primary)', lineHeight: 1.5 }}>
                        <strong>{item.label}</strong> — {item.message}
                        <button
                          type="button"
                          onClick={() => {
                            if (item.kind === 'document') {
                              goToStep(4);
                              window.setTimeout(() => {
                                document.getElementById(`doc-req-${item.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                              }, 150);
                            } else {
                              goToStep(stepShowing(item.key));
                            }
                          }}
                          className="btn btn-secondary"
                          style={{ fontSize: 'var(--text-2xs)', padding: '3px 10px', marginLeft: '8px' }}
                        >
                          Fix
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-primary)', lineHeight: 1.5 }}>
                    {application.reviewNotes || 'Please review your application and submit again.'}
                  </div>
                )}
              </div>
            )}

            {draftError && (
              <AlertBanner type="error" message={draftError} onClose={() => setDraftError(null)} />
            )}

            {stepAttempted && stepErrorCount > 0 && (
              <AlertBanner type="error">
                <strong>Please fix {stepErrorCount} field{stepErrorCount === 1 ? '' : 's'} to continue</strong> — highlighted below in red.
              </AlertBanner>
            )}

            {/* ══════════════════════════════════════════════════════════════════════
                STEP 1: Personal & Contact Details (with Mobile Verification)
               ══════════════════════════════════════════════════════════════════════ */}
            {activeStep === 1 && (
              <>
                {/* The mobile number, and the code that proves it is theirs. */}
                <div className="pub-reg-card">
                  <div style={SECTION_TITLE_STYLE}>
                    <Phone size={18} style={{ color: 'var(--accent)' }} />
                    <span>Mobile number</span>
                  </div>

                  {!otpVerified ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                        {OTP_BEFORE_SEND_WORDS}
                      </div>
                      <div id="reg-phone">
                        <label htmlFor="reg-phone-input" style={LABEL_STYLE}>Your mobile number *</label>
                        <PhoneInput
                          id="reg-phone-input"
                          value={phone}
                          title="Type your 10-digit mobile number for verification"
                          onChange={(v) => {
                            setPhone(v);
                            if (phoneConflict) setPhoneConflict(null);
                            if (otpError) setOtpError(null);
                          }}
                          onBlur={() => {
                            // The shared tidy-up (the one the phone app runs): "+91 98220-14455"
                            // becomes "9822014455". Only a number that tidies into a real mobile is
                            // saved — a half-typed one stays in the box, unsaved, for them to finish.
                            const tidied = normaliseIdentifierOnBlur('phone', phone) ?? phone.trim();
                            if (tidied !== phone) setPhone(tidied);
                            const number = normalisePhone(tidied);
                            if (!number) return;
                            void (async () => {
                              if (await checkPhoneConflictFn(number)) return;
                              void saveDraft({ mobile: number });
                            })();
                          }}
                          disabled={otpBusy}
                          invalid={Boolean(mobileHint(phone)) || Boolean(phoneConflict)}
                          describedBy="reg-phone-hint"
                        />
                        <div id="reg-phone-hint" style={HINT_STYLE} aria-live="polite">
                          {checkingPhone ? (
                            <span style={{ color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              <Loader2 size={12} className="animate-spin" /> Checking…
                            </span>
                          ) : (
                            mobileHint(phone) && <span style={{ color: 'var(--danger)' }}>{mobileHint(phone)}</span>
                          )}
                        </div>
                        {phoneConflict && (
                          <div style={{ marginTop: '8px' }}>
                            <AlertBanner type="error" message={phoneConflict} />
                          </div>
                        )}
                      </div>

                      {!codeSent ? (
                        <PrimaryButton
                          onClick={() => void handleSendCode()}
                          busy={otpBusy || checkingPhone}
                          disabled={Boolean(phoneConflict) || Boolean(mobileHint(phone)) || otpCooldown > 0}
                          title="Send a 6-digit verification code to this mobile number"
                        >
                          {otpCooldown > 0 ? `Send code (${otpCooldown}s)` : 'Send code'}
                        </PrimaryButton>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                          {otpSentTo && currentPhone() !== otpSentTo && (
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--warning)' }}>
                              The code was sent for +91 {otpSentTo}. You changed the number — resend the code for the new one.
                            </div>
                          )}
                          <div>
                            <label htmlFor="reg-code" style={LABEL_STYLE}>6-digit verification code</label>
                            <input
                              id="reg-code"
                              ref={codeRef}
                              value={code}
                              onChange={(e) => {
                                const next = e.target.value.replace(/\D/g, '').slice(0, 6);
                                setCode(next);
                                if (otpError) setOtpError(null);
                                /*
                                  Six digits is the whole answer, so nothing is gained by asking
                                  for a click as well — the code is either right or it is not, and
                                  the form can find that out the moment it has one. Pasting the
                                  code from the text or email lands here too.
                                */
                                if (next.length === 6 && !otpBusy) void handleVerifyCode(next);
                              }}
                              inputMode="numeric"
                              autoComplete="one-time-code"
                              aria-label="The 6-digit verification code"
                              maxLength={6}
                              placeholder="000000"
                              className="reg-input reg-code-input"
                              style={{ ...INPUT_STYLE, fontSize: 'var(--text-xl)' }}
                              disabled={otpBusy}
                            />
                          </div>
                          <PrimaryButton
                            onClick={() => void handleVerifyCode()}
                            busy={otpBusy}
                            // Fewer than six digits is not a code yet — nothing to send.
                            disabled={code.length !== 6}
                            title="Check the code and verify your mobile number"
                          >
                            Verify code
                          </PrimaryButton>
                          <button
                            type="button"
                            onClick={() => void handleSendCode()}
                            disabled={otpBusy || checkingPhone || Boolean(phoneConflict) || otpCooldown > 0}
                            title="Send the verification code again"
                            style={{
                              alignSelf: 'center', background: 'none', border: 'none', padding: '6px',
                              fontSize: 'var(--text-xs)', fontWeight: 600,
                              color: otpCooldown > 0 ? 'var(--text-muted)' : 'var(--accent)',
                              textDecoration: otpCooldown > 0 ? 'none' : 'underline',
                              cursor: otpCooldown > 0 || otpBusy ? 'default' : 'pointer',
                            }}
                          >
                            {otpCooldown > 0 ? `Resend code in ${otpCooldown}s` : 'Resend code'}
                          </button>
                        </div>
                      )}
                      {otpInfo && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--success)' }}>{otpInfo}</div>}
                      {otpError && <AlertBanner type="error" message={otpError} onClose={() => setOtpError(null)} />}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 'var(--text-md)', color: 'var(--text-primary)' }}>+91 {phone}</strong>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 10px', borderRadius: '999px',
                        fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--success)',
                        background: 'color-mix(in srgb, var(--success) 12%, transparent)',
                      }}>
                        <CheckCircle2 size={13} /> Verified
                      </span>
                    </div>
                  )}

                </div>

                {/* Personal Profile Details */}
                <div className="pub-reg-card">
                  <div style={SECTION_TITLE_STYLE}>
                    <User size={18} style={{ color: 'var(--accent)' }} />
                    <span>About you</span>
                  </div>

                  <div style={FIELD_GRID_STYLE}>
                    <div id="reg-fullName">
                      <label htmlFor="reg-fullName-input" style={LABEL_STYLE}>Full name (as on official ID) *</label>
                      <input
                        id="reg-fullName-input"
                        value={form.fullName}
                        title="Type your full name exactly as on your Aadhaar or PAN card"
                        onChange={(e) => updateField('fullName', e.target.value)}
                        onBlur={commitField('fullName')}
                        placeholder="e.g. Ramesh Kumar Sharma"
                        autoComplete="name"
                        maxLength={FIELD_LIMITS.fullName}
                        aria-invalid={Boolean(stepErrors.fullName)}
                        aria-describedby={stepErrors.fullName ? 'reg-fullName-error' : undefined}
                        className="reg-input"
                        style={stepErrors.fullName ? INPUT_ERROR_STYLE : INPUT_STYLE}
                      />
                      <FieldError id="reg-fullName-error" message={stepErrors.fullName} />
                    </div>
                    <div id="reg-dateOfBirth">
                      <label htmlFor="reg-dateOfBirth-input" style={LABEL_STYLE}>Date of birth *</label>
                      <input
                        id="reg-dateOfBirth-input"
                        type="date"
                        value={form.dateOfBirth}
                        title="Pick your date of birth as printed on your identity document"
                        min={DOB_MIN}
                        max={dobMaxToday()}
                        onChange={(e) => updateField('dateOfBirth', e.target.value)}
                        onBlur={commitField('dateOfBirth')}
                        aria-invalid={Boolean(stepErrors.dateOfBirth)}
                        aria-describedby={stepErrors.dateOfBirth ? 'reg-dateOfBirth-error' : undefined}
                        className="reg-input"
                        style={stepErrors.dateOfBirth ? INPUT_ERROR_STYLE : INPUT_STYLE}
                      />
                      <FieldError id="reg-dateOfBirth-error" message={stepErrors.dateOfBirth} />
                    </div>
                    <div id="reg-email">
                      <label htmlFor="reg-email-input" style={LABEL_STYLE}>Email address</label>
                      <input
                        id="reg-email-input"
                        value={form.email}
                        type="email"
                        title="Type an email address where HR can reach you"
                        autoCapitalize="none"
                        autoComplete="email"
                        onChange={(e) => updateField('email', e.target.value)}
                        onBlur={commitField('email')}
                        placeholder="you@example.com"
                        maxLength={FIELD_LIMITS.email}
                        aria-invalid={Boolean(stepErrors.email)}
                        aria-describedby={stepErrors.email ? 'reg-email-error' : undefined}
                        className="reg-input"
                        style={stepErrors.email ? INPUT_ERROR_STYLE : INPUT_STYLE}
                      />
                      <FieldError id="reg-email-error" message={stepErrors.email} />
                    </div>
                    <div>
                      <label htmlFor="reg-gender" style={LABEL_STYLE}>Gender</label>
                      <Select
                        value={form.gender}
                        onChange={(v) => commitSelect('gender', v)}
                        options={GENDER_OPTIONS}
                        placeholder="Select gender…"
                        aria-label="Gender"
                        id="reg-gender"
                        clearable
                      />
                    </div>
                  </div>

                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '10px',
                    flexWrap: 'wrap',
                    marginTop: '6px',
                    paddingTop: '16px',
                    borderTop: '1px solid var(--border-color)',
                  }}>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }} aria-live="polite">
                      {savingDraft ? 'Saving…' : draftSaved ? <span style={{ color: 'var(--success)' }}>✓ Saved</span> : 'Saves as you type'}
                    </div>
                    <PrimaryButton onClick={() => attemptGoToStep(2)} title="Save this step and go to experience and address">
                      Next
                    </PrimaryButton>
                  </div>
                </div>
              </>
            )}

            {/* ══════════════════════════════════════════════════════════════════════
                STEP 2: Experience & Address
               ══════════════════════════════════════════════════════════════════════ */}
            {activeStep === 2 && (
              <div className="pub-reg-card">
                <div style={SECTION_TITLE_STYLE}>
                  <Briefcase size={18} style={{ color: 'var(--accent)' }} />
                  <span>Professional experience</span>
                </div>

                <div style={FIELD_GRID_STYLE}>
                  <div id="reg-experienceYears">
                    <label htmlFor="reg-experienceYears-input" style={LABEL_STYLE}>Years of experience</label>
                    <Select
                      value={form.experienceYears}
                      onChange={(v) => commitSelect('experienceYears', v)}
                      options={EXPERIENCE_OPTIONS}
                      placeholder="Select years…"
                      searchPlaceholder="Type years…"
                      aria-label="Years of experience"
                      id="reg-experienceYears-input"
                      clearable
                      error={Boolean(stepErrors.experienceYears)}
                    />
                    <FieldError id="reg-experienceYears-error" message={stepErrors.experienceYears} />
                  </div>
                  <div>
                    <label htmlFor="reg-currentEmployer-input" style={LABEL_STYLE}>Current employer (if any)</label>
                    <input
                      id="reg-currentEmployer-input"
                      value={form.currentEmployer}
                      title="Type the name of the jeweller or firm you currently work with, if any"
                      onChange={(e) => updateField('currentEmployer', e.target.value)}
                      onBlur={commitField('currentEmployer')}
                      placeholder="Current jeweller or valuation firm"
                      autoComplete="organization"
                      maxLength={FIELD_LIMITS.currentEmployer}
                      className="reg-input"
                      style={INPUT_STYLE}
                    />
                  </div>
                </div>

                <div style={FIELD_GRID_STYLE}>
                  <div>
                    <label htmlFor="reg-expertise-input" style={LABEL_STYLE}>Core expertise</label>
                    <input
                      id="reg-expertise-input"
                      value={form.expertise}
                      title="Describe your core valuation skills, e.g. gold purity testing"
                      onChange={(e) => updateField('expertise', e.target.value)}
                      onBlur={commitField('expertise')}
                      placeholder="Gold purity testing, hallmarking, diamond grading…"
                      autoComplete="off"
                      maxLength={FIELD_LIMITS.expertise}
                      className="reg-input"
                      style={INPUT_STYLE}
                    />
                  </div>
                  <div>
                    <label htmlFor="reg-availability-input" style={LABEL_STYLE}>Availability for branch audits</label>
                    <input
                      id="reg-availability-input"
                      value={form.availability}
                      title="Type the days you are available for branch audits"
                      onChange={(e) => updateField('availability', e.target.value)}
                      onBlur={commitField('availability')}
                      placeholder="Weekdays, alternate Saturdays, full-time…"
                      autoComplete="off"
                      maxLength={FIELD_LIMITS.availability}
                      className="reg-input"
                      style={INPUT_STYLE}
                    />
                  </div>
                </div>

                <div style={{ borderTop: '1px solid var(--border-color)', margin: '6px 0' }} />

                <div>
                  <div style={SECTION_TITLE_STYLE}>
                    <MapPin size={18} style={{ color: 'var(--accent)' }} />
                    <span>Residential address</span>
                  </div>
                  <div style={{ ...SECTION_NOTE_STYLE, marginTop: '4px' }}>
                    Type pincode — we fill the rest.
                  </div>
                </div>

                <div style={FIELD_GRID_STYLE}>
                  <div id="reg-pincode">
                    <label htmlFor="reg-pincode-input" style={LABEL_STYLE}>
                      Pincode <span style={{ color: 'var(--danger)' }}>*</span>
                    </label>
                    <input
                      id="reg-pincode-input"
                      value={form.pincode}
                      title="Type your 6-digit postal pincode to look up your address"
                      onChange={(e) => updateField('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))}
                      onBlur={handlePincodeBlur}
                      inputMode="numeric"
                      autoComplete="postal-code"
                      placeholder="6-digit pincode"
                      aria-invalid={Boolean(stepErrors.pincode)}
                      aria-describedby={stepErrors.pincode ? 'reg-pincode-error reg-pincode-status' : 'reg-pincode-status'}
                      className="reg-input"
                      style={stepErrors.pincode ? INPUT_ERROR_STYLE : INPUT_STYLE}
                    />
                    <FieldError id="reg-pincode-error" message={stepErrors.pincode} />
                    <div id="reg-pincode-status" aria-live="polite">
                      {pincodeState === 'looking' && (
                        <div style={HINT_STYLE}><Loader2 size={11} className="spin" style={{ display: 'inline', verticalAlign: '-1px' }} /> Checking postal directory…</div>
                      )}
                      {pincodeState !== 'looking' && pincodeNote && (
                        <div style={pincodeState === 'notfound' ? { ...HINT_STYLE, color: 'var(--warning)' } : AUTO_NOTE_STYLE}>
                          <Info size={12} style={{ flexShrink: 0, marginTop: '1px' }} />
                          <span>{pincodeNote}</span>
                        </div>
                      )}
                      {/* The directory's answer, one press away — the candidate keeps the last word. */}
                      {pincodeOffer && (
                        <button
                          type="button"
                          title="Fill the state, district and town with the postal directory suggestion"
                          onClick={() => {
                            const place = pincodeOffer;
                            setForm((prev) => (prev ? {
                              ...prev, state: place.state, district: place.district, city: place.city ?? prev.city,
                            } : prev));
                            void saveDraft({
                              state: place.state,
                              city: place.city ?? undefined,
                              record: { district: place.district },
                            });
                            setPincodeOffer(null);
                            setPincodeNote(`Filled in for you: ${[place.city, place.district, place.state].filter(Boolean).join(' · ')}.`);
                          }}
                          style={{
                            marginTop: '6px', padding: '4px 10px', fontSize: 'var(--text-2xs)', fontWeight: 600,
                            borderRadius: '6px', cursor: 'pointer', color: 'var(--accent)',
                            background: 'transparent', border: '1px solid var(--accent)',
                          }}
                        >
                          Use {[pincodeOffer.city, pincodeOffer.district, pincodeOffer.state].filter(Boolean).join(' · ')}
                        </button>
                      )}
                      {!pincodeNote && pincodeState !== 'looking' && <FieldHint field="pincode" value={form.pincode} />}
                    </div>
                  </div>
                  <div id="reg-state">
                    <label htmlFor="reg-state" style={LABEL_STYLE}>
                      State <span style={{ color: 'var(--danger)' }}>*</span>
                    </label>
                    <Select
                      value={form.state}
                      onChange={(v) => {
                        commitSelect('state', v);
                        if (stepErrors.state) {
                          setStepErrors((prev) => {
                            const rest = { ...prev };
                            delete rest.state;
                            return rest;
                          });
                        }
                      }}
                      options={
                        form.state && !STATE_OPTIONS.some((o) => o.value === form.state)
                          ? [...STATE_OPTIONS, { value: form.state, label: `${form.state} (as recorded)` }]
                          : STATE_OPTIONS
                      }
                      placeholder="Select state…"
                      searchPlaceholder="Search states…"
                      aria-label="State"
                      id="reg-state"
                      clearable
                    />
                    <FieldError id="reg-state-error" message={stepErrors.state} />
                  </div>
                  <div id="reg-district">
                    <label htmlFor="reg-district-input" style={LABEL_STYLE}>District</label>
                    <input
                      id="reg-district-input"
                      value={form.district}
                      title="Type your district name"
                      onChange={(e) => updateField('district', e.target.value)}
                      onBlur={commitField('district')}
                      placeholder="e.g. Thane"
                      autoComplete="address-level2"
                      className="reg-input"
                      style={INPUT_STYLE}
                    />
                  </div>
                  <div id="reg-city">
                    <label htmlFor="reg-city-input" style={LABEL_STYLE}>
                      City / Town <span style={{ color: 'var(--danger)' }}>*</span>
                    </label>
                    <input
                      id="reg-city-input"
                      value={form.city}
                      title="Type your town or city name"
                      onChange={(e) => {
                        updateField('city', e.target.value);
                        if (stepErrors.city) {
                          setStepErrors((prev) => {
                            const rest = { ...prev };
                            delete rest.city;
                            return rest;
                          });
                        }
                      }}
                      onBlur={commitField('city')}
                      placeholder="e.g. Mumbai"
                      autoComplete="address-level2"
                      maxLength={FIELD_LIMITS.city}
                      aria-invalid={Boolean(stepErrors.city)}
                      className="reg-input"
                      style={stepErrors.city ? INPUT_ERROR_STYLE : INPUT_STYLE}
                    />
                    <FieldError id="reg-city-error" message={stepErrors.city} />
                  </div>
                </div>

                {circleConflict && (
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', fontSize: 'var(--text-2xs)', color: 'var(--warning)', lineHeight: 1.5 }}>
                    <AlertCircle size={12} style={{ flexShrink: 0, marginTop: '1px' }} />
                    <span>{circleConflict}</span>
                  </div>
                )}

                <div id="reg-address">
                  <label htmlFor="reg-address-input" style={LABEL_STYLE}>
                    Full residential street address <span style={{ color: 'var(--danger)' }}>*</span>
                  </label>
                    <textarea
                    id="reg-address-input"
                    value={form.address}
                    title="Type your full street address with flat, building and street"
                    onChange={(e) => {
                      updateField('address', e.target.value);
                      if (stepErrors.address) {
                        setStepErrors((prev) => {
                          const rest = { ...prev };
                          delete rest.address;
                          return rest;
                        });
                      }
                    }}
                    onBlur={commitField('address')}
                    rows={2}
                    placeholder="House / Flat No, Building / Colony, Street, Landmark"
                    autoComplete="street-address"
                    aria-invalid={Boolean(stepErrors.address)}
                    className="reg-input"
                    style={stepErrors.address ? { ...INPUT_ERROR_STYLE, resize: 'vertical' } : { ...INPUT_STYLE, resize: 'vertical' }}
                  />
                  <FieldError id="reg-address-error" message={stepErrors.address} />
                </div>

                {/* Optional location pin map */}
                <LocationPicker
                  latitude={pinLatitude}
                  longitude={pinLongitude}
                  onChange={(lat, lng) => {
                    setPinLatitude(lat);
                    setPinLongitude(lng);
                    // Save to draft as record fields — 'latitude' and 'longitude' are on the
                    // REGISTRATION_RECORD_FIELD_KEYS allow-list, so they flow through the
                    // standard promotion pipeline and land on the assayer entity automatically.
                    void saveDraft({
                      record: {
                        latitude: lat != null ? lat : '',
                        longitude: lng != null ? lng : '',
                      },
                    });
                  }}
                />

                <div style={{ borderTop: '1px solid var(--border-color)', margin: '6px 0' }} />

                <div>
                  <div style={SECTION_TITLE_STYLE}>
                    <Users size={18} style={{ color: 'var(--accent)' }} />
                    <span>References</span>
                  </div>
                  <div style={{ ...SECTION_NOTE_STYLE, marginTop: '4px' }}>
                    At least 1 person, with phone.
                  </div>
                </div>

                <ReferencesEditor
                  references={references}
                  error={referencesError}
                  onChange={(next) => {
                    setReferences(next);
                    setReferencesError(null);
                    void saveDraft({ references: next });
                  }}
                />

                {/*
                  WHO REFERRED THEM — the source reference, not a fourth referee. HR usually records
                  it at intake; then it is shown, not asked. Otherwise it is theirs to give, saved
                  when they leave the group (not box by box, which would call a half-typed entry
                  wrong while they are still typing it).
                */}
                {(() => {
                  const stored = readSourceReferral(application);
                  if (!candidateMayEditSourceReferral(stored)) {
                    return (
                      <div>
                        <div style={SECTION_TITLE_STYLE}>
                          <UserPlus size={18} style={{ color: 'var(--accent)' }} />
                          <span>Who referred you</span>
                        </div>
                        <div style={{ ...SECTION_NOTE_STYLE, marginTop: '4px' }}>
                          {sourceReferralLine(stored)} — recorded by our HR team. Tell them if this is not right.
                        </div>
                      </div>
                    );
                  }
                  /*
                    Optional, so folded away behind one line until they say somebody referred them
                    — and open already when they have said so before.
                  */
                  if (!referralOpen) {
                    return (
                      <button
                        type="button"
                        onClick={() => setReferralOpen(true)}
                        aria-expanded={false}
                        style={{
                          alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: '6px',
                          background: 'none', border: 'none', padding: '4px 0', cursor: 'pointer',
                          fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--accent)',
                        }}
                      >
                        <UserPlus size={16} /> Someone referred me <ChevronRight size={16} />
                      </button>
                    );
                  }
                  const commit = () => {
                    const payload = referralPayload(referral);
                    const { error } = normalizeSourceReferral(payload, 'CANDIDATE');
                    if (error) { setReferralError(error); return; }
                    setReferralError(null);
                    const same = JSON.stringify(referralPayload(referralDraftFrom(stored))) === JSON.stringify(payload);
                    if (!same) void saveDraft({ sourceReferral: payload });
                  };
                  return (
                    <div>
                      <div style={{ ...SECTION_TITLE_STYLE, marginBottom: '10px' }}>
                        <UserPlus size={18} style={{ color: 'var(--accent)' }} />
                        <span>Who referred you</span>
                      </div>
                      <div onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commit(); }}>
                        <SourceReferralFields value={referral} onChange={(next) => { setReferral(next); setReferralError(null); }} idPrefix="reg-referral" voice="you" />
                      </div>
                      {referralError && <div role="alert" style={{ ...HINT_STYLE, color: 'var(--danger)' }}>{referralError}</div>}
                    </div>
                  );
                })()}

                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '10px',
                  flexWrap: 'wrap',
                  marginTop: '6px',
                  paddingTop: '16px',
                  borderTop: '1px solid var(--border-color)',
                }}>
                  <button
                    type="button"
                    onClick={() => goToStep(1)}
                    title="Go back to the personal details step"
                    className="btn btn-secondary"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '11px 18px', minHeight: '48px' }}
                  >
                    <ArrowLeft size={16} /> Back
                  </button>
                  <PrimaryButton onClick={() => attemptGoToStep(3)} title="Save this step and go to ID and bank">
                    Next
                  </PrimaryButton>
                </div>
              </div>
            )}

            {/* ══════════════════════════════════════════════════════════════════════
                STEP 3: Statutory & Bank Details
               ══════════════════════════════════════════════════════════════════════ */}
            {activeStep === 3 && (
              <div className="pub-reg-card">
                <div style={SECTION_TITLE_STYLE}>
                  <CreditCard size={18} style={{ color: 'var(--accent)' }} />
                  <span>ID &amp; bank</span>
                </div>

                {/* Employment Category */}
                <div id="reg-employmentCategory">
                  <span id="reg-employmentCategory-label" style={LABEL_STYLE}>How do you practice as an appraiser? *</span>
                  <div
                    id="reg-employmentCategory-input"
                    tabIndex={-1}
                    role="group"
                    aria-labelledby="reg-employmentCategory-label"
                    aria-invalid={Boolean(stepErrors.employmentCategory)}
                    style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px', outline: 'none' }}
                  >
                    {CATEGORY_CARDS.map((c) => {
                      const selected = form.employmentCategory === c.value;
                      return (
                        <button
                          key={c.value}
                          type="button"
                          aria-pressed={selected}
                          title={`Choose ${c.title}: ${c.desc}`}
                          onClick={() => void handleEmploymentCategoryChange(c.value)}
                          className={`reg-cat-card${selected ? ' reg-cat-selected' : ''}`}
                          style={{
                            border: selected ? '2px solid var(--accent)' : '1.5px solid var(--border-color)',
                            borderRadius: '10px',
                            background: selected ? 'rgba(245, 158, 11, 0.12)' : 'var(--bg-surface-2)',
                            padding: '16px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '6px',
                          }}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)' }}>
                            <span style={{
                              width: '18px',
                              height: '18px',
                              borderRadius: '50%',
                              border: selected ? '2px solid var(--accent)' : '2px solid var(--text-secondary)',
                              background: selected ? 'var(--accent)' : 'transparent',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0,
                              boxSizing: 'border-box',
                              transition: 'all 0.15s ease',
                            }}>
                              {selected && (
                                <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#fff' }} />
                              )}
                            </span>
                            {c.title}
                          </span>
                          <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{c.desc}</span>
                          <span style={{
                            fontSize: 'var(--text-2xs)',
                            color: '#f59e0b',
                            fontWeight: 600,
                            background: 'rgba(245, 158, 11, 0.12)',
                            border: '1px solid rgba(245, 158, 11, 0.28)',
                            borderRadius: '6px',
                            padding: '3px 8px',
                            marginTop: '2px',
                            display: 'inline-block',
                            alignSelf: 'flex-start',
                          }}>
                            {c.docs}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <FieldError id="reg-employmentCategory-error" message={stepErrors.employmentCategory} />
                </div>

                {/* Statutory ID Numbers */}
                <div>
                  <div style={{ ...SECTION_TITLE_STYLE, fontSize: 'var(--text-sm)' }}>
                    <span>ID numbers</span>
                  </div>
                  <div style={FIELD_GRID_STYLE}>
                    <div id="reg-panNumber">
                      <label htmlFor="reg-panNumber-input" style={LABEL_STYLE}>PAN number</label>
                      <input
                        id="reg-panNumber-input"
                        value={form.panNumber}
                        title="Type your 10-character PAN, e.g. ABCDE1234F"
                        placeholder="ABCDE1234F"
                        onChange={(e) => updateField('panNumber', e.target.value.toUpperCase())}
                        onBlur={commitField('panNumber')}
                        autoCapitalize="characters"
                        autoComplete="off"
                        maxLength={10}
                        aria-invalid={Boolean(stepErrors.panNumber)}
                        className="reg-input"
                        style={{ ...((stepErrors.panNumber) ? INPUT_ERROR_STYLE : INPUT_STYLE), textTransform: 'uppercase', fontFamily: 'monospace' }}
                      />
                      <FieldError message={stepErrors.panNumber} />
                      {!stepErrors.panNumber && <FieldHint field="panNumber" value={form.panNumber} />}
                    </div>
                    <div id="reg-aadhaarNumber">
                      <label htmlFor="reg-aadhaarNumber-input" style={LABEL_STYLE}>Aadhaar number</label>
                      <input
                        id="reg-aadhaarNumber-input"
                        value={form.aadhaarNumber}
                        title="Type the 12-digit number from your Aadhaar card"
                        inputMode="numeric"
                        placeholder="12 digits"
                        onChange={(e) => updateField('aadhaarNumber', e.target.value.replace(/\D/g, '').slice(0, 12))}
                        onBlur={commitField('aadhaarNumber')}
                        autoComplete="off"
                        maxLength={12}
                        aria-invalid={Boolean(stepErrors.aadhaarNumber)}
                        className="reg-input"
                        style={{ ...(stepErrors.aadhaarNumber ? INPUT_ERROR_STYLE : INPUT_STYLE), fontFamily: 'monospace' }}
                      />
                      <FieldError message={stepErrors.aadhaarNumber} />
                      {!stepErrors.aadhaarNumber && <FieldHint field="aadhaarNumber" value={form.aadhaarNumber} />}
                    </div>
                  </div>
                </div>

                {/* Bank Details */}
                <div>
                  <div style={{ ...SECTION_TITLE_STYLE, fontSize: 'var(--text-sm)' }}>
                    <Landmark size={16} style={{ color: 'var(--accent)' }} />
                    <span>Bank account</span>
                  </div>
                  <div style={FIELD_GRID_STYLE}>
                    <div id="reg-ifscCode">
                      <label htmlFor="reg-ifscCode-input" style={LABEL_STYLE}>Bank IFSC code</label>
                      <input
                        id="reg-ifscCode-input"
                        value={form.ifscCode}
                        title="Type the IFSC code from your passbook, e.g. SBIN0001234"
                        placeholder="e.g. SBIN0001234"
                        onChange={(e) => {
                          updateField('ifscCode', e.target.value.toUpperCase());
                          setBankLocked(false);
                        }}
                        onBlur={handleIfscBlur}
                        autoCapitalize="characters"
                        autoComplete="off"
                        maxLength={11}
                        aria-invalid={Boolean(stepErrors.ifscCode)}
                        aria-describedby={stepErrors.ifscCode ? 'reg-ifscCode-error reg-ifscCode-status' : 'reg-ifscCode-status'}
                        className="reg-input"
                        style={{ ...(stepErrors.ifscCode ? INPUT_ERROR_STYLE : INPUT_STYLE), textTransform: 'uppercase', fontFamily: 'monospace' }}
                      />
                      <FieldError id="reg-ifscCode-error" message={stepErrors.ifscCode} />
                      {!stepErrors.ifscCode && <FieldHint field="ifscCode" value={form.ifscCode} />}
                      <div id="reg-ifscCode-status" aria-live="polite">
                        {ifscState === 'looking' && (
                          <div style={HINT_STYLE}><Loader2 size={11} className="spin" style={{ display: 'inline', verticalAlign: '-1px' }} /> Checking IFSC…</div>
                        )}
                        {ifscState !== 'looking' && ifscNote && (
                          <div style={ifscState === 'notfound' ? { ...HINT_STYLE, color: 'var(--warning)' } : AUTO_NOTE_STYLE}>
                            <Info size={12} style={{ flexShrink: 0, marginTop: '1px' }} />
                            <span>{ifscNote}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    <div id="reg-bankAccountNumber">
                      <label htmlFor="reg-bankAccountNumber-input" style={LABEL_STYLE}>Bank account number</label>
                      <input
                        id="reg-bankAccountNumber-input"
                        value={form.bankAccountNumber}
                        title="Type your bank account number where payouts should go"
                        inputMode="numeric"
                        placeholder="9–18 digit account number"
                        onChange={(e) => {
                          updateField('bankAccountNumber', e.target.value.replace(/\D/g, '').slice(0, 18));
                          // A changed number is a new number: it has to be typed a second time.
                          updateField('bankAccountNumberConfirm', '');
                        }}
                        onBlur={() => {
                          // Saved once confirmed (see the box below) — except emptying it, which needs no
                          // second typing and must reach the server so a wrong number can be cleared.
                          if (!form.bankAccountNumber.trim()) void saveDraft(fieldPatch('bankAccountNumber', ''));
                        }}
                        autoComplete="off"
                        aria-invalid={Boolean(stepErrors.bankAccountNumber)}
                        className="reg-input"
                        style={{ ...(stepErrors.bankAccountNumber ? INPUT_ERROR_STYLE : INPUT_STYLE), fontFamily: 'monospace' }}
                      />
                      <FieldError message={stepErrors.bankAccountNumber} />
                    </div>
                    {/*
                      Typed twice, because nothing else can catch a wrong digit: Indian account numbers
                      carry no check digit, so a slip still "looks right" and the pay goes to a stranger
                      or bounces. Pasting is refused here for that reason — a pasted copy repeats the
                      mistake instead of catching it.
                    */}
                    <div id="reg-bankAccountNumberConfirm">
                      <label htmlFor="reg-bankAccountNumberConfirm-input" style={LABEL_STYLE}>Re-enter account number</label>
                      <input
                        id="reg-bankAccountNumberConfirm-input"
                        value={form.bankAccountNumberConfirm ?? ''}
                        title="Type the account number again, from your passbook"
                        inputMode="numeric"
                        placeholder="Type it again to confirm"
                        onChange={(e) => updateField('bankAccountNumberConfirm', e.target.value.replace(/\D/g, '').slice(0, 18))}
                        onPaste={(e) => {
                          e.preventDefault();
                          setStepErrors((prev) => ({ ...prev, bankAccountNumberConfirm: 'Type it again rather than pasting — that is what catches a wrong digit.' }));
                        }}
                        onBlur={() => {
                          const problem = bankAccountConfirmProblem(form.bankAccountNumber, form.bankAccountNumberConfirm ?? '');
                          setStepErrors((prev) => {
                            const next = { ...prev };
                            if (problem && (form.bankAccountNumberConfirm ?? '').trim()) next.bankAccountNumberConfirm = problem;
                            else delete next.bankAccountNumberConfirm;
                            return next;
                          });
                          if (!problem && form.bankAccountNumber.trim()) {
                            void saveDraft(fieldPatch('bankAccountNumber', form.bankAccountNumber));
                          }
                        }}
                        autoComplete="off"
                        aria-invalid={Boolean(stepErrors.bankAccountNumberConfirm)}
                        className="reg-input"
                        style={{ ...(stepErrors.bankAccountNumberConfirm ? INPUT_ERROR_STYLE : INPUT_STYLE), fontFamily: 'monospace' }}
                      />
                      <FieldError message={stepErrors.bankAccountNumberConfirm} />
                    </div>
                  </div>

                  <div style={{ marginTop: '12px' }}>
                    <label htmlFor="reg-bankName-input" style={LABEL_STYLE}>Bank name</label>
                    {bankLocked && lastResolvedBank.current && form.bankName === lastResolvedBank.current ? (
                      <>
                        <input
                          id="reg-bankName-input"
                          value={form.bankName}
                          readOnly
                          title="Bank name verified from your IFSC code"
                          aria-readonly="true"
                          className="reg-input"
                          style={{ ...INPUT_STYLE, background: 'var(--bg-surface-2)', color: 'var(--text-primary)', fontWeight: 600 }}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                          <span>Verified from IFSC code.</span>
                          <button
                            type="button"
                            onClick={() => setBankLocked(false)}
                            title="Unlock the bank name field and type it yourself"
                            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent)', fontWeight: 600, fontSize: 'var(--text-xs)', textDecoration: 'underline' }}
                          >
                            Edit anyway
                          </button>
                        </div>
                      </>
                    ) : (
                      <input
                        id="reg-bankName-input"
                        value={form.bankName}
                        title="Type your bank name, or enter an IFSC code above to fill it in"
                        placeholder="Enter IFSC code above to auto-populate, or type manually"
                        onChange={(e) => updateField('bankName', e.target.value)}
                        onBlur={commitField('bankName')}
                        autoComplete="off"
                        maxLength={FIELD_LIMITS.bankName}
                        className="reg-input"
                        style={INPUT_STYLE}
                      />
                    )}
                  </div>
                </div>

                {/* Qualification */}
                <div>
                  <div style={{ maxWidth: '400px' }}>
                    <label htmlFor="reg-qualification-input" style={LABEL_STYLE}>Highest education</label>
                    <input
                      id="reg-qualification-input"
                      value={form.qualification}
                      title="Type your highest qualification as on your certificate"
                      placeholder="e.g. B.Com, Graduate, Diploma in Gemology"
                      onChange={(e) => updateField('qualification', e.target.value)}
                      onBlur={commitField('qualification')}
                      autoComplete="off"
                      maxLength={FIELD_LIMITS.qualification}
                      className="reg-input"
                      style={INPUT_STYLE}
                    />
                  </div>
                </div>

                <div style={{ borderTop: '1px solid var(--border-color)', margin: '6px 0' }} />

                {/* Emergency Contact */}
                <div>
                  <div style={{ ...SECTION_TITLE_STYLE, fontSize: 'var(--text-sm)' }}>
                    <Users size={16} style={{ color: 'var(--accent)' }} />
                    <span>Emergency contact</span>
                  </div>
                  <div style={SECTION_NOTE_STYLE}>
                    Family member we can call.
                  </div>
                </div>

                <div style={FIELD_GRID_STYLE}>
                  <div>
                    <label htmlFor="reg-ec-name-input" style={LABEL_STYLE}>Contact person name</label>
                    <input
                      id="reg-ec-name-input"
                      value={form.emergencyContactName}
                      title="Type the name of the person to contact in an emergency"
                      placeholder="e.g. Sunita Sharma"
                      onChange={(e) => updateField('emergencyContactName', e.target.value)}
                      onBlur={commitField('emergencyContactName')}
                      autoComplete="off"
                      maxLength={FIELD_LIMITS.emergencyContactName}
                      className="reg-input"
                      style={INPUT_STYLE}
                    />
                  </div>
                  <div id="reg-emergencyContactPhone">
                    <label htmlFor="reg-emergencyContactPhone-input" style={LABEL_STYLE}>Contact phone number</label>
                    <PhoneInput
                      id="reg-emergencyContactPhone-input"
                      value={form.emergencyContactPhone}
                      title="Type a 10-digit mobile number for your emergency contact"
                      onChange={(v) => updateField('emergencyContactPhone', v)}
                      onBlur={commitField('emergencyContactPhone')}
                      invalid={Boolean(stepErrors.emergencyContactPhone)}
                      describedBy={stepErrors.emergencyContactPhone ? 'reg-emergencyContactPhone-error' : undefined}
                    />
                    <FieldError id="reg-emergencyContactPhone-error" message={stepErrors.emergencyContactPhone} />
                  </div>
                  <div>
                    <label htmlFor="reg-ec-relation" style={LABEL_STYLE}>Relationship</label>
                    <Select
                      value={relationSelectValue}
                      onChange={handleRelationSelect}
                      options={RELATION_OPTIONS}
                      placeholder="Select relation…"
                      aria-label="Relationship"
                      id="reg-ec-relation"
                      clearable
                    />
                    {showRelationOther && (
                      <input
                        value={relationSelectValue === OTHER_SENTINEL ? form.emergencyContactRelation : ''}
                        onChange={(e) => updateField('emergencyContactRelation', e.target.value)}
                        onBlur={commitField('emergencyContactRelation')}
                        placeholder="e.g. Uncle, Neighbor"
                        aria-label="Other relationship"
                        maxLength={FIELD_LIMITS.emergencyContactRelation}
                        className="reg-input"
                        style={{ ...INPUT_STYLE, marginTop: '8px' }}
                      />
                    )}
                  </div>
                  <div id="reg-alternatePhone">
                    <label htmlFor="reg-alternatePhone-input" style={LABEL_STYLE}>Your alternate number <span style={{ fontWeight: 400 }}>(optional)</span></label>
                    <PhoneInput
                      id="reg-alternatePhone-input"
                      value={form.alternatePhone}
                      title="Type a second mobile number where you can be reached (optional)"
                      onChange={(v) => updateField('alternatePhone', v)}
                      onBlur={commitField('alternatePhone')}
                      placeholder="Optional second number"
                      invalid={Boolean(stepErrors.alternatePhone)}
                      describedBy={stepErrors.alternatePhone ? 'reg-alternatePhone-error' : undefined}
                    />
                    <FieldError id="reg-alternatePhone-error" message={stepErrors.alternatePhone} />
                  </div>
                </div>

                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: '10px',
                  flexWrap: 'wrap',
                  marginTop: '6px',
                  paddingTop: '16px',
                  borderTop: '1px solid var(--border-color)',
                }}>
                  <button
                    type="button"
                    onClick={() => goToStep(2)}
                    title="Go back to the experience and address step"
                    className="btn btn-secondary"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '11px 18px', minHeight: '48px' }}
                  >
                    <ArrowLeft size={16} /> Back
                  </button>
                  <PrimaryButton onClick={() => attemptGoToStep(4)} title="Save this step and go to documents">
                    Next
                  </PrimaryButton>
                </div>
              </div>
            )}

            {/* ══════════════════════════════════════════════════════════════════════
                STEP 4: Documents Upload & Final Submission
               ══════════════════════════════════════════════════════════════════════ */}
            {activeStep === 4 && (
              <>
                <div className="pub-reg-card">
                  <div>
                    <div style={SECTION_TITLE_STYLE}>
                      <FileCheck size={18} style={{ color: 'var(--accent)' }} />
                      <span>Documents</span>
                    </div>
                    {/* Format and size are said only when a file breaks them — never up front. */}
                    <div style={{ ...SECTION_NOTE_STYLE, marginTop: '4px' }}>
                      Lay flat, good light, all 4 corners.
                    </div>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {documentsRequested.map((requirement) => {
                      const doc = documents.find((d) => d.requirement === requirement);
                      const files = doc?.filePaths ?? [];
                      const uploaded = files.length > 0;
                      const busy = Boolean(uploading[requirement]) || Boolean(removing[requirement]);
                      const refused = Boolean(uploadRefused[requirement]);
                      const label = ONBOARDING_DOCUMENT_LABELS[requirement as keyof typeof ONBOARDING_DOCUMENT_LABELS] ?? requirement;
                      const isPhoto = requirement === 'PHOTOGRAPH';
                      const conditionalBadge = CONDITIONAL_DOCS.has(requirement)
                        ? (CONDITIONAL_BADGE[requirement] ?? 'Only if it applies to you')
                        : null;
                      const note = DOCUMENT_NOTE[requirement];
                      // Sent back by HR: flagged until a fresh scan lands, with HR's own words.
                      const sentBack = doc?.reviewStatus === 'NEEDS_RESUBMIT';
                      const sentBackMessage = infoRequests.find((i) => i.kind === 'document' && i.key === requirement)?.message
                        ?? doc?.rejectionNote
                        ?? (doc?.rejectionReason
                          ? (DOCUMENT_REJECTION_GUIDANCE[doc.rejectionReason as keyof typeof DOCUMENT_REJECTION_GUIDANCE] ?? null)
                          : null);

                      return (
                        <div
                          key={requirement}
                          id={`doc-req-${requirement}`}
                          style={{
                            border: sentBack || refused
                              ? '1px solid var(--warning)'
                              : uploaded
                                ? '1px solid color-mix(in srgb, var(--success) 45%, var(--border-color))'
                                : '1px dashed var(--border-color)',
                            borderRadius: 'var(--radius-sm, 10px)',
                            padding: '14px 16px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '12px',
                            flexWrap: 'wrap',
                            background: sentBack || refused
                              ? 'color-mix(in srgb, var(--warning) 8%, transparent)'
                              : uploaded ? 'color-mix(in srgb, var(--success) 5%, transparent)' : 'transparent',
                          }}
                        >
                          <div style={{ flex: '1 1 200px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                                {label}
                              </span>
                              {/*
                                Two states only. A required row needs no badge — nearly every row is
                                required, so "Required" on each said nothing. A conditional row says
                                exactly when it applies.
                              */}
                              {conditionalBadge && !uploaded && (
                                <span style={{
                                  fontSize: 'var(--text-3xs)', fontWeight: 700, padding: '2px 8px', borderRadius: '999px',
                                  background: 'var(--bg-surface-2)', color: 'var(--text-secondary)', border: '1px solid var(--border-color)',
                                }}>
                                  {conditionalBadge}
                                </span>
                              )}
                              {uploaded && (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--success)' }}>
                                  <Check size={13} strokeWidth={3} /> Added
                                </span>
                              )}
                            </div>
                            {note && !uploaded && (
                              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>{note}</div>
                            )}
                            {uploaded && (
                              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', paddingTop: '8px' }}>
                                {files.map((filePath, i) => {
                                  const name = files.length > 1 ? `${label} file ${i + 1}` : label;
                                  return (
                                    <DocumentThumb
                                      key={filePath}
                                      filePath={filePath}
                                      name={name}
                                      pages={pdfPages[filePath] ?? null}
                                      load={() => getRegistrationDocumentFileBlob(token, requirement, i)}
                                      onOpen={() => void openDocumentPreview(requirement, files, i)}
                                      onRemove={() => void handleRemoveFile(requirement, i)}
                                      removing={Boolean(removing[requirement])}
                                    />
                                  );
                                })}
                                {previewLoading === requirement && (
                                  <Loader2 size={16} className="spin" style={{ alignSelf: 'center', color: 'var(--accent)' }} />
                                )}
                              </div>
                            )}
                            {uploadErrors[requirement] && (
                              <div role="alert" style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', fontWeight: 600, lineHeight: 1.5 }}>
                                {uploadErrors[requirement]}
                              </div>
                            )}
                            {sentBack && sentBackMessage && (
                              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--warning)', fontWeight: 600, lineHeight: 1.5 }}>
                                {sentBackMessage}
                              </div>
                            )}
                          </div>

                          {/*
                            The camera first. Somebody filling this in on a phone is holding the
                            card; the scanner squares it up and cleans it so the desk can read the
                            number off it. Choosing a file is the small link under it, for anybody
                            with a scan already saved. A multi-page scan arrives as one PDF.
                          */}
                          <ScanOrAttach
                            variant="primary"
                            combinePages
                            documentLabel={label}
                            requirement={requirement}
                            disabled={busy}
                            accept={isPhoto ? SCAN_UPLOAD_IMAGE_ACCEPT : undefined}
                            scanLabel={uploading[requirement] ? 'Uploading…' : refused ? 'Take again' : uploaded ? 'Retake' : 'Take photo'}
                            attachLabel={refused ? 'Choose another file' : 'Choose file'}
                            onFiles={(chosen) => { if (chosen[0]) void handleUpload(requirement, chosen[0], uploaded); }}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="pub-reg-card">
                  {/*
                    WHAT IS STILL MISSING — AND NOTHING ELSE.

                    This was a five-row "pre-flight checklist" with a green tick for everything
                    already done (the agreement row could never be anything but green: the form does
                    not open until it is accepted) and a grey paragraph explaining the button. Only
                    the unmet items are listed now, each with the way to it, and none at all once
                    the application can go.
                  */}
                  {stillNeeded.length > 0 && (
                    <div>
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
                        Still needed:
                      </div>
                      <ul style={{ margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                        {stillNeeded.map((item) => (
                          <li key={item.key} style={{ fontSize: 'var(--text-xs)', color: 'var(--text-primary)', lineHeight: 1.5 }}>
                            <button
                              type="button"
                              onClick={item.go}
                              style={{
                                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                color: 'var(--accent)', textDecoration: 'underline', fontWeight: 600, fontSize: 'var(--text-xs)',
                                textAlign: 'left',
                              }}
                            >
                              {item.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '10px',
                    flexWrap: 'wrap',
                  }}>
                    <button
                      type="button"
                      onClick={() => goToStep(3)}
                      title="Go back to the ID and bank step"
                      className="btn btn-secondary"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '11px 18px', minHeight: '48px' }}
                    >
                      <ArrowLeft size={16} /> Back
                    </button>
                    <PrimaryButton
                      onClick={() => void handleSubmit()}
                      disabled={!canSubmit}
                      busy={submitBusy}
                      title="Send your application to HR"
                      style={{ minWidth: '160px', flex: '1 1 160px', maxWidth: '340px' }}
                    >
                      Submit
                    </PrimaryButton>
                  </div>

                  {submitError && <AlertBanner type="error" message={submitError} onClose={() => setSubmitError(null)} />}
                </div>

                {/*
                  WHAT THEY ALREADY AGREED TO, AND HOW TO UNDO IT — below Submit, one line.

                  The agreement happens before the form opens; what belongs here is the record of it
                  and the way out. The grievance contact stays in sight (the law asks for it); the
                  version and the note about the kept copy fold into a small toggle.
                */}
                <div className="pub-reg-card" style={{ gap: '8px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                    <ShieldCheck size={14} style={{ color: 'var(--success)' }} />
                    <span>You agreed{application.consentAcceptedAt ? ` on ${fmtDate(application.consentAcceptedAt)}` : ''}</span>
                    <span aria-hidden>·</span>
                    <button
                      type="button"
                      onClick={() => void handleWithdraw()}
                      disabled={withdrawing}
                      title="Withdraw your application and delete what you have shared"
                      style={{
                        background: 'none', border: 'none', padding: '2px',
                        color: 'var(--danger)', textDecoration: 'underline',
                        cursor: withdrawing ? 'default' : 'pointer',
                        fontSize: 'var(--text-xs)', fontWeight: 600,
                      }}
                    >
                      {withdrawing ? 'Withdrawing…' : 'Withdraw'}
                    </button>
                  </div>
                  {consentNotice && (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                      Questions about your details: {consentNotice.grievanceContact}
                    </div>
                  )}
                  <details style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                    <summary style={{ cursor: 'pointer' }}>About your agreement</summary>
                    <div style={{ marginTop: '4px', lineHeight: 1.5 }}>
                      {/* The version they ACCEPTED — not whatever the notice reads today. */}
                      {application.consentVersion ? `Version ${application.consentVersion}. ` : ''}
                      A copy of exactly what you read is kept with your application.
                    </div>
                  </details>
                  {consentError && <AlertBanner type="error" message={consentError} onClose={() => setConsentError(null)} />}
                </div>
              </>
            )}
          </main>
        </div>
      </div>

      {confirmDialog}

      {/* Full scan preview modal */}
      <DocumentPreviewModal
        open={previewOpen}
        onClose={handleClosePreview}
        items={previewItems}
        initialIndex={previewIndex}
      />
    </div>
  );
};

export default PublicRegistration;
