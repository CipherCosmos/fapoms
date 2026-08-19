import React, { useCallback, useEffect, useState } from 'react';
import { View, TextInput, TextStyle, Modal, Alert, Dimensions } from 'react-native';
import { useTheme, ThemePreference } from '../theme/ThemeProvider';
import {
  AppText, Avatar, Badge, Button, Card, GroupedRow, GroupedSection, GroupedSwitch,
  Icon, IconName, StatTile, Tappable,
} from '../components/ui/primitives';
import { SubScreen, useStackNav } from '../components/ui/SimpleStack';
import { ChangePasswordScreen } from './ChangePasswordScreen';
import { useLocation } from '../context/LocationContext';
import { formatRupees as money } from '@fapoms/shared';
import { getPreference, setPreference as setDevicePreference } from '../services/preferences';
import { MobileApiService, NotificationPreference, getApiBaseUrl } from '../services/api.service';
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
  totalEarnings: number | string;
  runningBalance: number | string;
  earningsPaid: number | string;
  earningsAwaitingApproval: number | string;
  assayerCode: string;
}

interface ProfileScreenProps {
  /** Clarification counts for the Stats tab, derived from the assayer's live assignments. */
  openQueries?: number;
  resolvedQueries?: number;
  assayerName?: string;
  assayerCode?: string;
  profile: ProfileDataState;
  savingProfile: boolean;
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
}> = ({ label, value, onChange, placeholder, keyboardType = 'default', autoCapitalize = 'none', lockedReason }) => {
  const t = useTheme();
  const [focus, setFocus] = useState(false);

  if (lockedReason) {
    return (
      <View style={{ gap: t.space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <AppText variant="overline" tone="faint">{label.toUpperCase()}</AppText>
          <Icon name="lock-closed" size={11} color={t.colors.textFaint} />
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
        <AppText variant="caption" tone="faint">{lockedReason}</AppText>
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
  savingProfile,
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
        <StatTile label="Balance" value={money(profile.runningBalance)} icon="wallet-outline" tone="accent" />
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

      {/* Saves whatever was touched in the two sections above. Kept unconditional (rather than
          gated to a tab) now that there's no tab to gate it to — it's cheap to show and an
          assayer who has nothing pending simply never needs to tap it. */}
      <Button
        label={savingProfile ? 'Saving…' : 'Save changes'}
        icon="save-outline"
        onPress={onSaveProfile}
        loading={savingProfile}
        size="lg"
        full
      />

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
      <SubScreen active={stackNav.current === 'contact'} title="Contact" onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.lg }}>
            <FieldInput label="Phone" value={profile.phone} onChange={(v) => onUpdateProfileField('phone', v)} keyboardType="phone-pad" placeholder="+91…" />
            <FieldInput label="Alternate phone" value={profile.alternatePhone} onChange={(v) => onUpdateProfileField('alternatePhone', v)} keyboardType="phone-pad" />
          </Card>
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'address'} title="Address" onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.lg }}>
            <FieldInput label="Address" value={profile.address} onChange={(v) => onUpdateProfileField('address', v)} autoCapitalize="words" />
            <View style={{ flexDirection: 'row', gap: t.space.md }}>
              <View style={{ flex: 1 }}>
                <FieldInput label="City" value={profile.city} onChange={(v) => onUpdateProfileField('city', v)} autoCapitalize="words" />
              </View>
              <View style={{ flex: 1 }}>
                <FieldInput label="Pincode" value={profile.pincode} onChange={(v) => onUpdateProfileField('pincode', v)} keyboardType="numeric" />
              </View>
            </View>
            <View style={{ flexDirection: 'row', gap: t.space.md }}>
              <View style={{ flex: 1 }}>
                <FieldInput label="District" value={profile.district} onChange={(v) => onUpdateProfileField('district', v)} autoCapitalize="words" />
              </View>
              <View style={{ flex: 1 }}>
                <FieldInput label="State" value={profile.state} onChange={(v) => onUpdateProfileField('state', v)} autoCapitalize="words" />
              </View>
            </View>
          </Card>
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'emergency'} title="Emergency contact" onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.lg }}>
            <FieldInput label="Name" value={profile.emergencyName} onChange={(v) => onUpdateProfileField('emergencyName', v)} autoCapitalize="words" />
            <View style={{ flexDirection: 'row', gap: t.space.md }}>
              <View style={{ flex: 1 }}>
                <FieldInput label="Phone" value={profile.emergencyPhone} onChange={(v) => onUpdateProfileField('emergencyPhone', v)} keyboardType="phone-pad" />
              </View>
              <View style={{ flex: 1 }}>
                <FieldInput label="Relation" value={profile.emergencyRelation} onChange={(v) => onUpdateProfileField('emergencyRelation', v)} autoCapitalize="words" />
              </View>
            </View>
          </Card>
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'capability'} title="Capability" onBack={stackNav.pop}>
        <View style={{ padding: t.space.lg, gap: t.space.lg }}>
          <Card level={1} style={{ gap: t.space.lg }}>
            <FieldInput label="Skills" value={profile.skills} onChange={(v) => onUpdateProfileField('skills', v)} placeholder="Gold assaying, purity testing" />
            <FieldInput label="Languages" value={profile.languages} onChange={(v) => onUpdateProfileField('languages', v)} placeholder="English, Hindi" />
            <FieldInput label="Experience (years)" value={String(profile.experienceYears ?? '')} onChange={(v) => onUpdateProfileField('experienceYears', Number(v) || 0)} keyboardType="numeric" />
          </Card>
        </View>
      </SubScreen>

      <SubScreen active={stackNav.current === 'capacity'} title="Capacity" onBack={stackNav.pop}>
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
            <FieldInput label="Preferred travel radius (km)" value={String(profile.preferredRadius ?? '')} onChange={(v) => onUpdateProfileField('preferredRadius', Number(v) || 0)} keyboardType="numeric" />
            <FieldInput label="Preferred regions" value={profile.preferredRegions} onChange={(v) => onUpdateProfileField('preferredRegions', v)} autoCapitalize="words" />
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
