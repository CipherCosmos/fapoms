import React, { useState } from 'react';
import { ActivityIndicator, Image, Linking, ScrollView, StyleSheet, View } from 'react-native';
import {
  EmploymentCategory,
  scanMimeType,
  storedScanFileName,
  type ApplicationInfoRequestItem,
  type RegistrationFormValues,
} from '@fapoms/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { AppText, Badge, Button, Card, Icon, Input, ModalSheet, Tappable } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import {
  SelfRegistrationApi,
  type RegistrationApplication,
  type RegistrationDocument,
  type RegistrationHydration,
} from '../../services/self-registration.service';
import { StepFooter, Stretch } from './parts';
import {
  capturePlanFor, conditionBadgeKey, documentLabel, rejectionText, rowNoteKey, stillNeeded, type CapturePlan,
} from './document-rows';

/** A refused or failed upload, said under its row with a way to try again. */
export interface RowProblem {
  message: string;
  /** The camera permission is off — offer Settings instead of trying the camera again. */
  cameraDenied?: boolean;
}

/** Which door a row's capture goes through: the big button, or the small link under it. */
export type CaptureDoor = 'primary' | 'secondary';

export interface StepDocumentsProps {
  token: string;
  form: RegistrationFormValues;
  application: RegistrationApplication;
  consentNotice: RegistrationHydration['consentNotice'];
  documents: RegistrationDocument[];
  documentsRequested: string[];
  /** Exactly what HR asked for — sent-back rows render their own instruction. */
  infoRequests?: ApplicationInfoRequestItem[];
  /** Whether ML Kit's scanner and the phone camera are in this build — decides each row's buttons. */
  devices: { scannerAvailable: boolean; cameraAvailable: boolean };
  uploadingRequirement: string | null;
  uploadErrors: Record<string, RowProblem | undefined>;
  /** Captures and uploads. `retake` replaces what the row holds; otherwise the files are added. */
  onCapture: (requirement: string, door: CaptureDoor, retake: boolean) => void;
  /** Takes one file off a row. */
  onRemove: (requirement: string, index: number) => void;
  /** `requirement:index` of the file being removed. */
  removing: string | null;
  otpVerified: boolean;
  withdrawing: boolean;
  onWithdraw: (reason: string | undefined) => void;
  submitting: boolean;
  onSubmit: () => void;
  goToStep: (step: number) => void;
  onBack: () => void;
}

// A replaced scan keeps the same URL, so the stored key's hash busts the image cache.
function versionedFileUrl(token: string, requirement: string, index: number, filePath: string): string {
  let h = 0;
  for (let i = 0; i < filePath.length; i++) h = (h * 31 + filePath.charCodeAt(i)) | 0;
  return `${SelfRegistrationApi.documentFileUrl(token, requirement, index)}?v=${(h >>> 0).toString(36)}`;
}

function openFile(url: string) {
  void Linking.openURL(url).catch(() => undefined);
}

const isImageFile = (label: string, filePath: string, index: number, count: number) =>
  (scanMimeType(storedScanFileName(label, filePath, count > 1 ? index + 1 : undefined)) ?? '').startsWith('image/');

const PreviewImage: React.FC<{ url: string }> = ({ url }) => {
  const t = useTheme();
  const tr = useT();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <Button label={tr('selfRegistration.documents.previewOpen')} icon="open-outline" variant="neutral" onPress={() => openFile(url)} full />
    );
  }
  return (
    <View style={{ width: '100%', height: 420, borderRadius: t.radius.lg, overflow: 'hidden', backgroundColor: t.colors.surfaceAlt }}>
      <Image
        source={{ uri: url }}
        resizeMode="contain"
        style={{ width: '100%', height: 420 }}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
      {!loaded && (
        <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator color={t.colors.primary} />
        </View>
      )}
    </View>
  );
};

/** A small picture of what was sent — a PDF shows as a page icon. Tap to look closer. */
const Thumb: React.FC<{ url: string; image: boolean; onPress: () => void; label: string }> = ({ url, image, onPress, label }) => {
  const t = useTheme();
  const [failed, setFailed] = useState(false);
  return (
    <Tappable onPress={onPress} accessibilityRole="button" accessibilityLabel={label}>
      <View style={{
        width: 64, height: 80, borderRadius: t.radius.md, overflow: 'hidden',
        backgroundColor: t.colors.surfaceAlt, borderWidth: 1, borderColor: t.colors.border,
        alignItems: 'center', justifyContent: 'center',
      }}>
        {image && !failed
          ? <Image source={{ uri: url }} resizeMode="cover" style={{ width: 64, height: 80 }} onError={() => setFailed(true)} />
          : <Icon name="document-text-outline" size={28} color={t.colors.textMuted} />}
      </View>
    </Tappable>
  );
};

/** A small underlined text action — the quiet alternative under a big button. */
const TextLink: React.FC<{ label: string; onPress: () => void; tone?: 'primary' | 'danger' | 'muted'; disabled?: boolean; center?: boolean }> = ({
  label, onPress, tone = 'primary', disabled, center,
}) => {
  const t = useTheme();
  return (
    <Tappable onPress={onPress} disabled={disabled} accessibilityRole="link" accessibilityLabel={label} hitSlop={10}>
      <AppText
        variant="small"
        tone={tone}
        style={{ fontWeight: '700', textDecorationLine: 'underline', paddingVertical: t.space.xs, textAlign: center ? 'center' : 'left' }}
      >
        {label}
      </AppText>
    </Tappable>
  );
};

export const StepDocuments: React.FC<StepDocumentsProps> = ({
  token, form, application, consentNotice, documents, documentsRequested, infoRequests = [], devices,
  uploadingRequirement, uploadErrors, onCapture, onRemove, removing,
  otpVerified, withdrawing, onWithdraw, submitting, onSubmit, goToStep, onBack,
}) => {
  const t = useTheme();
  const tr = useT();
  const [previewRequirement, setPreviewRequirement] = useState<string | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState('');
  const [consentDetails, setConsentDetails] = useState(false);

  const filesFor = (requirement: string) =>
    documents.find((d) => d.requirement === requirement)?.filePaths ?? [];

  const consentAccepted = Boolean(application.consentAcceptedAt);
  const needed = stillNeeded({
    otpVerified,
    hasName: Boolean(form.fullName.trim()),
    hasCategory: Boolean(form.employmentCategory),
    documentsRequested,
    documents,
  });
  const canSubmit = consentAccepted && needed.length === 0;

  const title = form.employmentCategory === EmploymentCategory.PROPRIETOR
    ? tr('selfRegistration.documents.titleProprietor')
    : form.employmentCategory === EmploymentCategory.FREELANCER
      ? tr('selfRegistration.documents.titleFreelancer')
      : tr('selfRegistration.documents.title');

  const previewFiles = previewRequirement ? filesFor(previewRequirement) : [];
  const previewLabel = previewRequirement ? documentLabel(previewRequirement) : '';

  const primaryButton = (plan: CapturePlan) => (plan.primary === 'files'
    ? { label: tr('selfRegistration.documents.chooseFile'), icon: 'document-attach-outline' }
    : { label: tr('selfRegistration.documents.takePhoto'), icon: 'camera' });
  const secondaryLabel = (plan: CapturePlan) => (plan.secondary === 'gallery'
    ? tr('selfRegistration.documents.orChooseGallery')
    : tr('selfRegistration.documents.orChooseFile'));

  return (
    <View style={{ gap: t.space.lg }}>
      <Card level={1} style={{ gap: t.space.md }}>
        <AppText variant="overline" tone="faint">{title.toUpperCase()}</AppText>
        <AppText variant="small" tone="muted">{tr('selfRegistration.documents.hint')}</AppText>

        {documentsRequested.length === 0 ? (
          <AppText variant="small" tone="muted">{tr('selfRegistration.documents.none')}</AppText>
        ) : (
          <View>
            {documentsRequested.map((requirement, index) => {
              const doc = documents.find((d) => d.requirement === requirement);
              const files = filesFor(requirement);
              const uploaded = files.length > 0;
              const busy = uploadingRequirement === requirement;
              const plan = capturePlanFor(requirement, devices);
              const label = documentLabel(requirement);
              const condition = conditionBadgeKey(requirement);
              const noteKey = rowNoteKey(requirement);
              // Sent back by HR: flagged until a fresh file lands, with HR's words or the standard ones.
              const sentBack = rejectionText(doc, infoRequests);
              const problem = uploadErrors[requirement];
              const primary = primaryButton(plan);

              return (
                <View
                  key={requirement}
                  style={[
                    { gap: t.space.sm, paddingVertical: t.space.md },
                    sentBack
                      ? {
                          borderWidth: 1.5, borderColor: t.colors.warning, borderRadius: t.radius.lg,
                          paddingHorizontal: t.space.md, marginVertical: t.space.xs,
                        }
                      : index > 0
                        ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.border }
                        : null,
                  ]}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: t.space.sm }}>
                    <AppText variant="bodyStrong" style={{ flexShrink: 1 }}>{label}</AppText>
                    {condition ? <Badge label={tr(condition)} tone="neutral" /> : null}
                  </View>

                  {uploaded ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      <Icon name="checkmark-circle" size={16} color={t.colors.success} />
                      <AppText variant="small" tone="success">{tr('selfRegistration.documents.added')}</AppText>
                    </View>
                  ) : noteKey ? (
                    <AppText variant="small" tone="muted">{tr(noteKey)}</AppText>
                  ) : null}

                  {sentBack ? (
                    <AppText variant="small" style={{ color: t.colors.warning, fontWeight: '700' }}>{sentBack}</AppText>
                  ) : null}

                  {uploaded && (
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.md }}>
                      {files.map((filePath, i) => {
                        const key = `${requirement}:${i}`;
                        return (
                          <View key={`${i}-${filePath}`} style={{ alignItems: 'center', gap: 2 }}>
                            <Thumb
                              url={versionedFileUrl(token, requirement, i, filePath)}
                              image={isImageFile(label, filePath, i, files.length)}
                              label={label}
                              onPress={() => setPreviewRequirement(requirement)}
                            />
                            {removing === key
                              ? <ActivityIndicator size="small" color={t.colors.danger} />
                              : (
                                <TextLink
                                  label={tr('selfRegistration.documents.remove')}
                                  tone="danger"
                                  disabled={busy || removing !== null}
                                  onPress={() => onRemove(requirement, i)}
                                />
                              )}
                          </View>
                        );
                      })}
                    </View>
                  )}

                  {problem ? (
                    <View style={{ gap: t.space.xs, backgroundColor: t.colors.dangerSoft, borderRadius: t.radius.md, padding: t.space.sm }}>
                      <AppText variant="small" tone="danger">{problem.message}</AppText>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: t.space.lg }}>
                        {problem.cameraDenied ? (
                          <TextLink label={tr('selfRegistration.documents.openSettings')} onPress={() => { void Linking.openSettings(); }} />
                        ) : (
                          <TextLink label={tr('selfRegistration.documents.retake')} onPress={() => onCapture(requirement, 'primary', uploaded)} disabled={busy} />
                        )}
                        {plan.secondary ? (
                          <TextLink label={secondaryLabel(plan)} onPress={() => onCapture(requirement, 'secondary', uploaded)} disabled={busy} />
                        ) : null}
                      </View>
                    </View>
                  ) : null}

                  {uploaded ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.lg, flexWrap: 'wrap' }}>
                      <Button
                        label={busy ? tr('selfRegistration.documents.uploading') : tr('selfRegistration.documents.retake')}
                        icon={plan.primary === 'files' ? 'document-attach-outline' : 'camera-outline'}
                        variant="neutral"
                        onPress={() => onCapture(requirement, 'primary', true)}
                        loading={busy}
                        disabled={busy || removing !== null}
                      />
                      {plan.secondary && !busy ? (
                        <TextLink label={secondaryLabel(plan)} onPress={() => onCapture(requirement, 'secondary', true)} />
                      ) : null}
                    </View>
                  ) : (
                    <View style={{ gap: 2 }}>
                      <Button
                        label={busy ? tr('selfRegistration.documents.uploading') : primary.label}
                        icon={primary.icon}
                        size="lg"
                        onPress={() => onCapture(requirement, 'primary', false)}
                        loading={busy}
                        disabled={busy}
                        full
                      />
                      {plan.secondary && !busy ? (
                        <TextLink label={secondaryLabel(plan)} onPress={() => onCapture(requirement, 'secondary', false)} center />
                      ) : null}
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        )}
      </Card>

      {/* Only what is missing, and only while something is. */}
      {needed.length > 0 && (
        <Card level={1} style={{ gap: t.space.sm, borderColor: t.colors.warning, borderWidth: 1 }}>
          <AppText variant="bodyStrong">{tr('selfRegistration.checklist.title')}</AppText>
          {needed.map((item) => (
            <Tappable
              key={`${item.key}:${'step' in item ? item.step : item.requirement}`}
              onPress={() => ('step' in item ? goToStep(item.step) : onCapture(item.requirement, 'primary', false))}
              accessibilityRole="link"
              accessibilityLabel={tr(item.key, item.vars)}
              hitSlop={6}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, paddingVertical: 2 }}>
                <Icon name="alert-circle" size={18} color={t.colors.warning} />
                <AppText variant="body" style={{ flex: 1 }}>{tr(item.key, item.vars)}</AppText>
                <Icon name="chevron-forward" size={16} color={t.colors.textFaint} />
              </View>
            </Tappable>
          ))}
        </Card>
      )}

      <StepFooter
        onBack={onBack}
        onContinue={onSubmit}
        continueLabel={tr('selfRegistration.submit.button')}
        continueDisabled={!canSubmit}
        continueLoading={submitting}
      />

      {/* The agreement — one line, below Submit. The legal contact stays; the version sits behind Details. */}
      <View style={{ gap: t.space.xs, paddingHorizontal: t.space.xs }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', columnGap: t.space.sm }}>
          <Icon name="shield-checkmark-outline" size={14} color={t.colors.textMuted} />
          {application.consentAcceptedAt ? (
            <AppText variant="small" tone="muted">
              {tr('selfRegistration.consent.agreedOn', {
                date: new Date(application.consentAcceptedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
              })}
              {' ·'}
            </AppText>
          ) : null}
          <Tappable
            onPress={() => { setWithdrawReason(''); setWithdrawOpen(true); }}
            disabled={withdrawing}
            accessibilityRole="button"
            accessibilityLabel={tr('selfRegistration.consent.withdraw')}
            hitSlop={12}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: t.space.xs }}>
              {withdrawing && <ActivityIndicator size="small" color={t.colors.danger} />}
              <AppText variant="small" tone="danger" style={{ fontWeight: '700', textDecorationLine: 'underline' }}>
                {tr('selfRegistration.consent.withdraw')}
              </AppText>
            </View>
          </Tappable>
          <AppText variant="small" tone="faint">·</AppText>
          <TextLink label={tr('selfRegistration.consent.details')} tone="muted" onPress={() => setConsentDetails((v) => !v)} />
        </View>
        <AppText variant="caption" tone="faint">
          {tr('selfRegistration.consent.grievance', { contact: consentNotice.grievanceContact })}
        </AppText>
        {consentDetails ? (
          <AppText variant="caption" tone="faint">
            {tr('selfRegistration.consent.agreedCopy', { version: application.consentVersion ?? consentNotice.version })}
          </AppText>
        ) : null}
      </View>

      <ModalSheet
        visible={previewRequirement !== null}
        onClose={() => setPreviewRequirement(null)}
        title={previewLabel}
        variant="sheet"
        closeLabel={tr('common.close')}
      >
        <ScrollView contentContainerStyle={{ paddingHorizontal: t.space.xl, paddingBottom: t.space['2xl'], gap: t.space.xl }}>
          {previewRequirement && previewFiles.map((filePath, i) => {
            const count = previewFiles.length;
            const url = versionedFileUrl(token, previewRequirement, i, filePath);
            return (
              <View key={`${i}-${filePath}`} style={{ gap: t.space.sm }}>
                {count > 1 && (
                  <AppText variant="overline" tone="faint">
                    {tr('selfRegistration.documents.previewFile', { index: i + 1, count })}
                  </AppText>
                )}
                {isImageFile(previewLabel, filePath, i, count) ? (
                  <PreviewImage key={url} url={url} />
                ) : (
                  <View style={{ gap: t.space.md, padding: t.space.lg, borderRadius: t.radius.lg, backgroundColor: t.colors.surfaceAlt }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                      <Icon name="document-text-outline" size={24} color={t.colors.textMuted} />
                      <AppText variant="small" tone="muted" style={{ flex: 1 }}>
                        {tr('selfRegistration.documents.previewNotImage')}
                      </AppText>
                    </View>
                    <Button
                      label={tr('selfRegistration.documents.previewOpen')}
                      icon="open-outline"
                      variant="neutral"
                      onPress={() => openFile(url)}
                      full
                    />
                  </View>
                )}
              </View>
            );
          })}
        </ScrollView>
      </ModalSheet>

      <ModalSheet
        visible={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
        title={tr('selfRegistration.consent.withdrawTitle')}
        variant="dialog"
        closeLabel={tr('common.close')}
        avoidKeyboard
        footer={(
          <View style={{ flexDirection: 'row', gap: t.space.sm }}>
            <Stretch>
              <Button label={tr('common.cancel')} variant="neutral" onPress={() => setWithdrawOpen(false)} full />
            </Stretch>
            <Stretch>
              <Button
                label={tr('selfRegistration.consent.withdrawConfirm')}
                variant="danger"
                onPress={() => { onWithdraw(withdrawReason.trim() || undefined); setWithdrawOpen(false); }}
                loading={withdrawing}
                full
              />
            </Stretch>
          </View>
        )}
      >
        <AppText variant="body" tone="muted">{tr('selfRegistration.consent.withdrawBody')}</AppText>
        <Input
          label={tr('selfRegistration.consent.withdrawReason')}
          value={withdrawReason}
          onChangeText={setWithdrawReason}
          multiline
          maxLength={500}
        />
      </ModalSheet>
    </View>
  );
};
