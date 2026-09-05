import React, { useCallback, useEffect, useState } from 'react';
import { View, Image, Pressable } from 'react-native';
import { AppText, Avatar, Icon } from './ui/primitives';
import { useTheme } from '../theme/ThemeProvider';
import { useT } from '../i18n';
import { MobileApiService } from '../services/api.service';
import { scanDocument, isDocumentScannerAvailable } from '../../modules/document-scanner';

/**
 * FAPOMS — the appraiser's own face, and the only way they can change it.
 *
 * ## Why this exists
 *
 * The record has had somewhere to keep a photograph for as long as it has existed, the API has had
 * a route to read one, and the web record page has drawn it with an initials fallback throughout.
 * Yet **0 of 1,163 people had one**, because the single path to putting one there was the
 * onboarding checklist — a screen that is only mounted while `registrationInProgress` is true, and
 * which nobody has been through. An appraiser who joined last year had no way to supply a
 * photograph at all, and no way to replace one that was wrong.
 *
 * That matters more than it sounds. Field staff are dispatched to bank branches by people who have
 * never met them, and the branch expecting somebody has no way to know who turned up.
 *
 * ## The capture path, and its honest limitation
 *
 * This reuses the ML Kit scanner already in the app, in `base` mode — capture only, no cropping
 * editor — with gallery import left on. A document scanner is not the right instrument for a face
 * and this is not pretending otherwise: what makes it workable is the gallery, so anybody can take
 * a photograph with the camera app they already know and import it here.
 *
 * A proper front-camera capture needs `expo-image-picker` or `expo-camera`, which is a dependency
 * added to a project that ships a custom dev client — a rebuild, not a code change. That is a
 * decision worth taking deliberately rather than smuggling in behind a photograph.
 */
export const ProfilePhoto: React.FC<{
  assayerId: string;
  name: string;
  /** Hands the captured file to the durable outbox, exactly as the checklist does. */
  onCapture: (requirement: string, documentLabel: string, fileName: string, fileUri: string) => Promise<void>;
  size?: number;
}> = ({ assayerId, name, onCapture, size = 72 }) => {
  const t = useTheme();
  const tr = useT();
  const [uri, setUri] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Fetched through the API rather than pointed at by a URL.
   *
   * The photo route needs an Authorization header and deliberately never issues a signed URL — a
   * signed URL is a bearer credential for that image which survives being pasted anywhere. A 404
   * is the ordinary case here, not an error: most records have no photograph, and initials are a
   * better answer than a broken image.
   */
  const load = useCallback(async () => {
    if (!assayerId) return;
    const data = await MobileApiService.fetchAssayerPhoto(assayerId);
    setUri(data);
  }, [assayerId]);

  useEffect(() => { void load(); }, [load]);

  const change = async () => {
    if (!isDocumentScannerAvailable()) return;
    setBusy(true);
    try {
      // One page, capture only, gallery allowed — see the note at the top of this file.
      const result = await scanDocument({ pageLimit: 1, scannerMode: 'base', galleryImportAllowed: true });
      const page = result?.pages?.[0]?.uri;
      if (!page) return;
      await onCapture('PHOTOGRAPH', tr('profile.photo.label'), 'photo.jpg', page);
      /**
       * Shown immediately from the local file, before the upload has been anywhere.
       *
       * The outbox is durable and may hold this for hours on a bad link. Waiting for the server to
       * confirm before showing the new face would leave somebody looking at their old photograph
       * after they had just replaced it, and the obvious response to that is to do it again.
       */
      setUri(page);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Pressable
      onPress={() => { void change(); }}
      disabled={busy || !isDocumentScannerAvailable()}
      accessibilityRole="button"
      accessibilityLabel={tr(uri ? 'profile.photo.change' : 'profile.photo.add')}
      style={{ position: 'relative' }}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: t.colors.surfaceAlt }}
          resizeMode="cover"
        />
      ) : (
        <Avatar name={name} size={size} />
      )}

      {/* A camera badge over the corner, which is how every phone signals "this picture is
          yours to change" — a labelled button underneath would say the same thing twice. */}
      {isDocumentScannerAvailable() && (
        <View
          style={{
            position: 'absolute', right: -2, bottom: -2,
            width: 26, height: 26, borderRadius: 13,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: t.colors.primary,
            borderWidth: 2, borderColor: t.colors.bg,
          }}
        >
          <Icon name={busy ? 'hourglass-outline' : 'camera'} size={13} color={t.colors.onPrimary} />
        </View>
      )}
    </Pressable>
  );
};

/** The line under the avatar, so the tap target is discoverable without being a second button. */
export const ProfilePhotoHint: React.FC<{ hasPhoto: boolean }> = ({ hasPhoto }) => {
  const tr = useT();
  return (
    <AppText variant="caption" tone="muted">
      {tr(hasPhoto ? 'profile.photo.changeHint' : 'profile.photo.addHint')}
    </AppText>
  );
};
