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
}

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
});

/** Only the fields actually filled in — an empty box means "unchanged", never "clear this". */
const buildDraftPatch = (f: FormState): UpdateRegistrationDraftInput => {
  const patch: UpdateRegistrationDraftInput = {};
  if (f.fullName.trim()) patch.fullName = f.fullName.trim();
  if (f.dateOfBirth) patch.dateOfBirth = f.dateOfBirth;
  if (f.gender) patch.gender = f.gender;
  if (f.address.trim()) patch.address = f.address.trim();
  if (f.state.trim()) patch.state = f.state.trim();
  if (f.city.trim()) patch.city = f.city.trim();
  if (f.pincode.trim()) patch.pincode = f.pincode.trim();
  if (f.experienceYears.trim() !== '' && !Number.isNaN(Number(f.experienceYears))) {
    patch.experienceYears = Number(f.experienceYears);
  }
  if (f.currentEmployer.trim()) patch.currentEmployer = f.currentEmployer.trim();
  if (f.expertise.trim()) patch.expertise = f.expertise.trim();
  if (f.availability.trim()) patch.availability = f.availability.trim();
  if (f.employmentCategory) patch.employmentCategory = f.employmentCategory;
  return patch;
};

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

  const saveDraft = async (next: FormState) => {
    setSavingDraft(true);
    setDraftError(null);
    setDraftSaved(false);
    try {
      const saved = await updateRegistrationDraft(token, buildDraftPatch(next));
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

  const handleFieldBlur = () => {
    if (form) void saveDraft(form);
  };

  const handleEmploymentCategoryChange = async (value: string) => {
    if (!form) return;
    const next: FormState = { ...form, employmentCategory: (value as EmploymentCategory) || '' };
    setForm(next);
    setSavingDraft(true);
    setDraftError(null);
    try {
      const saved = await updateRegistrationDraft(token, buildDraftPatch(next));
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
    () => Boolean(form?.fullName.trim()) && Boolean(form?.employmentCategory) && consentAccepted,
    [form, consentAccepted],
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

        {otpVerified && (
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
                    onBlur={handleFieldBlur}
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
                    onBlur={handleFieldBlur}
                    style={INPUT_STYLE}
                  />
                </div>
                <div>
                  <label htmlFor="reg-gender" style={LABEL_STYLE}>Gender</label>
                  <Select
                    value={form.gender}
                    onChange={(v) => { updateField('gender', v); void saveDraft({ ...form, gender: v }); }}
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
                  onBlur={handleFieldBlur}
                  rows={2}
                  style={{ ...INPUT_STYLE, resize: 'vertical' }}
                />
              </div>

              <div style={FIELD_GRID_STYLE}>
                <div>
                  <label htmlFor="reg-state" style={LABEL_STYLE}>State</label>
                  <input id="reg-state" value={form.state} onChange={(e) => updateField('state', e.target.value)} onBlur={handleFieldBlur} style={INPUT_STYLE} />
                </div>
                <div>
                  <label htmlFor="reg-city" style={LABEL_STYLE}>City</label>
                  <input id="reg-city" value={form.city} onChange={(e) => updateField('city', e.target.value)} onBlur={handleFieldBlur} style={INPUT_STYLE} />
                </div>
                <div>
                  <label htmlFor="reg-pincode" style={LABEL_STYLE}>Pincode</label>
                  <input id="reg-pincode" value={form.pincode} onChange={(e) => updateField('pincode', e.target.value)} onBlur={handleFieldBlur} inputMode="numeric" style={INPUT_STYLE} />
                </div>
              </div>

              <div style={{ borderTop: '1px solid var(--border-color)', margin: '4px 0' }} />

              <div style={FIELD_GRID_STYLE}>
                <div>
                  <label htmlFor="reg-experience" style={LABEL_STYLE}>Years of experience</label>
                  <input id="reg-experience" type="number" min={0} max={60} value={form.experienceYears} onChange={(e) => updateField('experienceYears', e.target.value)} onBlur={handleFieldBlur} style={INPUT_STYLE} />
                </div>
                <div>
                  <label htmlFor="reg-employer" style={LABEL_STYLE}>Current employer</label>
                  <input id="reg-employer" value={form.currentEmployer} onChange={(e) => updateField('currentEmployer', e.target.value)} onBlur={handleFieldBlur} style={INPUT_STYLE} />
                </div>
              </div>

              <div>
                <label htmlFor="reg-expertise" style={LABEL_STYLE}>Expertise</label>
                <input id="reg-expertise" value={form.expertise} onChange={(e) => updateField('expertise', e.target.value)} onBlur={handleFieldBlur} style={INPUT_STYLE} />
              </div>
              <div>
                <label htmlFor="reg-availability" style={LABEL_STYLE}>Availability</label>
                <input id="reg-availability" value={form.availability} onChange={(e) => updateField('availability', e.target.value)} onBlur={handleFieldBlur} style={INPUT_STYLE} />
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
                  onClick={() => form && void saveDraft(form)}
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
                          {uploaded ? `Uploaded (${doc!.filePaths.length} ${doc!.filePaths.length === 1 ? 'file' : 'files'})` : 'Nothing uploaded yet'}
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
                          capture="environment"
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
                  Needs your full name, an employment category and the declaration above before this
                  can be submitted.
                </div>
              )}
              {submitError && <AlertBanner type="error" message={submitError} onClose={() => setSubmitError(null)} />}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default PublicRegistration;
