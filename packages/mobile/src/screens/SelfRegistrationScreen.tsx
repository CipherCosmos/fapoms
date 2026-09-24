import React, { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import {
  ApplicationStatus, EmploymentCategory, REGISTRATION_STEP_COUNT,
  applicationFieldStep, inferRegistrationStep, normaliseIdentifierOnBlur, readApplicationInfoRequests, referenceSubmitProblem, registrationStepProblems,
  resumableRegistrationStep,
  type ApplicationInfoRequestItem, type RegistrationFormField, type RegistrationFormValues,
} from '@fapoms/shared';
import { useTheme } from '../theme/ThemeProvider';
import { AmbientGlow, AppText, Button, Card, Icon, IconButton, Input, ProgressBar } from '../components/ui/primitives';
import { OrbitMark } from '../components/ui/BrandMark';
import { useFeedback } from '../components/ui/Feedback';
import { useT, serverErrorText } from '../i18n';
import {
  captureWith, chooseFiles, chooseFromGallery, isCameraAvailable, isDocumentScannerAvailable, type CaptureOutcome,
} from '../components/document-capture';
import {
  SelfRegistrationApi, isVerificationLost,
  type DraftPatch, type RegistrationApplication, type RegistrationDocument, type RegistrationHydration,
  type RegistrationReference,
} from '../services/self-registration.service';
import {
  STEP_TITLE_KEYS, applicationRef, problemMessage, registrationFieldPatch, renderMessage, seedRegistrationForm,
  wholeFormPatch, type StepErrors,
} from './self-registration/registration-form';
import { ConsentGate } from './self-registration/ConsentGate';
import { FINISHED_STATUSES, RegistrationStatus } from './self-registration/RegistrationStatus';
import { StepPersonal } from './self-registration/StepPersonal';
import { StepAddress } from './self-registration/StepAddress';
import { StepBank } from './self-registration/StepBank';
import { StepDocuments, type CaptureDoor, type RowProblem } from './self-registration/StepDocuments';
import {
  capturePlanFor, documentLabel, missingSubmitDocument, uploadReplaceFlags,
} from './self-registration/document-rows';

/**
 * Appraiser self-registration from a phone that has never signed in — the same four steps, rules
 * and automations as the web link (`PublicRegistration.tsx`), which the candidate may equally use.
 *
 * Reached from `LoginScreen`'s "New here?" link and rendered by `App.tsx` while signed out. There is
 * no deep link (no `scheme`, no `expo-linking`), so the candidate pastes the invite link or code.
 * Every call is unauthenticated: the token in the link is the session (`self-registration.service.ts`).
 *
 * Order matters and is the server's: the notice is agreed before anything is collected, the number
 * is confirmed before filing, and each step's answers are checked before the next opens.
 */

export interface SelfRegistrationScreenProps {
  /** Back to the sign-in screen. */
  onExit: () => void;
}

type Phase = 'tokenEntry' | 'loading' | 'loadError' | 'ready';
type Pin = { latitude: number; longitude: number };

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

export const SelfRegistrationScreen: React.FC<SelfRegistrationScreenProps> = ({ onExit }) => {
  const t = useTheme();
  const tr = useT();
  const feedback = useFeedback();
  const scrollRef = useRef<ScrollView>(null);

  const [phase, setPhase] = useState<Phase>('tokenEntry');
  const [tokenInput, setTokenInput] = useState('');
  const [token, setToken] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [application, setApplication] = useState<RegistrationApplication | null>(null);
  const [documents, setDocuments] = useState<RegistrationDocument[]>([]);
  const [documentsRequested, setDocumentsRequested] = useState<string[]>([]);
  /** People who can vouch for the candidate — up to three, at least one with a number. */
  const [references, setReferences] = useState<RegistrationReference[]>([]);
  const [referencesError, setReferencesError] = useState<string | null>(null);
  /** Exactly what HR asked for — rendered as the to-do list, not one free-text note. */
  const [infoRequests, setInfoRequests] = useState<ApplicationInfoRequestItem[]>([]);
  const [consentNotice, setConsentNotice] = useState<RegistrationHydration['consentNotice'] | null>(null);

  const [form, setForm] = useState<RegistrationFormValues | null>(null);
  const formRef = useRef<RegistrationFormValues | null>(null);
  const [activeStep, setActiveStep] = useState(1);
  const [stepErrors, setStepErrors] = useState<StepErrors>({});

  const [phone, setPhone] = useState('');
  const [otpVerified, setOtpVerified] = useState(false);
  const [verificationNote, setVerificationNote] = useState<string | null>(null);

  const [pin, setPin] = useState<Pin | null>(null);
  const [categoryNote, setCategoryNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(0);
  const [saved, setSaved] = useState(false);

  const [uploadingRequirement, setUploadingRequirement] = useState<string | null>(null);
  const [uploadErrors, setUploadErrors] = useState<Record<string, RowProblem | undefined>>({});
  const [removing, setRemoving] = useState<string | null>(null);
  // Read once: whether this build has ML Kit's scanner and the phone camera (an older APK may not).
  const [devices] = useState(() => ({ scannerAvailable: isDocumentScannerAvailable(), cameraAvailable: isCameraAvailable() }));

  const [consentBusy, setConsentBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const updateForm = (next: RegistrationFormValues) => {
    formRef.current = next;
    setForm(next);
  };

  const scrollToTop = () => scrollRef.current?.scrollTo({ y: 0, animated: true });

  const verificationLost = useCallback(() => {
    setOtpVerified(false);
    setVerificationNote(tr('selfRegistration.otp.expired'));
  }, [tr]);

  // ── Opening the link ─────────────────────────────────────────────────────

  const load = useCallback(async (pasted: string) => {
    setPhase('loading');
    setLoadError(null);
    const { token: opened, result } = await SelfRegistrationApi.open(pasted);
    setToken(opened);
    if (!result.success) {
      setLoadError(serverErrorText(result.error, 'selfRegistration.loadFailedTitle', result.code));
      setPhase('loadError');
      return;
    }
    const data = result.data;
    const seeded = seedRegistrationForm(data.application);
    const fields = data.application.extendedProfile?.fields ?? {};
    setApplication(data.application);
    setDocuments(data.documents);
    setDocumentsRequested(data.documentsRequested);
    setInfoRequests(data.infoRequests ?? []);
    setReferences(readReferences(data.application));
    setReferencesError(null);
    setConsentNotice(data.consentNotice);
    updateForm(seeded);
    setPhone(data.application.mobile ?? '');
    setOtpVerified(Boolean(data.otpVerified));
    setPin(fields.latitude != null && fields.latitude !== '' && fields.longitude != null && fields.longitude !== ''
      ? { latitude: Number(fields.latitude), longitude: Number(fields.longitude) }
      : null);
    setActiveStep(resumableRegistrationStep(inferRegistrationStep(data.application, data.documents), seeded));
    setPhase('ready');
  }, []);

  const handleTokenSubmit = () => {
    if (!tokenInput.trim()) {
      feedback.error(tr('selfRegistration.tokenEntry.title'), tr('selfRegistration.tokenEntry.missingToken'));
      return;
    }
    void load(tokenInput);
  };

  // ── Saving ───────────────────────────────────────────────────────────────

  const save = useCallback((patch: DraftPatch) => {
    if (!token || Object.keys(patch).length === 0) return;
    setSaving((n) => n + 1);
    setSaved(false);
    void SelfRegistrationApi.updateDraft(token, patch).then((res) => {
      setSaving((n) => n - 1);
      if (!res.success) {
        feedback.error(tr('selfRegistration.saveFailedTitle'), serverErrorText(res.error, 'selfRegistration.saveFailedTitle', res.code));
        if (isVerificationLost(res)) verificationLost();
        return;
      }
      setApplication(res.data);
      // Read the to-do list back: the server drops an ask once its field actually changes.
      if ('infoRequests' in (res.data as object)) {
        setInfoRequests(readApplicationInfoRequests((res.data as { infoRequests?: unknown }).infoRequests));
      }
      setSaved(true);
    });
  }, [token, feedback, tr, verificationLost]);

  const setField = useCallback((key: RegistrationFormField, value: string) => {
    if (!formRef.current) return;
    updateForm({ ...formRef.current, [key]: value });
    setStepErrors((prev) => {
      if (!prev[key]) return prev;
      const rest = { ...prev };
      delete rest[key];
      return rest;
    });
  }, []);

  const commitField = useCallback((key: RegistrationFormField) => {
    const current = formRef.current;
    if (!current) return;
    const raw = String(current[key] ?? '');
    const cleaned = normaliseIdentifierOnBlur(key, raw);
    if (cleaned !== null) updateForm({ ...current, [key]: cleaned });
    const value = cleaned ?? raw;
    // The server reads "1990-04" as 1 April 1990, so a date only leaves once it is whole (or cleared).
    if (key === 'dateOfBirth' && value.trim() && !DATE_SHAPE.test(value.trim())) return;
    save(registrationFieldPatch(key, value));
  }, [save]);

  const pickField = useCallback((key: RegistrationFormField, value: string) => {
    setField(key, value);
    save(registrationFieldPatch(key, value));
  }, [setField, save]);

  const handlePinChange = useCallback((next: Pin | null) => {
    setPin(next);
    save({ record: { latitude: next?.latitude ?? '', longitude: next?.longitude ?? '' } });
  }, [save]);

  const handleReferencesChange = useCallback((next: RegistrationReference[]) => {
    setReferences(next);
    setReferencesError(null);
    save({ references: next });
  }, [save]);

  const readReferences = (app: RegistrationApplication): RegistrationReference[] => {
    const raw = app.extendedProfile?.references;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r) => !!r && (String(r.fullName ?? '').trim() !== '' || String(r.phone ?? '').trim() !== '' || String(r.email ?? '').trim() !== ''))
      .map((r) => ({
        fullName: String(r.fullName ?? ''),
        phone: String(r.phone ?? ''),
        relationship: String(r.relationship ?? ''),
        email: String(r.email ?? ''),
      }));
  };

  const handleCategoryChange = useCallback(async (category: EmploymentCategory) => {
    setField('employmentCategory', category);
    setSaving((n) => n + 1);
    const res = await SelfRegistrationApi.updateDraft(token, { employmentCategory: category });
    if (!res.success) {
      setSaving((n) => n - 1);
      feedback.error(tr('selfRegistration.saveFailedTitle'), serverErrorText(res.error, 'selfRegistration.saveFailedTitle', res.code));
      if (isVerificationLost(res)) verificationLost();
      return;
    }
    setApplication(res.data);
    // Which documents a category needs is the server's rule; ask rather than guess it here.
    const refreshed = await SelfRegistrationApi.hydrate(token);
    setSaving((n) => n - 1);
    setSaved(true);
    if (!refreshed.success) return;
    setDocuments(refreshed.data.documents);
    setDocumentsRequested(refreshed.data.documentsRequested);
    setInfoRequests(refreshed.data.infoRequests ?? []);
    const orphaned = refreshed.data.documents
      .filter((d) => d.filePaths.length > 0 && !refreshed.data.documentsRequested.includes(d.requirement))
      .map((d) => documentLabel(d.requirement));
    setCategoryNote(orphaned.length > 0
      ? tr('selfRegistration.form.categoryDocsKept', { documents: orphaned.join(', ') })
      : null);
  }, [token, feedback, tr, setField, verificationLost]);

  // ── Moving between steps ─────────────────────────────────────────────────

  const goToStep = useCallback((step: number) => {
    const current = formRef.current;
    if (!current) return;
    if (step > activeStep) {
      const errors: StepErrors = {};
      for (const [field, problem] of Object.entries(registrationStepProblems(activeStep, current))) {
        if (problem) errors[field as RegistrationFormField] = renderMessage(problemMessage(field as RegistrationFormField, problem, current), tr);
      }
      setStepErrors(errors);
      if (Object.keys(errors).length > 0) {
        scrollToTop();
        return;
      }
      const patch = wholeFormPatch(current);
      // Same guard as a single box: a half-typed date is not sent.
      if (patch.dateOfBirth && !DATE_SHAPE.test(patch.dateOfBirth)) delete patch.dateOfBirth;
      save(patch);
    } else {
      setStepErrors({});
    }
    setActiveStep(step);
    scrollToTop();
  }, [activeStep, save, tr]);

  // ── Documents, agreement, submit ─────────────────────────────────────────

  const setRowProblem = (requirement: string, problem: RowProblem | undefined) =>
    setUploadErrors((prev) => ({ ...prev, [requirement]: problem }));

  /**
   * One tap on a row: the camera (or the file picker), then straight up to the server — every file
   * picked, in order. A retake replaces what the row held with the first file and adds the rest.
   */
  const handleCapture = async (requirement: string, door: CaptureDoor, retake: boolean) => {
    if (uploadingRequirement) return;
    const plan = capturePlanFor(requirement, devices);
    const label = documentLabel(requirement);
    setRowProblem(requirement, undefined);
    let outcome: CaptureOutcome;
    if (door === 'primary') outcome = await captureWith(plan.primary, requirement, label);
    else if (plan.secondary === 'gallery') outcome = await chooseFromGallery(label);
    else outcome = await chooseFiles(label, { multiple: plan.allowMultipleFiles, imagesOnly: plan.imagesOnly });

    if (outcome.status === 'cancelled') return;
    if (outcome.status === 'cameraDenied') {
      setRowProblem(requirement, { message: tr('selfRegistration.documents.cameraDenied'), cameraDenied: true });
      return;
    }
    if (outcome.status === 'refused') {
      setRowProblem(requirement, { message: outcome.message });
      return;
    }
    if (outcome.status === 'failed') {
      setRowProblem(requirement, { message: serverErrorText(outcome.message, 'selfRegistration.documents.uploadFailedTitle') });
      return;
    }

    setUploadingRequirement(requirement);
    const flags = uploadReplaceFlags(outcome.files.length, retake);
    for (let i = 0; i < outcome.files.length; i++) {
      const file = outcome.files[i];
      const res = await SelfRegistrationApi.uploadDocument(token, requirement, file, { replace: flags[i] });
      if (!res.success) {
        setUploadingRequirement(null);
        // A refusal of the file itself (not a picture, too dark to be a document…) is the server's
        // own short sentence; anything else goes through the usual translation.
        setRowProblem(requirement, {
          message: res.code === 'UPLOAD_REJECTED' && res.error
            ? res.error
            : serverErrorText(res.error, 'selfRegistration.documents.uploadFailedTitle', res.code),
        });
        if (isVerificationLost(res)) verificationLost();
        return;
      }
      setDocuments((prev) => [...prev.filter((d) => d.requirement !== requirement), res.data]);
    }
    setUploadingRequirement(null);
    // The fresh file answers its own send-back: drop the ask now, not on the next reload.
    setInfoRequests((prev) => prev.filter((i) => !(i.kind === 'document' && i.key === requirement)));
  };

  const handleRemove = async (requirement: string, index: number) => {
    const ok = await feedback.confirm(
      tr('selfRegistration.documents.removeTitle'),
      tr('selfRegistration.documents.removeBody'),
      tr('selfRegistration.documents.remove'),
    );
    if (!ok) return;
    setRemoving(`${requirement}:${index}`);
    const res = await SelfRegistrationApi.deleteDocumentFile(token, requirement, index);
    setRemoving(null);
    if (!res.success) {
      feedback.error(
        tr('selfRegistration.documents.removeFailedTitle'),
        serverErrorText(res.error, 'selfRegistration.documents.removeFailedTitle', res.code),
      );
      if (isVerificationLost(res)) verificationLost();
      return;
    }
    setRowProblem(requirement, undefined);
    setDocuments((prev) => [...prev.filter((d) => d.requirement !== requirement), res.data]);
  };

  const handleAcceptConsent = async () => {
    if (!consentNotice) return;
    setConsentBusy(true);
    // The version the API served — what the row records and what the person read are the same.
    const res = await SelfRegistrationApi.acceptConsent(token, consentNotice.version);
    setConsentBusy(false);
    if (!res.success) {
      feedback.error(tr('selfRegistration.consent.failedTitle'), serverErrorText(res.error, 'selfRegistration.consent.failedTitle', res.code));
      return;
    }
    setApplication(res.data);
    scrollToTop();
  };

  const handleWithdraw = async (reason: string | undefined) => {
    setWithdrawing(true);
    const res = await SelfRegistrationApi.withdrawConsent(token, reason);
    setWithdrawing(false);
    if (!res.success) {
      feedback.error(tr('selfRegistration.consent.withdrawFailedTitle'), serverErrorText(res.error, 'selfRegistration.consent.withdrawFailedTitle', res.code));
      return;
    }
    setApplication(res.data);
  };

  const handleSubmit = async () => {
    // Checked here too, so the candidate is taken to the document rather than told by the server.
    const missingDoc = missingSubmitDocument(documentsRequested, documents);
    if (missingDoc) {
      feedback.error(
        tr('selfRegistration.submit.failedTitle'),
        tr('selfRegistration.documents.missingRequired', { document: documentLabel(missingDoc) }),
      );
      goToStep(REGISTRATION_STEP_COUNT);
      return;
    }
    const problem = referenceSubmitProblem(references);
    if (problem) {
      setReferencesError(problem);
      // The shared rule's own sentence — the same one the web form and the server give.
      feedback.error(tr('selfRegistration.submit.failedTitle'), problem);
      goToStep(2);
      return;
    }
    setSubmitting(true);
    const res = await SelfRegistrationApi.submit(token);
    setSubmitting(false);
    if (!res.success) {
      feedback.error(tr('selfRegistration.submit.failedTitle'), serverErrorText(res.error, 'selfRegistration.submit.failedTitle', res.code));
      if (isVerificationLost(res)) verificationLost();
      return;
    }
    setApplication(res.data);
  };

  // ── Render: paste the link ───────────────────────────────────────────────

  if (phase !== 'ready' || !application || !form || !consentNotice) {
    return (
      <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <AmbientGlow />
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: t.space.xl }} keyboardShouldPersistTaps="handled">
          <View style={{ gap: t.space['2xl'] }}>
            <View style={{ alignItems: 'center', gap: t.space.lg }}>
              <OrbitMark size={110} />
              <AppText variant="h1" style={{ textAlign: 'center' }}>{tr('selfRegistration.tokenEntry.title')}</AppText>
              <AppText variant="body" tone="muted" style={{ textAlign: 'center' }}>{tr('selfRegistration.tokenEntry.body')}</AppText>
            </View>

            <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl, borderRadius: t.radius['2xl'] }}>
              <Input
                label={tr('selfRegistration.tokenEntry.inputLabel')}
                value={tokenInput}
                onChangeText={setTokenInput}
                placeholder={tr('selfRegistration.tokenEntry.inputPlaceholder')}
                autoCapitalize="none"
                autoCorrect={false}
              />
              {phase === 'loadError' && loadError ? (
                <View style={{ gap: 4, backgroundColor: t.colors.dangerSoft, padding: t.space.md, borderRadius: t.radius.md }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
                    <Icon name="alert-circle" size={16} color={t.colors.danger} />
                    <AppText variant="caption" tone="danger" style={{ flex: 1 }}>{loadError}</AppText>
                  </View>
                  <AppText variant="caption" tone="muted">{tr('selfRegistration.loadFailedHelp')}</AppText>
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

            <Button label={tr('selfRegistration.tokenEntry.backToSignIn')} variant="ghost" onPress={onExit} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    );
  }

  // ── Render: finished ─────────────────────────────────────────────────────

  if (FINISHED_STATUSES.has(application.status)) {
    return <RegistrationStatus application={application} onExit={onExit} />;
  }

  // ── Render: the notice, then the four steps ──────────────────────────────

  const consented = Boolean(application.consentAcceptedAt);
  const errorCount = Object.keys(stepErrors).length;
  const stepProps = { token, form, errors: stepErrors, setField, commitField, pickField, save };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <AmbientGlow />

      <View style={{ paddingTop: t.space.lg, paddingHorizontal: t.space.lg, paddingBottom: t.space.md, gap: t.space.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
          <IconButton icon="close" onPress={onExit} accessibilityLabel={tr('common.close')} />
          <View style={{ flex: 1, minWidth: 0 }}>
            {consented ? (
              <>
                <AppText variant="caption" tone="primary">
                  {tr('selfRegistration.steps.progress', { step: activeStep, total: REGISTRATION_STEP_COUNT })}
                </AppText>
                <AppText variant="h2" numberOfLines={1}>{tr(STEP_TITLE_KEYS[activeStep - 1])}</AppText>
              </>
            ) : (
              <AppText variant="h2" numberOfLines={1}>{tr('selfRegistration.tokenEntry.title')}</AppText>
            )}
          </View>
          {/* Saving, on the title row: a small cloud and one word, not a line of its own. */}
          {consented && (
            <View
              style={{ flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: 120 }}
              accessibilityLabel={saving > 0 ? tr('selfRegistration.saving') : saved ? tr('selfRegistration.saved') : tr('selfRegistration.savesAsYouType')}
            >
              {saving > 0
                ? <ActivityIndicator size="small" color={t.colors.textMuted} style={{ transform: [{ scale: 0.7 }] }} />
                : <Icon name={saved ? 'cloud-done-outline' : 'cloud-outline'} size={16} color={saved ? t.colors.success : t.colors.textFaint} />}
              <AppText variant="caption" tone={saving === 0 && saved ? 'success' : 'faint'} numberOfLines={1}>
                {saving > 0 ? tr('selfRegistration.saving') : saved ? tr('selfRegistration.saved') : tr('selfRegistration.savesAsYouType')}
              </AppText>
            </View>
          )}
        </View>
        {consented && <ProgressBar value={activeStep / REGISTRATION_STEP_COUNT} />}
      </View>

      <ScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: t.space.lg, paddingTop: 0, gap: t.space.lg, paddingBottom: t.space['4xl'] }}
      >
        {!consented ? (
          <ConsentGate
            notice={consentNotice}
            candidateName={application.fullName}
            busy={consentBusy}
            onAccept={() => { void handleAcceptConsent(); }}
          />
        ) : (
          <>
            {application.status === ApplicationStatus.AWAITING_INFO && (
              <Card level={1} style={{ gap: t.space.sm, borderColor: t.colors.warning, borderWidth: 1 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
                  <Icon name="information-circle" size={20} color={t.colors.warning} />
                  <AppText variant="bodyStrong" style={{ flex: 1 }}>
                    {tr('selfRegistration.status.awaitingInfoTitle')}
                    {infoRequests.length > 0 ? ` (${infoRequests.length})` : ''}
                  </AppText>
                </View>
                {infoRequests.length > 0 ? (
                  <View style={{ gap: t.space.xs }}>
                    {infoRequests.map((item) => (
                      <View key={`${item.kind}:${item.key}`} style={{ flexDirection: 'row', gap: t.space.xs, alignItems: 'center' }}>
                        <AppText variant="body" tone="muted">•</AppText>
                        <AppText variant="body" style={{ flex: 1 }}>
                          <AppText variant="bodyStrong">{item.label}</AppText>
                          {' — '}{item.message}
                        </AppText>
                        {/* The web link had a way to each fix; the phone only named them, leaving
                            the candidate to hunt through four steps for the box. Same map both
                            use — documents are always the last step. */}
                        <Button
                          label={tr('selfRegistration.status.fixItem')}
                          variant="ghost"
                          size="sm"
                          onPress={() => goToStep(item.kind === 'document' ? REGISTRATION_STEP_COUNT : applicationFieldStep(item.key))}
                        />
                      </View>
                    ))}
                  </View>
                ) : (
                  <AppText variant="body">{application.reviewNotes || tr('selfRegistration.status.awaitingInfoFallback')}</AppText>
                )}
              </Card>
            )}

            {errorCount > 0 && (
              <View style={{
                flexDirection: 'row', alignItems: 'center', gap: t.space.sm,
                backgroundColor: t.colors.dangerSoft, borderRadius: t.radius.lg, padding: t.space.md,
              }}>
                <Icon name="alert-circle" size={18} color={t.colors.danger} />
                <AppText variant="small" tone="danger" style={{ flex: 1 }}>
                  {errorCount === 1
                    ? tr('selfRegistration.steps.fixOne')
                    : tr('selfRegistration.steps.fixMany', { count: errorCount })}
                </AppText>
              </View>
            )}

            {activeStep === 1 && (
              <StepPersonal
                {...stepProps}
                email={application.email}
                phone={phone}
                setPhone={setPhone}
                otpVerified={otpVerified}
                onVerified={(number) => {
                  setPhone(number);
                  setOtpVerified(true);
                  setVerificationNote(null);
                }}
                verificationNote={verificationNote}
                onContinue={() => goToStep(2)}
              />
            )}
            {activeStep === 2 && (
              <StepAddress
                {...stepProps}
                pin={pin}
                onPinChange={handlePinChange}
                references={references}
                referencesError={referencesError}
                onReferencesChange={handleReferencesChange}
                sourceReferral={application?.extendedProfile?.sourceReferral ?? null}
                onBack={() => goToStep(1)}
                onContinue={() => goToStep(3)}
              />
            )}
            {activeStep === 3 && (
              <StepBank
                {...stepProps}
                onCategoryChange={(category) => { void handleCategoryChange(category); }}
                categoryNote={categoryNote}
                onBack={() => goToStep(2)}
                onContinue={() => goToStep(4)}
              />
            )}
            {activeStep === 4 && (
              <StepDocuments
                token={token}
                form={form}
                application={application}
                consentNotice={consentNotice}
                documents={documents}
                documentsRequested={documentsRequested}
                infoRequests={infoRequests}
                devices={devices}
                uploadingRequirement={uploadingRequirement}
                uploadErrors={uploadErrors}
                onCapture={(requirement, door, retake) => { void handleCapture(requirement, door, retake); }}
                onRemove={(requirement, index) => { void handleRemove(requirement, index); }}
                removing={removing}
                otpVerified={otpVerified}
                withdrawing={withdrawing}
                onWithdraw={(reason) => { void handleWithdraw(reason); }}
                submitting={submitting}
                onSubmit={() => { void handleSubmit(); }}
                goToStep={goToStep}
                onBack={() => goToStep(3)}
              />
            )}

            <View style={{ gap: 4, paddingHorizontal: t.space.xs, marginTop: t.space.md }}>
              <AppText variant="caption" tone="faint">{tr('selfRegistration.stuckTitle')}</AppText>
              <AppText variant="caption" tone="faint">{tr('selfRegistration.stuckBody')}</AppText>
              <AppText variant="caption" tone="faint">{tr('selfRegistration.ref', { ref: applicationRef(application.id) })}</AppText>
            </View>
          </>
        )}
      </ScrollView>

    </KeyboardAvoidingView>
  );
};

export default SelfRegistrationScreen;
