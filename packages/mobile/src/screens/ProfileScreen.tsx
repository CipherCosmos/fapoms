import React, { useEffect, useState } from 'react';
import { View, TextInput, Switch, TextStyle } from 'react-native';
import { useTheme, ThemePreference } from '../theme/ThemeProvider';
import {
  AppText, Avatar, Badge, Button, Card, Divider, Icon, Section, StatStrip, StatTile, Tappable,
} from '../components/ui/primitives';
import { useLocation } from '../context/LocationContext';
import { formatRupees as money } from '@fapoms/shared';
import { getPreference, setPreference as setDevicePreference } from '../services/preferences';
import { MobileApiService, NotificationPreference } from '../services/api.service';
import { registerForPushNotificationsAsync, unregisterPushNotificationsAsync } from '../services/notification.service';
import { StatsScreen } from './StatsScreen';

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

  const Field: React.FC<{
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

  const Toggle: React.FC<{ label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }> = ({
    label, hint, value, onChange,
  }) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingVertical: t.space.sm }}>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <AppText variant="body">{label}</AppText>
        {hint && <AppText variant="caption" tone="faint">{hint}</AppText>}
      </View>
      <Switch
        value={!!value}
        onValueChange={onChange}
        trackColor={{ false: t.colors.surfacePress, true: t.colors.primarySoft }}
        thumbColor={value ? t.colors.primary : t.colors.textFaint}
      />
    </View>
  );

  const THEME_OPTIONS: { key: ThemePreference; label: string; icon: 'contrast-outline' | 'sunny-outline' | 'moon-outline' }[] = [
    { key: 'system', label: 'System', icon: 'contrast-outline' },
    { key: 'light', label: 'Light', icon: 'sunny-outline' },
    { key: 'dark', label: 'Dark', icon: 'moon-outline' },
  ];

  return (
    <View style={{ gap: t.space.xl }}>
      {/* Identity */}
      <Card level={2} style={{ alignItems: 'center', gap: t.space.md }}>
        <Avatar name={assayerName || 'Assayer'} size={72} />
        <View style={{ alignItems: 'center', gap: 4 }}>
          <AppText variant="h2">{assayerName || 'Field Assayer'}</AppText>
          {(assayerCode || profile.assayerCode) ? (
            <Badge label={assayerCode || profile.assayerCode} tone="primary" icon="id-card-outline" />
          ) : null}
        </View>
      </Card>

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
          { k: 'APP' as const, label: 'App', icon: 'settings-outline' as const },
        ]).map((s) => {
          const active = tab === s.k;
          return (
            <Tappable key={s.k} onPress={() => setTab(s.k)} style={{ flex: 1 }}>
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
              <Field label="Phone" value={profile.phone} onChange={(v) => onUpdateProfileField('phone', v)} keyboardType="phone-pad" placeholder="+91…" />
              <Field label="Alternate phone" value={profile.alternatePhone} onChange={(v) => onUpdateProfileField('alternatePhone', v)} keyboardType="phone-pad" />
            </Card>
          </Section>

          <Section title="Address">
            <Card level={1} style={{ gap: t.space.lg }}>
              <Field label="Address" value={profile.address} onChange={(v) => onUpdateProfileField('address', v)} autoCapitalize="words" />
              <View style={{ flexDirection: 'row', gap: t.space.md }}>
                <View style={{ flex: 1 }}>
                  <Field label="City" value={profile.city} onChange={(v) => onUpdateProfileField('city', v)} autoCapitalize="words" />
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="Pincode" value={profile.pincode} onChange={(v) => onUpdateProfileField('pincode', v)} keyboardType="numeric" />
                </View>
              </View>
              <View style={{ flexDirection: 'row', gap: t.space.md }}>
                <View style={{ flex: 1 }}>
                  <Field label="District" value={profile.district} onChange={(v) => onUpdateProfileField('district', v)} autoCapitalize="words" />
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="State" value={profile.state} onChange={(v) => onUpdateProfileField('state', v)} autoCapitalize="words" />
                </View>
              </View>
            </Card>
          </Section>

          <Section title="Emergency contact">
            <Card level={1} style={{ gap: t.space.lg }}>
              <Field label="Name" value={profile.emergencyName} onChange={(v) => onUpdateProfileField('emergencyName', v)} autoCapitalize="words" />
              <View style={{ flexDirection: 'row', gap: t.space.md }}>
                <View style={{ flex: 1 }}>
                  <Field label="Phone" value={profile.emergencyPhone} onChange={(v) => onUpdateProfileField('emergencyPhone', v)} keyboardType="phone-pad" />
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="Relation" value={profile.emergencyRelation} onChange={(v) => onUpdateProfileField('emergencyRelation', v)} autoCapitalize="words" />
                </View>
              </View>
            </Card>
          </Section>
        </>
      )}

      {tab === 'WORK' && (
        <>
          <Section title="Capability">
            <Card level={1} style={{ gap: t.space.lg }}>
              <Field label="Skills" value={profile.skills} onChange={(v) => onUpdateProfileField('skills', v)} placeholder="Gold assaying, purity testing" />
              <Field label="Languages" value={profile.languages} onChange={(v) => onUpdateProfileField('languages', v)} placeholder="English, Hindi" />
              <Field label="Experience (years)" value={String(profile.experienceYears ?? '')} onChange={(v) => onUpdateProfileField('experienceYears', Number(v) || 0)} keyboardType="numeric" />
            </Card>
          </Section>

          <Section title="Capacity">
            <Card level={1} style={{ gap: t.space.lg }}>
              <View style={{ flexDirection: 'row', gap: t.space.md }}>
                <View style={{ flex: 1 }}>
                  <Field label="Max per day" value={String(profile.maxDailyWorkload ?? '')} onChange={() => {}} lockedReason="Set by operations — it decides how much work you can be offered." />
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="Max per week" value={String(profile.maxWeeklyWorkload ?? '')} onChange={() => {}} lockedReason="Set by operations, alongside your daily limit." />
                </View>
              </View>
              <Field label="Preferred travel radius (km)" value={String(profile.preferredRadius ?? '')} onChange={(v) => onUpdateProfileField('preferredRadius', Number(v) || 0)} keyboardType="numeric" />
              <Field label="Preferred regions" value={profile.preferredRegions} onChange={(v) => onUpdateProfileField('preferredRegions', v)} autoCapitalize="words" />
            </Card>
          </Section>

          <Section title="Payment details">
            <Card level={1} style={{ gap: t.space.lg }}>
              <AppText variant="caption" tone="faint">
                Held by HR for payouts and statutory filing. Changes are reviewed before they take effect.
              </AppText>
              <Field label="PAN" value={profile.panNumber} onChange={() => {}} lockedReason="Held by HR. Contact your HR coordinator to correct this." />
              <Field label="Bank account" value={profile.bankAccountNumber} onChange={() => {}} lockedReason="Payment details are changed by HR only, so a payout cannot be redirected from a handset." />
              <Field label="IFSC" value={profile.ifscCode} onChange={() => {}} lockedReason="Changed by HR alongside your bank account." />
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
              <AppText variant="small" tone="muted">
                Follow your phone's setting, or pin the app to one mode.
              </AppText>
              <View style={{ flexDirection: 'row', gap: t.space.sm }}>
                {THEME_OPTIONS.map((o) => {
                  const active = t.preference === o.key;
                  return (
                    <Tappable
                      key={o.key}
                      style={{ flex: 1 }}
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
              <Toggle
                label="Push notifications"
                hint="New assignments, clarifications and payment updates"
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
              {pushBusy && (
                <AppText variant="caption" tone="faint" style={{ marginTop: 4 }}>Updating this device with the server…</AppText>
              )}

              {/* Per-category control, so the notifications that matter most to a field
                  worker can stay on while the rest are muted. Only shown while push is on —
                  with the device unregistered these have nothing to act on. */}
              {pushEnabled && (
                <View style={{ marginTop: t.space.md, gap: t.space.xs }}>
                  <AppText variant="caption" tone="faint">WHICH ALERTS</AppText>
                  {notifPrefsLoading ? (
                    <AppText variant="caption" tone="faint">Loading your alert preferences…</AppText>
                  ) : notifPrefs.length === 0 ? (
                    <AppText variant="caption" tone="faint">Alert preferences unavailable offline.</AppText>
                  ) : (
                    notifPrefs.map((pref) => (
                      <Toggle
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
              <Toggle
                label="Sound alerts"
                hint="Play a chime when a notification arrives"
                value={soundAlerts}
                onChange={async (v) => { setSoundAlerts(v); await setDevicePreference('soundAlerts', v); }}
              />
            </Card>
          </Section>

          <Section title="Location & Recommendations">
            <Card level={1}>
              <Toggle
                label="Share live location"
                hint="Off by default. When on, your current position — not your home address — is used to rank you for nearby audits, like ride-hailing apps."
                value={liveTrackingEnabled}
                onChange={async (v) => { await setLiveTrackingEnabled(v); }}
              />
              {!liveTrackingReady && (
                <AppText variant="caption" tone="faint" style={{ marginTop: 4 }}>Syncing your sharing preference…</AppText>
              )}
              {liveTrackingEnabled && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <Icon name="radio" size={13} color={t.colors.success} />
                  <AppText variant="caption" tone="success">Live position active — recommendations use where you are now</AppText>
                </View>
              )}
            </Card>
          </Section>

          <Section title="Security & Biometrics">
            <Card level={1} style={{ gap: t.space.md }}>
              {/* Controls whether the sign-in screen offers the biometric option at all.
                  Persisted to the device, so it survives a restart. */}
              <Toggle
                label="Biometric Sign-In"
                hint="Use fingerprint or face sensor to quickly sign into your assayer workspace"
                value={biometrics}
                onChange={async (v) => { setBiometrics(v); await setDevicePreference('biometrics', v); }}
              />
              <Divider spacing={t.space.xs} />
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ gap: 2, flex: 1 }}>
                  <AppText variant="small">Hardware Sensor</AppText>
                  <AppText variant="caption" tone="faint">Biometric hardware ready (Fingerprint / Face ID)</AppText>
                </View>
                <Badge label="ACTIVE" tone="success" icon="shield-checkmark-outline" />
              </View>
            </Card>
          </Section>

          <Section title="Accreditation & License">
            <Card level={1} style={{ gap: t.space.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                <Icon name="ribbon-outline" size={28} color={t.colors.primary} />
                <View style={{ flex: 1 }}>
                  <AppText variant="body" style={{ fontWeight: '700' }}>BIS / NABL Certified Assayer</AppText>
                  {/*
                    Shows the assayer's own licence number, or says it is missing.
                    This was hardcoded to `CERT-GOLD-AS0127-2026` — one specific person's
                    number, displayed to every user beside a green VERIFIED badge, while a
                    real `licenseNo` field sat unused in profile state. Anyone without an
                    accreditation on file appeared fully certified for bank collateral work.
                  */}
                  <AppText variant="caption" tone="faint">
                    {profile.licenseNo ? `License No: ${profile.licenseNo}` : 'No licence number on file'}
                  </AppText>
                </View>
                {profile.licenseNo ? <Badge label="VERIFIED" tone="success" /> : <Badge label="NOT ON FILE" tone="warning" />}
              </View>
              <AppText variant="caption" tone="muted" style={{ marginTop: 4 }}>
                Authorised for precious metal purity testing, gold ornament packet sealing, and bank collateral audits.
              </AppText>
            </Card>
          </Section>

          <Section title="Diagnostics & Storage">
            <Card level={1} style={{ gap: t.space.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <View style={{ gap: 2 }}>
                  <AppText variant="small">Live REST Server</AppText>
                  <AppText variant="caption" tone="faint">Connected to PostgreSQL backend</AppText>
                </View>
                <Badge label="ONLINE" tone="primary" icon="cloud-done-outline" />
              </View>
              <Divider spacing={t.space.xs} />
              <Button
                label="Clear Cache & Re-sync"
                icon="refresh-outline"
                variant="neutral"
                size="sm"
                onPress={() => {
                  onSaveProfile();
                }}
              />
            </Card>
          </Section>

          <Section title="Operations Desk & Hotline">
            <Card level={1} style={{ gap: t.space.md }}>
              <AppText variant="caption" tone="muted">
                Need immediate assistance during a branch audit? Contact operations dispatch desk directly.
              </AppText>
              <View style={{ flexDirection: 'row', gap: t.space.md }}>
                <View style={{ flex: 1 }}>
                  <Button label="Ops Hotline" icon="call-outline" variant="neutral" size="sm" full />
                </View>
                <View style={{ flex: 1 }}>
                  <Button label="Emergency SOS" icon="alert-circle-outline" variant="danger" size="sm" full />
                </View>
              </View>
            </Card>
          </Section>
        </>
      )}

      <Button
        label={savingProfile ? 'Saving…' : 'Save changes'}
        icon="save-outline"
        onPress={onSaveProfile}
        loading={savingProfile}
        size="lg"
        full
      />

      <View style={{ alignItems: 'center', paddingVertical: t.space.sm, gap: 2 }}>
        <AppText variant="caption" tone="faint">FAPOMS Field Assayer Suite • v2.4.12-release</AppText>
        <AppText variant="caption" tone="faint">AES-256 Encrypted • TLS 1.3 Secure Connection</AppText>
      </View>

      {onLogout && (
        <Button label="Sign out" icon="log-out-outline" variant="danger" onPress={onLogout} full />
      )}
    </View>
  );
};
