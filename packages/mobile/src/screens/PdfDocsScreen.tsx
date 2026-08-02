import React from 'react';
import { View } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Badge, Button, Card, EmptyState, Icon, Section } from '../components/ui/primitives';

interface PdfDocsScreenProps {
  activeAssignment: AssayerAssignment | null;
  uploadedPdfName: string | null;
  uploadingPdf: boolean;
  onSelectPdfFile: () => void;
  onOpenScanner?: () => void;
  onSubmitCompletedPdf: () => void;
  onOpenExpenseModal: () => void;
}

/**
 * Returning the completed audit packet.
 *
 * Presented as the three ordered steps it actually is — capture, review, submit
 * — because the old screen showed every control at once with no indication of
 * which came first, and left the submit button tappable with nothing attached.
 */
export const PdfDocsScreen: React.FC<PdfDocsScreenProps> = ({
  activeAssignment,
  uploadedPdfName,
  uploadingPdf,
  onSelectPdfFile,
  onOpenScanner,
  onSubmitCompletedPdf,
  onOpenExpenseModal,
}) => {
  const t = useTheme();

  if (!activeAssignment) {
    return (
      <EmptyState
        icon="document-text-outline"
        title="No audit selected"
        body="Open a stop from your route and check in to start returning its paperwork."
      />
    );
  }

  const hasFile = Boolean(uploadedPdfName);

  return (
    <View style={{ gap: t.space.xl }}>
      <Card level={1} style={{ gap: t.space.sm }}>
        <AppText variant="overline" tone="faint">RETURNING PAPERWORK FOR</AppText>
        <AppText variant="h2" numberOfLines={2}>{activeAssignment.branchName}</AppText>
        <AppText variant="small" tone="muted" numberOfLines={2}>{activeAssignment.branchAddress}</AppText>
      </Card>

      <Section title="1 · Capture the audited sheets">
        <Card level={1} style={{ gap: t.space.md }}>
          <AppText variant="small" tone="muted">
            Scan every page of the completed packet, or attach a PDF you have already produced.
          </AppText>
          <View style={{ flexDirection: 'row', gap: t.space.sm }}>
            {onOpenScanner && (
              <Button label="Scan pages" icon="scan" onPress={onOpenScanner} style={{ flex: 1 }} />
            )}
            <Button label="Attach PDF" icon="folder-open-outline" variant="neutral" onPress={onSelectPdfFile} style={{ flex: 1 }} />
          </View>
        </Card>
      </Section>

      <Section title="2 · Review">
        <Card level={1}>
          {hasFile ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
              <View style={{
                width: 40, height: 40, borderRadius: t.radius.md, backgroundColor: t.colors.successSoft,
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon name="document-text" size={19} color={t.colors.success} />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 5 }}>
                <AppText variant="bodyStrong" numberOfLines={1}>{uploadedPdfName}</AppText>
                <View style={{ flexDirection: 'row' }}>
                  <Badge label="Ready to submit" tone="success" dot />
                </View>
              </View>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
              <Icon name="alert-circle-outline" size={19} color={t.colors.textFaint} />
              <AppText variant="small" tone="muted" style={{ flex: 1 }}>
                Nothing captured yet — complete step 1 first.
              </AppText>
            </View>
          )}
        </Card>
      </Section>

      <Section title="3 · Submit">
        <Button
          label={uploadingPdf ? 'Submitting…' : 'Submit to the data entry desk'}
          icon="cloud-upload-outline"
          onPress={onSubmitCompletedPdf}
          loading={uploadingPdf}
          disabled={!hasFile}
          size="lg"
          full
        />
        {!hasFile && (
          <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>
            Capture the sheets before submitting.
          </AppText>
        )}
      </Section>

      <Button label="Log an expense for this trip" icon="receipt-outline" variant="ghost" onPress={onOpenExpenseModal} full />
    </View>
  );
};
