import React, { useState } from 'react';
import { View } from 'react-native';
import * as Location from 'expo-location';
import { AppText, Button, Icon } from './ui/primitives';
import { isPlausibleIndianCoord } from './ui/MapPicker';
import { useFeedback } from './ui/Feedback';
import { useTheme } from '../theme/ThemeProvider';
import { MobileApiService } from '../services/api.service';

/**
 * "We are not sure where you are on the map — is this you?"
 *
 * Shown on the home screen only to assayers the server has flagged (`locationNeedsConfirmation`):
 * the ones whose coordinate is missing or coarser than a pincode, usually because the roster's
 * address geocoded to the middle of a district or state. The person standing at the spot is the
 * one authority that beats any geocoder, so one tap captures their device GPS and pins it — as a
 * MANUAL fix the nightly sweep never moves. Dismissable for the session; it returns next launch
 * until the location is actually fixed.
 */
export function LocationConfirmBanner({
  assayerId,
  onConfirmed,
}: {
  assayerId: string;
  onConfirmed?: () => void;
}) {
  const t = useTheme();
  const feedback = useFeedback();
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [done, setDone] = useState(false);

  if (dismissed || done) return null;

  const confirm = async () => {
    setBusy(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        feedback.warning(
          'Location is off',
          'Allow location access for this app in your phone settings, then try again.',
        );
        return;
      }
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = fix.coords;
      if (!isPlausibleIndianCoord(latitude, longitude)) {
        feedback.error(
          'That does not look right',
          'Your phone reported a position outside India. Try again from where you are based.',
        );
        return;
      }
      const res = await MobileApiService.confirmBaseLocation(assayerId, latitude, longitude);
      if (!res.success) {
        feedback.error('Could not save', res.error || 'Please try again in a moment.');
        return;
      }
      setDone(true);
      feedback.success('Thank you', 'Your location is set. Planners can now find work near you.');
      onConfirmed?.();
    } catch {
      feedback.error(
        'Could not get a fix',
        'Step outside or near a window and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <View
      style={{
        backgroundColor: t.colors.warningSoft,
        borderRadius: t.radius.lg,
        padding: t.space.md,
        gap: t.space.sm,
        marginBottom: t.space.md,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        <Icon name="location-outline" size={18} color={t.colors.warning} />
        <AppText variant="bodyStrong" tone="warning" style={{ flex: 1 }}>
          Confirm where you are based
        </AppText>
      </View>
      <AppText variant="caption" tone="muted">
        We could not place you accurately on the map. Tap below where you live or work from, so we
        send you jobs that are actually close by.
      </AppText>
      <View style={{ flexDirection: 'row', gap: t.space.sm }}>
        <Button
          label="Use my current location"
          icon="navigate"
          variant="primary"
          loading={busy}
          onPress={confirm}
          style={{ flex: 1 }}
        />
        <Button
          label="Not now"
          variant="ghost"
          disabled={busy}
          onPress={() => setDismissed(true)}
        />
      </View>
    </View>
  );
}
