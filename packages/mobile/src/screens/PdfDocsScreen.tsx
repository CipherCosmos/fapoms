import React from 'react';
import { View } from 'react-native';
import { AssayerAssignment } from '../types/mobile-app';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Badge, Button, Card, EmptyState, Icon } from '../components/ui/primitives';

interface PdfDocsScreenProps {
  activeAssignment: AssayerAssignment | null;
  uploadedPdfName: string | null;
  uploadingPdf: boolean;
  onSelectPdfFile: () => void;
  onOpenScanner?: () => void;
  onSubmitCompletedPdf: () => void;
  onOpenExpenseModal: () => void;
  onReportIssue: () => void;
  /** Open the durable uploads list. */
  onOpenUploads: () => void;
  /** How many packets are still sending, and how many have failed — for the status line here. */
  activeUploads?: number;
  failedUploads?: number;
}

/**
 * A step's number and title, at the scale a step in a flow should read at — not the small-caps
 * overline `Section` uses for a settings-style group label. A "1 · Capture…" text heading reads
 * as a label; a filled numbered disc reads as a step, which is what tells an assayer mid-packet
 * they are one of three things done, not browsing a list of options. `done` fills the disc solid
 * (checkmark, success tone) once that step no longer needs attention — step 1 once a file exists,
 * so looking down the flow shows progress at a glance instead of every disc looking identical.
 */
const StepHeader: React.FC<{ index: number; title: string; done?: boolean }> = ({ index, title, done }) => {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
      <View style={{
        width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
        backgroundColor: done ? t.colors.success : t.colors.primarySoft,
      }}>
        {done ? (
          <Icon name="checkmark" size={16} color={t.colors.onPrimary} />
        ) : (
          <AppText variant="bodyStrong" tone="primary">{index}</AppText>
        )}
      </View>
      <AppText variant="h2">{title}</AppText>
    </View>
  );
};

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
  onReportIssue,
  onOpenUploads,
  activeUploads = 0,
  failedUploads = 0,
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
    <View style={{ gap: t.space['3xl'] }}>
      <Card level={1} style={{ gap: t.space.sm }}>
        <AppText variant="overline" tone="faint">RETURNING PAPERWORK FOR</AppText>
        <AppText variant="h2" numberOfLines={2}>{activeAssignment.branchName}</AppText>
        <AppText variant="small" tone="muted" numberOfLines={2}>{activeAssignment.branchAddress}</AppText>
      </Card>

      {/* Step 1: capture. No card here — a step in a flow is an instruction plus one obvious
          action, not a settings group, so it gets the same open canvas the header and the submit
          step get. The only place a bordered surface earns its keep on this screen is around the
          actual document once one exists, below. */}
      <View style={{ gap: t.space.lg }}>
        <StepHeader index={1} title="Capture the audited sheets" done={hasFile} />
        <AppText variant="small" tone="muted">
          Scan every page of the completed packet, or attach a PDF you have already produced.
        </AppText>
        <View style={{ flexDirection: 'row', gap: t.space.sm }}>
          {onOpenScanner && (
            <Button
              label="Scan pages"
              icon="scan"
              onPress={onOpenScanner}
              disabled={uploadingPdf}
              style={{ flex: 1 }}
            />
          )}
          <Button
            label="Attach PDF"
            icon="folder-open-outline"
            variant="neutral"
            onPress={onSelectPdfFile}
            // Re-picking mid-submit would swap the file out from under an upload already in
            // flight, so the source controls lock while the packet is on its way to the desk.
            disabled={uploadingPdf}
            style={{ flex: 1 }}
          />
        </View>
      </View>

      {/* Step 2: review. The one restrained card on this screen — it frames the actual
          document that resulted from step 1, the way a thumbnail earns a bordered surface
          where a plain instruction does not. */}
      <View style={{ gap: t.space.lg }}>
        <StepHeader index={2} title="Review" />
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
                  {uploadingPdf ? (
                    <Badge label="Uploading…" tone="info" dot />
                  ) : (
                    <Badge label="Ready to submit" tone="success" dot />
                  )}
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
      </View>

      {/* Step 3: submit. One obvious primary action, full-width, nothing competing with it. */}
      <View style={{ gap: t.space.lg }}>
        <StepHeader index={3} title="Submit" />
        <Button
          label={uploadingPdf ? 'Submitting…' : 'Submit to the data entry desk'}
          icon="cloud-upload-outline"
          onPress={onSubmitCompletedPdf}
          loading={uploadingPdf}
          disabled={!hasFile || uploadingPdf}
          size="lg"
          full
        />
        {!hasFile && (
          <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>
            Capture the sheets before submitting.
          </AppText>
        )}
        {/* The packet is handed to the durable outbox and sent in the background, so — unlike
            before — the assayer is explicitly freed to leave. A weak-signal transfer keeps going
            and its progress is watchable in Uploads. */}
        <AppText variant="caption" tone="faint" style={{ textAlign: 'center' }}>
          Once submitted, the packet sends in the background. You can leave this screen — it keeps going, even on weak signal.
        </AppText>
      </View>

      {/* The uploads outbox: what is still on its way to the desk, and anything that failed and
          needs a retry. Shown here (where packets are filed) so a failed one is impossible to
          miss, and always openable so the assayer can check a packet actually arrived. */}
      {(activeUploads > 0 || failedUploads > 0) ? (
        <Card
          level={1}
          onPress={onOpenUploads}
          style={{
            gap: t.space.xs,
            borderLeftWidth: 3,
            borderLeftColor: failedUploads > 0 ? t.colors.danger : t.colors.primary,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
            <Icon
              name={failedUploads > 0 ? 'alert-circle' : 'cloud-upload-outline'}
              size={20}
              color={failedUploads > 0 ? t.colors.danger : t.colors.primary}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <AppText variant="bodyStrong">
                {failedUploads > 0
                  ? `${failedUploads} packet${failedUploads === 1 ? '' : 's'} not sent`
                  : `${activeUploads} packet${activeUploads === 1 ? '' : 's'} sending`}
              </AppText>
              <AppText variant="caption" tone="muted">
                {failedUploads > 0 ? 'Tap to retry the ones that failed.' : 'Tap to see progress.'}
              </AppText>
            </View>
            {failedUploads > 0 ? <Badge label="Action needed" tone="danger" dot /> : <Badge label="Sending" tone="info" dot />}
          </View>
        </Card>
      ) : (
        <Button label="View my uploads" icon="cloud-upload-outline" variant="ghost" onPress={onOpenUploads} />
      )}

      <View style={{ flexDirection: 'row', gap: t.space.sm }}>
        <Button label="Log an expense" icon="receipt-outline" variant="ghost" onPress={onOpenExpenseModal} style={{ flex: 1 }} />
        {/* The field app's one route to raise a problem to the desk — it cannot cancel or
            reassign the job, so this is how an assayer signals "I can't do this / something's
            wrong" and the desk picks it up. */}
        <Button label="Report an issue" icon="flag-outline" variant="ghost" onPress={onReportIssue} style={{ flex: 1 }} />
      </View>
    </View>
  );
};
