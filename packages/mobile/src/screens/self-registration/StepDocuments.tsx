import React, { useState } from 'react';
import { ActivityIndicator, Image, Linking, ScrollView, StyleSheet, View } from 'react-native';
import {
  EmploymentCategory,
  ONBOARDING_DOCUMENT_LABELS,
  REGISTRATION_CONDITIONAL_DOCUMENTS, REGISTRATION_REQUIRED_DOCUMENTS,
  scanMimeType,
  storedScanFileName,
  type ApplicationInfoRequestItem,
  type OnboardingDocument,
  type RegistrationFormValues,
} from '@fapoms/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { AppText, Badge, Button, Card, Icon, Input, ModalSheet, Tappable } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { hintKeyFor } from '../../services/registration-checklist';
import {
  SelfRegistrationApi,
  type RegistrationApplication,
  type RegistrationDocument,
  type RegistrationHydration,
} from '../../services/self-registration.service';
import { GroupHeader, StepFooter, Stretch } from './parts';

export interface StepDocumentsProps {
  token: string;
  form: RegistrationFormValues;
  application: RegistrationApplication;
  consentNotice: RegistrationHydration['consentNotice'];
  documents: RegistrationDocument[];
  documentsRequested: string[];
  /** Exactly what HR asked for — sent-back rows render their own instruction. */
  infoRequests?: ApplicationInfoRequestItem[];
  uploadingRequirement: string | null;
  uploadErrors: Record<string, string | undefined>;
  /** Opens the camera/file scanner for a requirement; the orchestrator uploads the result. */
  onCapture: (requirement: string) => void;
  otpVerified: boolean;
  phone: string;
  withdrawing: boolean;
  onWithdraw: (reason: string | undefined) => void;
  submitting: boolean;
  onSubmit: () => void;
  goToStep: (step: number) => void;
  onBack: () => void;
}

const labelFor = (requirement: string) =>
  ONBOARDING_DOCUMENT_LABELS[requirement as OnboardingDocument] ?? requirement;

// A replaced scan keeps the same URL, so the stored key's hash busts the image cache.
function versionedFileUrl(token: string, requirement: string, index: number, filePath: string): string {
  let h = 0;
  for (let i = 0; i < filePath.length; i++) h = (h * 31 + filePath.charCodeAt(i)) | 0;
  return `${SelfRegistrationApi.documentFileUrl(token, requirement, index)}?v=${(h >>> 0).toString(36)}`;
}

function openFile(url: string) {
  void Linking.openURL(url).catch(() => undefined);
}

const PreviewImage: React.FC<{ url: string }> = ({ url }) => {
  const t = useTheme();
  const tr = useT();
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <Button
        label={tr('selfRegistration.documents.previewOpen')}
        icon="open-outline"
        variant="neutral"
        onPress={() => openFile(url)}
        full
      />
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

const ChecklistRow: React.FC<{ done: boolean; label: string; detail?: string; linkLabel?: string; onLink?: () => void }> = ({
  done, label, detail, linkLabel, onLink,
}) => {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
      <Icon
        name={done ? 'checkmark-circle' : 'alert-circle'}
        size={22}
        color={done ? t.colors.success : t.colors.warning}
      />
      <View style={{ flex: 1 }}>
        <AppText variant="body">{label}</AppText>
        {detail ? <AppText variant="caption" tone="faint">{detail}</AppText> : null}
      </View>
      {!done && linkLabel && onLink ? (
        <Tappable onPress={onLink} accessibilityRole="link" accessibilityLabel={linkLabel} hitSlop={12}>
          <AppText variant="small" tone="primary" style={{ fontWeight: '700', paddingVertical: t.space.xs }}>
            {linkLabel}
          </AppText>
        </Tappable>
      ) : null}
    </View>
  );
};

export const StepDocuments: React.FC<StepDocumentsProps> = ({
  token, form, application, consentNotice, documents, documentsRequested, infoRequests = [],
  uploadingRequirement, uploadErrors,
  onCapture, otpVerified, phone, withdrawing, onWithdraw, submitting, onSubmit, goToStep, onBack,
}) => {
  const t = useTheme();
  const tr = useT();
  const [previewRequirement, setPreviewRequirement] = useState<string | null>(null);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState('');

  const filesFor = (requirement: string) =>
    documents.find((d) => d.requirement === requirement)?.filePaths ?? [];

  const hasName = Boolean(form.fullName.trim());
  const hasCategory = Boolean(form.employmentCategory);
  const consentAccepted = Boolean(application.consentAcceptedAt);
  const hasPhoto = filesFor('PHOTOGRAPH').length > 0;
  const canSubmit = hasName && hasCategory && consentAccepted && otpVerified && hasPhoto;

  const title = form.employmentCategory === EmploymentCategory.PROPRIETOR
    ? tr('selfRegistration.documents.titleProprietor')
    : form.employmentCategory === EmploymentCategory.FREELANCER
      ? tr('selfRegistration.documents.titleFreelancer')
      : tr('selfRegistration.documents.title');

  const previewFiles = previewRequirement ? filesFor(previewRequirement) : [];
  const previewLabel = previewRequirement ? labelFor(previewRequirement) : '';

  const openWithdraw = () => {
    setWithdrawReason('');
    setWithdrawOpen(true);
  };

  const confirmWithdraw = () => {
    onWithdraw(withdrawReason.trim() || undefined);
    setWithdrawOpen(false);
  };

  return (
    <View style={{ gap: t.space.lg }}>
      <Card level={1} style={{ gap: t.space.md }}>
        <AppText variant="overline" tone="faint">{title.toUpperCase()}</AppText>
        <AppText variant="small" tone="muted">{tr('selfRegistration.documents.hint')}</AppText>

        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: t.space.md,
          padding: t.space.md, borderRadius: t.radius.lg, backgroundColor: t.colors.surfaceAlt,
        }}>
          <View style={{
            width: 44, height: 44, borderRadius: t.radius.md, backgroundColor: t.colors.primarySoft,
            alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon name="camera" size={22} color={t.colors.primary} />
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <AppText variant="bodyStrong">{tr('selfRegistration.documents.photoTitle')}</AppText>
            <AppText variant="small" tone="muted">{tr('selfRegistration.documents.photoBody')}</AppText>
          </View>
        </View>

        {documentsRequested.length === 0 ? (
          <AppText variant="small" tone="muted">{tr('selfRegistration.documents.none')}</AppText>
        ) : (
          <View>
            {documentsRequested.map((requirement, index) => {
              const doc = documents.find((d) => d.requirement === requirement);
              const files = filesFor(requirement);
              const uploaded = files.length > 0;
              const busy = uploadingRequirement === requirement;
              const isPhoto = requirement === 'PHOTOGRAPH';
              const isConditional = REGISTRATION_CONDITIONAL_DOCUMENTS.includes(requirement);
              // Sent back by HR: flagged until a fresh scan lands, with HR's own words.
              const sentBack = doc?.reviewStatus === 'NEEDS_RESUBMIT';
              const sentBackMessage = infoRequests.find((i) => i.kind === 'document' && i.key === requirement)?.message
                ?? doc?.rejectionNote
                ?? null;
              const highlight = (isPhoto && !uploaded) || sentBack;
              const hintKey = uploaded ? null : hintKeyFor(requirement);
              const error = uploadErrors[requirement];

              // Enforced at submit — the other "Required" badges are advice, this one is a refusal.
              const blocksSubmit = REGISTRATION_REQUIRED_DOCUMENTS.includes(requirement);
              const badge = isPhoto
                ? <Badge label={tr('selfRegistration.documents.badgePhoto')} tone="primary" />
                : blocksSubmit
                  ? <Badge label={tr('selfRegistration.documents.badgeNeededToSubmit')} tone="primary" />
                  : isConditional
                  ? <Badge label={tr('selfRegistration.documents.badgeIfApplicable')} tone="neutral" />
                  : <Badge label={tr('selfRegistration.documents.badgeRequired')} tone="accent" />;

              const status = uploaded
                ? (files.length > 1
                  ? tr('selfRegistration.documents.addedMany', { count: files.length })
                  : tr('selfRegistration.documents.added'))
                : isPhoto
                  ? tr('selfRegistration.documents.photoPending')
                  : requirement === 'BANK_PASSBOOK'
                    ? tr('selfRegistration.documents.passbookNote')
                  : requirement === 'RENT_AGREEMENT'
                    ? tr('selfRegistration.documents.rentAgreementNote')
                    : requirement === 'ELECTRICITY_BILL'
                      ? tr('selfRegistration.documents.electricityBillNote')
                      : tr('selfRegistration.documents.pending');

              return (
                <View
                  key={requirement}
                  style={[
                    { gap: t.space.sm, paddingVertical: t.space.md },
                    highlight
                      ? {
                          borderWidth: 1.5,
                          borderColor: sentBack ? t.colors.warning : t.colors.primary,
                          borderRadius: t.radius.lg,
                          paddingHorizontal: t.space.md, marginVertical: t.space.xs,
                        }
                      : index > 0
                        ? { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.colors.border }
                        : null,
                  ]}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: t.space.sm }}>
                    <AppText variant="bodyStrong" style={{ flexShrink: 1 }}>{labelFor(requirement)}</AppText>
                    {badge}
                  </View>

                  {/* One line per row: the photo tip says what "not added yet" would, and more usefully. */}
                  {hintKey && !isConditional ? (
                    <AppText variant="small" tone="muted">{tr(hintKey)}</AppText>
                  ) : (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                      {uploaded && <Icon name="checkmark-circle" size={16} color={t.colors.success} />}
                      <AppText variant="small" tone={uploaded ? 'success' : 'muted'} style={{ flex: 1 }}>{status}</AppText>
                    </View>
                  )}
                  {error ? <AppText variant="caption" tone="danger">{error}</AppText> : null}
                  {sentBack && sentBackMessage ? (
                    <AppText variant="small" style={{ color: t.colors.warning, fontWeight: '700' }}>
                      {sentBackMessage}
                    </AppText>
                  ) : null}

                  {uploaded ? (
                    <View style={{ flexDirection: 'row', gap: t.space.sm }}>
                      <Stretch>
                        <Button
                          label={tr('selfRegistration.documents.check')}
                          icon="eye-outline"
                          variant="neutral"
                          onPress={() => setPreviewRequirement(requirement)}
                          full
                        />
                      </Stretch>
                      <Stretch>
                        <Button
                          label={tr('selfRegistration.documents.replace')}
                          icon="camera-outline"
                          variant="neutral"
                          onPress={() => onCapture(requirement)}
                          loading={busy}
                          disabled={busy}
                          full
                        />
                      </Stretch>
                    </View>
                  ) : (
                    <Button
                      label={tr('selfRegistration.documents.add')}
                      icon="camera-outline"
                      onPress={() => onCapture(requirement)}
                      loading={busy}
                      disabled={busy}
                      full
                    />
                  )}
                </View>
              );
            })}
          </View>
        )}
      </Card>

      <Card level={1} style={{ gap: t.space.md }}>
        <GroupHeader icon="shield-checkmark-outline" title={tr('selfRegistration.consent.agreementTitle')} />
        {application.consentAcceptedAt ? (
          <AppText variant="small" tone="muted">
            {tr('selfRegistration.consent.agreedOn', {
              date: new Date(application.consentAcceptedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
              version: application.consentVersion ?? consentNotice.version,
            })}
          </AppText>
        ) : null}
        <AppText variant="caption" tone="muted">
          {tr('selfRegistration.consent.grievance', { contact: consentNotice.grievanceContact })}
        </AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: t.space.md }}>
          {consentAccepted && <Badge label={tr('selfRegistration.consent.agreed')} tone="success" icon="checkmark" />}
          <Tappable
            onPress={openWithdraw}
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
        </View>
      </Card>

      <Card level={1} style={{ gap: t.space.md }}>
        <AppText variant="overline" tone="faint">{tr('selfRegistration.checklist.title').toUpperCase()}</AppText>
        <ChecklistRow
          done={otpVerified}
          label={tr('selfRegistration.checklist.phone')}
          detail={phone ? `+91 ${phone}` : undefined}
          linkLabel={tr('selfRegistration.checklist.goStep1')}
          onLink={() => goToStep(1)}
        />
        <ChecklistRow
          done={hasName}
          label={tr('selfRegistration.checklist.fullName')}
          linkLabel={tr('selfRegistration.checklist.goStep1')}
          onLink={() => goToStep(1)}
        />
        <ChecklistRow
          done={hasCategory}
          label={tr('selfRegistration.checklist.category')}
          linkLabel={tr('selfRegistration.checklist.goStep3')}
          onLink={() => goToStep(3)}
        />
        <ChecklistRow
          done={hasPhoto}
          label={tr('selfRegistration.checklist.photo')}
          linkLabel={tr('selfRegistration.checklist.goPhoto')}
          onLink={() => onCapture('PHOTOGRAPH')}
        />
        <ChecklistRow done={consentAccepted} label={tr('selfRegistration.checklist.consent')} />
        {!canSubmit && (
          <AppText variant="caption" tone="faint">{tr('selfRegistration.checklist.hint')}</AppText>
        )}
      </Card>

      <StepFooter
        onBack={onBack}
        onContinue={onSubmit}
        continueLabel={tr('selfRegistration.submit.button')}
        continueDisabled={!canSubmit}
        continueLoading={submitting}
      />

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
            const fileName = storedScanFileName(previewLabel, filePath, count > 1 ? i + 1 : undefined);
            const url = versionedFileUrl(token, previewRequirement, i, filePath);
            const isImage = (scanMimeType(fileName) ?? '').startsWith('image/');
            return (
              <View key={`${i}-${filePath}`} style={{ gap: t.space.sm }}>
                {count > 1 && (
                  <AppText variant="overline" tone="faint">
                    {tr('selfRegistration.documents.previewFile', { index: i + 1, count })}
                  </AppText>
                )}
                {isImage ? (
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
                onPress={confirmWithdraw}
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
