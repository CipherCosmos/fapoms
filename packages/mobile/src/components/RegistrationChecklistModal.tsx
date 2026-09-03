import React, { useMemo, useState } from 'react';
import { Modal, ScrollView, View, Platform } from 'react-native';
import * as Location from 'expo-location';
import { useTheme } from '../theme/ThemeProvider';
import { AppText, Badge, Button, Card, CollapsibleSection, Icon, IconButton, ProgressBar } from './ui/primitives';
import { isPlausibleIndianCoord } from './ui/MapPicker';
import { useFeedback } from './ui/Feedback';
import { MobileApiService, type RegistrationChecklist } from '../services/api.service';
import type { OutboxUpload } from '../services/upload-outbox';
import { buildChecklistRows, checklistProgress, type ChecklistRow, type ChecklistRowState } from '../services/registration-checklist';
import { DocumentScanner } from './DocumentScanner';
import { useT, serverErrorText, type TranslationKey } from '../i18n';

interface RegistrationChecklistModalProps {
  visible: boolean;
  onClose: () => void;
  checklist: RegistrationChecklist | null;
  uploads: OutboxUpload[];
  /** Hands one captured document to the durable outbox. Wired to the app's single outbox. */
  onCapture: (requirement: string, documentLabel: string, fileName: string, fileUri: string) => Promise<void>;
  onRetry: (id: string) => void;
  /** Re-reads the checklist from the server after something changes. */
  onReload: () => void;
  /** The signed-in assayer. Used only for the address pin. */
  assayerId: string;
  /** True when the server says this person's map position is missing or too coarse to use. */
  locationNeedsConfirmation: boolean;
  onLocationConfirmed: () => void;
}

/**
 * How each row reads and looks. Deliberately five short words or fewer.
 *
 * The badge holds a catalogue key rather than a sentence: this map is module-scope (see the
 * note on the row components below) and so is evaluated once, before any language is chosen,
 * where a translated string would freeze at whatever locale happened to be active at import.
 */
const ROW_STATE: Record<ChecklistRowState, { labelKey: TranslationKey; tone: 'success' | 'info' | 'warning' | 'danger'; icon: string }> = {
  RECEIVED: { labelKey: 'registration.state.received', tone: 'success', icon: 'checkmark-circle' },
  SENDING: { labelKey: 'registration.state.sending', tone: 'info', icon: 'cloud-upload-outline' },
  FAILED: { labelKey: 'registration.state.failed', tone: 'danger', icon: 'alert-circle-outline' },
  NEEDED: { labelKey: 'registration.state.needed', tone: 'warning', icon: 'ellipse-outline' },
};

const DocumentRow: React.FC<{
  row: ChecklistRow;
  onTake: (row: ChecklistRow) => void;
  onRetry?: () => void;
}> = ({ row, onTake, onRetry }) => {
  const t = useTheme();
  const tr = useT();
  const s = ROW_STATE[row.state];
  const done = row.state === 'RECEIVED';

  return (
    <Card level={1} style={{ gap: t.space.sm }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <Icon
          name={s.icon}
          size={22}
          color={
            s.tone === 'success' ? t.colors.success
            : s.tone === 'danger' ? t.colors.danger
            : s.tone === 'warning' ? t.colors.warning
            : t.colors.primary
          }
        />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <AppText variant="bodyStrong" numberOfLines={2}>{row.label}</AppText>
          {!done && !!row.hintKey && (
            <AppText variant="caption" tone="muted">{tr(row.hintKey)}</AppText>
          )}
        </View>
        <Badge label={tr(s.labelKey)} tone={s.tone} dot />
      </View>

      {row.state === 'FAILED' && (
        <Button label={tr('common.tryAgain')} icon="refresh" onPress={() => (onRetry ? onRetry() : onTake(row))} full />
      )}
      {row.state === 'NEEDED' && (
        <Button label={tr('registration.takePhoto')} icon="camera-outline" onPress={() => onTake(row)} full />
      )}
      {row.state === 'RECEIVED' && (
        <AppText variant="caption" tone="faint">
          {row.fileCount > 1 ? tr('registration.photosReceived', { count: row.fileCount }) : tr('registration.haveThis')}
        </AppText>
      )}
    </Card>
  );
};

/**
 * "What the office still needs from you."
 *
 * Registration document capture did not exist on this app at all: the only trace of it was a
 * comment in the API service recording that a previous attempt had been deleted for posting to a
 * route that never existed. The routes to *write* a document have accepted an assayer's own
 * uploads for some time; what was missing was any way for the person to find out what was
 * wanted, which is what `GET /assayers/:id/registration-checklist` now answers.
 *
 * **This screen is an accelerator and must never become a gate.** HR completes registrations from
 * the desk, for people with no smartphone and people with no signal, and that has to keep
 * working. So: nothing here blocks any other part of the app, there is no nagging, the screen
 * says out loud that the office can do this instead, and a checklist that fails to load simply
 * does not appear.
 *
 * The capture path is the one already in the app — the same ML Kit scanner used for audit
 * packets, and the same durable outbox — because a registration scan has exactly the audit
 * packet's problem: a photograph taken in a place with no signal, which must survive the app
 * being killed and send itself later.
 */
export const RegistrationChecklistModal: React.FC<RegistrationChecklistModalProps> = ({
  visible,
  onClose,
  checklist,
  uploads,
  onCapture,
  onRetry,
  onReload,
  assayerId,
  locationNeedsConfirmation,
  onLocationConfirmed,
}) => {
  const t = useTheme();
  const tr = useT();
  const feedback = useFeedback();
  const [capturing, setCapturing] = useState<ChecklistRow | null>(null);
  const [pinning, setPinning] = useState(false);
  const [pinned, setPinned] = useState(false);

  const rows = useMemo(
    () => buildChecklistRows(checklist?.items ?? [], uploads),
    [checklist, uploads],
  );
  const progress = useMemo(() => checklistProgress(rows), [rows]);

  const required = rows.filter((r) => !r.optional);
  const todo = required.filter((r) => r.state === 'NEEDED' || r.state === 'FAILED');
  const inFlight = required.filter((r) => r.state === 'SENDING');
  const done = required.filter((r) => r.state === 'RECEIVED');
  const optional = rows.filter((r) => r.optional && r.state !== 'RECEIVED');

  const latestUploadFor = (requirement: string) =>
    [...uploads]
      .filter((u) => u.target.kind === 'REGISTRATION_DOCUMENT' && u.target.requirement === requirement)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  /**
   * Pin the person's home on the map from where they are standing.
   *
   * Same one-tap action as the home screen's location banner, and it writes through the same
   * `confirmBaseLocation` route, so there is one way this fact gets set rather than two that can
   * disagree. It appears here because "where do you live" belongs with the rest of registration
   * from the worker's point of view, even though the server stores it on a different record.
   */
  const confirmLocation = async () => {
    setPinning(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        feedback.warning(tr('registration.home.locationOffTitle'), tr('registration.home.locationOffBody'));
        return;
      }
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = fix.coords;
      if (!isPlausibleIndianCoord(latitude, longitude)) {
        feedback.error(tr('registration.home.outsideIndiaTitle'), tr('registration.home.outsideIndiaBody'));
        return;
      }
      const res = await MobileApiService.confirmBaseLocation(assayerId, latitude, longitude);
      if (!res.success) {
        feedback.error(tr('registration.home.saveFailedTitle'), serverErrorText(res.error, 'registration.home.saveFailedBody'));
        return;
      }
      setPinned(true);
      feedback.success(tr('registration.home.thanksTitle'), tr('registration.home.thanksBody'));
      onLocationConfirmed();
    } catch {
      feedback.error(tr('registration.home.noFixTitle'), tr('registration.home.noFixBody'));
    } finally {
      setPinning(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" transparent={false} onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.colors.bg }}>
        <View
          style={{
            paddingTop: Platform.OS === 'ios' ? 50 : 20,
            paddingHorizontal: t.space.lg,
            paddingBottom: t.space.md,
            backgroundColor: t.colors.surface,
            flexDirection: 'row',
            alignItems: 'center',
            gap: t.space.md,
            borderBottomWidth: 1,
            borderColor: t.colors.border,
          }}
        >
          <IconButton icon="arrow-back" onPress={onClose} accessibilityLabel={tr('common.back')} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="h3" numberOfLines={1}>{tr('registration.title')}</AppText>
            <AppText variant="caption" tone="muted" numberOfLines={1}>
              {tr('registration.progress', { done: progress.done, required: progress.required })}
            </AppText>
          </View>
        </View>

        <ScrollView contentContainerStyle={{ padding: t.space.lg, gap: t.space.md }}>
          <View style={{ gap: t.space.sm }}>
            <ProgressBar
              value={progress.required === 0 ? 0 : progress.done / progress.required}
              tone={progress.outstanding === 0 ? 'success' : 'primary'}
            />
            {/*
              Said first, and said plainly. A checklist of missing documents reads as a threat to
              somebody whose work depends on being approved, and the true thing is reassuring:
              this screen saves them a trip, it does not decide anything. Registrations are
              completed at the desk every day for people who never open this app.
            */}
            <AppText variant="small" tone="muted">{tr('registration.reassurance')}</AppText>
          </View>

          {todo.length > 0 && (
            <View style={{ gap: t.space.md }}>
              <AppText variant="h3">{tr('registration.stillNeeded')}</AppText>
              {todo.map((row) => (
                <DocumentRow
                  key={row.requirement}
                  row={row}
                  onTake={setCapturing}
                  onRetry={
                    row.state === 'FAILED'
                      ? () => {
                          const entry = latestUploadFor(row.requirement);
                          if (entry) onRetry(entry.id);
                          else setCapturing(row);
                        }
                      : undefined
                  }
                />
              ))}
            </View>
          )}

          {inFlight.length > 0 && (
            <View style={{ gap: t.space.md }}>
              <AppText variant="h3">{tr('registration.onTheWay')}</AppText>
              {inFlight.map((row) => (
                <DocumentRow key={row.requirement} row={row} onTake={setCapturing} />
              ))}
              <AppText variant="caption" tone="muted">{tr('registration.onTheWayNote')}</AppText>
            </View>
          )}

          {(locationNeedsConfirmation && !pinned) && (
            <View style={{ gap: t.space.md }}>
              <AppText variant="h3">{tr('registration.home.title')}</AppText>
              <Card level={1} style={{ gap: t.space.sm }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                  <Icon name="location-outline" size={22} color={t.colors.warning} />
                  <AppText variant="bodyStrong" style={{ flex: 1 }}>{tr('registration.home.setHomeArea')}</AppText>
                </View>
                <AppText variant="caption" tone="muted">{tr('registration.home.body')}</AppText>
                <Button
                  label={tr('registration.home.useCurrent')}
                  icon="navigate"
                  loading={pinning}
                  onPress={confirmLocation}
                  full
                />
              </Card>
            </View>
          )}

          {done.length > 0 && (
            <CollapsibleSection
              title={tr('registration.alreadyWithOffice', { count: done.length })}
              defaultOpen={todo.length === 0}
            >
              <View style={{ gap: t.space.md }}>
                {done.map((row) => (
                  <DocumentRow key={row.requirement} row={row} onTake={setCapturing} />
                ))}
              </View>
            </CollapsibleSection>
          )}

          {optional.length > 0 && (
            <CollapsibleSection
              title={tr('registration.otherPapers')}
              summary={tr('registration.otherPapersHint')}
            >
              <View style={{ gap: t.space.md }}>
                {optional.map((row) => (
                  <DocumentRow key={row.requirement} row={row} onTake={setCapturing} />
                ))}
              </View>
            </CollapsibleSection>
          )}

          {todo.length === 0 && inFlight.length === 0 && progress.required > 0 && (
            <Card level={1} style={{ gap: t.space.sm, alignItems: 'center' }}>
              <Icon name="checkmark-circle" size={34} color={t.colors.success} />
              <AppText variant="bodyStrong">{tr('registration.allDoneTitle')}</AppText>
              <AppText variant="caption" tone="muted" style={{ textAlign: 'center' }}>
                {tr('registration.allDoneBody')}
              </AppText>
            </Card>
          )}
        </ScrollView>
      </View>

      {capturing && (
        <DocumentScanner
          visible
          purpose={capturing.label}
          onClose={() => setCapturing(null)}
          onSaved={async (doc) => {
            // Narrowed by this render, the way the audit-packet scanner call site does it, so the
            // requirement cannot go null underneath the upload if the person closes the screen.
            const row = capturing;
            setCapturing(null);

            // A single card or form. Prefer the assembled PDF when ML Kit made one, otherwise the
            // first page image — the server accepts both, and there is no case where a
            // registration document needs pages sent as separate uploads.
            const uri = doc.pdfUri ?? doc.pages[0]?.uri;
            if (!uri) {
              feedback.error(tr('registration.capture.nothingTitle'), tr('registration.capture.nothingBody'));
              return;
            }
            await onCapture(row.requirement, row.label, doc.fileName, uri);
            feedback.success(tr('registration.capture.addedTitle'), tr('registration.capture.addedBody', { document: row.label }));
            onReload();
          }}
        />
      )}
    </Modal>
  );
};
