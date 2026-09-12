import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, TextInput, ScrollView, KeyboardAvoidingView, Platform, ActivityIndicator, TextStyle, Modal,
} from 'react-native';
import { EmploymentCategory, ONBOARDING_DOCUMENT_LABELS, INDIAN_STATES, type OnboardingDocument } from '@fapoms/shared';
import { useTheme } from '../theme/ThemeProvider';
import {
  AmbientGlow, AppText, Badge, Button, Card, Icon, IconButton, Tappable,
} from '../components/ui/primitives';
import { OrbitMark } from '../components/ui/BrandMark';
import { useFeedback } from '../components/ui/Feedback';
import { useT, serverErrorText } from '../i18n';
import { DocumentScanner, type ScannedDocument } from '../components/DocumentScanner';
import {
  SelfRegistrationApi,
  extractRegistrationToken,
  type RegistrationApplication,
  type RegistrationDocument,
  type DraftPatch,
} from '../services/self-registration.service';

/**
 * Appraiser Recruitment self-registration — the ONE way into this flow from a phone that has
 * never signed in.
 *
 * Reached from `LoginScreen`'s "New here?" link, and rendered by `App.tsx` the same way
 * `LoginScreen`/`LockScreen` are: as a plain conditional swap while `isAuthenticated` is false,
 * inside the SAME `SafeAreaView` + `StatusBar` wrapper those screens already get — this
 * component does not render its own, matching `LoginScreen`'s own contract.
 *
 * There is no `fapoms://register/<token>` deep link: `app.config.js` declares no `scheme`, and
 * the app carries no `expo-linking` dependency at all, so the OS has nowhere to hand such a
 * link even if the invite email offered one (it doesn't — it links to the web page). The
 * realistic entry point is therefore a pasted link or token, typed or shared into this screen's
 * own first step — see `extractRegistrationToken`.
 *
 * Every call below is unauthenticated (see `self-registration.service.ts`): the token in the
 * link IS the session, there is no bearer header, and nothing here touches `MobileApiService`
 * or `AuthContext`.
 */

export interface SelfRegistrationScreenProps {
  /** Back to the sign-in screen. */
  onExit: () => void;
}

type Phase = 'tokenEntry' | 'loading' | 'loadError' | 'ready';

/** Matches the backend's own default (`registration.otpResendCooldownSeconds`). Cosmetic only —
 *  the server enforces the real cooldown regardless of what this counts down to zero. */
const RESEND_COOLDOWN_SECONDS = 60;

const documentLabel = (requirement: string): string =>
  ONBOARDING_DOCUMENT_LABELS[requirement as OnboardingDocument] ?? requirement;

// ────────────────────────────────────────────────────────── small building blocks

/** A bordered text field in the same style `LoginScreen`'s inputs use — this screen is reached
 *  from the logged-out state, so it borrows that screen's look rather than the authenticated
 *  `ProfileScreen`'s flat locked-field treatment. */
const LabeledInput: React.FC<{
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'phone-pad' | 'email-address';
  autoCapitalize?: 'none' | 'characters' | 'words' | 'sentences';
  multiline?: boolean;
  hint?: string;
  maxLength?: number;
}> = ({
  label, value, onChangeText, onBlur, placeholder, keyboardType = 'default',
  autoCapitalize = 'sentences', multiline, hint, maxLength,
}) => {
  const t = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: t.space.sm }}>
      <AppText variant="overline" tone="faint">{label}</AppText>
      {/* Focus is a border-colour change only — see LoginScreen.tsx for why toggling
          elevation/shadow on focus drops IME focus under Fabric on Android. */}
      <View
        style={{
          backgroundColor: t.colors.surfaceAlt,
          borderRadius: t.radius.lg,
          borderWidth: 1.5,
          borderColor: focused ? t.colors.primary : t.colors.border,
          paddingHorizontal: t.space.lg,
          paddingVertical: multiline ? t.space.md : 0,
          minHeight: multiline ? 90 : 50,
          justifyContent: multiline ? 'flex-start' : 'center',
        }}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => { setFocused(false); onBlur?.(); }}
          placeholder={placeholder}
          placeholderTextColor={t.colors.textFaint}
          keyboardType={keyboardType}
          autoCapitalize={autoCapitalize}
          multiline={multiline}
          maxLength={maxLength}
          style={{
            color: t.colors.text,
            fontSize: 15,
            fontWeight: '600',
            paddingVertical: 0,
            textAlignVertical: multiline ? 'top' : 'center',
          } as TextStyle}
        />
      </View>
      {hint ? <AppText variant="caption" tone="faint">{hint}</AppText> : null}
    </View>
  );
};

/**
 * A row of mutually-exclusive chips.
 *
 * Not `Segmented`: that control always shows SOME option as chosen (it clamps a missing value
 * to index 0), which is wrong here — gender is optional, and employment category has to render
 * as genuinely unset until the candidate actually picks one, or the submit gate below would be
 * lying about what is chosen.
 */
const ChoiceChips: React.FC<{
  options: { key: string; label: string }[];
  value: string | null;
  onChange: (key: string) => void;
}> = ({ options, value, onChange }) => {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
      {options.map((o) => {
        const active = o.key === value;
        return (
          <Tappable
            key={o.key}
            onPress={() => onChange(o.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            accessibilityLabel={o.label}
          >
            <View style={{
              paddingVertical: t.space.sm, paddingHorizontal: t.space.lg, borderRadius: t.radius.pill,
              backgroundColor: active ? t.colors.primarySoft : t.colors.surfaceAlt,
              borderWidth: 1.5, borderColor: active ? t.colors.primary : t.colors.border,
            }}>
              <AppText variant="small" tone={active ? 'primary' : 'muted'}>{o.label}</AppText>
            </View>
          </Tappable>
        );
      })}
    </View>
  );
};

/**
 * State, chosen from the canonical list rather than typed.
 *
 * The same list `ProfileScreen`'s own `StatePicker` uses — a live assayer's address save is
 * refused outright if the state is not on it (`assertAddressConsistent`), so a candidate typing
 * "Karnatka" or "TN" here would look fine at draft time and only surface as a problem at HR
 * approval, on a record the candidate can no longer touch.
 */
const StateField: React.FC<{ value: string; onChange: (v: string) => void }> = ({ value, onChange }) => {
  const t = useTheme();
  const tr = useT();
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: t.space.sm }}>
      <AppText variant="overline" tone="faint">{tr('selfRegistration.form.state')}</AppText>
      <Tappable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={tr('selfRegistration.form.state')}>
        <View style={{
          backgroundColor: t.colors.surfaceAlt, borderRadius: t.radius.lg, borderWidth: 1.5, borderColor: t.colors.border,
          paddingHorizontal: t.space.lg, height: 50, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <AppText variant="small" tone={value ? 'default' : 'faint'}>{value || tr('selfRegistration.form.chooseState')}</AppText>
          <Icon name="chevron-down" size={14} color={t.colors.textFaint} />
        </View>
      </Tappable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, backgroundColor: t.colors.scrim, justifyContent: 'flex-end' }}>
          <View style={{
            backgroundColor: t.colors.surface,
            borderTopLeftRadius: t.radius['2xl'], borderTopRightRadius: t.radius['2xl'],
            maxHeight: '75%', paddingTop: t.space.lg,
          }}>
            <View style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              paddingHorizontal: t.space.lg, paddingBottom: t.space.md,
            }}>
              <AppText variant="h3">{tr('selfRegistration.form.state')}</AppText>
              <Tappable onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel={tr('common.close')}>
                <AppText variant="bodyStrong" style={{ color: t.colors.primary }}>{tr('common.done')}</AppText>
              </Tappable>
            </View>
            <ScrollView>
              {INDIAN_STATES.map((s) => (
                <Tappable key={s.value} onPress={() => { onChange(s.value); setOpen(false); }} accessibilityRole="button" accessibilityLabel={s.label}>
                  <View style={{
                    paddingHorizontal: t.space.lg, paddingVertical: t.space.md,
                    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                    borderBottomWidth: 1, borderBottomColor: t.colors.border,
                  }}>
                    <AppText variant="body" tone={s.value === value ? 'primary' : 'default'}>{s.label}</AppText>
                    {s.value === value && <Icon name="checkmark-circle" size={16} color={t.colors.primary} />}
                  </View>
                </Tappable>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
};

/** The terminal/pending views: submitted, approved, rejected. No form behind any of them. */
const StatusScreen: React.FC<{
  icon: string;
  tone?: 'default' | 'success' | 'danger';
  title: string;
  body: string;
  onExit: () => void;
}> = ({ icon, tone = 'default', title, body, onExit }) => {
  const t = useTheme();
  const tr = useT();
  const color = tone === 'success' ? t.colors.success : tone === 'danger' ? t.colors.danger : t.colors.primary;
  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
      <AmbientGlow />
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.space.xl, gap: t.space.lg }}>
        <Icon name={icon} size={56} color={color} />
        <AppText variant="h1" style={{ textAlign: 'center' }}>{title}</AppText>
        <AppText variant="body" tone="muted" style={{ textAlign: 'center' }}>{body}</AppText>
        <Button label={tr('common.close')} variant="neutral" onPress={onExit} style={{ marginTop: t.space.lg }} />
      </View>
    </View>
  );
};

// ────────────────────────────────────────────────────────── the screen

export const SelfRegistrationScreen: React.FC<SelfRegistrationScreenProps> = ({ onExit }) => {
  const t = useTheme();
  const tr = useT();
  const feedback = useFeedback();

  const [phase, setPhase] = useState<Phase>('tokenEntry');
  const [tokenInput, setTokenInput] = useState('');
  const [token, setToken] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [application, setApplication] = useState<RegistrationApplication | null>(null);
  const [documents, setDocuments] = useState<RegistrationDocument[]>([]);
  const [documentsRequested, setDocumentsRequested] = useState<string[]>([]);

  // OTP — gates everything below it. Verified is a per-session flag; the server's own cache
  // entry (`regotp:verified:<tokenHash>`) is what actually gates the draft/consent/document/
  // submit routes, so re-verifying on every fresh load of this screen matches what the backend
  // requires rather than assuming a stale local flag still holds.
  const [phone, setPhone] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpVerified, setOtpVerified] = useState(false);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [verifyingOtp, setVerifyingOtp] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  // The editable profile fields. Seeded once from whatever the application already has (an
  // AWAITING_INFO resume should not make a candidate retype what they already gave), then this
  // is the source of truth for the form — each save round-trips a field but does not pull the
  // whole draft back, so a slow response can never overwrite what the candidate is mid-typing.
  const [draft, setDraft] = useState<DraftPatch>({});
  const draftSeeded = useRef(false);
  const [savingDraft, setSavingDraft] = useState(false);

  const [capturingRequirement, setCapturingRequirement] = useState<string | null>(null);
  const [uploadingRequirement, setUploadingRequirement] = useState<string | null>(null);

  const [consentAccepted, setConsentAccepted] = useState(false);
  const [savingConsent, setSavingConsent] = useState(false);

  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const id = setInterval(() => setResendCooldown((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [resendCooldown]);

  const applyHydration = useCallback((data: {
    application: RegistrationApplication;
    documents: RegistrationDocument[];
    documentsRequested: string[];
  }) => {
    setApplication(data.application);
    setDocuments(data.documents);
    setDocumentsRequested(data.documentsRequested);
    setConsentAccepted(!!data.application.consentAcceptedAt);
    if (!draftSeeded.current) {
      draftSeeded.current = true;
      setDraft({
        fullName: data.application.fullName ?? '',
        email: data.application.email ?? '',
        dateOfBirth: data.application.dateOfBirth ? String(data.application.dateOfBirth).slice(0, 10) : '',
        gender: data.application.gender ?? '',
        address: data.application.address ?? '',
        state: data.application.state ?? '',
        city: data.application.city ?? '',
        pincode: data.application.pincode ?? '',
        experienceYears: data.application.experienceYears ?? undefined,
        currentEmployer: data.application.currentEmployer ?? '',
        expertise: data.application.expertise ?? '',
        availability: data.application.availability ?? '',
        employmentCategory: data.application.employmentCategory ?? undefined,
      });
      setPhone(data.application.mobile ?? '');
    }
  }, []);

  const load = useCallback(async (rawToken: string) => {
    setPhase('loading');
    setLoadError(null);
    const res = await SelfRegistrationApi.hydrate(rawToken);
    if (!res.success) {
      setLoadError(serverErrorText(res.error, 'selfRegistration.loadFailedTitle'));
      setPhase('loadError');
      return;
    }
    applyHydration(res.data);
    setPhase('ready');
  }, [applyHydration]);

  const handleTokenSubmit = () => {
    if (!tokenInput.trim()) {
      feedback.error(tr('selfRegistration.tokenEntry.title'), tr('selfRegistration.tokenEntry.missingToken'));
      return;
    }
    const extracted = extractRegistrationToken(tokenInput);
    setToken(extracted);
    void load(extracted);
  };

  // ── OTP ──────────────────────────────────────────────────────────────────

  const handleSendOtp = async () => {
    const trimmedPhone = phone.trim();
    if (!trimmedPhone) {
      feedback.error(tr('selfRegistration.otp.sendFailedTitle'), tr('selfRegistration.otp.missingPhone'));
      return;
    }
    setSendingOtp(true);
    const res = await SelfRegistrationApi.requestOtp(token, trimmedPhone);
    setSendingOtp(false);
    if (!res.success) {
      feedback.error(tr('selfRegistration.otp.sendFailedTitle'), serverErrorText(res.error, 'selfRegistration.otp.sendFailedTitle'));
      return;
    }
    setOtpSent(true);
    setResendCooldown(RESEND_COOLDOWN_SECONDS);
    feedback.success(tr('selfRegistration.otp.sentTitle'), tr('selfRegistration.otp.sentBody', { phone: trimmedPhone }));
  };

  const handleVerifyOtp = async () => {
    const code = otpCode.trim();
    if (!code) {
      feedback.error(tr('selfRegistration.otp.verifyFailedTitle'), tr('selfRegistration.otp.missingCode'));
      return;
    }
    setVerifyingOtp(true);
    const res = await SelfRegistrationApi.verifyOtp(token, phone.trim(), code);
    setVerifyingOtp(false);
    if (!res.success) {
      feedback.error(tr('selfRegistration.otp.verifyFailedTitle'), serverErrorText(res.error, 'selfRegistration.otp.verifyFailedTitle'));
      return;
    }
    setOtpVerified(true);
    feedback.success(tr('selfRegistration.otp.verifiedTitle'), tr('selfRegistration.otp.verifiedBody'));
  };

  // ── Draft ────────────────────────────────────────────────────────────────

  /**
   * What goes on the wire for an autosave.
   *
   * Every text field is checked against `undefined` rather than truthiness, and sent whenever it
   * has been seeded at all (which is every field, the moment `applyHydration` first runs) — so
   * clearing a field the candidate had previously filled actually reaches the server as the
   * empty string it now is, instead of being silently dropped and reappearing on the next load.
   * The backend's own `updateDraft` only skips a field that is `undefined`; it already treats an
   * empty string as "clear this". `dateOfBirth` is the one exception: it is gated behind the
   * `YYYY-MM-DD` shape so a half-typed date is never sent as one the server (or a later
   * `new Date(...)`) would parse as `Invalid Date`. `experienceYears` and `employmentCategory`
   * only go out once genuinely set, since there is no "clear this" value for either that the
   * server's own validators (`@IsInt`, `@IsEnum`) would accept.
   */
  const cleanDraftPayload = useCallback((d: DraftPatch): DraftPatch => {
    const out: DraftPatch = {};
    if (d.fullName !== undefined) out.fullName = d.fullName.trim();
    if (d.email !== undefined) out.email = d.email.trim();
    if (d.dateOfBirth && /^\d{4}-\d{2}-\d{2}$/.test(d.dateOfBirth)) out.dateOfBirth = d.dateOfBirth;
    if (d.gender !== undefined) out.gender = d.gender;
    if (d.address !== undefined) out.address = d.address.trim();
    if (d.state !== undefined) out.state = d.state.trim();
    if (d.city !== undefined) out.city = d.city.trim();
    if (d.pincode !== undefined) out.pincode = d.pincode.trim();
    if (d.experienceYears != null && !Number.isNaN(d.experienceYears)) out.experienceYears = d.experienceYears;
    if (d.currentEmployer !== undefined) out.currentEmployer = d.currentEmployer.trim();
    if (d.expertise !== undefined) out.expertise = d.expertise.trim();
    if (d.availability !== undefined) out.availability = d.availability.trim();
    if (d.employmentCategory) out.employmentCategory = d.employmentCategory;
    return out;
  }, []);

  /**
   * Saves ONE patch — never the whole `draft` object.
   *
   * This mattered in practice, not just in theory: a tap that both blurs a text field and
   * selects a chip in the same gesture (e.g. leaving Full Name to tap a Gender chip) fires two
   * autosaves within milliseconds of each other. Each of those, if it sent the FULL local
   * `draft` snapshot rather than just what it changed, would resend whatever it captured of
   * every OTHER field at that moment — and one of them is invariably one keystroke stale. The
   * server applies each PATCH by simple last-write-wins per field, so a wide snapshot from the
   * stale request can silently erase a value the OTHER request had just written moments before.
   * Verified against the running backend + Postgres: a fullName-blur save and a gender-chip
   * save fired together reproduced exactly this — the wider save's empty `gender: ''` overwrote
   * the chip's `gender: 'MALE'` that had landed a few milliseconds earlier. Sending only the
   * field each action actually owns makes the two writes disjoint, so neither can clobber the
   * other's.
   */
  const persistDraft = useCallback(async (patch: DraftPatch, opts?: { refreshDocumentsRequested?: boolean }) => {
    if (!token || Object.keys(patch).length === 0) return;
    setSavingDraft(true);
    const res = await SelfRegistrationApi.updateDraft(token, cleanDraftPayload(patch));
    setSavingDraft(false);
    if (!res.success) {
      feedback.error(tr('selfRegistration.form.saveFailedTitle'), serverErrorText(res.error, 'selfRegistration.form.saveFailedTitle'));
      return;
    }
    setApplication(res.data);
    // `documentsRequested` is derived from `employmentCategory` but only the hydrate route
    // computes it — a category change has to re-fetch it rather than guess the rule client-side
    // and risk drifting from `documentsRequestedFor` on the backend.
    if (opts?.refreshDocumentsRequested) {
      const hydrated = await SelfRegistrationApi.hydrate(token);
      if (hydrated.success) {
        setDocuments(hydrated.data.documents);
        setDocumentsRequested(hydrated.data.documentsRequested);
      }
    }
  }, [token, cleanDraftPayload, feedback, tr]);

  const updateDraftField = <K extends keyof DraftPatch>(key: K, value: DraftPatch[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * Fired on a text field's blur. Takes the field's own key rather than closing over the whole
   * `draft` — see `persistDraft`'s note on why a wide snapshot is the wrong thing to send here.
   * A fresh closure per field, per render, so it always reads that field's just-typed value.
   */
  const commitField = <K extends keyof DraftPatch>(key: K) => () => {
    void persistDraft({ [key]: draft[key] } as DraftPatch);
  };

  const handleGenderChange = (gender: string) => {
    setDraft((prev) => ({ ...prev, gender }));
    void persistDraft({ gender });
  };

  const handleStateChange = (state: string) => {
    setDraft((prev) => ({ ...prev, state }));
    void persistDraft({ state });
  };

  const handleEmploymentCategoryChange = (employmentCategory: EmploymentCategory) => {
    setDraft((prev) => ({ ...prev, employmentCategory }));
    void persistDraft({ employmentCategory }, { refreshDocumentsRequested: true });
  };

  // ── Documents ────────────────────────────────────────────────────────────

  const handleDocumentSaved = async (requirement: string, doc: ScannedDocument) => {
    setCapturingRequirement(null);
    const uri = doc.pdfUri ?? doc.pages[0]?.uri;
    if (!uri) {
      feedback.error(tr('selfRegistration.documents.uploadFailedTitle'), tr('selfRegistration.documents.nothingCaptured'));
      return;
    }
    setUploadingRequirement(requirement);
    const res = await SelfRegistrationApi.uploadDocument(token, requirement, {
      uri, name: doc.fileName, mimeType: doc.mimeType,
    });
    setUploadingRequirement(null);
    if (!res.success) {
      feedback.error(tr('selfRegistration.documents.uploadFailedTitle'), serverErrorText(res.error, 'selfRegistration.documents.uploadFailedTitle'));
      return;
    }
    setDocuments((prev) => [...prev.filter((d) => d.requirement !== requirement), res.data]);
    feedback.success(tr('selfRegistration.documents.uploaded'), documentLabel(requirement));
  };

  // ── Consent ──────────────────────────────────────────────────────────────

  const handleAcceptConsent = async () => {
    if (consentAccepted || savingConsent) return;
    setSavingConsent(true);
    const res = await SelfRegistrationApi.acceptConsent(token, 'v1');
    setSavingConsent(false);
    if (!res.success) {
      feedback.error(tr('selfRegistration.consent.failedTitle'), serverErrorText(res.error, 'selfRegistration.consent.failedTitle'));
      return;
    }
    setApplication(res.data);
    setConsentAccepted(true);
  };

  // ── Submit ───────────────────────────────────────────────────────────────

  const canSubmit = Boolean(draft.fullName?.trim()) && Boolean(draft.employmentCategory) && consentAccepted;

  const handleSubmit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    // Flush the current draft first — a field the candidate just edited must reach the server
    // before submit runs its own "fullName and employmentCategory are set" checks.
    const flush = await SelfRegistrationApi.updateDraft(token, cleanDraftPayload(draft));
    if (!flush.success) {
      setSubmitting(false);
      feedback.error(tr('selfRegistration.submit.failedTitle'), serverErrorText(flush.error, 'selfRegistration.submit.failedTitle'));
      return;
    }
    const res = await SelfRegistrationApi.submit(token);
    setSubmitting(false);
    if (!res.success) {
      feedback.error(tr('selfRegistration.submit.failedTitle'), serverErrorText(res.error, 'selfRegistration.submit.failedTitle'));
      return;
    }
    setApplication(res.data);
    feedback.success(tr('selfRegistration.submit.submittedTitle'), tr('selfRegistration.submit.submittedBody'));
  };

  // ── Render: token entry / loading / load error ──────────────────────────

  if (phase !== 'ready') {
    return (
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <AmbientGlow />
        <ScrollView
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: t.space.xl }}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ gap: t.space['2xl'] }}>
            <View style={{ alignItems: 'center', gap: t.space.lg }}>
              <OrbitMark size={110} />
              <AppText variant="h1" style={{ textAlign: 'center' }}>{tr('selfRegistration.tokenEntry.title')}</AppText>
              <AppText variant="body" tone="muted" style={{ textAlign: 'center' }}>{tr('selfRegistration.tokenEntry.body')}</AppText>
            </View>

            <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl, borderRadius: t.radius['2xl'] }}>
              <LabeledInput
                label={tr('selfRegistration.tokenEntry.inputLabel')}
                value={tokenInput}
                onChangeText={setTokenInput}
                placeholder={tr('selfRegistration.tokenEntry.inputPlaceholder')}
                autoCapitalize="none"
              />

              {phase === 'loadError' && loadError ? (
                <View style={{
                  flexDirection: 'row', alignItems: 'center', gap: t.space.sm,
                  backgroundColor: t.colors.dangerSoft, padding: t.space.md, borderRadius: t.radius.md,
                }}>
                  <Icon name="alert-circle" size={16} color={t.colors.danger} />
                  <AppText variant="caption" style={{ color: t.colors.danger, flex: 1 }}>{loadError}</AppText>
                </View>
              ) : null}

              <Button
                label={phase === 'loading' ? tr('selfRegistration.loading') : tr('selfRegistration.tokenEntry.continueLabel')}
                onPress={handleTokenSubmit}
                loading={phase === 'loading'}
                size="lg"
                glow
                full
              />
            </Card>

            <Tappable onPress={onExit} accessibilityRole="button" accessibilityLabel={tr('selfRegistration.tokenEntry.backToSignIn')}>
              <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>
                {tr('selfRegistration.tokenEntry.backToSignIn')}
              </AppText>
            </Tappable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  if (!application) return null; // unreachable — `phase` only becomes 'ready' alongside it

  // ── Render: terminal / pending statuses ──────────────────────────────────

  if (application.status === 'PENDING_VALIDATION') {
    return (
      <StatusScreen
        icon="time-outline"
        title={tr('selfRegistration.status.pendingTitle')}
        body={tr('selfRegistration.status.pendingBody')}
        onExit={onExit}
      />
    );
  }
  if (application.status === 'APPROVED') {
    return (
      <StatusScreen
        icon="checkmark-circle"
        tone="success"
        title={tr('selfRegistration.status.approvedTitle')}
        body={tr('selfRegistration.status.approvedBody')}
        onExit={onExit}
      />
    );
  }
  if (application.status === 'REJECTED') {
    return (
      <StatusScreen
        icon="close-circle-outline"
        tone="danger"
        title={tr('selfRegistration.status.rejectedTitle')}
        body={application.reviewNotes || tr('selfRegistration.status.rejectedBodyFallback')}
        onExit={onExit}
      />
    );
  }

  // ── Render: the form (DRAFT, or AWAITING_INFO resuming) ──────────────────

  const showReviewBanner = application.status === 'AWAITING_INFO' && !!application.reviewNotes;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <AmbientGlow />

      <View style={{
        paddingTop: t.space.lg, paddingHorizontal: t.space.lg, paddingBottom: t.space.md,
        flexDirection: 'row', alignItems: 'center', gap: t.space.md,
      }}>
        <IconButton icon="arrow-back" onPress={onExit} accessibilityLabel={tr('common.back')} />
        <AppText variant="h2" style={{ flex: 1 }} numberOfLines={1}>{tr('selfRegistration.tokenEntry.title')}</AppText>
      </View>

      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: t.space.lg, paddingTop: 0, gap: t.space.lg, paddingBottom: t.space['4xl'] }}
      >
        {showReviewBanner && (
          <Card level={1} style={{ gap: t.space.sm, borderColor: t.colors.warning, borderWidth: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
              <Icon name="information-circle" size={20} color={t.colors.warning} />
              <AppText variant="bodyStrong" style={{ flex: 1 }}>{tr('selfRegistration.status.awaitingInfoTitle')}</AppText>
            </View>
            <AppText variant="small" tone="muted">{tr('selfRegistration.status.awaitingInfoBody')}</AppText>
            <AppText variant="body">{application.reviewNotes}</AppText>
          </Card>
        )}

        {/* OTP — gates everything below it */}
        <Card level={2} style={{ gap: t.space.md, padding: t.space.xl, borderRadius: t.radius['2xl'] }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
            <Icon
              name={otpVerified ? 'checkmark-circle' : 'shield-checkmark-outline'}
              size={20}
              color={otpVerified ? t.colors.success : t.colors.primary}
            />
            <AppText variant="h3" style={{ flex: 1 }}>{tr('selfRegistration.otp.title')}</AppText>
            {otpVerified && <Badge label={tr('common.done')} tone="success" />}
          </View>

          {otpVerified ? (
            <AppText variant="small" tone="muted">{tr('selfRegistration.otp.verifiedBody')}</AppText>
          ) : (
            <>
              <AppText variant="small" tone="muted">{tr('selfRegistration.otp.body')}</AppText>
              <LabeledInput
                label={tr('selfRegistration.otp.phoneLabel')}
                value={phone}
                onChangeText={setPhone}
                placeholder={tr('selfRegistration.otp.phonePlaceholder')}
                keyboardType="phone-pad"
                autoCapitalize="none"
              />
              {!otpSent ? (
                <Button label={tr('selfRegistration.otp.sendCode')} onPress={handleSendOtp} loading={sendingOtp} full />
              ) : (
                <>
                  <AppText variant="caption" tone="faint">
                    {tr('selfRegistration.otp.sentBody', { phone: phone.trim() })}
                  </AppText>
                  <LabeledInput
                    label={tr('selfRegistration.otp.codeLabel')}
                    value={otpCode}
                    onChangeText={setOtpCode}
                    placeholder={tr('selfRegistration.otp.codePlaceholder')}
                    keyboardType="numeric"
                    autoCapitalize="none"
                    maxLength={8}
                  />
                  <Button label={tr('selfRegistration.otp.verify')} onPress={handleVerifyOtp} loading={verifyingOtp} full />
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Tappable onPress={() => { setOtpSent(false); setOtpCode(''); }} disabled={sendingOtp || verifyingOtp}>
                      <AppText variant="caption" tone="faint">{tr('selfRegistration.otp.change')}</AppText>
                    </Tappable>
                    <Tappable onPress={handleSendOtp} disabled={resendCooldown > 0 || sendingOtp}>
                      <AppText variant="caption" tone={resendCooldown > 0 ? 'faint' : 'primary'}>
                        {resendCooldown > 0
                          ? tr('selfRegistration.otp.resendIn', { seconds: resendCooldown })
                          : tr('selfRegistration.otp.resendCode')}
                      </AppText>
                    </Tappable>
                  </View>
                </>
              )}
            </>
          )}
        </Card>

        {otpVerified && (
          <>
            {/* Profile form */}
            <Card level={1} style={{ gap: t.space.lg }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <AppText variant="h3">{tr('selfRegistration.form.title')}</AppText>
                {savingDraft && <ActivityIndicator size="small" color={t.colors.primary} />}
              </View>
              <AppText variant="caption" tone="faint">{tr('selfRegistration.form.savingHint')}</AppText>

              <LabeledInput
                label={tr('selfRegistration.form.fullName')}
                value={draft.fullName ?? ''}
                onChangeText={(v) => updateDraftField('fullName', v)}
                onBlur={commitField('fullName')}
                placeholder={tr('selfRegistration.form.fullNamePlaceholder')}
                autoCapitalize="words"
              />
              <LabeledInput
                label={tr('selfRegistration.form.email')}
                value={draft.email ?? ''}
                onChangeText={(v) => updateDraftField('email', v)}
                onBlur={commitField('email')}
                placeholder={tr('selfRegistration.form.emailPlaceholder')}
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <LabeledInput
                label={tr('selfRegistration.form.dateOfBirth')}
                value={draft.dateOfBirth ?? ''}
                onChangeText={(v) => updateDraftField('dateOfBirth', v)}
                onBlur={commitField('dateOfBirth')}
                placeholder={tr('selfRegistration.form.dateOfBirthPlaceholder')}
                keyboardType="numeric"
                autoCapitalize="none"
                hint={tr('selfRegistration.form.dateOfBirthHint')}
              />

              <View style={{ gap: t.space.sm }}>
                <AppText variant="overline" tone="faint">{tr('selfRegistration.form.gender')}</AppText>
                <ChoiceChips
                  options={[
                    { key: 'MALE', label: tr('selfRegistration.form.genderMale') },
                    { key: 'FEMALE', label: tr('selfRegistration.form.genderFemale') },
                    { key: 'OTHER', label: tr('selfRegistration.form.genderOther') },
                  ]}
                  value={draft.gender || null}
                  onChange={handleGenderChange}
                />
              </View>

              <LabeledInput
                label={tr('selfRegistration.form.address')}
                value={draft.address ?? ''}
                onChangeText={(v) => updateDraftField('address', v)}
                onBlur={commitField('address')}
                placeholder={tr('selfRegistration.form.addressPlaceholder')}
                autoCapitalize="sentences"
                multiline
              />

              <StateField value={draft.state ?? ''} onChange={handleStateChange} />

              <LabeledInput
                label={tr('selfRegistration.form.city')}
                value={draft.city ?? ''}
                onChangeText={(v) => updateDraftField('city', v)}
                onBlur={commitField('city')}
                placeholder={tr('selfRegistration.form.cityPlaceholder')}
                autoCapitalize="words"
              />
              <LabeledInput
                label={tr('selfRegistration.form.pincode')}
                value={draft.pincode ?? ''}
                onChangeText={(v) => updateDraftField('pincode', v)}
                onBlur={commitField('pincode')}
                placeholder={tr('selfRegistration.form.pincodePlaceholder')}
                keyboardType="numeric"
                autoCapitalize="none"
              />
              <LabeledInput
                label={tr('selfRegistration.form.experienceYears')}
                value={draft.experienceYears != null ? String(draft.experienceYears) : ''}
                onChangeText={(v) => {
                  const digits = v.replace(/[^0-9]/g, '');
                  updateDraftField('experienceYears', digits ? Number(digits) : undefined);
                }}
                onBlur={commitField('experienceYears')}
                placeholder={tr('selfRegistration.form.experienceYearsPlaceholder')}
                keyboardType="numeric"
                autoCapitalize="none"
              />
              <LabeledInput
                label={tr('selfRegistration.form.currentEmployer')}
                value={draft.currentEmployer ?? ''}
                onChangeText={(v) => updateDraftField('currentEmployer', v)}
                onBlur={commitField('currentEmployer')}
                placeholder={tr('selfRegistration.form.currentEmployerPlaceholder')}
                autoCapitalize="words"
              />
              <LabeledInput
                label={tr('selfRegistration.form.expertise')}
                value={draft.expertise ?? ''}
                onChangeText={(v) => updateDraftField('expertise', v)}
                onBlur={commitField('expertise')}
                placeholder={tr('selfRegistration.form.expertisePlaceholder')}
                autoCapitalize="sentences"
              />
              <LabeledInput
                label={tr('selfRegistration.form.availability')}
                value={draft.availability ?? ''}
                onChangeText={(v) => updateDraftField('availability', v)}
                onBlur={commitField('availability')}
                placeholder={tr('selfRegistration.form.availabilityPlaceholder')}
                autoCapitalize="sentences"
              />

              <View style={{ gap: t.space.sm }}>
                <AppText variant="overline" tone="faint">{tr('selfRegistration.form.employmentCategory')}</AppText>
                <ChoiceChips
                  options={[
                    { key: EmploymentCategory.FREELANCER, label: tr('selfRegistration.form.freelancer') },
                    { key: EmploymentCategory.PROPRIETOR, label: tr('selfRegistration.form.proprietor') },
                  ]}
                  value={draft.employmentCategory || null}
                  onChange={(key) => handleEmploymentCategoryChange(key as EmploymentCategory)}
                />
              </View>
            </Card>

            {/* Documents */}
            <Card level={1} style={{ gap: t.space.md }}>
              <AppText variant="h3">{tr('selfRegistration.documents.title')}</AppText>
              {documentsRequested.length === 0 ? (
                <AppText variant="small" tone="muted">{tr('selfRegistration.documents.none')}</AppText>
              ) : (
                <>
                  <AppText variant="small" tone="muted">{tr('selfRegistration.documents.hint')}</AppText>
                  {documentsRequested.map((requirement) => {
                    const uploaded = documents.some((d) => d.requirement === requirement && d.filePaths.length > 0);
                    const busy = uploadingRequirement === requirement;
                    return (
                      <View
                        key={requirement}
                        style={{ gap: t.space.sm, paddingVertical: t.space.sm, borderTopWidth: 1, borderTopColor: t.colors.border }}
                      >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                          <Icon
                            name={uploaded ? 'checkmark-circle' : 'document-outline'}
                            size={20}
                            color={uploaded ? t.colors.success : t.colors.textMuted}
                          />
                          <AppText variant="bodyStrong" style={{ flex: 1 }}>{documentLabel(requirement)}</AppText>
                          {uploaded && <Badge label={tr('selfRegistration.documents.uploaded')} tone="success" />}
                        </View>
                        <Button
                          label={
                            busy ? tr('selfRegistration.documents.uploading')
                              : uploaded ? tr('selfRegistration.documents.retake')
                              : tr('selfRegistration.documents.takePhoto')
                          }
                          icon="camera-outline"
                          variant={uploaded ? 'neutral' : undefined}
                          onPress={() => setCapturingRequirement(requirement)}
                          loading={busy}
                          disabled={busy}
                          full
                        />
                      </View>
                    );
                  })}
                </>
              )}
            </Card>

            {/* Consent */}
            <Card level={1} style={{ gap: t.space.md }}>
              <AppText variant="h3">{tr('selfRegistration.consent.title')}</AppText>
              <Tappable
                onPress={handleAcceptConsent}
                disabled={consentAccepted || savingConsent}
                accessibilityRole="switch"
                accessibilityState={{ checked: consentAccepted, disabled: consentAccepted || savingConsent }}
                accessibilityLabel={tr('selfRegistration.consent.text')}
              >
                <View style={{ flexDirection: 'row', gap: t.space.md }}>
                  <Icon
                    name={consentAccepted ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={consentAccepted ? t.colors.success : t.colors.textMuted}
                  />
                  <AppText variant="small" style={{ flex: 1 }}>{tr('selfRegistration.consent.text')}</AppText>
                </View>
              </Tappable>
              {consentAccepted && <Badge label={tr('selfRegistration.consent.accepted')} tone="success" icon="checkmark" />}
            </Card>

            {/* Submit */}
            <View style={{ gap: t.space.sm }}>
              <Button
                label={tr('selfRegistration.submit.button')}
                onPress={handleSubmit}
                loading={submitting}
                disabled={!canSubmit || submitting}
                size="lg"
                glow
                full
              />
              {!canSubmit && (
                <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>
                  {tr('selfRegistration.submit.requirementsHint')}
                </AppText>
              )}
            </View>
          </>
        )}
      </ScrollView>

      {capturingRequirement && (
        <DocumentScanner
          visible
          purpose={documentLabel(capturingRequirement)}
          onClose={() => setCapturingRequirement(null)}
          onSaved={(doc) => { void handleDocumentSaved(capturingRequirement, doc); }}
        />
      )}
    </KeyboardAvoidingView>
  );
};

export default SelfRegistrationScreen;
