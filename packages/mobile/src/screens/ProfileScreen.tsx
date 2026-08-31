import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, TextInput, TextStyle, Modal, Alert, Dimensions, ScrollView, ActivityIndicator } from 'react-native';
import * as Location from 'expo-location';
import { useTheme, ThemePreference } from '../theme/ThemeProvider';
import {
  AppText, Avatar, Badge, Button, Card, GroupedRow, GroupedSection, GroupedSwitch,
  Icon, IconName, StatTile, Tappable,
} from '../components/ui/primitives';
import { SubScreen, useStackNav } from '../components/ui/SimpleStack';
import { ChangePasswordScreen } from './ChangePasswordScreen';
import { useLocation } from '../context/LocationContext';
// INDIAN_STATES and canonicalStateName are the SAME canonical list the backend validates a saved
// address against (assayer.service.ts → assertAddressConsistent rejects anything else outright), so
// the state field is a picker over that list rather than a free-text box that can only fail.
import { formatRupees as money, INDIAN_STATES, canonicalStateName } from '@fapoms/shared';
import { MapPicker, isPlausibleIndianCoord, INDIA_CENTRE } from '../components/ui/MapPicker';
import { getPreference, setPreference as setDevicePreference } from '../services/preferences';
import { MobileApiService, NotificationPreference, getApiBaseUrl } from '../services/api.service';
import type { AssayerStatement } from '../types/mobile-app';
import { probeServerUrl } from '../services/server-config';
import { registerForPushNotificationsAsync, unregisterPushNotificationsAsync } from '../services/notification.service';
import { StatsScreen } from './StatsScreen';
import * as LocalAuthentication from 'expo-local-authentication';
// The version/build/bundle line is one shared helper (utils/appVersion.ts) so this screen and
// the login screen can never disagree about what is installed.
import { versionLine } from '../utils/appVersion';

/**
 * The assayer's record as the app holds it.
 *
 * The device-settings flags that used to live here (push, sound, biometrics, offline sync,
 * theme, PIN) have been removed. They were never persisted and never read — see
 * services/preferences.ts, which now owns them and is consulted where each one matters.
 */
export interface ProfileDataState {
  phone: string;
  alternatePhone: string;
  address: string;
  city: string;
  state: string;
  district: string;
  pincode: string;
  latitude: number;
  longitude: number;
  preferredRegions: string;
  preferredRadius: number;
  languages: string;
  licenseNo: string;
  emergencyName: string;
  emergencyPhone: string;
  emergencyRelation: string;
  skills: string;
  experienceYears: number;
  panNumber: string;
  bankAccountNumber: string;
  ifscCode: string;
  maxDailyWorkload: number;
  maxWeeklyWorkload: number;
  employmentType: string;
  performanceRating: number | string;
  averageRating: number;
  totalAssignments: number;
  completedAssignments: number;
  onTimeCompletions: number;
  assayerCode: string;
  /** Server flag: this assayer's map position is missing or coarse and should be confirmed. */
  locationNeedsConfirmation?: boolean;
}

interface ProfileScreenProps {
  /** Clarification counts for the Stats tab, derived from the assayer's live assignments. */
  openQueries?: number;
  resolvedQueries?: number;
  assayerName?: string;
  assayerCode?: string;
  profile: ProfileDataState;
  /** The assayer's statement — the one source for what they are owed. Null while it loads. */
  statement?: AssayerStatement | null;
  savingProfile: boolean;
  /** Whether `profile` actually differs from the server's last confirmed copy. */
  profileDirty: boolean;
  onUpdateProfileField: (field: keyof ProfileDataState, value: any) => void;
  onSaveProfile: () => void;
  onLogout?: () => void;
  onOpenFeedback?: () => void;
  /** Opens the self-service time-off calendar. */
  onOpenAvailability?: () => void;
}

/**
 * Plain-language names for the notification categories. The API returns enum values
 * (ASSIGNMENT, BILLING…), which are not what a field assayer should be reading.
 */
const CATEGORY_LABELS: Record<string, { label: string; hint: string }> = {
  ASSIGNMENT: { label: 'Assignments', hint: 'New offers, acceptances and cancellations' },
  VALIDATION: { label: 'Clarifications', hint: 'Questions raised on your submitted reports' },
  DOCUMENT: { label: 'Documents', hint: 'Paperwork dispatched to you, or sent back for re-upload' },
  PLANNING: { label: 'Planning', hint: 'Coverage and scheduling changes affecting your branches' },
  WORKFORCE: { label: 'Your record', hint: 'Certification expiry and profile changes' },
  BILLING: { label: 'Payments', hint: 'Expense decisions and payouts' },
  SYSTEM: { label: 'System', hint: 'Service notices and app updates' },
};

// ─────────────────────────────────────────────────────────── Row building blocks
//
// These are module-scope on purpose. Defining them inside the component body gives them a new
// component identity on every parent render, so React unmounts and remounts the subtree — for
// a TextInput that means the keyboard cursor is thrown out after each keystroke (the same
// remount bug fixed app-wide in the modal/drawer inputs). Hoisted, identity is stable.

type RowTone = 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** Row helper kept for call-site compatibility with the old local component — now a thin pass-
 *  through to the shared GroupedRow primitive (icon badge, inset divider owned by the parent
 *  GroupedSection) instead of a screen-local, separately-bordered row. */
const SettingRow: React.FC<{
  icon: IconName;
  tone?: RowTone;
  label: string;
  hint?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  chevron?: boolean;
}> = (props) => <GroupedRow {...props} />;

/** A SettingRow whose trailing control is the shared iOS-shaped GroupedSwitch. */
const ToggleRow: React.FC<{
  icon: IconName;
  tone?: RowTone;
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}> = ({ icon, tone, label, hint, value, onChange }) => (
  <GroupedRow
    icon={icon}
    tone={tone}
    label={label}
    hint={hint}
    trailing={<GroupedSwitch value={!!value} onChange={onChange} accessibilityLabel={label} />}
  />
);

/** A compact indented toggle for per-category alerts, sitting under the master push row — no
 *  icon badge of its own so it reads as nested under the row above it, still inside the same
 *  grouped container and sharing its inset dividers. */
const SubToggle: React.FC<{ label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }> = ({
  label, hint, value, onChange,
}) => {
  const t = useTheme();
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingVertical: t.space.sm, paddingHorizontal: t.space.lg, paddingLeft: 29 + t.space.md + t.space.lg }}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <AppText variant="small">{label}</AppText>
          {hint ? <AppText variant="caption" tone="faint">{hint}</AppText> : null}
        </View>
        <GroupedSwitch value={!!value} onChange={onChange} accessibilityLabel={label} />
      </View>
    </View>
  );
};

/**
 * The "Edit"/"Done" text control for an editable sub-screen's header — the standard iOS
 * Settings/Contacts placement (top-right of the nav bar) for exactly this job: fields start
 * read-only, this is the one deliberate tap that unlocks them.
 */
const EditToggle: React.FC<{ editing: boolean; onToggle: () => void }> = ({ editing, onToggle }) => {
  const t = useTheme();
  return (
    <Tappable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={editing ? 'Done editing' : 'Edit'}
      hitSlop={8}
    >
      <View style={{ paddingHorizontal: t.space.sm, paddingVertical: t.space.xs }}>
        <AppText variant="bodyStrong" style={{ color: t.colors.primary }}>
          {editing ? 'Done' : 'Edit'}
        </AppText>
      </View>
    </Tappable>
  );
};

const FieldInput: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric' | 'phone-pad';
  autoCapitalize?: 'none' | 'characters' | 'words';
  /**
   * Maintained by HR and refused by the server on a self-edit. Rendered read-only with the
   * reason instead of as an input: an editable box that always fails is worse than no box,
   * because the worker types, saves, and only then learns it was never theirs to change.
   */
  lockedReason?: string;
  /**
   * Not permanently locked — just not currently in this section's edit mode (see each editable
   * SubScreen's "Edit" toggle below). Same flat display treatment as `lockedReason`, minus the
   * lock icon and reason line, since it's reachable by the assayer themselves, just not by
   * accident. Without this, every field on the screen was a live TextInput at all times: a stray
   * character brushed in while scrolling, or a field wiped by a mis-aimed tap, sat there
   * indistinguishable from a deliberate edit until the (previously always-visible) Save button
   * sent it to the server.
   */
  readOnly?: boolean;
}> = ({ label, value, onChange, placeholder, keyboardType = 'default', autoCapitalize = 'none', lockedReason, readOnly }) => {
  const t = useTheme();
  const [focus, setFocus] = useState(false);

  if (lockedReason || readOnly) {
    return (
      <View style={{ gap: t.space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <AppText variant="overline" tone="faint">{label.toUpperCase()}</AppText>
          {lockedReason && <Icon name="lock-closed" size={11} color={t.colors.textFaint} />}
        </View>
        <View style={{
          backgroundColor: t.colors.surface,
          borderRadius: t.radius.md,
          borderWidth: 1.5,
          borderColor: t.colors.border,
          paddingHorizontal: t.space.lg,
          paddingVertical: t.space.md,
        }}>
          <AppText variant="small" tone={value ? 'default' : 'faint'}>
            {value ? String(value) : 'Not on file'}
          </AppText>
        </View>
        {lockedReason && <AppText variant="caption" tone="faint">{lockedReason}</AppText>}
      </View>
    );
  }

  return (
    <View style={{ gap: t.space.sm }}>
      <AppText variant="overline" tone="faint">{label.toUpperCase()}</AppText>
      {/* Focus feedback is a border-colour change ONLY. Toggling elevation/shadow on focus of
          an input (or any ancestor) makes Fabric drop IME focus — see LoginScreen.tsx. */}
      <TextInput
        value={String(value ?? '')}
        onChangeText={onChange}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        placeholder={placeholder}
        placeholderTextColor={t.colors.textFaint}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        style={{
          backgroundColor: t.colors.bg,
          borderRadius: t.radius.md,
          borderWidth: 1.5,
          borderColor: focus ? t.colors.primary : t.colors.border,
          paddingHorizontal: t.space.lg,
          height: 50,
          color: t.colors.text,
          fontSize: 15,
          fontWeight: '600',
          paddingVertical: 0,
        } as TextStyle}
      />
    </View>
  );
};

/* ── Address ─────────────────────────────────────────────────────────────────────────────── */

/**
 * State, chosen from the canonical list rather than typed.
 *
 * The server refuses a save outright when the state is not one it recognises
 * (assayer.service.ts → `assertAddressConsistent`: `"X" is not a state we recognise`). A free-text
 * box made that the single most likely reason an assayer's address save bounced — "Karnatka",
 * "TN", "Maharastra" all look fine to the person typing them. `INDIAN_STATES` here is the very
 * same list the validator reads, so a picked value cannot be rejected for spelling.
 */
const StatePicker: React.FC<{ value: string; onChange: (v: string) => void; readOnly?: boolean }> = ({
  value, onChange, readOnly,
}) => {
  const t = useTheme();
  const [open, setOpen] = useState(false);

  if (readOnly) {
    return <FieldInput label="State" value={value} onChange={() => {}} readOnly />;
  }

  return (
    <View style={{ gap: t.space.sm }}>
      <AppText variant="overline" tone="faint">STATE</AppText>
      <Tappable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel="Choose state">
        <View style={{
          backgroundColor: t.colors.bg,
          borderRadius: t.radius.md,
          borderWidth: 1.5,
          borderColor: t.colors.border,
          paddingHorizontal: t.space.lg,
          height: 50,
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <AppText variant="small" tone={value ? 'default' : 'faint'}>{value || 'Choose a state'}</AppText>
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
              <AppText variant="h3">State</AppText>
              <Tappable onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel="Close">
                <AppText variant="bodyStrong" style={{ color: t.colors.primary }}>Done</AppText>
              </Tappable>
            </View>
            <ScrollView>
              {INDIAN_STATES.map((s) => (
                <Tappable
                  key={s.value}
                  onPress={() => { onChange(s.value); setOpen(false); }}
                  accessibilityRole="button"
                  accessibilityLabel={s.label}
                >
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

/**
 * The assayer's home address, and the coordinate that goes with it.
 *
 * ## Why the pin matters more than it looks
 *
 * These coordinates are not decoration on a form. They are the origin the platform measures every
 * travel distance from: routing, the travel-cost calculation behind offer recommendations, and the
 * verification of the assayer's own travel claims all start from this point. A home pin that is
 * wrong by thirty kilometres produces a travel claim that looks inflated when it is honest, and a
 * job-matching radius centred on the wrong town.
 *
 * That is also why nothing here ever invents a coordinate. useAssayerProfile.ts carries the
 * history: a hardcoded New Delhi default silently became the stored home location for every worker
 * who never touched the field, and fed exactly these calculations. When no pin is known this screen
 * says so and asks for a deliberate action — it does not centre the map somewhere plausible and
 * quietly save it.
 *
 * ## Why a coordinate sent from here is durable
 *
 * When the app supplies latitude+longitude, the server records it as a manual pin
 * (coordinate-resolution.ts: `geoSource: 'manual'`, "Placed by hand") and never overwrites a manual
 * pin with later automatic geocoding. So what the assayer places here is authoritative from then
 * on — worth getting right once, and worth validating before it leaves the phone.
 */
const AddressEditor: React.FC<{
  profile: ProfileDataState;
  onUpdateProfileField: (field: keyof ProfileDataState, value: any) => void;
  editing: boolean;
}> = ({ profile, onUpdateProfileField, editing }) => {
  const t = useTheme();

  const [busy, setBusy] = useState<null | 'gps' | 'pin' | 'pincode'>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Manual placement mode: a draft coordinate the user is dragging, NOT yet written to the
   *  profile. Kept out of `profile` on purpose so an abandoned placement saves nothing. */
  const [draft, setDraft] = useState<{ latitude: number; longitude: number } | null>(null);
  /** The pincode we last ran a lookup for, so re-rendering or a programmatic fill does not
   *  re-trigger the network round trip. */
  const lastPincodeLookup = useRef<string>('');

  const hasPin = isPlausibleIndianCoord(profile.latitude, profile.longitude);

  /**
   * Which fields a reverse geocode is allowed to overwrite.
   *
   * Overwritten (`fromPin: true`): city, district, state, pincode. These are pure administrative
   * facts about the point on the map — if the pin says Pune and the form says Nashik, the form is
   * simply wrong, and silently keeping the stale value is what produces the pincode↔state mismatch
   * the server rejects on save.
   *
   * Preserved: the free-text `address` line, once the assayer has typed anything into it. That
   * line is where "Flat 3B, Shanti Apartments, above the SBI branch" lives — a device geocoder
   * cannot know a flat number, and overwriting it with "Baner Road" would destroy the only part of
   * the address a courier or a desk officer actually needs. It is filled from the geocoder ONLY
   * when it is still empty, as a helpful first draft the user can then edit.
   */
  const applyPlace = useCallback((place: Location.LocationGeocodedAddress) => {
    const city = place.city || place.subregion || '';
    const district = place.subregion || place.district || '';
    // Run the geocoder's region name through the same canonicaliser the server uses; a device that
    // returns "Maharastra" or "NCT of Delhi" must not become an unsaveable profile.
    const state = canonicalStateName(place.region) || '';
    const pincode = (place.postalCode || '').replace(/\D/g, '').slice(0, 6);

    if (city) onUpdateProfileField('city', city);
    if (district) onUpdateProfileField('district', district);
    if (state) onUpdateProfileField('state', state);
    if (pincode.length === 6) {
      onUpdateProfileField('pincode', pincode);
      lastPincodeLookup.current = pincode;
    }

    if (!String(profile.address || '').trim()) {
      const street = [place.name, place.street].filter(Boolean).join(', ');
      if (street) onUpdateProfileField('address', street);
    }

    if (!state && place.region) {
      setNote(`Your device reported the state as “${place.region}”, which isn't one we recognise — please pick it below.`);
    }
  }, [onUpdateProfileField, profile.address]);

  /**
   * Reverse geocode a coordinate.
   *
   * `reverseGeocodeAsync` uses the DEVICE's own geocoder — no API key, no network service of ours.
   * On an Android build without Google Play Services it can legitimately return `[]`; that is not
   * an error worth blocking on, the pin is still good, so we say so and leave the fields to the
   * user rather than stranding them.
   */
  const fillFromCoord = useCallback(async (latitude: number, longitude: number) => {
    try {
      const places = await Location.reverseGeocodeAsync({ latitude, longitude });
      if (!places || places.length === 0) {
        setNote('Pin saved. This phone could not look up the address for it — please fill the fields below yourself.');
        return;
      }
      applyPlace(places[0]);
    } catch {
      setNote('Pin saved. The address lookup did not respond — please fill the fields below yourself.');
    }
  }, [applyPlace]);

  /** Write a coordinate to the profile, refusing anything the server would drop anyway. */
  const commitPin = useCallback(async (latitude: number, longitude: number, reverse: boolean) => {
    if (!isPlausibleIndianCoord(latitude, longitude)) {
      setError('That point is outside India. Move the pin to your home address before saving.');
      return;
    }
    setError(null);
    setNote(null);
    onUpdateProfileField('latitude', latitude);
    onUpdateProfileField('longitude', longitude);
    if (!reverse) return;
    setBusy('pin');
    await fillFromCoord(latitude, longitude);
    setBusy(null);
  }, [fillFromCoord, onUpdateProfileField]);

  /** The one-tap path: an assayer standing at their own front door should not have to type. */
  const useCurrentLocation = useCallback(async () => {
    setBusy('gps');
    setError(null);
    setNote(null);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setError('Location permission is off. Allow location for Orbit in your phone settings, or place the pin on the map instead.');
        return;
      }
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = fix.coords;
      if (!isPlausibleIndianCoord(latitude, longitude)) {
        setError('Your phone reported a position outside India. Place the pin on the map instead.');
        return;
      }
      setDraft(null);
      onUpdateProfileField('latitude', latitude);
      onUpdateProfileField('longitude', longitude);
      await fillFromCoord(latitude, longitude);
    } catch {
      setError('Could not get a location fix. Step outside or near a window and try again, or place the pin on the map.');
    } finally {
      setBusy(null);
    }
  }, [fillFromCoord, onUpdateProfileField]);

  /**
   * Pincode is the server's anchor of truth for an address (it cross-checks pincode against
   * state/district on save), so a valid six-digit code is the highest-value thing to resolve:
   * forward geocode it, then reverse geocode the result to fill district/state and move the pin.
   */
  const onPincodeChange = useCallback(async (raw: string) => {
    const value = raw.replace(/\D/g, '').slice(0, 6);
    onUpdateProfileField('pincode', value);
    if (value.length !== 6 || value === lastPincodeLookup.current) return;
    lastPincodeLookup.current = value;
    setBusy('pincode');
    setError(null);
    setNote(null);
    try {
      const hits = await Location.geocodeAsync(`${value}, India`);
      const hit = hits?.[0];
      if (!hit || !isPlausibleIndianCoord(hit.latitude, hit.longitude)) {
        setNote('Could not look that pincode up on this phone — fill the district and state yourself.');
        return;
      }
      onUpdateProfileField('latitude', hit.latitude);
      onUpdateProfileField('longitude', hit.longitude);
      setDraft(null);
      const places = await Location.reverseGeocodeAsync({ latitude: hit.latitude, longitude: hit.longitude });
      // A pincode centroid is a neighbourhood, not a doorstep: take the administrative fields but
      // leave the street line alone, and tell the user to nudge the pin to their actual home.
      if (places?.[0]) {
        const place = places[0];
        const district = place.subregion || place.district || '';
        const state = canonicalStateName(place.region) || '';
        if (place.city) onUpdateProfileField('city', place.city);
        if (district) onUpdateProfileField('district', district);
        if (state) onUpdateProfileField('state', state);
      }
      setNote('Pin moved to the centre of that pincode — drag the map to your exact home.');
    } catch {
      setNote('Pincode lookup failed on this phone — fill the district and state yourself.');
    } finally {
      setBusy(null);
    }
  }, [onUpdateProfileField]);

  const coordLine = hasPin
    ? `${Number(profile.latitude).toFixed(5)}, ${Number(profile.longitude).toFixed(5)}`
    : null;

  return (
    <View style={{ padding: t.space.lg, gap: t.space.lg }}>
      <Card level={1} style={{ gap: t.space.md }}>
        <AppText variant="overline" tone="faint">HOME LOCATION</AppText>

        {editing && (
          <Button
            label={busy === 'gps' ? 'Finding you…' : 'Use my current location'}
            icon="navigate"
            onPress={useCurrentLocation}
            loading={busy === 'gps'}
            disabled={busy !== null}
            full
          />
        )}

        {hasPin ? (
          <>
            <MapPicker
              latitude={profile.latitude}
              longitude={profile.longitude}
              editable={editing && busy === null}
              onChange={(lat, lng) => { void commitPin(lat, lng, true); }}
              initialZoom={16}
            />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
              {busy === 'pin' && <ActivityIndicator size="small" color={t.colors.primary} />}
              <AppText variant="caption" tone="muted">{coordLine}</AppText>
            </View>
          </>
        ) : draft ? (
          <>
            {/* Explicit placement mode. The draft is deliberately NOT in the profile yet, so
                backing out of this screen saves nothing and leaves the pin honestly unset. */}
            <MapPicker
              latitude={draft.latitude}
              longitude={draft.longitude}
              editable={busy === null}
              onChange={(lat, lng) => setDraft({ latitude: lat, longitude: lng })}
              initialZoom={INDIA_CENTRE.zoom}
            />
            <View style={{ flexDirection: 'row', gap: t.space.sm }}>
              <View style={{ flex: 1 }}>
                <Button label="Cancel" variant="neutral" onPress={() => { setDraft(null); setError(null); }} full />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label="Use this pin"
                  onPress={() => { void commitPin(draft.latitude, draft.longitude, true); }}
                  disabled={busy !== null}
                  full
                />
              </View>
            </View>
          </>
        ) : (
          <View style={{
            borderRadius: t.radius.lg,
            borderWidth: 1,
            borderStyle: 'dashed',
            borderColor: t.colors.borderStrong,
            backgroundColor: t.colors.surfaceAlt,
            padding: t.space.lg,
            gap: t.space.sm,
            alignItems: 'center',
          }}>
            <Icon name="location-outline" size={22} color={t.colors.textFaint} />
            <AppText variant="small" tone="muted" style={{ textAlign: 'center' }}>
              No home location on file yet.
            </AppText>
            {editing && (
              <Button label="Place the pin on a map" variant="neutral" icon="map" onPress={() => setDraft({ ...INDIA_CENTRE })} />
            )}
          </View>
        )}

        {error && <AppText variant="caption" style={{ color: t.colors.danger }}>{error}</AppText>}
        {!error && note && <AppText variant="caption" tone="muted">{note}</AppText>}

        <AppText variant="caption" tone="faint">
          Your travel distance and travel claims are measured from this pin, so it decides which
          audits you are offered and what you are paid to reach them.
        </AppText>
      </Card>

      <Card level={1} style={{ gap: t.space.lg }}>
        <FieldInput
          label="Address"
          value={profile.address}
          onChange={(v) => onUpdateProfileField('address', v)}
          placeholder="Flat / house, building, street"
          autoCapitalize="words"
          readOnly={!editing}
        />
        <View style={{ flexDirection: 'row', gap: t.space.md }}>
          <View style={{ flex: 1 }}>
            <FieldInput label="City" value={profile.city} onChange={(v) => onUpdateProfileField('city', v)} autoCapitalize="words" readOnly={!editing} />
          </View>
          <View style={{ flex: 1 }}>
            <FieldInput
              label="Pincode"
              value={profile.pincode}
              onChange={(v) => { void onPincodeChange(v); }}
              keyboardType="numeric"
              placeholder="6 digits"
              readOnly={!editing}
            />
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: t.space.md }}>
          <View style={{ flex: 1 }}>
            <FieldInput label="District" value={profile.district} onChange={(v) => onUpdateProfileField('district', v)} autoCapitalize="words" readOnly={!editing} />
          </View>
          <View style={{ flex: 1 }}>
            <StatePicker value={profile.state} onChange={(v) => onUpdateProfileField('state', v)} readOnly={!editing} />
          </View>
        </View>
        {busy === 'pincode' && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
            <ActivityIndicator size="small" color={t.colors.primary} />
            <AppText variant="caption" tone="muted">Looking up that pincode…</AppText>
          </View>
        )}
      </Card>
    </View>
  );
};

/**
 * Profile and settings.
 *
 * The old screen had six tabs of densely packed inputs and a fake GPS readout
 * that printed "GPS LOCKED 🛰️ (Precision ±5m)" from a local string, never from
 * the device. That is gone rather than restyled.
 *
 * `appTheme` already existed on this state object but was never wired to
 * anything — it now drives the real theme, and persists.
 */
export const ProfileScreen: React.FC<ProfileScreenProps> = ({
  openQueries = 0,
  resolvedQueries = 0,
  assayerName = '',
  assayerCode = '',
  profile,
  statement,
  savingProfile,
  profileDirty,
  onUpdateProfileField,
  onSaveProfile,
  onLogout,
  onOpenFeedback,
  onOpenAvailability,
}) => {
  const [changePasswordVisible, setChangePasswordVisible] = useState(false);
  const t = useTheme();

  // Every settings group used to expand in place (CollapsibleSection). Zerodha/Apple-style
  // professional apps instead push each group to its own screen — a row on the list, a full
  // screen behind it. `useStackNav` is a one-level-deep push stack (see SimpleStack.tsx for why
  // this isn't react-navigation): `push('contact')` opens the Contact sub-screen, `pop()` (or the
  // sub-screen's own back chevron / hardware back / edge swipe) returns to the row list.
  const stackNav = useStackNav();

  /**
   * Whether the currently-open editable sub-screen (Contact/Address/Emergency
   * contact/Capability/Capacity) accepts input right now. Every field on those screens defaults
   * to a flat, read-only display (`FieldInput`'s `readOnly` prop) until this is toggled on via
   * the "Edit" control in that sub-screen's header — see the request this answers: an
   * always-editable field next to an always-visible Save button meant a stray character brushed
   * in while scrolling had a live path to overwriting the server record. One shared flag (not
   * one per section) is enough because the stack is one level deep and only one section is ever
   * open at a time; it resets to false on every navigation so leaving a section never leaves the
   * next one silently unlocked.
   */
  const [editing, setEditing] = useState(false);
  useEffect(() => { setEditing(false); }, [stackNav.current]);

  /**
   * Device settings, seeded from the persisted store rather than from the profile object.
   *
   * These were fields on `profile` that only ever lived in memory — nothing read them and
   * nothing saved them, so every switch reset on relaunch and none changed the app's
   * behaviour. Each is now backed by the device preference store and consulted where it
   * matters (the chime, the sign-in screen).
   */
  const [soundAlerts, setSoundAlerts] = useState(() => getPreference('soundAlerts'));
  const [biometrics, setBiometrics] = useState(() => getPreference('biometrics'));
  const [sensor, setSensor] = useState<'checking' | 'ready' | 'not-enrolled' | 'none'>('checking');

  // Real connectivity, not a hardcoded "ONLINE". Probes the actual server the app is pointed at
  // (the /health endpoint) so the badge tells the truth when the assayer is out of signal.
  const [conn, setConn] = useState<'checking' | 'online' | 'offline'>('checking');
  const checkConnection = useCallback(async () => {
    setConn('checking');
    const r = await probeServerUrl(getApiBaseUrl());
    setConn(r.ok ? 'online' : 'offline');
  }, []);
  useEffect(() => { void checkConnection(); }, [checkConnection]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [hasHardware, isEnrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync().catch(() => false),
        LocalAuthentication.isEnrolledAsync().catch(() => false),
      ]);
      if (cancelled) return;
      setSensor(!hasHardware ? 'none' : isEnrolled ? 'ready' : 'not-enrolled');
    })();
    return () => { cancelled = true; };
  }, []);
  const [pushEnabled, setPushEnabled] = useState(() => getPreference('pushEnabled'));
  const [pushBusy, setPushBusy] = useState(false);

  /**
   * Per-category notification preferences, held server-side.
   *
   * Push used to be all-or-nothing: an assayer who wanted to stop billing chatter had to
   * silence assignment offers too — the one notification they cannot afford to miss. The
   * backend has always stored these per category; nothing in the app read them.
   */
  const [notifPrefs, setNotifPrefs] = useState<NotificationPreference[]>([]);
  const [notifPrefsLoading, setNotifPrefsLoading] = useState(true);
  const [savingCategory, setSavingCategory] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    MobileApiService.getNotificationPreferences()
      .then((prefs) => { if (!cancelled) setNotifPrefs(prefs); })
      .finally(() => { if (!cancelled) setNotifPrefsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const toggleCategory = async (category: string, push: boolean) => {
    setSavingCategory(category);
    // Optimistic: the switch responds immediately, and reverts if the server refuses.
    const previous = notifPrefs;
    setNotifPrefs((prev) => prev.map((p) => (p.category === category ? { ...p, push } : p)));
    const res = await MobileApiService.setNotificationPreference(category, { push });
    if (!res.success) setNotifPrefs(previous);
    else if (res.preferences) setNotifPrefs(res.preferences);
    setSavingCategory(null);
  };
  const { liveTrackingEnabled, liveTrackingReady, setLiveTrackingEnabled } = useLocation();

  /**
   * The details the back office needs before this assayer can be paid or dispatched.
   *
   * Ordered by consequence: without a bank account and PAN the billing run cannot pay them at
   * all, and without a phone number the desk cannot reach them at a branch.
   */
  const missingFields = ([
    { value: profile.bankAccountNumber, label: 'Bank account number', target: 'payment' as const },
    { value: profile.ifscCode, label: 'IFSC code', target: 'payment' as const },
    { value: profile.panNumber, label: 'PAN number', target: 'payment' as const },
    { value: profile.phone, label: 'Phone number', target: 'contact' as const },
    { value: profile.emergencyPhone, label: 'Emergency contact', target: 'emergency' as const },
  ]).filter((f) => !String(f.value ?? '').trim());

  const recordComplete = missingFields.length === 0;

  const THEME_OPTIONS: { key: ThemePreference; label: string; icon: 'contrast-outline' | 'sunny-outline' | 'moon-outline' }[] = [
    { key: 'system', label: 'System', icon: 'contrast-outline' },
    { key: 'light', label: 'Light', icon: 'sunny-outline' },
    { key: 'dark', label: 'Dark', icon: 'moon-outline' },
  ];

  const serverHost = getApiBaseUrl().replace(/^https?:\/\//, '').replace(/\/api\/v1$/, '');

  const SCREEN_H = Dimensions.get('window').height;

  return (
    // `position: relative` + an explicit min-height gives the pushed SubScreens (each absolutely
    // positioned, see SimpleStack.tsx) a sized ancestor to anchor to — without it "position:
    // absolute; top:0; bottom:0" has nothing to be relative to inside App.tsx's outer ScrollView,
    // whose content height is intrinsic rather than fixed.
    <View style={{ gap: t.space.xl, position: 'relative', minHeight: SCREEN_H }}>
      {/*
        Identity, and what is stopping this record from being usable.

        Who am I, at a glance: large avatar, name at h1, code and standing as badges. Under it,
        the one thing the old header never said — that payouts stall on missing bank or PAN
        details; the assayer used to find out when money did not arrive.
      */}
      <Card level={2} style={{ gap: t.space.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.lg }}>
          <Avatar name={assayerName || 'Assayer'} size={72} />
          <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
            {/* Large-title weight, not h1 — Apple's Settings/Contacts headers show your name at
                the same scale as a screen's own title, not as a subordinate label under the
                avatar. */}
            <AppText variant="largeTitle" numberOfLines={1} style={{ letterSpacing: -0.5 }}>{assayerName || 'Field Assayer'}</AppText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xs, alignItems: 'center' }}>
              {(assayerCode || profile.assayerCode) ? (
                <Badge label={assayerCode || profile.assayerCode} tone="primary" icon="id-card-outline" />
              ) : null}
              <Badge
                label={recordComplete ? 'ACTIVE' : 'INCOMPLETE'}
                tone={recordComplete ? 'success' : 'warning'}
                dot
              />
              {profile.employmentType ? (
                <Badge label={profile.employmentType === 'INTERNAL' ? 'In-house' : 'Contract'} tone="neutral" />
              ) : null}
            </View>
          </View>
        </View>

        {missingFields.length > 0 ? (
          <Tappable
            onPress={() => stackNav.push(missingFields[0].target)}
            accessibilityRole="button"
            accessibilityLabel={`${missingFields.length} profile details missing — open the section to fix them`}
          >
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: t.space.sm,
              padding: t.space.md, borderRadius: t.radius.md, backgroundColor: t.colors.warningSoft,
            }}>
              <Icon name="alert-circle-outline" size={18} color={t.colors.warning} />
              <AppText variant="small" tone="warning" style={{ flex: 1 }}>
                {missingFields.length === 1
                  ? `${missingFields[0].label} is missing.`
                  : `${missingFields.length} details missing, including ${missingFields[0].label.toLowerCase()}.`}
                {' '}Payments and assignments can be held up without these.
              </AppText>
              <Icon name="chevron-forward" size={16} color={t.colors.warning} />
            </View>
          </Tappable>
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
            {/* Outline weight, not filled — this is a static "complete" indicator, not an
                active/selected control. The app's convention (see TabDock icon/iconActive)
                reserves filled glyphs for the active state; a filled checkmark here read as
                inconsistent next to QueriesScreen's outline "resolved" icon for the same concept. */}
            <Icon name="checkmark-circle-outline" size={18} color={t.colors.success} />
            <AppText variant="small" tone="muted">Your record is complete.</AppText>
          </View>
        )}
      </Card>

      {/*
        The key numbers a field worker actually checks: what I've done, what I'm owed.

        `StatStrip` (a horizontal ScrollView) is right for a strip that's meant to be swiped —
        StatsScreen and EarningsScreen use it for that. Here it was wrong: at 3-4 tiles wide with
        each tile's own `minWidth: 140`, the strip overflowed a normal phone's screen width and
        forced a sideways scroll on the very first thing a field worker sees after their name —
        exactly the "big component that makes things horizontally scrollable" this was reported
        against. Nothing else in this app (or in the rest of this session's redesign) scrolls
        sideways; a wrapping grid keeps every figure visible at once, which is also just more
        useful for a glanceable summary than one that hides a card off-screen.
      */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.md }}>
        <StatTile label="Completed" value={profile.completedAssignments ?? 0} icon="checkmark-done" tone="success" />
        <StatTile label="Assigned" value={profile.totalAssignments ?? 0} icon="clipboard-outline" />
        {/* What you are owed has one source — the statement — so this tile shows what the
            statement says, or an em dash when it could not be read. Never a second figure. */}
        <StatTile label="Balance" value={statement ? money(statement.totals.outstanding) : '—'} icon="wallet-outline" tone="accent" />
        {Number(profile.averageRating) > 0 && (
          <StatTile label="Rating" value={Number(profile.averageRating).toFixed(1)} icon="star" tone="warning" hint="out of 5" />
        )}
      </View>

      {/*
        One continuous grouped list from here down — Apple Settings/Zerodha Console style.
        There used to be a top-level PROFILE/WORK/STATS/APP segmented switcher gating which of
        these sections was visible; that hid three groups behind a tap and made the screen read
        as four separate screens wearing one title. A single scroll, in order of what an
        assayer needs most often, does the same job without the extra navigation layer.
      */}
      <GroupedSection title="Profile">
        <GroupedRow
          icon="call-outline" tone="primary" label="Contact"
          hint={profile.phone || 'Add your phone number'}
          onPress={() => stackNav.push('contact')} chevron
        />
        <GroupedRow
          icon="home-outline" tone="accent" label="Address"
          hint={[profile.city, profile.state].filter(Boolean).join(', ') || 'Where you are based'}
          onPress={() => stackNav.push('address')} chevron
        />
        <GroupedRow
          icon="medkit-outline" tone="danger" label="Emergency contact"
          hint={profile.emergencyName ? `${profile.emergencyName}${profile.emergencyPhone ? ` · ${profile.emergencyPhone}` : ''}` : 'Who to call if something happens on site'}
          onPress={() => stackNav.push('emergency')} chevron
        />
      </GroupedSection>

      <GroupedSection title="Work">
        {/* Self-service time off opens straight into the calendar overlay — there's nothing
            else to show behind this row, so it stays a direct action rather than a push. */}
        <GroupedRow
          icon="calendar-outline" tone="primary" label="Availability"
          hint="Mark days you're unavailable — you won't be offered audits then."
          onPress={onOpenAvailability} accessibilityLabel="Set your time off" chevron
        />
        <GroupedRow
          icon="ribbon-outline" tone="accent" label="Capability"
          hint={`${profile.skills ? profile.skills.split(',').filter((s) => s.trim()).length : 0} skills · ${profile.languages ? profile.languages.split(',').filter((s) => s.trim()).length : 0} languages`}
          onPress={() => stackNav.push('capability')} chevron
        />
        <GroupedRow
          icon="speedometer-outline" tone="info" label="Capacity"
          hint="How much work you can take"
          onPress={() => stackNav.push('capacity')} chevron
        />
        <GroupedRow
          icon="card-outline" tone="success" label="Payment details"
          hint="Bank account and PAN"
          onPress={() => stackNav.push('payment')} chevron
        />
      </GroupedSection>

      {/*
        Shown only while there's an actual unsaved edit (`profileDirty`, from useAssayerProfile's
        diff against the server's last confirmed copy). It used to sit here unconditionally on
        every visit — a button with nothing to do, and a tap on it just re-sent whatever was
        already saved. Worse, it invited exactly the mistake this whole change set exists to
        prevent: a permanently-present Save button next to permanently-editable fields means a
        stray character typed (or a field accidentally cleared) while just scrolling past on a
        touchscreen has a live, one-tap path to actually overwrite the server record. The fields
        themselves are now read-only until "Edit" is tapped on their own section (see
        FieldInput's `readOnly` prop and each SubScreen's trailing edit toggle below) — dirty can
        now only become true from a deliberate edit, and this button only exists while one is
        pending.
      */}
      {profileDirty && (
        <Button
          label={savingProfile ? 'Saving…' : 'Save changes'}
          icon="save-outline"
          onPress={onSaveProfile}
          loading={savingProfile}
          size="lg"
          full
        />
      )}

      {/* Performance used to be an entire alternate screen (StatsScreen) swapped in by the STATS
          tab — the only tab that wasn't a list of rows at all, which is exactly the inconsistency
          being fixed here. It's now one row like everything else, with a live completion-rate
          hint so the number that matters most doesn't require a tap to see, and StatsScreen's
          full breakdown (unchanged) lives behind it as a pushed sub-screen. */}
      <GroupedSection title="Performance">
        <GroupedRow
          icon="stats-chart-outline" tone="primary" label="Performance"
          hint={
            Number(profile.totalAssignments) > 0
              ? `${Math.round((Number(profile.completedAssignments) / Number(profile.totalAssignments)) * 100)}% completion rate`
              : 'Your assignment history and ratings'
          }
          onPress={() => stackNav.push('stats')} chevron
        />
      </GroupedSection>

      <GroupedSection title="App">
        <GroupedRow
          icon="color-palette-outline" tone="primary" label="Appearance"
          hint={THEME_OPTIONS.find((o) => o.key === t.preference)?.label ?? 'Theme'}
          onPress={() => stackNav.push('appearance')} chevron
        />
        <GroupedRow
          icon="notifications-outline" tone="accent" label="Notifications"
          hint={pushBusy ? 'Updating this device with the server…' : pushEnabled ? 'Push notifications on' : 'Push notifications off'}
          onPress={() => stackNav.push('notifications')} chevron
        />
        <GroupedRow
          icon="navigate-outline" tone="info" label="Location & Recommendations"
          hint={liveTrackingEnabled ? 'Live location sharing on' : 'Live location sharing off'}
          onPress={() => stackNav.push('location')} chevron
        />
        <GroupedRow
          icon="server-outline" tone="neutral" label="Connection"
          hint={serverHost}
          onPress={() => stackNav.push('connection')} chevron
        />
      </GroupedSection>

      <GroupedSection title="Account">
        <GroupedRow
          icon="finger-print-outline" tone="success" label="Security & Biometrics"
          hint={biometrics ? 'Biometric lock on' : 'Password and biometric lock'}
          onPress={() => stackNav.push('security')} chevron
        />
        <GroupedRow
          icon="ribbon-outline" tone="primary" label="Accreditation & License"
          hint={profile.licenseNo ? `License No: ${profile.licenseNo}` : 'No licence number on file'}
          onPress={() => stackNav.push('accreditation')} chevron
        />
      </GroupedSection>

      {/* Help & Feedback: the assayer's two-way channel to the product team — report a
          bug, ask for something, or ask a question, and follow the replies in thread. */}
      {onOpenFeedback && (
        <GroupedSection title="Help & Feedback">
          <SettingRow
            icon="chatbox-ellipses-outline"
            tone="primary"
            label="Send feedback"
            hint="Report a bug, suggest an improvement, or ask the product team a question"
            onPress={onOpenFeedback}
            accessibilityLabel="Open feedback and support"
            chevron
          />
        </GroupedSection>
      )}

      {/* Session: the destructive action lives alone at the very bottom, in danger tone,
          visually severed from everything an assayer edits day to day. Never glowing.
          A confirmation step guards it — this used to fire onLogout on a single tap, so a
          mis-tap on a moving handset (or a thumb sliding past the row above it) threw an
          assayer out mid-audit with no way back except re-entering their password. */}
      {onLogout && (
        <GroupedSection title="Session">
          <SettingRow
            icon="log-out-outline"
            tone="danger"
            label="Sign out"
            hint="You'll need your password to sign back in"
            onPress={() => {
              Alert.alert(
                'Sign out of Orbit?',
                "You'll need your password to sign back in.",
                [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Sign out', style: 'destructive', onPress: onLogout },
                ],
              );
            }}
            accessibilityLabel="Sign out of Orbit"
            chevron
          />
        </GroupedSection>
      )}

      <View style={{ alignItems: 'center', paddingVertical: t.space.sm, gap: 2 }}>
        {/*
          Read from the build rather than typed in. This said "v2.4.12-release" while the app
          it shipped in was 1.0.0 — a support call asking "which version are you on?" would
          have been answered with a number that never existed.

          The line under it used to claim "AES-256 Encrypted • TLS 1.3 Secure Connection".
          Neither was true of what the app does: it talks to a configurable host over plain
          HTTP on the LAN, and nothing here encrypts at rest beyond the OS keystore holding the
          session token. A false security claim in a bank audit tool is worse than no claim.
        */}
        <AppText variant="caption" tone="faint">
          Orbit Field Assayer • {versionLine()}
        </AppText>
      </View>

      {/*
        The pushed sub-screens. Every one used to be a `CollapsibleSection` expanding in place;
        the content inside each `<SubScreen>` below is unchanged from what used to live inside the
        matching section — only the container changed, from an inline accordion to a screen you
        navigate to and back from, the pattern Apple Settings and Zerodha Console both use.
        Rendered unconditionally so each keeps its `active` prop and the mount/unmount is owned by
        SubScreen's own slide animation rather than by this list.
      */}
      <SubScreen
        active={stackNav.current === 'contact'} title="Contact" onBack={stackNav.pop}
        trailing={<EditToggle editing={editing} onToggle={() => setEditing((e) => !e)} />}
      >
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.lg }}>
            <FieldInput label="Phone" value={profile.phone} onChange={(v) => onUpdateProfileField('phone', v)} keyboardType="phone-pad" placeholder="+91…" readOnly={!editing} />
            <FieldInput label="Alternate phone" value={profile.alternatePhone} onChange={(v) => onUpdateProfileField('alternatePhone', v)} keyboardType="phone-pad" readOnly={!editing} />
          </Card>
        </View>
      </SubScreen>

      <SubScreen
        active={stackNav.current === 'address'} title="Address" onBack={stackNav.pop}
        trailing={<EditToggle editing={editing} onToggle={() => setEditing((e) => !e)} />}
      >
        <AddressEditor profile={profile} onUpdateProfileField={onUpdateProfileField} editing={editing} />
      </SubScreen>

      <SubScreen
        active={stackNav.current === 'emergency'} title="Emergency contact" onBack={stackNav.pop}
        trailing={<EditToggle editing={editing} onToggle={() => setEditing((e) => !e)} />}
      >
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.lg }}>
            <FieldInput label="Name" value={profile.emergencyName} onChange={(v) => onUpdateProfileField('emergencyName', v)} autoCapitalize="words" readOnly={!editing} />
            <View style={{ flexDirection: 'row', gap: t.space.md }}>
              <View style={{ flex: 1 }}>
                <FieldInput label="Phone" value={profile.emergencyPhone} onChange={(v) => onUpdateProfileField('emergencyPhone', v)} keyboardType="phone-pad" readOnly={!editing} />
              </View>
              <View style={{ flex: 1 }}>
                <FieldInput label="Relation" value={profile.emergencyRelation} onChange={(v) => onUpdateProfileField('emergencyRelation', v)} autoCapitalize="words" readOnly={!editing} />
              </View>
            </View>
          </Card>
        </View>
      </SubScreen>

      <SubScreen
        active={stackNav.current === 'capability'} title="Capability" onBack={stackNav.pop}
        trailing={<EditToggle editing={editing} onToggle={() => setEditing((e) => !e)} />}
      >
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.lg }}>
            <FieldInput label="Skills" value={profile.skills} onChange={(v) => onUpdateProfileField('skills', v)} placeholder="Gold assaying, purity testing" readOnly={!editing} />
            <FieldInput label="Languages" value={profile.languages} onChange={(v) => onUpdateProfileField('languages', v)} placeholder="English, Hindi" readOnly={!editing} />
            <FieldInput label="Experience (years)" value={String(profile.experienceYears ?? '')} onChange={(v) => onUpdateProfileField('experienceYears', Number(v) || 0)} keyboardType="numeric" readOnly={!editing} />
          </Card>
        </View>
      </SubScreen>

      <SubScreen
        active={stackNav.current === 'capacity'} title="Capacity" onBack={stackNav.pop}
        trailing={<EditToggle editing={editing} onToggle={() => setEditing((e) => !e)} />}
      >
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.lg }}>
            <View style={{ flexDirection: 'row', gap: t.space.md }}>
              <View style={{ flex: 1 }}>
                <FieldInput label="Max per day" value={String(profile.maxDailyWorkload ?? '')} onChange={() => {}} lockedReason="Set by operations — it decides how much work you can be offered." />
              </View>
              <View style={{ flex: 1 }}>
                <FieldInput label="Max per week" value={String(profile.maxWeeklyWorkload ?? '')} onChange={() => {}} lockedReason="Set by operations, alongside your daily limit." />
              </View>
            </View>
            <FieldInput label="Preferred travel radius (km)" value={String(profile.preferredRadius ?? '')} onChange={(v) => onUpdateProfileField('preferredRadius', Number(v) || 0)} keyboardType="numeric" readOnly={!editing} />
            <FieldInput label="Preferred regions" value={profile.preferredRegions} onChange={(v) => onUpdateProfileField('preferredRegions', v)} autoCapitalize="words" readOnly={!editing} />
          </Card>
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'payment'} title="Payment details" onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.lg }}>
            <AppText variant="caption" tone="faint">
              Held by HR for payouts and statutory filing. Changes are reviewed before they take effect.
            </AppText>
            <FieldInput label="PAN" value={profile.panNumber} onChange={() => {}} lockedReason="Held by HR. Contact your HR coordinator to correct this." />
            <FieldInput label="Bank account" value={profile.bankAccountNumber} onChange={() => {}} lockedReason="Payment details are changed by HR only, so a payout cannot be redirected from a handset." />
            <FieldInput label="IFSC" value={profile.ifscCode} onChange={() => {}} lockedReason="Changed by HR alongside your bank account." />
          </Card>
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'stats'} title="Performance" onBack={stackNav.pop}>
        <StatsScreen
          totalAssignments={profile.totalAssignments}
          completedAssignments={profile.completedAssignments}
          averageRating={profile.averageRating}
          openQueries={openQueries ?? 0}
          resolvedQueries={resolvedQueries ?? 0}
        />
      </SubScreen>

      <SubScreen active={stackNav.current === 'appearance'} title="Appearance" onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.md }}>
            <SettingRow
              icon="color-palette-outline"
              tone="primary"
              label="Theme"
              hint="Follow your phone's setting, or pin the app to one mode."
            />
            <View style={{ flexDirection: 'row', gap: t.space.sm }}>
              {THEME_OPTIONS.map((o) => {
                const active = t.preference === o.key;
                return (
                  <Tappable
                    key={o.key}
                    style={{ flex: 1 }}
                    accessibilityRole="button"
                    accessibilityLabel={`${o.label} theme${active ? ', selected' : ''}`}
                    onPress={() => t.setPreference(o.key)}
                  >
                    <View style={{
                      alignItems: 'center', gap: 6, paddingVertical: t.space.lg, borderRadius: t.radius.md,
                      backgroundColor: active ? t.colors.primarySoft : t.colors.bg,
                      borderWidth: 1.5, borderColor: active ? t.colors.primary : t.colors.border,
                    }}>
                      <Icon name={o.icon} size={20} color={active ? t.colors.primary : t.colors.textFaint} />
                      <AppText variant="caption" tone={active ? 'primary' : 'faint'}>{o.label}</AppText>
                    </View>
                  </Tappable>
                );
              })}
            </View>
          </Card>
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'notifications'} title="Notifications" onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <GroupedSection>
            <ToggleRow
              icon="notifications-outline"
              tone="primary"
              label="Push notifications"
              hint={pushBusy ? 'Updating this device with the server…' : 'New assignments, clarifications and payment updates'}
              value={pushEnabled}
              onChange={async (v) => {
                setPushBusy(true);
                try {
                  const ok = v ? !!(await registerForPushNotificationsAsync()) : await unregisterPushNotificationsAsync();
                  if (ok) { setPushEnabled(v); await setDevicePreference('pushEnabled', v); }
                } finally {
                  setPushBusy(false);
                }
              }}
            />
            {pushEnabled && (
              <View style={{ paddingTop: t.space.xs, paddingBottom: t.space.xs, paddingLeft: t.space.lg }}>
                <AppText variant="overline" tone="faint" style={{ paddingLeft: 29 + t.space.md, marginBottom: t.space.xs }}>WHICH ALERTS</AppText>
                {notifPrefsLoading ? (
                  <AppText variant="caption" tone="faint" style={{ paddingLeft: 29 + t.space.md }}>Loading your alert preferences…</AppText>
                ) : notifPrefs.length === 0 ? (
                  <AppText variant="caption" tone="faint" style={{ paddingLeft: 29 + t.space.md }}>Alert preferences unavailable offline.</AppText>
                ) : (
                  notifPrefs.map((pref) => (
                    <SubToggle
                      key={pref.category}
                      label={CATEGORY_LABELS[pref.category]?.label ?? pref.category}
                      hint={savingCategory === pref.category ? 'Saving…' : CATEGORY_LABELS[pref.category]?.hint}
                      value={pref.push}
                      onChange={(v) => toggleCategory(pref.category, v)}
                    />
                  ))
                )}
              </View>
            )}
            <ToggleRow
              icon="volume-medium-outline"
              tone="accent"
              label="Sound alerts"
              hint="Play a chime when a notification arrives"
              value={soundAlerts}
              onChange={async (v) => { setSoundAlerts(v); await setDevicePreference('soundAlerts', v); }}
            />
          </GroupedSection>
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'location'} title="Location & Recommendations" onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <GroupedSection>
            <ToggleRow
              icon="navigate-outline"
              tone="info"
              label="Share live location"
              hint="Off by default. When on, your current position — not your home address — is used to rank you for nearby audits, like ride-hailing apps."
              value={liveTrackingEnabled}
              onChange={async (v) => { await setLiveTrackingEnabled(v); }}
            />
          </GroupedSection>
          {!liveTrackingReady && (
            <AppText variant="caption" tone="faint" style={{ marginLeft: t.space.lg }}>Syncing your sharing preference…</AppText>
          )}
          {liveTrackingEnabled && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: t.space.lg }}>
              <Icon name="radio" size={13} color={t.colors.success} />
              <AppText variant="caption" tone="success">Live position active — recommendations use where you are now</AppText>
            </View>
          )}
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'security'} title="Security & Biometrics" onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <GroupedSection>
            <SettingRow
              icon="key-outline"
              tone="neutral"
              label="Change password"
              hint="Update the password you sign in with"
              chevron
              onPress={() => setChangePasswordVisible(true)}
            />
            <ToggleRow
              icon="finger-print-outline"
              tone="success"
              label="Biometric Lock"
              hint="Require your fingerprint or face to open Orbit, and after two minutes away from the app"
              value={biometrics}
              onChange={async (v) => { setBiometrics(v); await setDevicePreference('biometrics', v); }}
            />
            <SettingRow
              icon="hardware-chip-outline"
              tone={sensor === 'ready' ? 'success' : 'neutral'}
              label="Hardware sensor"
              hint={
                sensor === 'ready'
                  ? 'Fingerprint or face recognition enrolled on this device'
                  : sensor === 'not-enrolled'
                    ? 'Sensor present, but no fingerprint or face is enrolled. Add one in your phone settings.'
                    : sensor === 'none'
                      ? 'This device has no biometric sensor. Sign in with your password.'
                      : 'Checking…'
              }
              trailing={
                <Badge
                  label={sensor === 'ready' ? 'READY' : sensor === 'checking' ? '…' : 'UNAVAILABLE'}
                  tone={sensor === 'ready' ? 'success' : 'neutral'}
                  icon={sensor === 'ready' ? 'shield-checkmark-outline' : 'alert-circle-outline'}
                />
              }
            />
          </GroupedSection>
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'accreditation'} title="Accreditation & License" onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <GroupedSection
            footnote="Authorised for precious metal purity testing, gold ornament packet sealing, and bank collateral audits."
          >
            <SettingRow
              icon="ribbon-outline"
              tone="primary"
              label="BIS / NABL Certified Assayer"
              hint={profile.licenseNo ? `License No: ${profile.licenseNo}` : 'No licence number on file'}
              trailing={profile.licenseNo ? <Badge label="VERIFIED" tone="success" /> : <Badge label="NOT ON FILE" tone="warning" />}
            />
          </GroupedSection>
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'connection'} title="Connection" onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <GroupedSection>
            <SettingRow
              icon="server-outline"
              tone="accent"
              label="Server"
              hint={serverHost}
              trailing={
                conn === 'checking' ? (
                  <Badge label="CHECKING" tone="neutral" icon="sync-outline" />
                ) : conn === 'online' ? (
                  <Badge label="ONLINE" tone="success" icon="cloud-done-outline" />
                ) : (
                  <Badge label="OFFLINE" tone="danger" icon="cloud-offline-outline" />
                )
              }
            />
          </GroupedSection>
          <Button
            label={conn === 'checking' ? 'Checking…' : 'Check connection'}
            icon="refresh-outline"
            variant="neutral"
            size="sm"
            loading={conn === 'checking'}
            onPress={() => { void checkConnection(); }}
          />
        </View>
      </SubScreen>

      {/*
        The same screen the forced-reset flow uses, presented as a sheet.
        `onChanged` only closes it here: this is a voluntary change, so there is no
        `mustChangePassword` flag to clear and nothing further for the app to do.
      */}
      <Modal
        visible={changePasswordVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setChangePasswordVisible(false)}
      >
        <ChangePasswordScreen
          onChanged={() => setChangePasswordVisible(false)}
          onCancel={() => setChangePasswordVisible(false)}
          onLogout={() => { setChangePasswordVisible(false); onLogout?.(); }}
        />
      </Modal>
    </View>
  );
};
