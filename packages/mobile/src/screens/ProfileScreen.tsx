import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import {
  formatRupees as money,
  INDIAN_STATES,
  canonicalStateName,
  splitMissingByOwnership,
  HR_MAINTAINED_ASSAYER_FIELDS,
} from '@fapoms/shared';
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
import { useT, useLanguage, type TranslationKey, type LanguagePreference } from '../i18n';

/**
 * The assayer's record as the app holds it.
 *
 * The device-settings flags that used to live here (push, sound, biometrics, offline sync,
 * theme, PIN) have been removed. They were never persisted and never read — see
 * services/preferences.ts, which now owns them and is consulted where each one matters.
 */
/**
 * This screen's state, restated under the API's own field names.
 *
 * The completeness list in @fapoms/shared is keyed the way the API is (`emergencyContactPhone`,
 * `latitude`), while this screen has always used shorter local names (`emergencyPhone`). Rather
 * than rename state used by a dozen render sites, translate once, here, so exactly one function
 * decides what "incomplete" means for both the phone and the web.
 *
 * `latitude` is reported as blank when it is 0: `emptyProfile` seeds the pair with 0/0 when the
 * device has no fix, and 0,0 is the Atlantic — a placeholder, not a home address, and precisely
 * the value the record-completeness check exists to flag.
 */
export function assayerRecordFromProfile(p: {
  phone?: string; panNumber?: string; bankAccountNumber?: string; ifscCode?: string;
  joiningDate?: string; emergencyPhone?: string; latitude?: number;
}): Record<string, unknown> {
  return {
    phone: p.phone,
    panNumber: p.panNumber,
    bankAccountNumber: p.bankAccountNumber,
    ifscCode: p.ifscCode,
    joiningDate: p.joiningDate,
    emergencyContactPhone: p.emergencyPhone,
    latitude: p.latitude ? String(p.latitude) : '',
  };
}

/**
 * Why a field is locked, decided by the shared policy rather than by this file.
 *
 * The lock reasons were hardcoded strings on each input, so the phone held its own opinion about
 * what the API would accept. `GET /assayers/profile/editable-fields` was built specifically so a
 * client would not do that, and nothing ever called it. Reading the same list the API enforces
 * from `@fapoms/shared` is better still: no round-trip, no loading state, no failure mode, and a
 * field that moves between the two lists changes the phone with it.
 *
 * Returns `undefined` for anything the assayer may edit, which is what `FieldInput` wants.
 */
export function lockReasonFor(key: string): TranslationKey | undefined {
  if (!HR_MAINTAINED_ASSAYER_FIELDS.includes(key)) return undefined;
  return HR_LOCK_REASONS[key] ?? 'profile.lockReasons.fallback';
}

/**
 * Which sentence explains each locked field. Only the wording is decided here; whether a field
 * locks at all is the shared policy's call.
 *
 * Catalogue keys rather than sentences because this map is module-scope and evaluated once at
 * import, before any language has been chosen.
 */
const HR_LOCK_REASONS: Record<string, TranslationKey> = {
  maxDailyWorkload: 'profile.lockReasons.maxDailyWorkload',
  maxWeeklyWorkload: 'profile.lockReasons.maxWeeklyWorkload',
  panNumber: 'profile.lockReasons.panNumber',
  bankAccountNumber: 'profile.lockReasons.bankAccountNumber',
  ifscCode: 'profile.lockReasons.ifscCode',
  joiningDate: 'profile.lockReasons.joiningDate',
  employmentType: 'profile.lockReasons.employmentType',
  performanceRating: 'profile.lockReasons.performanceRating',
};

/** Which sub-screen fixes a given gap, so "Complete it" lands somewhere useful. */
export const PROFILE_SECTION_FOR_FIELD: Record<string, string> = {
  phone: 'contact',
  emergencyContactPhone: 'emergency',
  latitude: 'address',
  panNumber: 'payment',
  bankAccountNumber: 'payment',
  ifscCode: 'payment',
};

export interface ProfileDataState {
  phone: string;
  alternatePhone: string;
  /** Self-editable, and what system notification emails go to. */
  email: string;
  address: string;
  city: string;
  state: string;
  district: string;
  pincode: string;
  latitude: number;
  longitude: number;
  preferredRegions: string;
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
  /** HR-maintained, read-only here. Present so the completeness banner can count it. */
  joiningDate: string;
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
 * Plain-language names for the notification categories, as catalogue keys.
 *
 * The API returns enum values (ASSIGNMENT, BILLING…), which are not what a field assayer
 * should be reading. Keys rather than sentences: this is module-scope and evaluated at import,
 * where a translated string would freeze at whatever language happened to be active then.
 */
const CATEGORY_KEYS: Record<string, { label: TranslationKey; hint: TranslationKey }> = {
  ASSIGNMENT: { label: 'profile.notifications.categories.ASSIGNMENT', hint: 'profile.notifications.categoryHints.ASSIGNMENT' },
  VALIDATION: { label: 'profile.notifications.categories.VALIDATION', hint: 'profile.notifications.categoryHints.VALIDATION' },
  DOCUMENT: { label: 'profile.notifications.categories.DOCUMENT', hint: 'profile.notifications.categoryHints.DOCUMENT' },
  PLANNING: { label: 'profile.notifications.categories.PLANNING', hint: 'profile.notifications.categoryHints.PLANNING' },
  WORKFORCE: { label: 'profile.notifications.categories.WORKFORCE', hint: 'profile.notifications.categoryHints.WORKFORCE' },
  BILLING: { label: 'profile.notifications.categories.BILLING', hint: 'profile.notifications.categoryHints.BILLING' },
  SYSTEM: { label: 'profile.notifications.categories.SYSTEM', hint: 'profile.notifications.categoryHints.SYSTEM' },
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
  const tr = useT();
  return (
    <Tappable
      onPress={onToggle}
      accessibilityRole="button"
      accessibilityLabel={editing ? tr('profile.editing.done') : tr('profile.editing.edit')}
      hitSlop={8}
    >
      <View style={{ paddingHorizontal: t.space.sm, paddingVertical: t.space.xs }}>
        <AppText variant="bodyStrong" style={{ color: t.colors.primary }}>
          {editing ? tr('common.done') : tr('common.edit')}
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
  // 'email-address' included so the email field gets the @ key rather than a general keyboard —
  // a field typed once and mistyped once is a notification address nobody notices is wrong.
  keyboardType?: 'default' | 'numeric' | 'phone-pad' | 'email-address';
  autoCapitalize?: 'none' | 'characters' | 'words';
  /**
   * Maintained by HR and refused by the server on a self-edit. Rendered read-only with the
   * reason instead of as an input: an editable box that always fails is worse than no box,
   * because the worker types, saves, and only then learns it was never theirs to change.
   */
  lockedReason?: TranslationKey;
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
  const tr = useT();
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
            {value ? String(value) : tr('common.notOnFile')}
          </AppText>
        </View>
        {lockedReason && <AppText variant="caption" tone="faint">{tr(lockedReason)}</AppText>}
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
  const tr = useT();
  const [open, setOpen] = useState(false);

  if (readOnly) {
    return <FieldInput label={tr('profile.fields.state')} value={value} onChange={() => {}} readOnly />;
  }

  return (
    <View style={{ gap: t.space.sm }}>
      <AppText variant="overline" tone="faint">{tr('profile.fields.stateLabel')}</AppText>
      <Tappable onPress={() => setOpen(true)} accessibilityRole="button" accessibilityLabel={tr('profile.address.chooseStateAccessibility')}>
        <View style={{
          backgroundColor: t.colors.bg,
          borderRadius: t.radius.md,
          borderWidth: 1.5,
          borderColor: t.colors.border,
          paddingHorizontal: t.space.lg,
          height: 50,
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <AppText variant="small" tone={value ? 'default' : 'faint'}>{value || tr('profile.address.chooseState')}</AppText>
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
              <AppText variant="h3">{tr('profile.fields.state')}</AppText>
              <Tappable onPress={() => setOpen(false)} accessibilityRole="button" accessibilityLabel={tr('common.close')}>
                <AppText variant="bodyStrong" style={{ color: t.colors.primary }}>{tr('common.done')}</AppText>
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
  const tr = useT();

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
      setNote(tr('profile.address.unrecognisedState', { state: place.region }));
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
        setNote(tr('profile.address.pinSavedNoLookup'));
        return;
      }
      applyPlace(places[0]);
    } catch {
      setNote(tr('profile.address.pinSavedLookupFailed'));
    }
  }, [applyPlace]);

  /** Write a coordinate to the profile, refusing anything the server would drop anyway. */
  const commitPin = useCallback(async (latitude: number, longitude: number, reverse: boolean) => {
    if (!isPlausibleIndianCoord(latitude, longitude)) {
      setError(tr('profile.address.pinOutsideIndia'));
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
        setError(tr('profile.address.permissionOff'));
        return;
      }
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = fix.coords;
      if (!isPlausibleIndianCoord(latitude, longitude)) {
        setError(tr('profile.address.fixOutsideIndia'));
        return;
      }
      setDraft(null);
      onUpdateProfileField('latitude', latitude);
      onUpdateProfileField('longitude', longitude);
      await fillFromCoord(latitude, longitude);
    } catch {
      setError(tr('profile.address.noFix'));
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
        setNote(tr('profile.address.pincodeNotFound'));
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
      setNote(tr('profile.address.pincodeMovedPin'));
    } catch {
      setNote(tr('profile.address.pincodeLookupFailed'));
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
        <AppText variant="overline" tone="faint">{tr('profile.address.homeLocation')}</AppText>

        {editing && (
          <Button
            label={busy === 'gps' ? tr('profile.address.finding') : tr('profile.address.useCurrent')}
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
                <Button label={tr('common.cancel')} variant="neutral" onPress={() => { setDraft(null); setError(null); }} full />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label={tr('profile.address.useThisPin')}
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
              {tr('profile.address.noPin')}
            </AppText>
            {editing && (
              <Button label={tr('profile.address.placePin')} variant="neutral" icon="map" onPress={() => setDraft({ ...INDIA_CENTRE })} />
            )}
          </View>
        )}

        {error && <AppText variant="caption" style={{ color: t.colors.danger }}>{error}</AppText>}
        {!error && note && <AppText variant="caption" tone="muted">{note}</AppText>}

        <AppText variant="caption" tone="faint">{tr('profile.address.pinExplainer')}</AppText>
      </Card>

      <Card level={1} style={{ gap: t.space.lg }}>
        <FieldInput
          label={tr('profile.fields.address')}
          value={profile.address}
          onChange={(v) => onUpdateProfileField('address', v)}
          placeholder={tr('profile.fields.addressPlaceholder')}
          autoCapitalize="words"
          readOnly={!editing}
        />
        <View style={{ flexDirection: 'row', gap: t.space.md }}>
          <View style={{ flex: 1 }}>
            <FieldInput label={tr('profile.fields.city')} value={profile.city} onChange={(v) => onUpdateProfileField('city', v)} autoCapitalize="words" readOnly={!editing} />
          </View>
          <View style={{ flex: 1 }}>
            <FieldInput
              label={tr('profile.fields.pincode')}
              value={profile.pincode}
              onChange={(v) => { void onPincodeChange(v); }}
              keyboardType="numeric"
              placeholder={tr('profile.fields.pincodePlaceholder')}
              readOnly={!editing}
            />
          </View>
        </View>
        <View style={{ flexDirection: 'row', gap: t.space.md }}>
          <View style={{ flex: 1 }}>
            <FieldInput label={tr('profile.fields.district')} value={profile.district} onChange={(v) => onUpdateProfileField('district', v)} autoCapitalize="words" readOnly={!editing} />
          </View>
          <View style={{ flex: 1 }}>
            <StatePicker value={profile.state} onChange={(v) => onUpdateProfileField('state', v)} readOnly={!editing} />
          </View>
        </View>
        {busy === 'pincode' && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
            <ActivityIndicator size="small" color={t.colors.primary} />
            <AppText variant="caption" tone="muted">{tr('profile.address.pincodeLookup')}</AppText>
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
  const tr = useT();
  const language = useLanguage();

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
   * Counted from `ASSAYER_RECORD_FIELDS` in @fapoms/shared — the same list the web roster and the
   * HR overview count from. This screen used to keep its own five-field version, which left out
   * `joiningDate` and `latitude`, so the phone could say "Your record is complete" while the web
   * still listed the person under "Incomplete record". Two lists, two answers, and the person
   * being told they were done was the one who could not see the other screen.
   *
   * The canonical list is keyed the way the API is (`emergencyContactPhone`), and this screen's
   * state uses its own shorter names, so the adapter below restates the phone's values under the
   * canonical keys. It is a shape translation, not a second opinion about what is required —
   * `profile-record-fields.spec` fails if a critical key ever stops being mapped here.
   */
  const canonicalRecord = useMemo(
    () => assayerRecordFromProfile(profile),
    [profile],
  );

  /**
   * Split by who can close the gap. The old banner listed PAN and bank account as things to fix,
   * and both are HR-maintained — the assayer could open the field, find it locked, and have no
   * idea what to do next. "Waiting on HR" is the difference between a task and a grievance.
   */
  const { yours: missingYours, hr: missingHr } = useMemo(
    () => splitMissingByOwnership(canonicalRecord),
    [canonicalRecord],
  );

  const missingFields = missingYours.map((f) => ({
    value: null,
    label: f.label,
    target: PROFILE_SECTION_FOR_FIELD[f.key] ?? ('contact' as const),
  }));

  const recordComplete = missingYours.length === 0 && missingHr.length === 0;

  const THEME_OPTIONS: { key: ThemePreference; label: string; icon: 'contrast-outline' | 'sunny-outline' | 'moon-outline' }[] = [
    { key: 'system', label: tr('profile.theme.system'), icon: 'contrast-outline' },
    { key: 'light', label: tr('profile.theme.light'), icon: 'sunny-outline' },
    { key: 'dark', label: tr('profile.theme.dark'), icon: 'moon-outline' },
  ];

  /**
   * The language options, in the order a stuck reader can use them.
   *
   * Each language's name is written in that language, in both catalogues — somebody who cannot
   * read the interface they are looking at has to be able to recognise their own language in
   * this list, which is the entire point of the setting.
   */
  const LANGUAGE_OPTIONS: { key: LanguagePreference; label: string; icon: 'phone-portrait-outline' | 'language-outline' }[] = [
    { key: 'system', label: tr('language.system'), icon: 'phone-portrait-outline' },
    { key: 'en', label: tr('language.en'), icon: 'language-outline' },
    { key: 'hi', label: tr('language.hi'), icon: 'language-outline' },
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
          <Avatar name={assayerName || tr('profile.identity.avatarFallback')} size={72} />
          <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
            {/* Large-title weight, not h1 — Apple's Settings/Contacts headers show your name at
                the same scale as a screen's own title, not as a subordinate label under the
                avatar. */}
            <AppText variant="largeTitle" numberOfLines={1} style={{ letterSpacing: -0.5 }}>{assayerName || tr('profile.identity.fallbackName')}</AppText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.xs, alignItems: 'center' }}>
              {(assayerCode || profile.assayerCode) ? (
                <Badge label={assayerCode || profile.assayerCode} tone="primary" icon="id-card-outline" />
              ) : null}
              <Badge
                label={recordComplete ? tr('profile.status.active') : tr('profile.status.incomplete')}
                tone={recordComplete ? 'success' : 'warning'}
                dot
              />
              {profile.employmentType ? (
                <Badge label={profile.employmentType === 'INTERNAL' ? tr('profile.employment.inHouse') : tr('profile.employment.contract')} tone="neutral" />
              ) : null}
            </View>
          </View>
        </View>

        {missingFields.length > 0 ? (
          <Tappable
            onPress={() => stackNav.push(missingFields[0].target)}
            accessibilityRole="button"
            accessibilityLabel={tr('profile.gaps.accessibility', { count: missingFields.length })}
          >
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: t.space.sm,
              padding: t.space.md, borderRadius: t.radius.md, backgroundColor: t.colors.warningSoft,
            }}>
              <Icon name="alert-circle-outline" size={18} color={t.colors.warning} />
              <AppText variant="small" tone="warning" style={{ flex: 1 }}>
                {missingFields.length === 1
                  ? tr('profile.gaps.oneMissing', { field: missingFields[0].label })
                  : tr('profile.gaps.manyMissing', {
                      count: missingFields.length,
                      field: missingFields[0].label.toLowerCase(),
                    })}
                {' '}{tr('profile.gaps.heldUp')}
              </AppText>
              <Icon name="chevron-forward" size={16} color={t.colors.warning} />
            </View>
          </Tappable>
        ) : null}

        {/*
          Gaps only HR can close, stated separately and NOT as a task.

          These are the payment and employment fields — self-editing them is the payroll-diversion
          route, so the API refuses. The old banner listed them alongside the assayer's own fields
          under "details missing", which sent people to a screen where the input was greyed out
          with no explanation. Telling someone their record is held up by something they cannot
          touch is only fair if you also say who can.
        */}
        {missingHr.length > 0 ? (
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: t.space.sm,
            padding: t.space.md, borderRadius: t.radius.md, backgroundColor: t.colors.surfaceAlt,
          }}>
            <Icon name="time-outline" size={18} color={t.colors.textMuted} />
            <AppText variant="small" tone="muted" style={{ flex: 1 }}>
              {tr('profile.gaps.waitingOnHr', { fields: missingHr.map((f) => f.label.toLowerCase()).join(', ') })}
              {' '}{tr('profile.gaps.backOffice')}
            </AppText>
          </View>
        ) : null}

        {recordComplete ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
            {/* Outline weight, not filled — this is a static "complete" indicator, not an
                active/selected control. The app's convention (see TabDock icon/iconActive)
                reserves filled glyphs for the active state; a filled checkmark here read as
                inconsistent next to QueriesScreen's outline "resolved" icon for the same concept. */}
            <Icon name="checkmark-circle-outline" size={18} color={t.colors.success} />
            <AppText variant="small" tone="muted">{tr('profile.gaps.complete')}</AppText>
          </View>
        ) : null}
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
        <StatTile label={tr('profile.stats.completed')} value={profile.completedAssignments ?? 0} icon="checkmark-done" tone="success" />
        <StatTile label={tr('profile.stats.assigned')} value={profile.totalAssignments ?? 0} icon="clipboard-outline" />
        {/* What you are owed has one source — the statement — so this tile shows what the
            statement says, or an em dash when it could not be read. Never a second figure. */}
        <StatTile label={tr('profile.stats.balance')} value={statement ? money(statement.totals.outstanding) : '—'} icon="wallet-outline" tone="accent" />
        {Number(profile.averageRating) > 0 && (
          <StatTile label={tr('profile.stats.rating')} value={Number(profile.averageRating).toFixed(1)} icon="star" tone="warning" hint={tr('profile.stats.ratingHint')} />
        )}
      </View>

      {/*
        One continuous grouped list from here down — Apple Settings/Zerodha Console style.
        There used to be a top-level PROFILE/WORK/STATS/APP segmented switcher gating which of
        these sections was visible; that hid three groups behind a tap and made the screen read
        as four separate screens wearing one title. A single scroll, in order of what an
        assayer needs most often, does the same job without the extra navigation layer.
      */}
      <GroupedSection title={tr('profile.sections.profile')}>
        <GroupedRow
          icon="call-outline" tone="primary" label={tr('profile.rows.contact')}
          hint={profile.phone || tr('profile.rows.contactHint')}
          onPress={() => stackNav.push('contact')} chevron
        />
        <GroupedRow
          icon="home-outline" tone="accent" label={tr('profile.rows.address')}
          hint={[profile.city, profile.state].filter(Boolean).join(', ') || tr('profile.rows.addressHint')}
          onPress={() => stackNav.push('address')} chevron
        />
        <GroupedRow
          icon="medkit-outline" tone="danger" label={tr('profile.rows.emergency')}
          hint={profile.emergencyName ? `${profile.emergencyName}${profile.emergencyPhone ? ` · ${profile.emergencyPhone}` : ''}` : tr('profile.rows.emergencyHint')}
          onPress={() => stackNav.push('emergency')} chevron
        />
      </GroupedSection>

      <GroupedSection title={tr('profile.sections.work')}>
        {/* Self-service time off opens straight into the calendar overlay — there's nothing
            else to show behind this row, so it stays a direct action rather than a push. */}
        <GroupedRow
          icon="calendar-outline" tone="primary" label={tr('profile.rows.availability')}
          hint={tr('profile.rows.availabilityHint')}
          onPress={onOpenAvailability} accessibilityLabel={tr('profile.rows.availabilityAccessibility')} chevron
        />
        <GroupedRow
          icon="ribbon-outline" tone="accent" label={tr('profile.rows.capability')}
          hint={tr('profile.rows.capabilityHint', {
            skills: profile.skills ? profile.skills.split(',').filter((s) => s.trim()).length : 0,
            languages: profile.languages ? profile.languages.split(',').filter((s) => s.trim()).length : 0,
          })}
          onPress={() => stackNav.push('capability')} chevron
        />
        <GroupedRow
          icon="speedometer-outline" tone="info" label={tr('profile.rows.capacity')}
          hint={tr('profile.rows.capacityHint')}
          onPress={() => stackNav.push('capacity')} chevron
        />
        <GroupedRow
          icon="card-outline" tone="success" label={tr('profile.rows.payment')}
          hint={tr('profile.rows.paymentHint')}
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
          label={savingProfile ? tr('common.saving') : tr('profile.saveChanges')}
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
      <GroupedSection title={tr('profile.sections.performance')}>
        <GroupedRow
          icon="stats-chart-outline" tone="primary" label={tr('profile.rows.performance')}
          hint={
            Number(profile.totalAssignments) > 0
              ? tr('profile.rows.performanceHint', {
                  rate: Math.round((Number(profile.completedAssignments) / Number(profile.totalAssignments)) * 100),
                })
              : tr('profile.rows.performanceHintEmpty')
          }
          onPress={() => stackNav.push('stats')} chevron
        />
      </GroupedSection>

      <GroupedSection title={tr('profile.sections.app')}>
        <GroupedRow
          icon="language-outline" tone="primary" label={tr('language.title')}
          hint={LANGUAGE_OPTIONS.find((o) => o.key === language.preference)?.label ?? tr('language.en')}
          onPress={() => stackNav.push('language')} chevron
          />
          <GroupedRow
          icon="color-palette-outline" tone="primary" label={tr('profile.rows.appearance')}
          hint={THEME_OPTIONS.find((o) => o.key === t.preference)?.label ?? tr('profile.rows.appearanceFallback')}
          onPress={() => stackNav.push('appearance')} chevron
          />
        <GroupedRow
          icon="notifications-outline" tone="accent" label={tr('profile.rows.notifications')}
          hint={pushBusy ? tr('profile.rows.pushUpdating') : pushEnabled ? tr('profile.rows.pushOn') : tr('profile.rows.pushOff')}
          onPress={() => stackNav.push('notifications')} chevron
        />
        <GroupedRow
          icon="navigate-outline" tone="info" label={tr('profile.rows.location')}
          hint={liveTrackingEnabled ? tr('profile.rows.liveOn') : tr('profile.rows.liveOff')}
          onPress={() => stackNav.push('location')} chevron
        />
        <GroupedRow
          icon="server-outline" tone="neutral" label={tr('profile.rows.connection')}
          hint={serverHost}
          onPress={() => stackNav.push('connection')} chevron
        />
      </GroupedSection>

      <GroupedSection title={tr('profile.sections.account')}>
        <GroupedRow
          icon="finger-print-outline" tone="success" label={tr('profile.rows.security')}
          hint={biometrics ? tr('profile.rows.biometricOn') : tr('profile.rows.biometricOff')}
          onPress={() => stackNav.push('security')} chevron
        />
        <GroupedRow
          icon="ribbon-outline" tone="primary" label={tr('profile.rows.accreditation')}
          hint={profile.licenseNo ? tr('profile.rows.licenceNumber', { number: profile.licenseNo }) : tr('profile.rows.noLicence')}
          onPress={() => stackNav.push('accreditation')} chevron
        />
      </GroupedSection>

      {/* Help & Feedback: the assayer's two-way channel to the product team — report a
          bug, ask for something, or ask a question, and follow the replies in thread. */}
      {onOpenFeedback && (
        <GroupedSection title={tr('profile.sections.help')}>
          <SettingRow
            icon="chatbox-ellipses-outline"
            tone="primary"
            label={tr('profile.rows.feedback')}
            hint={tr('profile.rows.feedbackHint')}
            onPress={onOpenFeedback}
            accessibilityLabel={tr('profile.rows.feedbackAccessibility')}
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
        <GroupedSection title={tr('profile.sections.session')}>
          <SettingRow
            icon="log-out-outline"
            tone="danger"
            label={tr('profile.rows.signOut')}
            hint={tr('profile.rows.signOutHint')}
            onPress={() => {
              Alert.alert(
                tr('profile.signOutConfirm.title'),
                tr('profile.signOutConfirm.body'),
                [
                  { text: tr('common.cancel'), style: 'cancel' },
                  { text: tr('common.signOut'), style: 'destructive', onPress: onLogout },
                ],
              );
            }}
            accessibilityLabel={tr('profile.signOutConfirm.accessibility')}
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
          {tr('profile.footer')} {versionLine()}
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
        active={stackNav.current === 'contact'} title={tr('profile.rows.contact')} onBack={stackNav.pop}
        trailing={<EditToggle editing={editing} onToggle={() => setEditing((e) => !e)} />}
      >
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.lg }}>
            <FieldInput label={tr('profile.fields.phone')} value={profile.phone} onChange={(v) => onUpdateProfileField('phone', v)} keyboardType="phone-pad" placeholder="+91…" readOnly={!editing} />
            <FieldInput label={tr('profile.fields.alternatePhone')} value={profile.alternatePhone} onChange={(v) => onUpdateProfileField('alternatePhone', v)} keyboardType="phone-pad" readOnly={!editing} />
            <FieldInput label={tr('profile.fields.email')} value={profile.email} onChange={(v) => onUpdateProfileField('email', v)} keyboardType="email-address" autoCapitalize="none" placeholder={tr('profile.fields.emailPlaceholder')} readOnly={!editing} />
          </Card>
        </View>
      </SubScreen>

      <SubScreen
        active={stackNav.current === 'address'} title={tr('profile.rows.address')} onBack={stackNav.pop}
        trailing={<EditToggle editing={editing} onToggle={() => setEditing((e) => !e)} />}
      >
        <AddressEditor profile={profile} onUpdateProfileField={onUpdateProfileField} editing={editing} />
      </SubScreen>

      <SubScreen
        active={stackNav.current === 'emergency'} title={tr('profile.rows.emergency')} onBack={stackNav.pop}
        trailing={<EditToggle editing={editing} onToggle={() => setEditing((e) => !e)} />}
      >
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.lg }}>
            <FieldInput label={tr('profile.fields.name')} value={profile.emergencyName} onChange={(v) => onUpdateProfileField('emergencyName', v)} autoCapitalize="words" readOnly={!editing} />
            <View style={{ flexDirection: 'row', gap: t.space.md }}>
              <View style={{ flex: 1 }}>
                <FieldInput label={tr('profile.fields.phone')} value={profile.emergencyPhone} onChange={(v) => onUpdateProfileField('emergencyPhone', v)} keyboardType="phone-pad" readOnly={!editing} />
              </View>
              <View style={{ flex: 1 }}>
                <FieldInput label={tr('profile.fields.relation')} value={profile.emergencyRelation} onChange={(v) => onUpdateProfileField('emergencyRelation', v)} autoCapitalize="words" readOnly={!editing} />
              </View>
            </View>
          </Card>
        </View>
      </SubScreen>

      <SubScreen
        active={stackNav.current === 'capability'} title={tr('profile.rows.capability')} onBack={stackNav.pop}
        trailing={<EditToggle editing={editing} onToggle={() => setEditing((e) => !e)} />}
      >
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.lg }}>
            <FieldInput label={tr('profile.fields.skills')} value={profile.skills} onChange={(v) => onUpdateProfileField('skills', v)} placeholder={tr('profile.fields.skillsPlaceholder')} readOnly={!editing} />
            <FieldInput label={tr('profile.fields.languages')} value={profile.languages} onChange={(v) => onUpdateProfileField('languages', v)} placeholder={tr('profile.fields.languagesPlaceholder')} readOnly={!editing} />
            <FieldInput label={tr('profile.fields.experienceYears')} value={String(profile.experienceYears ?? '')} onChange={(v) => onUpdateProfileField('experienceYears', Number(v) || 0)} keyboardType="numeric" readOnly={!editing} />
          </Card>
        </View>
      </SubScreen>

      <SubScreen
        active={stackNav.current === 'capacity'} title={tr('profile.rows.capacity')} onBack={stackNav.pop}
        trailing={<EditToggle editing={editing} onToggle={() => setEditing((e) => !e)} />}
      >
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.lg }}>
            <View style={{ flexDirection: 'row', gap: t.space.md }}>
              <View style={{ flex: 1 }}>
                <FieldInput label={tr('profile.fields.maxPerDay')} value={String(profile.maxDailyWorkload ?? '')} onChange={() => {}} lockedReason={lockReasonFor('maxDailyWorkload')} />
              </View>
              <View style={{ flex: 1 }}>
                <FieldInput label={tr('profile.fields.maxPerWeek')} value={String(profile.maxWeeklyWorkload ?? '')} onChange={() => {}} lockedReason={lockReasonFor('maxWeeklyWorkload')} />
              </View>
            </View>
            {/*
              "Preferred travel radius (km)" used to be an editable input here. It was a lie: no
              such column exists on the assayer record, `updateAssayerProfile` never sent it, and
              nothing in planning has ever read it. Typing in it marked the profile dirty, the
              save reported success, and the next load reset it to the hardcoded default — so the
              assayer believed they had limited how far they would travel, and the planner kept
              offering work at any distance.

              Removed rather than locked, because there is nothing behind it to explain. Making it
              real means a column, a DTO field, and a distance check in the recommendation engine.
            */}
            <FieldInput label={tr('profile.fields.preferredRegions')} value={profile.preferredRegions} onChange={(v) => onUpdateProfileField('preferredRegions', v)} autoCapitalize="words" readOnly={!editing} />
          </Card>
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'payment'} title={tr('profile.rows.payment')} onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.lg }}>
            <AppText variant="caption" tone="faint">{tr('profile.lockReasons.paymentHeader')}</AppText>
            {/* "PAN" and "IFSC" are not translated in any locale: they are the names printed on the
                card and the passbook the assayer is copying from. See the note in locales/hi.ts. */}
            <FieldInput label="PAN" value={profile.panNumber} onChange={() => {}} lockedReason={lockReasonFor('panNumber')} />
            <FieldInput label={tr('profile.fields.bankAccount')} value={profile.bankAccountNumber} onChange={() => {}} lockedReason={lockReasonFor('bankAccountNumber')} />
            <FieldInput label={tr('profile.fields.ifsc')} value={profile.ifscCode} onChange={() => {}} lockedReason={lockReasonFor('ifscCode')} />
          </Card>
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'stats'} title={tr('profile.rows.performance')} onBack={stackNav.pop}>
        <StatsScreen
          totalAssignments={profile.totalAssignments}
          completedAssignments={profile.completedAssignments}
          averageRating={profile.averageRating}
          openQueries={openQueries ?? 0}
          resolvedQueries={resolvedQueries ?? 0}
        />
      </SubScreen>

      {/*
        Language.
        Placed above Appearance, and its row above Appearance's too, because for this workforce it
        is the more consequential of the two by a wide margin. Laid out as one option per row
        rather than as the three side-by-side tiles the theme picker uses: a language name is a
        word, not a glyph, and Devanagari at tile width would have to be shrunk below the 12px
        type floor `theme/contrast.spec.ts` pins.
      */}
      <SubScreen active={stackNav.current === 'language'} title={tr('language.title')} onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.md }}>
            <SettingRow icon="language-outline" tone="primary" label={tr('language.title')} hint={tr('language.hint')} />
            <View style={{ gap: t.space.sm }}>
              {LANGUAGE_OPTIONS.map((o) => {
                const active = language.preference === o.key;
                return (
                  <Tappable
                    key={o.key}
                    accessibilityRole="button"
                    accessibilityLabel={o.label}
                    accessibilityState={{ selected: active }}
                    onPress={() => language.setLanguage(o.key)}
                  >
                    <View style={{
                      flexDirection: 'row', alignItems: 'center', gap: t.space.md,
                      paddingVertical: t.space.md, paddingHorizontal: t.space.lg, borderRadius: t.radius.md,
                      backgroundColor: active ? t.colors.primarySoft : t.colors.bg,
                      borderWidth: 1.5, borderColor: active ? t.colors.primary : t.colors.border,
                    }}>
                      <Icon name={o.icon} size={20} color={active ? t.colors.primary : t.colors.textFaint} />
                      <AppText variant="body" tone={active ? 'primary' : 'default'} style={{ flex: 1 }}>{o.label}</AppText>
                      {active && <Icon name="checkmark-circle" size={18} color={t.colors.primary} />}
                    </View>
                  </Tappable>
                );
              })}
            </View>
            {/* Said on the screen, not only in a comment: the Hindi is machine-drafted and not yet
                reviewed, and somebody choosing it deserves to know why parts of the app will still
                be in English. */}
            <AppText variant="caption" tone="muted">{tr('language.hiDraftNote')}</AppText>
          </Card>
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'appearance'} title={tr('profile.rows.appearance')} onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.md }}>
            <SettingRow
              icon="color-palette-outline"
              tone="primary"
              label={tr('profile.theme.label')}
              hint={tr('profile.theme.hint')}
            />
            <View style={{ flexDirection: 'row', gap: t.space.sm }}>
              {THEME_OPTIONS.map((o) => {
                const active = t.preference === o.key;
                return (
                  <Tappable
                    key={o.key}
                    style={{ flex: 1 }}
                    accessibilityRole="button"
                    accessibilityLabel={active
                      ? tr('profile.theme.accessibilitySelected', { name: o.label })
                      : tr('profile.theme.accessibility', { name: o.label })}
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

      <SubScreen active={stackNav.current === 'notifications'} title={tr('profile.rows.notifications')} onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <GroupedSection>
            <ToggleRow
              icon="notifications-outline"
              tone="primary"
              label={tr('profile.notifications.push')}
              hint={pushBusy ? tr('profile.rows.pushUpdating') : tr('profile.notifications.pushHint')}
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
                <AppText variant="overline" tone="faint" style={{ paddingLeft: 29 + t.space.md, marginBottom: t.space.xs }}>{tr('profile.notifications.whichAlerts')}</AppText>
                {notifPrefsLoading ? (
                  <AppText variant="caption" tone="faint" style={{ paddingLeft: 29 + t.space.md }}>{tr('profile.notifications.loading')}</AppText>
                ) : notifPrefs.length === 0 ? (
                  <AppText variant="caption" tone="faint" style={{ paddingLeft: 29 + t.space.md }}>{tr('profile.notifications.unavailable')}</AppText>
                ) : (
                  notifPrefs.map((pref) => (
                    <SubToggle
                      key={pref.category}
                      label={CATEGORY_KEYS[pref.category] ? tr(CATEGORY_KEYS[pref.category].label) : pref.category}
                      hint={
                        savingCategory === pref.category
                          ? tr('common.saving')
                          : CATEGORY_KEYS[pref.category] && tr(CATEGORY_KEYS[pref.category].hint)
                      }
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
              label={tr('profile.notifications.sound')}
              hint={tr('profile.notifications.soundHint')}
              value={soundAlerts}
              onChange={async (v) => { setSoundAlerts(v); await setDevicePreference('soundAlerts', v); }}
            />
          </GroupedSection>
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'location'} title={tr('profile.rows.location')} onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <GroupedSection>
            <ToggleRow
              icon="navigate-outline"
              tone="info"
              label={tr('profile.location.share')}
              hint={tr('profile.location.shareHint')}
              value={liveTrackingEnabled}
              onChange={async (v) => { await setLiveTrackingEnabled(v); }}
            />
          </GroupedSection>
          {!liveTrackingReady && (
            <AppText variant="caption" tone="faint" style={{ marginLeft: t.space.lg }}>{tr('profile.location.syncing')}</AppText>
          )}
          {liveTrackingEnabled && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginLeft: t.space.lg }}>
              <Icon name="radio" size={13} color={t.colors.success} />
              <AppText variant="caption" tone="success">{tr('profile.location.active')}</AppText>
            </View>
          )}
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'security'} title={tr('profile.rows.security')} onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <GroupedSection>
            <SettingRow
              icon="key-outline"
              tone="neutral"
              label={tr('profile.security.changePassword')}
              hint={tr('profile.security.changePasswordHint')}
              chevron
              onPress={() => setChangePasswordVisible(true)}
            />
            <ToggleRow
              icon="finger-print-outline"
              tone="success"
              label={tr('profile.security.biometricLock')}
              hint={tr('profile.security.biometricLockHint')}
              value={biometrics}
              onChange={async (v) => { setBiometrics(v); await setDevicePreference('biometrics', v); }}
            />
            <SettingRow
              icon="hardware-chip-outline"
              tone={sensor === 'ready' ? 'success' : 'neutral'}
              label={tr('profile.security.sensor')}
              hint={
                sensor === 'ready'
                  ? tr('profile.security.sensorEnrolled')
                  : sensor === 'not-enrolled'
                    ? tr('profile.security.sensorNotEnrolled')
                    : sensor === 'none'
                      ? tr('profile.security.sensorNone')
                      : tr('profile.security.sensorChecking')
              }
              trailing={
                <Badge
                  label={sensor === 'ready' ? tr('profile.security.ready') : sensor === 'checking' ? '…' : tr('profile.security.unavailable')}
                  tone={sensor === 'ready' ? 'success' : 'neutral'}
                  icon={sensor === 'ready' ? 'shield-checkmark-outline' : 'alert-circle-outline'}
                />
              }
            />
          </GroupedSection>
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'accreditation'} title={tr('profile.rows.accreditation')} onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <GroupedSection
            footnote={tr('profile.accreditation.footnote')}
          >
            <SettingRow
              icon="ribbon-outline"
              tone="primary"
              label={tr('profile.accreditation.certified')}
              hint={profile.licenseNo ? tr('profile.rows.licenceNumber', { number: profile.licenseNo }) : tr('profile.rows.noLicence')}
              trailing={profile.licenseNo
                ? <Badge label={tr('profile.accreditation.verified')} tone="success" />
                : <Badge label={tr('profile.accreditation.notOnFile')} tone="warning" />}
            />
          </GroupedSection>
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'connection'} title={tr('profile.rows.connection')} onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <GroupedSection>
            <SettingRow
              icon="server-outline"
              tone="accent"
              label={tr('profile.connection.server')}
              hint={serverHost}
              trailing={
                conn === 'checking' ? (
                  <Badge label={tr('profile.connection.checking')} tone="neutral" icon="sync-outline" />
                ) : conn === 'online' ? (
                  <Badge label={tr('profile.connection.online')} tone="success" icon="cloud-done-outline" />
                ) : (
                  <Badge label={tr('profile.connection.offline')} tone="danger" icon="cloud-offline-outline" />
                )
              }
            />
          </GroupedSection>
          <Button
            label={conn === 'checking' ? tr('profile.connection.checkInProgress') : tr('profile.connection.check')}
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
