import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Paperclip, Phone, ShieldCheck } from 'lucide-react';
import {
  ApplicationStatus, EmploymentCategory, ONBOARDING_DOCUMENT_LABELS,
  SCAN_UPLOAD_ACCEPT, uploadSizeProblem,
} from '@fapoms/shared';
import { Select } from '../components/ui/Select';
import { AlertBanner } from '../components/ui/AlertBanner';
import { userMessage } from '../services/errors';
import {
  hydrateRegistration, requestRegistrationOtp, verifyRegistrationOtp, updateRegistrationDraft,
  acceptRegistrationConsent, uploadRegistrationDocument, submitRegistration, isOtpVerificationLost,
  type RegistrationApplication, type RegistrationApplicationDocument, type UpdateRegistrationDraftInput,
} from '../services/public-registration';

/**
 * Appraiser self-registration — public, reachable by the emailed invite link alone.
 *
 * A candidate who passed an interview gets `https://<app>/register/<token>` and opens it from
 * whatever device is in their hand, with no app and no account: verify a mobile number by OTP,
 * fill in a profile, attach a few scans, tick a consent box, submit for HR review. Everything this
 * page calls lives under `/public/registration/:token/...` and carries no auth of any kind besides
 * that token — see `services/public-registration.ts` for why it does not go through the app's
 * normal `ApiClient`.
 *
 * Mounted by `App.tsx` in the same early-return branch `/view-mark` uses, above the sign-in gate:
 * this component must render correctly with no token in `localStorage` at all. The consent version
 * is a single literal here rather than a setting — Draft/AwaitingInfo is the only editable window
 * this exists for, and there is exactly one version of the declaration in force.
 */
const CONSENT_VERSION = 'v1';

const CONTAINER_STYLE: React.CSSProperties = {
  minHeight: '100vh',
  background: 'var(--bg-page)',
  color: 'var(--text-primary)',
  padding: '20px 16px 48px',
};

const CARD_STYLE: React.CSSProperties = {
  maxWidth: '560px',
  margin: '0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: '20px',
};

const SECTION_STYLE: React.CSSProperties = {
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-md)',
  background: 'var(--bg-card)',
  padding: '16px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
};

const SECTION_TITLE_STYLE: React.CSSProperties = {
  fontSize: '15px',
  fontWeight: 700,
  color: 'var(--text-primary)',
};

const SECTION_NOTE_STYLE: React.CSSProperties = {
  fontSize: '12.5px',
  color: 'var(--text-muted)',
  lineHeight: 1.5,
};

const LABEL_STYLE: React.CSSProperties = {
  display: 'block',
  fontSize: '12px',
  fontWeight: 600,
  color: 'var(--text-secondary)',
  marginBottom: '4px',
};

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  fontSize: '15px',
  fontFamily: 'inherit',
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--radius-sm)',
  outline: 'none',
  boxSizing: 'border-box',
};

const FIELD_GRID_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: '12px',
};

interface FormState {
  fullName: string;
  dateOfBirth: string;
  gender: string;
  address: string;
  state: string;
  city: string;
  pincode: string;
  experienceYears: string;
  currentEmployer: string;
  expertise: string;
  availability: string;
  employmentCategory: EmploymentCategory | '';
  /**
   * The half the candidate's form never asked for.
   *
   * A person approved without these reached the roster unable to be paid (no account, no IFSC),
   * unreachable in an emergency, and with no PAN to deduct tax against — while the form had
   * cheerfully collected a photograph of the PAN card. The scan proves the number; it is not the
   * number, and nothing downstream can read it.
   */
  panNumber: string;
  aadhaarNumber: string;
  bankAccountNumber: string;
  ifscCode: string;
  bankName: string;
  qualification: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  emergencyContactRelation: string;
}

/**
 * The record-shaped half of the form, by the record's own field names.
 *
 * Exported for `PublicRegistration.spec.ts`, which fails if this stops covering a field the record
 * dictionary calls critical — the guard against the candidate form quietly collecting less than
 * the person needs, which is exactly how it came to ask for a photograph of a PAN card and never
 * for the number.
 */
export const RECORD_KEYS = [
  'panNumber', 'aadhaarNumber', 'bankAccountNumber', 'ifscCode', 'bankName',
  'qualification', 'emergencyContactName', 'emergencyContactPhone', 'emergencyContactRelation',
] as const;

const seedForm = (app: RegistrationApplication): FormState => ({
  fullName: app.fullName ?? '',
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

/**
 * One box, one request.
 *
 * `buildDraftPatch` serialised the whole form on every blur and dropped every empty box, which
 * cost three different things: overlapping saves overwrote each other with stale values, a
 * candidate could not clear a field they had mistyped, and one invalid value made every later
 * save fail with a complaint about a box they were no longer looking at.
 *
 * A blank IS sent. The server treats it as "clear this" and says so in as many words.
 */
function fieldPatch(key: keyof FormState, value: string): UpdateRegistrationDraftInput {
  const trimmed = (value ?? '').trim();

  if (key === 'experienceYears') {
    if (trimmed === '') return {};
    const years = Number(trimmed);
    return Number.isNaN(years) ? {} : { experienceYears: years };
  }
  // The server enumerates what it will accept; anything else is refused rather than guessed at.
  if (key === 'employmentCategory') {
    return trimmed ? { employmentCategory: trimmed as EmploymentCategory } : {};
  }
  if ((RECORD_KEYS as readonly string[]).includes(key as string)) {
    return { record: { [key]: trimmed } };
  }
  return { [key]: trimmed } as UpdateRegistrationDraftInput;
}

/** Every box at once, for the explicit "Save draft" button. */
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

const GENDER_OPTIONS = [
  { value: 'Male', label: 'Male' },
  { value: 'Female', label: 'Female' },
  { value: 'Other', label: 'Other' },
  { value: 'Prefer not to say', label: 'Prefer not to say' },
];

const EMPLOYMENT_CATEGORY_OPTIONS = [
  { value: EmploymentCategory.FREELANCER, label: 'Freelancer' },
  { value: EmploymentCategory.PROPRIETOR, label: 'Proprietor' },
];

const STATUS_COPY: Partial<Record<ApplicationStatus, (app: RegistrationApplication) => string>> = {
  [ApplicationStatus.PENDING_VALIDATION]: () =>
    'Submitted. Your application is under review — HR will get back to you.',
  [ApplicationStatus.APPROVED]: () =>
    'Your application was approved — HR will contact you about next steps.',
  [ApplicationStatus.REJECTED]: (app) =>
    `Your application was not approved.${app.reviewNotes ? ` ${app.reviewNotes}` : ''}`,
};

/** A full-width primary button, matching the app's own `.btn`/`.btn-primary` classes. */
const PrimaryButton: React.FC<{
  onClick: () => void;
  disabled?: boolean;
  busy?: boolean;
  children: React.ReactNode;
}> = ({ onClick, disabled, busy, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled || busy}
    className="btn btn-primary"
    style={{ width: '100%', padding: '11px 16px', fontSize: '14px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
  >
    {busy && <Loader2 size={15} className="spin" />}
    {children}
  </button>
);

export const PublicRegistration: React.FC<{ token: string }> = ({ token }) => {
  const [loadState, setLoadState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [application, setApplication] = useState<RegistrationApplication | null>(null);
  const [documents, setDocuments] = useState<RegistrationApplicationDocument[]>([]);
  const [documentsRequested, setDocumentsRequested] = useState<string[]>([]);
  const [form, setForm] = useState<FormState | null>(null);

  const [phone, setPhone] = useState('');
  const [otpVerified, setOtpVerified] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');
  const [otpBusy, setOtpBusy] = useState(false);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpInfo, setOtpInfo] = useState<string | null>(null);

  const [savingDraft, setSavingDraft] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftSaved, setDraftSaved] = useState(false);

  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const [uploadErrors, setUploadErrors] = useState<Record<string, string | undefined>>({});

  const [consentBusy, setConsentBusy] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);

  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const onVerificationLost = useCallback((err: unknown) => {
    if (isOtpVerificationLost(err)) {
      setOtpVerified(false);
      setCodeSent(false);
      setOtpError('Your verification has expired. Request a new code to continue.');
    }
  }, []);

  const load = useCallback(async () => {
    setLoadState('loading');
    setLoadError(null);
    try {
      const result = await hydrateRegistration(token);
      setApplication(result.application);
      setDocuments(result.documents);
      setDocumentsRequested(result.documentsRequested);
      setForm(seedForm(result.application));
      setPhone(result.application.mobile ?? '');
      setLoadState('loaded');
    } catch (err) {
      setLoadError(userMessage(err));
      setLoadState('error');
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  /** Re-reads only the requested-documents checklist and status, without disturbing unsaved typing. */
  const refreshDocumentChecklist = useCallback(async () => {
    try {
      const result = await hydrateRegistration(token);
      setDocumentsRequested(result.documentsRequested);
      setDocuments(result.documents);
      setApplication((prev) => (prev ? { ...prev, ...result.application } : result.application));
    } catch {
      // Non-fatal — the checklist just stays as it was until the next successful reload.
    }
  }, [token]);

  const handleSendCode = async () => {
    setOtpError(null);
    setOtpInfo(null);
    const trimmed = phone.trim();
    if (trimmed.length < 6) {
      setOtpError('Enter a valid mobile number.');
      return;
    }
    setOtpBusy(true);
    try {
      await requestRegistrationOtp(token, trimmed);
      setCodeSent(true);
      setOtpInfo(`A verification code has been emailed to ${application?.email ?? 'your email address'}.`);
    } catch (err) {
      setOtpError(userMessage(err));
    } finally {
      setOtpBusy(false);
    }
  };

  const handleVerifyCode = async () => {
    setOtpError(null);
    const trimmed = phone.trim();
    if (!code.trim()) {
      setOtpError('Enter the code you received.');
      return;
    }
    setOtpBusy(true);
    try {
      await verifyRegistrationOtp(token, trimmed, code.trim());
      setOtpVerified(true);
      setOtpInfo(null);
    } catch (err) {
      setOtpError(userMessage(err));
    } finally {
      setOtpBusy(false);
    }
  };

  const saveDraft = async (patch: UpdateRegistrationDraftInput) => {
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
  };

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
    setDraftSaved(false);
  };

  /**
   * One field per blur, and a blank is a real answer.
   *
   * This sent the WHOLE form on every blur, which is the race the phone form documents fixing:
   * two overlapping saves, the wider one carrying an empty box, and the narrower one's value
   * overwritten a few milliseconds after it landed. It also dropped blanks — so a candidate who
   * mistyped their PAN and then cleared the box kept the wrong PAN on the server, under a "Saved"
   * tick, while the server has always been willing to clear it. And because one bad value went
   * out with every subsequent save, a single mistyped PAN made saving the BANK NAME fail with a
   * complaint about the PAN.
   */
  const commitField = (key: keyof FormState) => () => {
    if (!form) return;
    void saveDraft(fieldPatch(key, form[key]));
  };

  const handleEmploymentCategoryChange = async (value: string) => {
    if (!form) return;
    const next: FormState = { ...form, employmentCategory: (value as EmploymentCategory) || '' };
    setForm(next);
    setSavingDraft(true);
    setDraftError(null);
    try {
      const saved = await updateRegistrationDraft(token, fieldPatch('employmentCategory', value));
      setApplication(saved);
      setDraftSaved(true);
      await refreshDocumentChecklist();
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

  const handleConsentToggle = async (checked: boolean) => {
    if (!checked || application?.consentAcceptedAt) return;
    setConsentBusy(true);
    setConsentError(null);
    try {
      const saved = await acceptRegistrationConsent(token, CONSENT_VERSION);
      setApplication(saved);
    } catch (err) {
      setConsentError(userMessage(err));
      onVerificationLost(err);
    } finally {
      setConsentBusy(false);
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
  const canSubmit = useMemo(
    () => Boolean(form?.fullName.trim()) && Boolean(form?.employmentCategory) && consentAccepted
      && otpVerified,
    [form, consentAccepted, otpVerified],
  );

  if (loadState === 'loading') {
    return (
      <div style={CONTAINER_STYLE}>
        <div style={{ ...CARD_STYLE, textAlign: 'center', paddingTop: '80px', color: 'var(--text-muted)' }}>
          Opening your registration…
        </div>
      </div>
    );
  }

  if (loadState === 'error' || !application || !form) {
    return (
      <div style={CONTAINER_STYLE}>
        <div style={CARD_STYLE}>
          <div style={{ ...SECTION_STYLE, borderColor: 'var(--danger)' }}>
            <div style={SECTION_TITLE_STYLE}>This link is not valid</div>
            <div style={{ fontSize: '13.5px', color: 'var(--text-secondary)' }}>
              {loadError || 'Ask HR to resend your registration link.'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const statusMessage = STATUS_COPY[application.status]?.(application);
  if (statusMessage) {
    return (
      <div style={CONTAINER_STYLE}>
        <div style={CARD_STYLE}>
          <div style={{
            ...SECTION_STYLE,
            borderColor: application.status === ApplicationStatus.REJECTED ? 'var(--danger)' : 'var(--success)',
          }}>
            <div style={{
              ...SECTION_TITLE_STYLE,
              color: application.status === ApplicationStatus.REJECTED ? 'var(--danger)' : 'var(--success)',
            }}>
              {application.status === ApplicationStatus.PENDING_VALIDATION && 'Application submitted'}
              {application.status === ApplicationStatus.APPROVED && 'Application approved'}
              {application.status === ApplicationStatus.REJECTED && 'Application not approved'}
            </div>
            <div style={{ fontSize: '13.5px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {statusMessage}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={CONTAINER_STYLE}>
      <div style={CARD_STYLE}>
        <div>
          <div style={{ fontSize: '19px', fontWeight: 700 }}>Appraiser registration</div>
          <div style={{ fontSize: '13px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.5 }}>
            Confirm your email with the code we send, then fill in your details and attach your documents. You can
            come back to this same link at any time before you submit.
          </div>
        </div>

        {application.status === ApplicationStatus.AWAITING_INFO && (
          <AlertBanner type="error">
            <strong>HR needs something from you:</strong> {application.reviewNotes || 'Please review and complete your application.'}
          </AlertBanner>
        )}

        {/* ── Mobile verification ─────────────────────────────────────────── */}
        <div style={SECTION_STYLE}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Phone size={16} style={{ color: 'var(--text-muted)' }} aria-hidden />
            <div style={SECTION_TITLE_STYLE}>Confirm it&apos;s you</div>
            {otpVerified && (
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--success)', fontWeight: 600 }}>
                <Check size={13} aria-hidden /> Verified
              </span>
            )}
          </div>
          {!otpVerified ? (
            <>
              <div>
                {/* The code goes to the mailbox that received the invite, not to this number —
                    SMS is not configured, and email is the channel for everything here. The number
                    is still collected because the record needs it. */}
                <div style={{ fontSize: '12.5px', color: 'var(--text-muted)', marginBottom: '10px' }}>
                  We&apos;ll email a 6-digit code to <strong>{application.email ?? 'your email address'}</strong>.
                </div>
                <label htmlFor="reg-phone" style={LABEL_STYLE}>Your mobile number</label>
                <input
                  id="reg-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  // Saved like every other box. It used to key the verification cache and nothing
                  // else, so the number the candidate typed here was discarded and the record kept
                  // whatever HR entered at the interview — for the first critical field there is.
                  // Verifying the code is what makes it final; this keeps a corrected number from
                  // being lost if they wander off before verifying.
                  onBlur={() => phone.trim() && void saveDraft({ mobile: phone.trim() })}
                  inputMode="tel"
                  placeholder="10-digit mobile number"
                  style={INPUT_STYLE}
                  disabled={otpBusy}
                />
              </div>
              {!codeSent ? (
                <PrimaryButton onClick={() => void handleSendCode()} busy={otpBusy}>
                  Send code
                </PrimaryButton>
              ) : (
                <>
                  <div>
                    <label htmlFor="reg-code" style={LABEL_STYLE}>Verification code</label>
                    <input
                      id="reg-code"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      inputMode="numeric"
                      placeholder="6-digit code"
                      style={INPUT_STYLE}
                      disabled={otpBusy}
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <div style={{ flex: '1 1 160px' }}>
                      <PrimaryButton onClick={() => void handleVerifyCode()} busy={otpBusy}>
                        Verify
                      </PrimaryButton>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleSendCode()}
                      disabled={otpBusy}
                      className="btn btn-secondary"
                      style={{ flex: '1 1 140px', padding: '11px 16px', fontSize: '13px' }}
                    >
                      Resend code
                    </button>
                  </div>
                </>
              )}
              {otpInfo && <div style={{ fontSize: '12.5px', color: 'var(--success)' }}>{otpInfo}</div>}
              {otpError && <AlertBanner type="error" message={otpError} onClose={() => setOtpError(null)} />}
            </>
          ) : (
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              {phone} is verified for this application.
            </div>
          )}
        </div>

        {/*
          The form is open before the code is.

          Everything below used to be hidden until `otpVerified`, which defeated the server's own
          rule: it gates FILING, not typing (`registration-application.service.ts`, "Where the
          verification code is actually required"). The code is emailed to the mailbox the link
          arrived in, so gating the form proved nothing the link had not — and on a deployment with
          email switched off, a candidate holding a valid link could not enter a single character.
          That is not a hypothetical: this deployment ran with email off until today.

          Submitting still needs the code. See `canSubmit`.
        */}
        <>
            {/* ── Profile ────────────────────────────────────────────────── */}
            <div style={SECTION_STYLE}>
              <div style={SECTION_TITLE_STYLE}>Your details</div>
              <div style={SECTION_NOTE_STYLE}>Saved automatically as you move between fields.</div>

              <div style={FIELD_GRID_STYLE}>
                <div>
                  <label htmlFor="reg-fullName" style={LABEL_STYLE}>Full name (as on Aadhaar/PAN)</label>
                  <input
                    id="reg-fullName"
                    value={form.fullName}
                    onChange={(e) => updateField('fullName', e.target.value)}
                    onBlur={commitField('fullName')}
                    style={INPUT_STYLE}
                  />
                </div>
                <div>
                  <label htmlFor="reg-dob" style={LABEL_STYLE}>Date of birth</label>
                  <input
                    id="reg-dob"
                    type="date"
                    value={form.dateOfBirth}
                    onChange={(e) => updateField('dateOfBirth', e.target.value)}
                    onBlur={commitField('dateOfBirth')}
                    style={INPUT_STYLE}
                  />
                </div>
                <div>
                  <label htmlFor="reg-gender" style={LABEL_STYLE}>Gender</label>
                  <Select
                    value={form.gender}
                    onChange={(v) => { updateField('gender', v); void saveDraft(fieldPatch('gender', v)); }}
                    options={GENDER_OPTIONS}
                    placeholder="Select…"
                    aria-label="Gender"
                    id="reg-gender"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="reg-address" style={LABEL_STYLE}>Address</label>
                <textarea
                  id="reg-address"
                  value={form.address}
                  onChange={(e) => updateField('address', e.target.value)}
                  onBlur={commitField('address')}
                  rows={2}
                  style={{ ...INPUT_STYLE, resize: 'vertical' }}
                />
              </div>

              <div style={FIELD_GRID_STYLE}>
                <div>
                  <label htmlFor="reg-state" style={LABEL_STYLE}>State</label>
                  <input id="reg-state" value={form.state} onChange={(e) => updateField('state', e.target.value)} onBlur={commitField('state')} style={INPUT_STYLE} />
                </div>
                <div>
                  <label htmlFor="reg-city" style={LABEL_STYLE}>City</label>
                  <input id="reg-city" value={form.city} onChange={(e) => updateField('city', e.target.value)} onBlur={commitField('city')} style={INPUT_STYLE} />
                </div>
                <div>
                  <label htmlFor="reg-pincode" style={LABEL_STYLE}>Pincode</label>
                  <input id="reg-pincode" value={form.pincode} onChange={(e) => updateField('pincode', e.target.value)} onBlur={commitField('pincode')} inputMode="numeric" style={INPUT_STYLE} />
                </div>
              </div>

              <div style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />

              <div style={FIELD_GRID_STYLE}>
                <div>
                  <label htmlFor="reg-experience" style={LABEL_STYLE}>Years of experience</label>
                  <input id="reg-experience" type="number" min={0} max={60} value={form.experienceYears} onChange={(e) => updateField('experienceYears', e.target.value)} onBlur={commitField('experienceYears')} style={INPUT_STYLE} />
                </div>
                <div>
                  <label htmlFor="reg-employer" style={LABEL_STYLE}>Current employer</label>
                  <input id="reg-employer" value={form.currentEmployer} onChange={(e) => updateField('currentEmployer', e.target.value)} onBlur={commitField('currentEmployer')} style={INPUT_STYLE} />
                </div>
              </div>

              <div>
                <label htmlFor="reg-expertise" style={LABEL_STYLE}>Expertise</label>
                <input id="reg-expertise" value={form.expertise} onChange={(e) => updateField('expertise', e.target.value)} onBlur={commitField('expertise')} style={INPUT_STYLE} />
              </div>
              <div>
                <label htmlFor="reg-availability" style={LABEL_STYLE}>Availability</label>
                <input id="reg-availability" value={form.availability} onChange={(e) => updateField('availability', e.target.value)} onBlur={commitField('availability')} style={INPUT_STYLE} />
              </div>

              {/*
                Identity, pay and next-of-kin.

                These are not extras. Without the PAN there is no TDS deduction and no statutory
                filing; without the account and IFSC there is no payout at all; without a reachable
                contact there is no duty of care for somebody sent alone to a branch. The form used
                to ask for a photograph of the PAN card and never for the number on it, so every
                person who registered here arrived on the roster unable to be paid.

                Asked here rather than left to HR because the candidate is the one holding the
                documents. Anything left blank is chased on the record afterwards — an approval is
                not refused over it.
              */}
              <div style={SECTION_TITLE_STYLE}>Identity and payment</div>
              <div style={SECTION_NOTE_STYLE}>
                We need these to pay you and to deduct tax correctly. They are stored encrypted and
                shown masked.
              </div>
              <div style={FIELD_GRID_STYLE}>
                <div>
                  <label htmlFor="reg-pan" style={LABEL_STYLE}>PAN</label>
                  <input
                    id="reg-pan" value={form.panNumber} placeholder="ABCDE1234F"
                    onChange={(e) => updateField('panNumber', e.target.value.toUpperCase())}
                    onBlur={commitField('panNumber')} autoCapitalize="characters" style={INPUT_STYLE}
                  />
                </div>
                <div>
                  <label htmlFor="reg-aadhaar" style={LABEL_STYLE}>Aadhaar</label>
                  <input
                    id="reg-aadhaar" value={form.aadhaarNumber} inputMode="numeric" placeholder="12 digits"
                    onChange={(e) => updateField('aadhaarNumber', e.target.value)}
                    onBlur={commitField('aadhaarNumber')} style={INPUT_STYLE}
                  />
                </div>
              </div>
              <div style={FIELD_GRID_STYLE}>
                <div>
                  <label htmlFor="reg-bank-account" style={LABEL_STYLE}>Bank account number</label>
                  <input
                    id="reg-bank-account" value={form.bankAccountNumber} inputMode="numeric"
                    onChange={(e) => updateField('bankAccountNumber', e.target.value)}
                    onBlur={commitField('bankAccountNumber')} style={INPUT_STYLE}
                  />
                </div>
                <div>
                  <label htmlFor="reg-ifsc" style={LABEL_STYLE}>IFSC</label>
                  <input
                    id="reg-ifsc" value={form.ifscCode} placeholder="SBIN0001234"
                    onChange={(e) => updateField('ifscCode', e.target.value.toUpperCase())}
                    onBlur={commitField('ifscCode')} autoCapitalize="characters" style={INPUT_STYLE}
                  />
                </div>
              </div>
              <div style={FIELD_GRID_STYLE}>
                <div>
                  <label htmlFor="reg-bank-name" style={LABEL_STYLE}>Bank name</label>
                  <input
                    id="reg-bank-name" value={form.bankName}
                    onChange={(e) => updateField('bankName', e.target.value)}
                    onBlur={commitField('bankName')} style={INPUT_STYLE}
                  />
                </div>
                <div>
                  <label htmlFor="reg-qualification" style={LABEL_STYLE}>Qualification</label>
                  <input
                    id="reg-qualification" value={form.qualification} placeholder="Certificate or degree"
                    onChange={(e) => updateField('qualification', e.target.value)}
                    onBlur={commitField('qualification')} style={INPUT_STYLE}
                  />
                </div>
              </div>

              <div style={SECTION_TITLE_STYLE}>Emergency contact</div>
              <div style={SECTION_NOTE_STYLE}>
                Somebody we can reach if something happens while you are out at a branch.
              </div>
              <div style={FIELD_GRID_STYLE}>
                <div>
                  <label htmlFor="reg-ec-name" style={LABEL_STYLE}>Name</label>
                  <input
                    id="reg-ec-name" value={form.emergencyContactName}
                    onChange={(e) => updateField('emergencyContactName', e.target.value)}
                    onBlur={commitField('emergencyContactName')} style={INPUT_STYLE}
                  />
                </div>
                <div>
                  <label htmlFor="reg-ec-phone" style={LABEL_STYLE}>Phone</label>
                  <input
                    id="reg-ec-phone" value={form.emergencyContactPhone} inputMode="tel"
                    onChange={(e) => updateField('emergencyContactPhone', e.target.value)}
                    onBlur={commitField('emergencyContactPhone')} style={INPUT_STYLE}
                  />
                </div>
              </div>
              <div>
                <label htmlFor="reg-ec-relation" style={LABEL_STYLE}>Relationship</label>
                <input
                  id="reg-ec-relation" value={form.emergencyContactRelation} placeholder="Spouse, parent, sibling…"
                  onChange={(e) => updateField('emergencyContactRelation', e.target.value)}
                  onBlur={commitField('emergencyContactRelation')} style={INPUT_STYLE}
                />
              </div>

              <div>
                <label htmlFor="reg-employment-category" style={LABEL_STYLE}>Employment category</label>
                <Select
                  value={form.employmentCategory}
                  onChange={(v) => void handleEmploymentCategoryChange(v)}
                  options={EMPLOYMENT_CATEGORY_OPTIONS}
                  placeholder="Freelancer or Proprietor?"
                  aria-label="Employment category"
                  id="reg-employment-category"
                />
                <div style={{ ...SECTION_NOTE_STYLE, marginTop: '4px' }}>
                  Decides which documents you are asked for below.
                </div>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  // "Save draft" is the one place the whole form legitimately goes at once — the
                  // candidate asked for it, so there is no concurrent blur to race with.
                  onClick={() => form && void saveDraft(wholeFormPatch(form))}
                  disabled={savingDraft}
                  className="btn btn-secondary"
                  style={{ padding: '9px 16px', fontSize: '13px' }}
                >
                  {savingDraft ? 'Saving…' : 'Save draft'}
                </button>
                {draftSaved && !savingDraft && (
                  <span style={{ fontSize: '12px', color: 'var(--success)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <Check size={13} aria-hidden /> Saved
                  </span>
                )}
              </div>
              {draftError && <AlertBanner type="error" message={draftError} onClose={() => setDraftError(null)} />}
            </div>

            {/* ── Documents ──────────────────────────────────────────────── */}
            <div style={SECTION_STYLE}>
              <div style={SECTION_TITLE_STYLE}>Documents</div>
              <div style={SECTION_NOTE_STYLE}>
                A clear photo or scan of each one below. You can replace or add pages later from this
                same link.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                {documentsRequested.map((requirement) => {
                  const doc = documents.find((d) => d.requirement === requirement);
                  const uploaded = Boolean(doc && doc.filePaths.length > 0);
                  const busy = Boolean(uploading[requirement]);
                  const label = ONBOARDING_DOCUMENT_LABELS[requirement as keyof typeof ONBOARDING_DOCUMENT_LABELS] ?? requirement;
                  return (
                    <div
                      key={requirement}
                      style={{
                        border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)',
                        padding: '10px 12px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap',
                      }}
                    >
                      <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                        <div style={{ fontSize: '13px', fontWeight: 600 }}>{label}</div>
                        <div style={{ fontSize: '12px', color: uploaded ? 'var(--success)' : 'var(--text-muted)', marginTop: '2px' }}>
                          {uploaded
                            ? `Uploaded (${doc!.filePaths.length} ${doc!.filePaths.length === 1 ? 'file' : 'files'})`
                            : requirement === 'PHOTOGRAPH'
                              ? 'Needed before you can be approved — this is the face on your ID card'
                              : 'Nothing uploaded yet'}
                        </div>
                        {uploadErrors[requirement] && (
                          <div style={{ fontSize: '12px', color: 'var(--danger)', marginTop: '4px' }}>{uploadErrors[requirement]}</div>
                        )}
                      </div>
                      <label
                        className="btn btn-secondary"
                        style={{ fontSize: '12px', padding: '7px 12px', cursor: busy ? 'wait' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: '6px', width: 'auto' }}
                      >
                        <Paperclip size={13} aria-hidden />
                        {busy ? 'Uploading…' : uploaded ? 'Replace' : 'Attach'}
                        <input
                          type="file"
                          accept={SCAN_UPLOAD_ACCEPT}
                          // The rear camera for a document held in front of you, the front one for
                          // a portrait of yourself. A selfie taken on the rear camera is taken
                          // blind, and this photograph is the face printed on their ID card.
                          capture={requirement === 'PHOTOGRAPH' ? 'user' : 'environment'}
                          style={{ display: 'none' }}
                          disabled={busy}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            e.target.value = '';
                            if (file) void handleUpload(requirement, file);
                          }}
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── Consent ────────────────────────────────────────────────── */}
            <div style={SECTION_STYLE}>
              <div style={SECTION_TITLE_STYLE}>Declaration and consent</div>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5, cursor: consentAccepted ? 'default' : 'pointer' }}>
                <input
                  type="checkbox"
                  checked={consentAccepted}
                  disabled={consentAccepted || consentBusy}
                  onChange={(e) => void handleConsentToggle(e.target.checked)}
                  style={{ marginTop: '2px', flexShrink: 0 }}
                />
                <span>
                  I declare that the information provided is true to the best of my knowledge, and I
                  consent to Sumeru Global verifying my documents and details as part of this
                  application.
                </span>
              </label>
              {consentAccepted && (
                <div style={{ fontSize: '12px', color: 'var(--success)', display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                  <ShieldCheck size={13} aria-hidden /> Recorded.
                </div>
              )}
              {consentError && <AlertBanner type="error" message={consentError} onClose={() => setConsentError(null)} />}
            </div>

            {/* ── Submit ─────────────────────────────────────────────────── */}
            <div style={SECTION_STYLE}>
              <PrimaryButton onClick={() => void handleSubmit()} disabled={!canSubmit} busy={submitBusy}>
                Submit application
              </PrimaryButton>
              {!canSubmit && (
                <div style={SECTION_NOTE_STYLE}>
                  {!otpVerified
                    ? 'Confirm the code we emailed you before submitting. Everything you have typed is already saved.'
                    : 'Needs your full name, an employment category and the declaration above before this can be submitted.'}
                </div>
              )}
              {submitError && <AlertBanner type="error" message={submitError} onClose={() => setSubmitError(null)} />}
            </div>
        </>
      </div>
    </div>
  );
};

export default PublicRegistration;
