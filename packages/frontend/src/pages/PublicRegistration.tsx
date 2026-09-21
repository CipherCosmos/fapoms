import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check, Loader2, Phone, ShieldCheck, Eye, ArrowLeft, CheckCircle2, AlertCircle, User, Briefcase, CreditCard, FileCheck, MapPin, Landmark, GraduationCap, Users, Info, Camera, HelpCircle, Award,
} from 'lucide-react';
import {
  ApplicationStatus, EmploymentCategory, ONBOARDING_DOCUMENT_LABELS,
  uploadSizeProblem, isValidIfsc, normalisePhone, scanMimeType, storedScanFileName,
  inferRegistrationStep, registrationStepProblems, resumableRegistrationStep, REGISTRATION_CONDITIONAL_DOCUMENTS,
  type RegistrationFormField, type RegistrationFormValues, type RegistrationProblem,
} from '@fapoms/shared';
import { Select } from '../components/ui/Select';
import { ScanOrAttach } from '../components/scanner/ScanOrAttach';
import { AlertBanner } from '../components/ui/AlertBanner';
import { userMessage } from '../services/errors';
import { identityFormatHint, normaliseIdentityOnBlur } from '../config/identity-fields';
import {
  STATE_OPTIONS, GENDER_OPTIONS, EXPERIENCE_OPTIONS,
  RELATION_OPTIONS, OTHER_SENTINEL, isOtherValue,
  resolvePincode, pincodeStateConflict, resolveIfsc,
  mobileHint, mobileHelper, normaliseMobile, DOB_MIN, dobMaxToday,
  isSixDigitPin, FIELD_LIMITS,
} from '../config/registration-options';
import {
  hydrateRegistration, requestRegistrationOtp, verifyRegistrationOtp, updateRegistrationDraft,
  checkRegistrationPhoneConflict,
  acceptRegistrationConsent,
  withdrawRegistrationConsent,
  type RegistrationHydrateResult, uploadRegistrationDocument, submitRegistration, isOtpVerificationLost,
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

const EYEBROW_STYLE: React.CSSProperties = {
  fontSize: 'var(--text-2xs)',
  fontWeight: 700,
  letterSpacing: '0.1em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
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
}> = ({ id, value, onChange, onBlur, placeholder, disabled, invalid, describedBy }) => (
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
});

function fieldPatch(key: keyof FormState, value: string): UpdateRegistrationDraftInput {
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

const STATUS_COPY: Partial<Record<ApplicationStatus, (app: RegistrationApplication) => string>> = {
  [ApplicationStatus.PENDING_VALIDATION]: () =>
    'Your application has been successfully submitted and is currently under review by our Operations & Compliance team.',
  [ApplicationStatus.APPROVED]: () =>
    'Congratulations! Your Sumeru Global Appraiser application has been officially approved.',
  [ApplicationStatus.REJECTED]: (app) =>
    `Your application was not approved.${app.reviewNotes ? ` Review note: ${app.reviewNotes}` : ''}`,
  [ApplicationStatus.WITHDRAWN]: () =>
    'You withdrew this application. What you had given us has been deleted, apart from the record '
    + 'that an application was made and withdrawn. If you change your mind, ask the office that '
    + 'invited you for a fresh link.',
};


// PrimaryButton now lives in ./registration/PrimaryButton — the consent screen uses it too.

const WIZARD_STEPS = [
  { id: 1, title: 'Personal & Contact', shortTitle: 'Personal', icon: User, desc: 'Identity & Mobile Verification' },
  { id: 2, title: 'Experience & Address', shortTitle: 'Experience', icon: Briefcase, desc: 'Experience & Pincode Auto-Fill' },
  { id: 3, title: 'Statutory & Bank', shortTitle: 'Bank & ID', icon: CreditCard, desc: 'PAN, Aadhaar & Bank IFSC' },
  { id: 4, title: 'Documents & Submit', shortTitle: 'Documents', icon: FileCheck, desc: 'Scans, Photo & Declaration' },
] as const;

const CONDITIONAL_DOCS = new Set(REGISTRATION_CONDITIONAL_DOCUMENTS);

type StepErrors = Record<string, string>;

const getStepStorageKey = (token: string) => `fapoms_reg_step_${token}`;
const getMaxStepStorageKey = (token: string) => `fapoms_reg_max_${token}`;

const getStoredStep = (token: string): number | null => {
  try {
    if (typeof window !== 'undefined' && window.location?.hash) {
      const match = window.location.hash.match(/step-?([1-4])/i);
      if (match) {
        const s = parseInt(match[1], 10);
        if (s >= 1 && s <= 4) return s;
      }
    }
    if (typeof localStorage !== 'undefined' && token) {
      const raw = localStorage.getItem(getStepStorageKey(token));
      if (raw) {
        const s = parseInt(raw, 10);
        if (s >= 1 && s <= 4) return s;
      }
    }
  } catch {
    // Ignore storage/hash read errors
  }
  return null;
};

const getStoredMaxStep = (token: string, initial: number): number => {
  try {
    if (typeof localStorage !== 'undefined' && token) {
      const raw = localStorage.getItem(getMaxStepStorageKey(token));
      if (raw) {
        const s = parseInt(raw, 10);
        if (s >= 1 && s <= 4) return Math.max(s, initial);
      }
    }
  } catch {
    // Ignore storage errors
  }
  return initial;
};

const saveStepPosition = (token: string, step: number) => {
  try {
    if (typeof localStorage !== 'undefined' && token) {
      localStorage.setItem(getStepStorageKey(token), String(step));
      const currentMax = parseInt(localStorage.getItem(getMaxStepStorageKey(token)) || '1', 10);
      localStorage.setItem(getMaxStepStorageKey(token), String(Math.max(currentMax, step)));
    }
  } catch {
    // Ignore localStorage errors
  }
  try {
    if (typeof window !== 'undefined' && window.history?.replaceState) {
      const currentUrl = new URL(window.location.href);
      currentUrl.hash = `step-${step}`;
      window.history.replaceState(null, '', currentUrl.toString());
    }
  } catch {
    // Ignore history errors
  }
};

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
  if (problem.code === 'outOfRange') return `Enter ${problem.min} for fresher, up to ${problem.max} years.`;
  if (problem.code === 'dateOfBirth') return problem.message;
  return STEP_MESSAGES[field]?.[problem.code] ?? 'Check this answer.';
}

function validateRegistrationStep(step: number, f: FormState): StepErrors {
  const errs: StepErrors = {};
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
  const [form, setForm] = useState<FormState | null>(null);

  const [activeStep, setActiveStep] = useState<number>(() => getStoredStep(token) ?? 1);
  const [maxStepVisited, setMaxStepVisited] = useState<number>(() => getStoredMaxStep(token, getStoredStep(token) ?? 1));
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

  const [consentBusy, setConsentBusy] = useState(false);
  /** The versioned notice the API serves; the form does not exist until it has been accepted. */
  const [consentNotice, setConsentNotice] = useState<RegistrationHydrateResult['consentNotice'] | null>(null);
  const [withdrawing, setWithdrawing] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);

  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [relationOtherOpen, setRelationOtherOpen] = useState(false);

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
      const seeded = seedForm(result.application);
      setForm(seeded);
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

      // Check stored step and draft progress
      const currentStored = getStoredStep(token);
      const inferred = inferRegistrationStep(result.application, result.documents);
      const target = currentStored !== null ? currentStored : inferred;
      const finalStep = resumableRegistrationStep(target, seeded);
      setActiveStep(finalStep);
      setMaxStepVisited((prev) => Math.max(prev, finalStep, inferred));
      saveStepPosition(token, finalStep);

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
    if (!entered) {
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
    saveStepPosition(token, step);
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
    saveStepPosition(token, step);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  useEffect(() => {
    const handleHash = () => {
      const match = window.location.hash.match(/step-?([1-4])/i);
      if (match) {
        const target = parseInt(match[1], 10);
        if (target >= 1 && target <= 4 && target !== activeStep) {
          if (target <= maxStepVisited) {
            goToStep(target);
          }
        }
      }
    };
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, [activeStep, maxStepVisited]);

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

  const handleUpload = async (requirement: string, file: File) => {
    const problem = uploadSizeProblem(file);
    if (problem) {
      setUploadErrors((prev) => ({ ...prev, [requirement]: problem }));
      return;
    }
    setUploadErrors((prev) => ({ ...prev, [requirement]: undefined }));
    setUploading((prev) => ({ ...prev, [requirement]: true }));
    try {
      const row = await uploadRegistrationDocument(token, requirement, file);
      setDocuments((prev) => [...prev.filter((d) => d.requirement !== requirement), row]);
    } catch (err) {
      setUploadErrors((prev) => ({ ...prev, [requirement]: userMessage(err) }));
      onVerificationLost(err);
    } finally {
      setUploading((prev) => ({ ...prev, [requirement]: false }));
    }
  };

  const openDocumentPreview = async (requirement: string, filePaths: string[]) => {
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
      setPreviewIndex(0);
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
   * confirmations is a right in name only.
   */
  const handleWithdraw = async () => {
    const reason = window.prompt(
      'Withdrawing stops your application and deletes what you have given us. '
      + 'You can say why if you want to — it is not required.',
      '',
    );
    if (reason === null) return;
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

  // ── Loading Screen ────────────────────────────────────────────────────────
  if (loadState === 'loading') {
    return (
      <div className="pub-reg-root">
        <style>{FORM_CSS}</style>
        <PublicMasthead />
        <div className="pub-reg-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
          <div className="pub-reg-card" style={{ maxWidth: '440px', width: '100%', textAlign: 'center', padding: '40px 24px' }}>
            <Loader2 size={32} className="spin" style={{ margin: '0 auto 16px', color: 'var(--accent)' }} />
            <div style={{ fontSize: 'var(--text-md)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '6px' }}>
              Opening Your Registration Portal
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
              Verifying your invitation session…
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Error Screen (Invalid / Expired Token) ─────────────────────────────────
  if (loadState === 'error' || !application || !form) {
    return (
      <div className="pub-reg-root">
        <style>{FORM_CSS}</style>
        <PublicMasthead />
        <div className="pub-reg-container" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
          <div className="pub-reg-card" style={{ maxWidth: '520px', width: '100%', borderColor: 'var(--danger)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: 'var(--danger)' }}>
              <AlertCircle size={24} style={{ flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 'var(--text-md)', fontWeight: 700 }}>
                  This Registration Link is Not Valid
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: '2px' }}>
                  Invitation Token Verification Failed
                </div>
              </div>
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
              {loadError || 'This link may have expired, already been completed, or was entered incorrectly.'}
            </div>
            <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px', marginTop: '6px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <div style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)' }}>
                What should you do?
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                Please contact the HR team member or coordinator who invited you to request a new registration link.
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Terminal States (Submitted, Approved, Rejected) ───────────────────────
  const statusMessage = STATUS_COPY[application.status]?.(application);
  if (statusMessage) {
    const isSubmitted = application.status === ApplicationStatus.PENDING_VALIDATION;
    const isApproved = application.status === ApplicationStatus.APPROVED;
    const isRejected = application.status === ApplicationStatus.REJECTED;

    return (
      <div className="pub-reg-root">
        <style>{FORM_CSS}</style>
        <PublicMasthead />
        <div className="pub-reg-container" style={{ maxWidth: '840px' }}>
          <div className="pub-reg-card" style={{
            borderColor: isRejected ? 'var(--danger)' : 'var(--success)',
            padding: '32px 28px',
          }}>
            {/* Status Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
              <div style={{
                width: '54px', height: '54px', borderRadius: '50%',
                background: isRejected ? 'rgba(239,68,68,0.12)' : 'rgba(34,197,94,0.12)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}>
                {isRejected ? (
                  <AlertCircle size={30} style={{ color: 'var(--danger)' }} />
                ) : (
                  <CheckCircle2 size={30} style={{ color: 'var(--success)' }} />
                )}
              </div>
              <div>
                <div style={{
                  fontSize: 'var(--text-xs)',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: isRejected ? 'var(--danger)' : 'var(--success)',
                  marginBottom: '2px',
                }}>
                  {isSubmitted && 'Application Submitted & Under Active Verification'}
                  {isApproved && 'Official Appraiser Empanelment Approved'}
                  {isRejected && 'Application Review Concluded'}
                </div>
                <h1 style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
                  {isSubmitted && `Thank you, ${application.fullName || 'Candidate'}`}
                  {isApproved && `Congratulations, ${application.fullName || 'Appraiser'}`}
                  {isRejected && 'Application Decision Notice'}
                </h1>
              </div>
            </div>

            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6, margin: '8px 0 0' }}>
              {statusMessage}
            </p>

            {/* Candidate Metadata Snapshot */}
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '12px',
              padding: '14px 18px',
              background: 'var(--bg-surface-2)',
              borderRadius: '10px',
              border: '1px solid var(--border-color)',
              marginTop: '12px',
            }}>
              <div>
                <div style={{ fontSize: 'var(--text-3xs)', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  Application Ref
                </div>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                  #APP-{(application.id || '').slice(0, 8).toUpperCase()}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--text-3xs)', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  Verified Mobile
                </div>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)' }}>
                  +91 {application.mobile}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--text-3xs)', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  Employment Category
                </div>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {application.employmentCategory || 'Assayer'}
                </div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--text-3xs)', textTransform: 'uppercase', color: 'var(--text-secondary)', fontWeight: 600 }}>
                  Registered Email
                </div>
                <div style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {application.email || '—'}
                </div>
              </div>
            </div>

            {/* 3-Stage Lifecycle Timeline for Submitted status */}
            {isSubmitted && (
              <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-hair)' }}>
                <div style={{ fontSize: 'var(--text-xs)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: '16px' }}>
                  Next Steps &amp; Review Process
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                    <div style={{ width: '26px', height: '26px', borderRadius: '50%', background: 'var(--success)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--text-2xs)', fontWeight: 700, flexShrink: 0, marginTop: '2px' }}>
                      <Check size={14} strokeWidth={3} />
                    </div>
                    <div>
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Stage 1: Registration Profile Submitted
                      </div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        Your details, statutory IDs, bank information, and uploaded documents have been securely recorded.
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                    <div style={{ width: '26px', height: '26px', borderRadius: '50%', background: 'rgba(245,158,11,0.15)', border: '2px solid #f59e0b', color: '#f59e0b', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--text-2xs)', fontWeight: 700, flexShrink: 0, marginTop: '2px' }}>
                      2
                    </div>
                    <div>
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Stage 2: HR Document Verification (In Progress)
                      </div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        The HR operations team reviews your submitted documents (Aadhaar, PAN, Bank details) for verification.
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start' }}>
                    <div style={{ width: '26px', height: '26px', borderRadius: '50%', background: 'var(--bg-surface-2)', border: '1.5px solid var(--border-color)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 'var(--text-2xs)', fontWeight: 700, flexShrink: 0, marginTop: '2px' }}>
                      3
                    </div>
                    <div>
                      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                        Stage 3: Approval &amp; Roster Activation
                      </div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        Once verified, your profile is approved and activated onto the appraiser roster.
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {isApproved && (
              <div style={{ marginTop: '20px', paddingTop: '20px', borderTop: '1px solid var(--border-hair)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--success)', fontWeight: 600, fontSize: 'var(--text-sm)', marginBottom: '8px' }}>
                  <Award size={18} /> Appraiser Profile Approved &amp; Active
                </div>
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.6 }}>
                  Your application has been approved by the HR team. Your assayer profile is now active on the system.
                  Your operations coordinator will reach out directly regarding field assignments and next steps.
                </p>
              </div>
            )}

            {/* Support Desk Footer */}
            <div style={{ borderTop: '1px solid var(--border-color)', paddingTop: '16px', marginTop: '16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px' }}>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                Need updates or assistance? Reach out to the Sumeru Global HR coordinator who issued your invitation.
              </div>
            </div>
          </div>
        </div>
      </div>
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
        <PublicMasthead />
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
      <PublicMasthead />

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
                        className={`pub-reg-roadmap-item ${isCurrent ? 'is-active' : ''} ${isCompleted ? 'is-completed' : ''}`}
                        aria-current={isCurrent ? 'step' : undefined}
                        style={{ cursor: isClickable ? 'pointer' : 'default' }}
                      >
                        <div className="pub-reg-roadmap-icon">
                          {isCompleted ? <Check size={14} strokeWidth={3} /> : <IconComp size={15} />}
                        </div>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div className={`pub-reg-rail-step-title ${isCurrent ? 'is-active' : ''}`}>{s.title}</div>
                          <div className="pub-reg-rail-step-desc">{s.desc}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* The quiet facts: the reference to quote, and whether their typing is safe. */}
                <div className="pub-reg-rail-foot">
                  <span>Ref #APP-{(application.id || '').slice(0, 8).toUpperCase()}</span>
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
              <AlertBanner type="error">
                <strong>HR requested clarification:</strong> {application.reviewNotes || 'Please review and update your application details.'}
              </AlertBanner>
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
                {/* Contact Verification Box */}
                <div className="pub-reg-card">
                  <div style={SECTION_TITLE_STYLE}>
                    <Phone size={18} style={{ color: 'var(--accent)' }} />
                    <span>Mobile phone verification</span>
                    {otpVerified && (
                      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: 'var(--text-xs)', color: 'var(--success)', fontWeight: 600 }}>
                        <CheckCircle2 size={15} /> Verified
                      </span>
                    )}
                  </div>

                  {!otpVerified ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                        {OTP_BEFORE_SEND_WORDS} Enter your 10-digit mobile number below — it will be recorded on
                        your appraiser profile.
                      </div>
                      <div id="reg-phone">
                        <label htmlFor="reg-phone-input" style={LABEL_STYLE}>Your mobile number *</label>
                        <PhoneInput
                          id="reg-phone-input"
                          value={phone}
                          onChange={(v) => {
                            setPhone(v);
                            if (phoneConflict) setPhoneConflict(null);
                            if (otpError) setOtpError(null);
                          }}
                          onBlur={() => {
                            const n = currentPhone();
                            if (n !== phone) setPhone(n);
                            if (n.trim()) {
                              void (async () => {
                                const norm = normalisePhone(n);
                                if (norm && await checkPhoneConflictFn(norm)) return;
                                void saveDraft({ mobile: n.trim() });
                              })();
                            }
                          }}
                          disabled={otpBusy}
                          invalid={Boolean(mobileHint(phone)) || Boolean(phoneConflict)}
                          describedBy="reg-phone-hint"
                        />
                        <div id="reg-phone-hint" style={HINT_STYLE}>
                          {checkingPhone ? (
                            <span style={{ color: 'var(--primary)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                              <Loader2 size={12} className="animate-spin" /> Checking availability…
                            </span>
                          ) : (
                            mobileHint(phone) ?? mobileHelper(phone)
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
                        >
                          {otpCooldown > 0 ? `Send verification code (${otpCooldown}s)` : 'Send verification code'}
                        </PrimaryButton>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                          {otpSentTo && (
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                              Code sent for <strong style={{ color: 'var(--text-primary)' }}>+91 {otpSentTo}</strong>
                              {currentPhone() !== otpSentTo && ' — you edited the number since; resend for the new one.'}
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
                          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                            <div style={{ flex: '1 1 160px' }}>
                              <PrimaryButton onClick={() => void handleVerifyCode()} busy={otpBusy}>
                                Verify code
                              </PrimaryButton>
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleSendCode()}
                              disabled={otpBusy || checkingPhone || Boolean(phoneConflict) || otpCooldown > 0}
                              className="btn btn-secondary"
                              style={{
                                flex: '1 1 140px',
                                padding: '10px 16px',
                                minHeight: '48px',
                                fontSize: 'var(--text-sm)',
                                cursor: otpCooldown > 0 || otpBusy ? 'not-allowed' : 'pointer',
                                opacity: otpCooldown > 0 ? 0.6 : 1,
                              }}
                            >
                              {otpCooldown > 0 ? `Resend code (${otpCooldown}s)` : 'Resend code'}
                            </button>
                          </div>
                        </div>
                      )}
                      {otpInfo && <div style={{ fontSize: 'var(--text-xs)', color: 'var(--success)' }}>{otpInfo}</div>}
                      {otpError && <AlertBanner type="error" message={otpError} onClose={() => setOtpError(null)} />}
                    </div>
                  ) : (
                    <div style={{
                      padding: '14px 16px', borderRadius: '8px',
                      background: 'color-mix(in srgb, var(--success) 10%, transparent)',
                      border: '1px solid var(--success)',
                      fontSize: 'var(--text-sm)', color: 'var(--success)', display: 'flex', alignItems: 'center', gap: '10px',
                    }}>
                      <CheckCircle2 size={18} style={{ flexShrink: 0 }} />
                      <span><strong>+91 {phone}</strong> is confirmed and verified for this application.</span>
                    </div>
                  )}
                </div>

                {/* Personal Profile Details */}
                <div className="pub-reg-card">
                  <div style={EYEBROW_STYLE}>Personal details</div>
                  <div style={SECTION_TITLE_STYLE}>
                    <User size={18} style={{ color: 'var(--accent)' }} />
                    <span>Identity details</span>
                  </div>
                  <div style={SECTION_NOTE_STYLE}>
                    Enter your name exactly as stated on your Aadhaar or PAN card — our verification team compares it letter-for-letter with your official documents.
                  </div>

                  <div style={FIELD_GRID_STYLE}>
                    <div id="reg-fullName">
                      <label htmlFor="reg-fullName-input" style={LABEL_STYLE}>Full name (as on official ID) *</label>
                      <input
                        id="reg-fullName-input"
                        value={form.fullName}
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
                      <label htmlFor="reg-dateOfBirth-input" style={LABEL_STYLE}>Date of birth</label>
                      <input
                        id="reg-dateOfBirth-input"
                        type="date"
                        value={form.dateOfBirth}
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
                      {savingDraft ? 'Saving…' : draftSaved ? <span style={{ color: 'var(--success)' }}>✓ Saved automatically</span> : 'Progress saves automatically'}
                    </div>
                    <PrimaryButton onClick={() => attemptGoToStep(2)}>
                      Continue to Experience &amp; Address &rarr;
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
                    Type your 6-digit pincode first — our postal directory will automatically look up your district, city, and state.
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
                    className="btn btn-secondary"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '11px 18px', minHeight: '48px' }}
                  >
                    <ArrowLeft size={16} /> Back
                  </button>
                  <PrimaryButton onClick={() => attemptGoToStep(3)}>
                    Continue to Statutory &amp; Bank &rarr;
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
                  <span>Statutory compliance &amp; payout details</span>
                </div>
                <div style={SECTION_NOTE_STYLE}>
                  Required for direct audit payouts and account verification. Please verify details carefully.
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
                    <span>Statutory identity numbers</span>
                  </div>
                  <div style={FIELD_GRID_STYLE}>
                    <div id="reg-panNumber">
                      <label htmlFor="reg-panNumber-input" style={LABEL_STYLE}>PAN number</label>
                      <input
                        id="reg-panNumber-input"
                        value={form.panNumber}
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
                    <span>Bank account for payout settlements</span>
                  </div>
                  <div style={SECTION_NOTE_STYLE}>
                    Enter your IFSC code first — our database will verify and auto-populate your bank name.
                  </div>
                  <div style={FIELD_GRID_STYLE}>
                    <div id="reg-bankAccountNumber">
                      <label htmlFor="reg-bankAccountNumber-input" style={LABEL_STYLE}>Bank account number</label>
                      <input
                        id="reg-bankAccountNumber-input"
                        value={form.bankAccountNumber}
                        inputMode="numeric"
                        placeholder="9–18 digit account number"
                        onChange={(e) => updateField('bankAccountNumber', e.target.value.replace(/\D/g, '').slice(0, 18))}
                        onBlur={commitField('bankAccountNumber')}
                        autoComplete="off"
                        aria-invalid={Boolean(stepErrors.bankAccountNumber)}
                        className="reg-input"
                        style={{ ...(stepErrors.bankAccountNumber ? INPUT_ERROR_STYLE : INPUT_STYLE), fontFamily: 'monospace' }}
                      />
                      <FieldError message={stepErrors.bankAccountNumber} />
                    </div>
                    <div id="reg-ifscCode">
                      <label htmlFor="reg-ifscCode-input" style={LABEL_STYLE}>Bank IFSC code</label>
                      <input
                        id="reg-ifscCode-input"
                        value={form.ifscCode}
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
                          <div style={HINT_STYLE}><Loader2 size={11} className="spin" style={{ display: 'inline', verticalAlign: '-1px' }} /> Verifying IFSC with RBI directory…</div>
                        )}
                        {ifscState !== 'looking' && ifscNote && (
                          <div style={ifscState === 'notfound' ? { ...HINT_STYLE, color: 'var(--warning)' } : AUTO_NOTE_STYLE}>
                            <Info size={12} style={{ flexShrink: 0, marginTop: '1px' }} />
                            <span>{ifscNote}</span>
                          </div>
                        )}
                      </div>
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
                          aria-readonly="true"
                          className="reg-input"
                          style={{ ...INPUT_STYLE, background: 'var(--bg-surface-2)', color: 'var(--text-primary)', fontWeight: 600 }}
                        />
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                          <span>Verified from IFSC code.</span>
                          <button
                            type="button"
                            onClick={() => setBankLocked(false)}
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
                  <div style={{ ...SECTION_TITLE_STYLE, fontSize: 'var(--text-sm)' }}>
                    <GraduationCap size={16} style={{ color: 'var(--accent)' }} />
                    <span>Educational qualification</span>
                  </div>
                  <div style={{ maxWidth: '400px' }}>
                    <label htmlFor="reg-qualification-input" style={LABEL_STYLE}>Highest academic / professional qualification</label>
                    <input
                      id="reg-qualification-input"
                      value={form.qualification}
                      placeholder="e.g. B.Com, Graduate, Diploma in Gemology"
                      onChange={(e) => updateField('qualification', e.target.value)}
                      onBlur={commitField('qualification')}
                      autoComplete="off"
                      maxLength={FIELD_LIMITS.qualification}
                      className="reg-input"
                      style={INPUT_STYLE}
                    />
                    <div style={HINT_STYLE}>As stated on your graduation or diploma certificate.</div>
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
                    Required for field audit safety protocols. Please provide a family member or primary contact.
                  </div>
                </div>

                <div style={FIELD_GRID_STYLE}>
                  <div>
                    <label htmlFor="reg-ec-name-input" style={LABEL_STYLE}>Contact person name</label>
                    <input
                      id="reg-ec-name-input"
                      value={form.emergencyContactName}
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
                    className="btn btn-secondary"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '11px 18px', minHeight: '48px' }}
                  >
                    <ArrowLeft size={16} /> Back
                  </button>
                  <PrimaryButton onClick={() => attemptGoToStep(4)}>
                    Continue to Documents & Submit &rarr;
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
                  <div style={EYEBROW_STYLE}>
                    {form.employmentCategory === EmploymentCategory.PROPRIETOR ? 'Proprietor documents' : form.employmentCategory === EmploymentCategory.FREELANCER ? 'Freelancer documents' : 'Documents'}
                  </div>
                  <div style={SECTION_TITLE_STYLE}>
                    <FileCheck size={18} style={{ color: 'var(--accent)' }} />
                    <span>Required document attachments</span>
                  </div>
                  <div style={SECTION_NOTE_STYLE}>
                    Photograph documents flat in good lighting with all four corners visible. Accepted formats: JPG, PNG or PDF (up to 10MB per file).
                    Click "Check scan" after attaching to verify clarity.
                  </div>

                  {/* VIP ID Photo Banner */}
                  <div className="pub-reg-photo-banner" style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                    <div style={{
                      width: '42px', height: '42px', borderRadius: '8px',
                      background: 'linear-gradient(135deg, var(--accent) 0%, #d97706 100%)',
                      color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      <Camera size={22} />
                    </div>
                    <div>
                      <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-primary)' }}>
                        Photograph for Appraiser ID Card
                      </div>
                      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-secondary)', marginTop: '2px', lineHeight: 1.4 }}>
                        Your uploaded photograph will be printed on your official Appraiser ID Card upon onboarding approval. Please ensure a clear, front-facing passport-style photo.
                      </div>
                    </div>
                  </div>

                  {/* Document upload items list */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {documentsRequested.map((requirement) => {
                      const doc = documents.find((d) => d.requirement === requirement);
                      const uploaded = Boolean(doc && doc.filePaths.length > 0);
                      const busy = Boolean(uploading[requirement]);
                      const isInspecting = previewLoading === requirement;
                      const label = ONBOARDING_DOCUMENT_LABELS[requirement as keyof typeof ONBOARDING_DOCUMENT_LABELS] ?? requirement;
                      const isPhoto = requirement === 'PHOTOGRAPH';
                      const isConditional = CONDITIONAL_DOCS.has(requirement);

                      return (
                        <div
                          key={requirement}
                          id={`doc-req-${requirement}`}
                          style={{
                            border: uploaded
                              ? '1px solid color-mix(in srgb, var(--success) 45%, var(--border-color))'
                              : isPhoto ? '1px solid var(--accent)' : '1px dashed var(--border-color)',
                            borderRadius: 'var(--radius-sm, 10px)',
                            padding: '14px 16px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '12px',
                            flexWrap: 'wrap',
                            background: uploaded ? 'color-mix(in srgb, var(--success) 5%, transparent)' : 'transparent',
                          }}
                        >
                          <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
                                {label}
                              </span>
                              <span style={{
                                fontSize: 'var(--text-3xs)',
                                fontWeight: 700,
                                padding: '2px 8px',
                                borderRadius: '999px',
                                background: isPhoto
                                  ? 'var(--accent)'
                                  : isConditional ? 'var(--bg-surface-2)' : 'color-mix(in srgb, var(--accent) 14%, transparent)',
                                color: isPhoto ? '#fff' : isConditional ? 'var(--text-secondary)' : 'var(--accent)',
                                border: isConditional ? '1px solid var(--border-color)' : 'none',
                              }}>
                                {isPhoto ? 'Mandatory for ID Card' : isConditional ? 'If applicable' : 'Required'}
                              </span>
                            </div>
                            <div style={{ fontSize: 'var(--text-xs)', color: uploaded ? 'var(--success)' : 'var(--text-secondary)', marginTop: '4px' }}>
                              {uploaded ? (
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                                  <Check size={12} strokeWidth={3} /> Uploaded &amp; attached ({doc!.filePaths.length} file{doc!.filePaths.length === 1 ? '' : 's'})
                                </span>
                              ) : isPhoto ? (
                                'Required for your Appraiser ID Card — clear face portrait'
                              ) : isConditional ? (
                                requirement === 'RENT_AGREEMENT' ? 'Required only if residential address differs from Aadhaar' : 'Required if shop premises are rented'
                              ) : (
                                'Pending attachment'
                              )}
                            </div>
                            {uploadErrors[requirement] && (
                              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--danger)', marginTop: '4px' }}>
                                {uploadErrors[requirement]}
                              </div>
                            )}
                          </div>

                          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                            {uploaded && (
                              <button
                                type="button"
                                onClick={() => void openDocumentPreview(requirement, doc!.filePaths)}
                                disabled={isInspecting}
                                className="btn btn-secondary"
                                style={{
                                  fontSize: 'var(--text-xs)',
                                  padding: '9px 12px',
                                  minHeight: '42px',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '6px',
                                }}
                                title="Open scan to inspect visual clarity"
                              >
                                <Eye size={14} />
                                {isInspecting ? 'Loading…' : 'Check scan'}
                              </button>
                            )}

                            {/*
                              The camera, not just a file picker. A candidate filling this in on a
                              phone is holding the card; the scanner squares it up and cleans it so
                              the desk can read the number off it, instead of receiving a four-
                              megabyte photograph of a card lying on a table at an angle. Choosing
                              a file is still right here beside it, for anybody on a laptop with a
                              scan already saved.
                            */}
                            <ScanOrAttach
                              documentLabel={label}
                              requirement={requirement}
                              disabled={busy}
                              attachLabel={busy ? 'Uploading…' : uploaded ? 'Replace file' : 'Choose file'}
                              onFiles={(files) => { if (files[0]) void handleUpload(requirement, files[0]); }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/*
                  WHAT THEY ALREADY AGREED TO, AND HOW TO UNDO IT.

                  This used to be the tick-box itself, sitting beside Submit after every answer had
                  been collected. The agreement now happens before the form opens, so what belongs
                  here is the record of it — and the way out, which is the half that never existed.
                */}
                <div className="pub-reg-card">
                  <div style={SECTION_TITLE_STYLE}>
                    <ShieldCheck size={18} style={{ color: 'var(--accent)' }} />
                    <span>Your agreement</span>
                  </div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.55 }}>
                    You agreed to the notice
                    {application.consentAcceptedAt ? ` on ${new Date(application.consentAcceptedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}` : ''}
                    {consentNotice ? ` (version ${consentNotice.version})` : ''}. A copy of exactly what you
                    read is kept with your application.
                  </div>
                  {consentNotice && (
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                      Questions about your details: {consentNotice.grievanceContact}
                    </div>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--success)', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                      <ShieldCheck size={15} /> Agreed
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleWithdraw()}
                      disabled={withdrawing}
                      style={{
                        background: 'none', border: 'none', padding: '2px',
                        color: 'var(--danger)', textDecoration: 'underline',
                        cursor: withdrawing ? 'default' : 'pointer',
                        fontSize: 'var(--text-xs)', fontWeight: 600,
                      }}
                    >
                      {withdrawing ? 'Withdrawing…' : 'Withdraw and delete what I have given'}
                    </button>
                  </div>
                  {consentError && <AlertBanner type="error" message={consentError} onClose={() => setConsentError(null)} />}
                </div>

                {/* Submission Requirements Summary Checklist */}
                <div className="pub-reg-card">
                  <div style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '4px' }}>
                    Final Submission Pre-Flight Checklist
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: 'var(--text-xs)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: otpVerified ? 'var(--success)' : 'var(--warning)' }}>
                      {otpVerified ? <Check size={15} strokeWidth={3} /> : <AlertCircle size={15} />}
                      <span>
                        Mobile number verified (+91 {phone})
                        {!otpVerified && (
                          <button
                            type="button"
                            onClick={() => goToStep(1)}
                            style={{ marginLeft: '8px', color: 'var(--accent)', background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer', padding: '2px', fontWeight: 600, fontSize: 'var(--text-xs)' }}
                          >
                            Verify in Step 1 &rarr;
                          </button>
                        )}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: form.fullName.trim() ? 'var(--success)' : 'var(--warning)' }}>
                      {form.fullName.trim() ? <Check size={15} strokeWidth={3} /> : <AlertCircle size={15} />}
                      <span>
                        Candidate legal name entered
                        {!form.fullName.trim() && (
                          <button
                            type="button"
                            onClick={() => goToStep(1)}
                            style={{ marginLeft: '8px', color: 'var(--accent)', background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer', padding: '2px', fontWeight: 600, fontSize: 'var(--text-xs)' }}
                          >
                            Enter in Step 1 &rarr;
                          </button>
                        )}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: form.employmentCategory ? 'var(--success)' : 'var(--warning)' }}>
                      {form.employmentCategory ? <Check size={15} strokeWidth={3} /> : <AlertCircle size={15} />}
                      <span>
                        Practice category chosen ({form.employmentCategory || 'Freelancer / Proprietor'})
                        {!form.employmentCategory && (
                          <button
                            type="button"
                            onClick={() => goToStep(3)}
                            style={{ marginLeft: '8px', color: 'var(--accent)', background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer', padding: '2px', fontWeight: 600, fontSize: 'var(--text-xs)' }}
                          >
                            Select in Step 3 &rarr;
                          </button>
                        )}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: hasPhotograph ? 'var(--success)' : 'var(--warning)' }}>
                      {hasPhotograph ? <Check size={15} strokeWidth={3} /> : <AlertCircle size={15} />}
                      <span>
                        ID Card photograph uploaded
                        {!hasPhotograph && (
                          <button
                            type="button"
                            onClick={() => {
                              const el = document.getElementById('doc-req-PHOTOGRAPH');
                              if (el) {
                                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                              } else {
                                window.scrollTo({ top: 120, behavior: 'smooth' });
                              }
                            }}
                            style={{ marginLeft: '8px', color: 'var(--accent)', background: 'none', border: 'none', textDecoration: 'underline', cursor: 'pointer', padding: '2px', fontWeight: 600, fontSize: 'var(--text-xs)' }}
                          >
                            Upload photo above &uarr;
                          </button>
                        )}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: consentAccepted ? 'var(--success)' : 'var(--warning)' }}>
                      {consentAccepted ? <Check size={15} strokeWidth={3} /> : <AlertCircle size={15} />}
                      <span>Declaration &amp; consent acknowledged</span>
                    </div>
                  </div>

                  {!canSubmit && (
                    <div style={{ marginTop: '12px', padding: '12px 14px', background: 'var(--bg-surface-2)', borderRadius: '8px', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.5, border: '1px solid var(--border-hair)' }}>
                      The Submit button will activate once all items above show a green checkmark. You can review and edit previous steps before submitting.
                    </div>
                  )}

                  <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '10px',
                    flexWrap: 'wrap',
                    marginTop: '16px',
                    paddingTop: '16px',
                    borderTop: '1px solid var(--border-color)',
                  }}>
                    <button
                      type="button"
                      onClick={() => goToStep(3)}
                      className="btn btn-secondary"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '11px 18px', minHeight: '48px' }}
                    >
                      <ArrowLeft size={16} /> Back
                    </button>
                    <PrimaryButton
                      onClick={() => void handleSubmit()}
                      disabled={!canSubmit}
                      busy={submitBusy}
                      style={{ minWidth: '220px', flex: '1 1 220px', maxWidth: '340px' }}
                    >
                      Submit application for HR review
                    </PrimaryButton>
                  </div>

                  {submitError && <AlertBanner type="error" message={submitError} onClose={() => setSubmitError(null)} />}
                </div>
              </>
            )}
          </main>
        </div>
      </div>

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
