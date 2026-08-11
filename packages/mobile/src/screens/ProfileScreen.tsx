import React, { useCallback, useEffect, useState } from 'react';
import { View, TextInput, Switch, TextStyle } from 'react-native';
import { useTheme, ThemePreference } from '../theme/ThemeProvider';
import {
  AppText, Avatar, Badge, Button, Card, Divider, Icon, IconName, Section, StatStrip, StatTile, Tappable,
} from '../components/ui/primitives';
import { useLocation } from '../context/LocationContext';
import { formatRupees as money } from '@fapoms/shared';
import { getPreference, setPreference as setDevicePreference } from '../services/preferences';
import { MobileApiService, NotificationPreference, getApiBaseUrl } from '../services/api.service';
import { probeServerUrl } from '../services/server-config';
import { registerForPushNotificationsAsync, unregisterPushNotificationsAsync } from '../services/notification.service';
import { StatsScreen } from './StatsScreen';
import Constants from 'expo-constants';
import * as LocalAuthentication from 'expo-local-authentication';

const appVersion = Constants.expoConfig?.version ?? '1.0.0';

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

type SectionKey = 'PROFILE' | 'WORK' | 'STATS' | 'APP';

// ─────────────────────────────────────────────────────────── Row building blocks
//
// These are module-scope on purpose. Defining them inside the component body gives them a new
// component identity on every parent render, so React unmounts and remounts the subtree — for
// a TextInput that means the keyboard cursor is thrown out after each keystroke (the same
// remount bug fixed app-wide in the modal/drawer inputs). Hoisted, identity is stable.

/** The leading tinted square that anchors every settings row — the iOS-Settings glyph tile. */
const IconTile: React.FC<{ icon: IconName; bg: string; fg: string }> = ({ icon, bg, fg }) => (
  <View style={{
    width: 32, height: 32, borderRadius: 8,
    backgroundColor: bg, alignItems: 'center', justifyContent: 'center',
  }}>
    <Icon name={icon} size={17} color={fg} />
  </View>
);

type RowTone = 'primary' | 'accent' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/**
 * A settings row: leading icon tile, label + optional hint, trailing control
 * (a value, a chevron, a Switch — whatever `trailing` renders). Tappable when
 * `onPress` is given, plain otherwise.
 */
const SettingRow: React.FC<{
  icon: IconName;
  tone?: RowTone;
  label: string;
  hint?: string;
  trailing?: React.ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  chevron?: boolean;
}> = ({ icon, tone = 'neutral', label, hint, trailing, onPress, accessibilityLabel, chevron }) => {
  const t = useTheme();
  const tones: Record<RowTone, { bg: string; fg: string }> = {
    primary: { bg: t.colors.primarySoft, fg: t.colors.primary },
    accent: { bg: t.colors.accentSoft, fg: t.colors.accent },
    success: { bg: t.colors.successSoft, fg: t.colors.success },
    warning: { bg: t.colors.warningSoft, fg: t.colors.warning },
    danger: { bg: t.colors.dangerSoft, fg: t.colors.danger },
    info: { bg: t.colors.infoSoft, fg: t.colors.info },
    neutral: { bg: t.colors.surfacePress, fg: t.colors.textMuted },
  };
  const c = tones[tone];

  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingVertical: t.space.sm }}>
      <IconTile icon={icon} bg={c.bg} fg={c.fg} />
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <AppText variant="body" tone={tone === 'danger' ? 'danger' : 'default'}>{label}</AppText>
        {hint ? <AppText variant="caption" tone="faint">{hint}</AppText> : null}
      </View>
      {trailing}
      {chevron && <Icon name="chevron-forward" size={16} color={t.colors.textFaint} />}
    </View>
  );

  return onPress ? (
    <Tappable onPress={onPress} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label}>
      {body}
    </Tappable>
  ) : body;
};

/** A SettingRow whose trailing control is a Switch. */
const ToggleRow: React.FC<{
  icon: IconName;
  tone?: RowTone;
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}> = ({ icon, tone, label, hint, value, onChange }) => {
  const t = useTheme();
  return (
    <SettingRow
      icon={icon}
      tone={tone}
      label={label}
      hint={hint}
      trailing={
        <Switch
          value={!!value}
          onValueChange={onChange}
          accessibilityLabel={label}
          trackColor={{ false: t.colors.surfacePress, true: t.colors.primarySoft }}
          thumbColor={value ? t.colors.primary : t.colors.textFaint}
        />
      }
    />
  );
};

/** A compact indented toggle for per-category alerts, sitting under the master push row. */
const SubToggle: React.FC<{ label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }> = ({
  label, hint, value, onChange,
}) => {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingVertical: t.space.sm, paddingLeft: 32 + t.space.md }}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <AppText variant="small">{label}</AppText>
        {hint ? <AppText variant="caption" tone="faint">{hint}</AppText> : null}
      </View>
      <Switch
        value={!!value}
        onValueChange={onChange}
        accessibilityLabel={label}
        trackColor={{ false: t.colors.surfacePress, true: t.colors.primarySoft }}
        thumbColor={value ? t.colors.primary : t.colors.textFaint}
      />
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
  onOpenAvailability,
}) => {
  const t = useTheme();
  const [tab, setTab] = useState<SectionKey>('PROFILE');

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
    { value: profile.bankAccountNumber, label: 'Bank account number', tab: 'WORK' as const },
    { value: profile.ifscCode, label: 'IFSC code', tab: 'WORK' as const },
    { value: profile.panNumber, label: 'PAN number', tab: 'WORK' as const },
    { value: profile.phone, label: 'Phone number', tab: 'PROFILE' as const },
    { value: profile.emergencyPhone, label: 'Emergency contact', tab: 'PROFILE' as const },
  ]).filter((f) => !String(f.value ?? '').trim());

  const recordComplete = missingFields.length === 0;

  const THEME_OPTIONS: { key: ThemePreference; label: string; icon: 'contrast-outline' | 'sunny-outline' | 'moon-outline' }[] = [
    { key: 'system', label: 'System', icon: 'contrast-outline' },
    { key: 'light', label: 'Light', icon: 'sunny-outline' },
    { key: 'dark', label: 'Dark', icon: 'moon-outline' },
  ];

  const serverHost = getApiBaseUrl().replace(/^https?:\/\//, '').replace(/\/api\/v1$/, '');

  return (
    <View style={{ gap: t.space.xl }}>
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
            <AppText variant="h1" numberOfLines={1}>{assayerName || 'Field Assayer'}</AppText>
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
            onPress={() => setTab(missingFields[0].tab)}
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
            <Icon name="checkmark-circle" size={18} color={t.colors.success} />
            <AppText variant="small" tone="muted">Your record is complete.</AppText>
          </View>
        )}
      </Card>

      {/* The key numbers a field worker actually checks: what I've done, what I'm owed. */}
      <StatStrip>
        <StatTile label="Completed" value={profile.completedAssignments ?? 0} icon="checkmark-done" tone="success" />
        <StatTile label="Assigned" value={profile.totalAssignments ?? 0} icon="clipboard-outline" />
        <StatTile label="Balance" value={money(profile.runningBalance)} icon="wallet-outline" tone="accent" />
        {Number(profile.averageRating) > 0 && (
          <StatTile label="Rating" value={Number(profile.averageRating).toFixed(1)} icon="star" tone="warning" hint="out of 5" />
        )}
      </StatStrip>

      {/* Three groups instead of six crowded tabs */}
      <View style={{ flexDirection: 'row', gap: t.space.sm }}>
        {([
          { k: 'PROFILE' as const, label: 'Profile', icon: 'person-outline' as const },
          { k: 'WORK' as const, label: 'Work', icon: 'briefcase-outline' as const },
          { k: 'STATS' as const, label: 'Stats', icon: 'stats-chart-outline' as const },
          { k: 'APP' as const, label: 'Settings', icon: 'settings-outline' as const },
        ]).map((s) => {
          const active = tab === s.k;
          return (
            <Tappable key={s.k} onPress={() => setTab(s.k)} style={{ flex: 1 }} accessibilityRole="button" accessibilityLabel={`${s.label} tab`}>
              <View style={{
                alignItems: 'center', gap: 5, paddingVertical: t.space.md, borderRadius: t.radius.md,
                backgroundColor: active ? t.colors.primarySoft : t.colors.surface,
                borderWidth: 1, borderColor: active ? 'transparent' : t.colors.border,
              }}>
                <Icon name={s.icon} size={18} color={active ? t.colors.primary : t.colors.textFaint} />
                <AppText variant="caption" tone={active ? 'primary' : 'faint'}>{s.label}</AppText>
              </View>
            </Tappable>
          );
        })}
      </View>

      {tab === 'PROFILE' && (
        <>
          <Section title="Contact">
            <Card level={1} style={{ gap: t.space.lg }}>
              <FieldInput label="Phone" value={profile.phone} onChange={(v) => onUpdateProfileField('phone', v)} keyboardType="phone-pad" placeholder="+91…" />
              <FieldInput label="Alternate phone" value={profile.alternatePhone} onChange={(v) => onUpdateProfileField('alternatePhone', v)} keyboardType="phone-pad" />
            </Card>
          </Section>

          <Section title="Address">
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
          </Section>

          <Section title="Emergency contact">
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
          </Section>
        </>
      )}

      {tab === 'WORK' && (
        <>
          <Section title="Availability">
            <Card level={1}>
              {/* Self-service time off. The scheduler already honours leave, so this is what
                  keeps offers away while the assayer is out — no HR round-trip. */}
              <SettingRow
                icon="calendar-outline"
                tone="primary"
                label="Set your time off"
                hint="Mark days you're unavailable — you won't be offered audits then."
                onPress={onOpenAvailability}
                accessibilityLabel="Set your time off"
                chevron
              />
            </Card>
          </Section>

          <Section title="Capability">
            <Card level={1} style={{ gap: t.space.lg }}>
              <FieldInput label="Skills" value={profile.skills} onChange={(v) => onUpdateProfileField('skills', v)} placeholder="Gold assaying, purity testing" />
              <FieldInput label="Languages" value={profile.languages} onChange={(v) => onUpdateProfileField('languages', v)} placeholder="English, Hindi" />
              <FieldInput label="Experience (years)" value={String(profile.experienceYears ?? '')} onChange={(v) => onUpdateProfileField('experienceYears', Number(v) || 0)} keyboardType="numeric" />
            </Card>
          </Section>

          <Section title="Capacity">
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
          </Section>

          <Section title="Payment details">
            <Card level={1} style={{ gap: t.space.lg }}>
              <AppText variant="caption" tone="faint">
                Held by HR for payouts and statutory filing. Changes are reviewed before they take effect.
              </AppText>
              <FieldInput label="PAN" value={profile.panNumber} onChange={() => {}} lockedReason="Held by HR. Contact your HR coordinator to correct this." />
              <FieldInput label="Bank account" value={profile.bankAccountNumber} onChange={() => {}} lockedReason="Payment details are changed by HR only, so a payout cannot be redirected from a handset." />
              <FieldInput label="IFSC" value={profile.ifscCode} onChange={() => {}} lockedReason="Changed by HR alongside your bank account." />
            </Card>
          </Section>
        </>
      )}

      {/* Performance figures, all derived from counts the backend genuinely returns.
          StatsScreen was written and then never reachable — it existed in the codebase with
          no route into it, so an assayer could not see how they were doing. */}
      {tab === 'STATS' && (
        <StatsScreen
          totalAssignments={profile.totalAssignments}
          completedAssignments={profile.completedAssignments}
          averageRating={profile.averageRating}
          openQueries={openQueries ?? 0}
          resolvedQueries={resolvedQueries ?? 0}
        />
      )}

      {tab === 'APP' && (
        <>
          <Section title="Appearance">
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
                      // ThemeProvider persists the choice itself (device preference store),
                      // so there is nothing else to keep in step. This previously also wrote
                      // an `appTheme` field on the profile object that nothing ever read.
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
          </Section>

          <Section title="Notifications">
            <Card level={1}>
              {/* Registers or removes this handset's push token on the server. Delivery is
                  decided server-side, so unregistering is the only thing that genuinely stops
                  pushes — the old switch set a state field nothing read or persisted. */}
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
                    // Only reflect the switch if the server actually accepted the change,
                    // so it never shows "on" while this device is unregistered.
                    if (ok) { setPushEnabled(v); await setDevicePreference('pushEnabled', v); }
                  } finally {
                    setPushBusy(false);
                  }
                }}
              />

              {/* Per-category control, so the notifications that matter most to a field
                  worker can stay on while the rest are muted. Only shown while push is on —
                  with the device unregistered these have nothing to act on. */}
              {pushEnabled && (
                <View style={{ marginTop: t.space.xs, gap: t.space.xs }}>
                  <AppText variant="overline" tone="faint" style={{ paddingLeft: 32 + t.space.md }}>WHICH ALERTS</AppText>
                  {notifPrefsLoading ? (
                    <AppText variant="caption" tone="faint" style={{ paddingLeft: 32 + t.space.md }}>Loading your alert preferences…</AppText>
                  ) : notifPrefs.length === 0 ? (
                    <AppText variant="caption" tone="faint" style={{ paddingLeft: 32 + t.space.md }}>Alert preferences unavailable offline.</AppText>
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
              <Divider spacing={t.space.xs} />
              <ToggleRow
                icon="volume-medium-outline"
                tone="accent"
                label="Sound alerts"
                hint="Play a chime when a notification arrives"
                value={soundAlerts}
                onChange={async (v) => { setSoundAlerts(v); await setDevicePreference('soundAlerts', v); }}
              />
            </Card>
          </Section>

          <Section title="Location & Recommendations">
            <Card level={1}>
              <ToggleRow
                icon="navigate-outline"
                tone="info"
                label="Share live location"
                hint="Off by default. When on, your current position — not your home address — is used to rank you for nearby audits, like ride-hailing apps."
                value={liveTrackingEnabled}
                onChange={async (v) => { await setLiveTrackingEnabled(v); }}
              />
              {!liveTrackingReady && (
                <AppText variant="caption" tone="faint" style={{ marginTop: 4, paddingLeft: 32 + t.space.md }}>Syncing your sharing preference…</AppText>
              )}
              {liveTrackingEnabled && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4, paddingLeft: 32 + t.space.md }}>
                  <Icon name="radio" size={13} color={t.colors.success} />
                  <AppText variant="caption" tone="success">Live position active — recommendations use where you are now</AppText>
                </View>
              )}
            </Card>
          </Section>

          <Section title="Security & Biometrics">
            <Card level={1}>
              {/* Controls the lock over a restored session, and whether the sign-in screen
                  offers the biometric option. Persisted to the device, so it survives a
                  restart. */}
              <ToggleRow
                icon="finger-print-outline"
                tone="success"
                label="Biometric Lock"
                hint="Require your fingerprint or face to open Orbit, and after two minutes away from the app"
                value={biometrics}
                onChange={async (v) => { setBiometrics(v); await setDevicePreference('biometrics', v); }}
              />
              <Divider spacing={t.space.xs} />
              {/*
                Reports what the handset actually has. This row rendered a hardcoded "ACTIVE"
                badge and the words "Biometric hardware ready" on every device — including one
                with no sensor, or a sensor with no fingerprint enrolled, where the lock cannot
                engage at all. It told the assayer their session was protected when it was not.
              */}
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
            </Card>
          </Section>

          <Section title="Accreditation & License">
            <Card level={1} style={{ gap: t.space.sm }}>
              {/*
                Shows the assayer's own licence number, or says it is missing.
                This was hardcoded to `CERT-GOLD-AS0127-2026` — one specific person's
                number, displayed to every user beside a green VERIFIED badge, while a
                real `licenseNo` field sat unused in profile state. Anyone without an
                accreditation on file appeared fully certified for bank collateral work.
              */}
              <SettingRow
                icon="ribbon-outline"
                tone="primary"
                label="BIS / NABL Certified Assayer"
                hint={profile.licenseNo ? `License No: ${profile.licenseNo}` : 'No licence number on file'}
                trailing={profile.licenseNo ? <Badge label="VERIFIED" tone="success" /> : <Badge label="NOT ON FILE" tone="warning" />}
              />
              <AppText variant="caption" tone="muted">
                Authorised for precious metal purity testing, gold ornament packet sealing, and bank collateral audits.
              </AppText>
            </Card>
          </Section>

          <Section title="Connection">
            <Card level={1} style={{ gap: t.space.md }}>
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
              <Divider spacing={t.space.xs} />
              <Button
                label={conn === 'checking' ? 'Checking…' : 'Check connection'}
                icon="refresh-outline"
                variant="neutral"
                size="sm"
                loading={conn === 'checking'}
                onPress={() => { void checkConnection(); }}
              />
            </Card>
          </Section>

          {/*
            An "Operations Desk & Hotline" card sat here with "Ops Hotline" and "Emergency SOS"
            buttons. Neither had an onPress — they were painted controls. In a field app the
            emergency button is the one thing that must never be decorative, so it is removed
            rather than left looking available. Queries to the desk go through the thread on
            the assignment itself, which is a real channel with a record.
          */}
        </>
      )}

      {/* Only on the tabs that hold editable fields. On Stats and Settings it was a primary
          action that saved nothing the user had touched. */}
      {(tab === 'PROFILE' || tab === 'WORK') && (
        <Button
          label={savingProfile ? 'Saving…' : 'Save changes'}
          icon="save-outline"
          onPress={onSaveProfile}
          loading={savingProfile}
          size="lg"
          full
        />
      )}

      {/* Session: the destructive action lives alone at the very bottom, in danger tone,
          visually severed from everything an assayer edits day to day. Never glowing. */}
      {onLogout && (
        <Section title="Session">
          <Card level={1}>
            <SettingRow
              icon="log-out-outline"
              tone="danger"
              label="Sign out"
              hint="You'll need your password to sign back in"
              onPress={onLogout}
              accessibilityLabel="Sign out of Orbit"
              chevron
            />
          </Card>
        </Section>
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
        <AppText variant="caption" tone="faint">Orbit Field Assayer • v{appVersion}</AppText>
      </View>
    </View>
  );
};
