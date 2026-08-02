import React, { useState } from 'react';
import { View, TextInput, Switch, TextStyle } from 'react-native';
import { useTheme, ThemePreference } from '../theme/ThemeProvider';
import {
  AppText, Avatar, Badge, Button, Card, Divider, Icon, Section, StatStrip, StatTile, Tappable,
} from '../components/ui/primitives';

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
  biometricsEnabled?: boolean;
  pinCode?: string;
  offlineSyncEnabled?: boolean;
  pushNotificationsEnabled?: boolean;
  soundAlertsEnabled?: boolean;
  appTheme?: 'DARK' | 'LIGHT' | 'SYSTEM';
}

interface ProfileScreenProps {
  assayerName?: string;
  assayerCode?: string;
  profile: ProfileDataState;
  savingProfile: boolean;
  onUpdateProfileField: (field: keyof ProfileDataState, value: any) => void;
  onSaveProfile: () => void;
  onLogout?: () => void;
}

type SectionKey = 'PROFILE' | 'WORK' | 'APP';

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

  const money = (n: number | string) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

  const Field: React.FC<{
    label: string;
    value: string;
    onChange: (v: string) => void;
    placeholder?: string;
    keyboardType?: 'default' | 'numeric' | 'phone-pad';
    autoCapitalize?: 'none' | 'characters' | 'words';
  }> = ({ label, value, onChange, placeholder, keyboardType = 'default', autoCapitalize = 'none' }) => {
    const [focus, setFocus] = useState(false);
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
                  <Field label="Max per day" value={String(profile.maxDailyWorkload ?? '')} onChange={(v) => onUpdateProfileField('maxDailyWorkload', Number(v) || 0)} keyboardType="numeric" />
                </View>
                <View style={{ flex: 1 }}>
                  <Field label="Max per week" value={String(profile.maxWeeklyWorkload ?? '')} onChange={(v) => onUpdateProfileField('maxWeeklyWorkload', Number(v) || 0)} keyboardType="numeric" />
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
              <Field label="PAN" value={profile.panNumber} onChange={(v) => onUpdateProfileField('panNumber', v)} autoCapitalize="characters" />
              <Field label="Bank account" value={profile.bankAccountNumber} onChange={(v) => onUpdateProfileField('bankAccountNumber', v)} keyboardType="numeric" />
              <Field label="IFSC" value={profile.ifscCode} onChange={(v) => onUpdateProfileField('ifscCode', v)} autoCapitalize="characters" />
            </Card>
          </Section>
        </>
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
                      onPress={() => {
                        t.setPreference(o.key);
                        // Keep the persisted profile field in step with the live theme.
                        onUpdateProfileField('appTheme', o.key.toUpperCase() as ProfileDataState['appTheme']);
                      }}
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
              <Toggle
                label="Push notifications"
                hint="New assignments, clarifications and payment updates"
                value={profile.pushNotificationsEnabled !== false}
                onChange={(v) => onUpdateProfileField('pushNotificationsEnabled', v)}
              />
              <Divider spacing={t.space.xs} />
              <Toggle
                label="Sound alerts"
                value={!!profile.soundAlertsEnabled}
                onChange={(v) => onUpdateProfileField('soundAlertsEnabled', v)}
              />
            </Card>
          </Section>

          <Section title="Security">
            <Card level={1}>
              <Toggle
                label="Biometric sign-in"
                hint="Resume a saved session with your fingerprint or face"
                value={!!profile.biometricsEnabled}
                onChange={(v) => onUpdateProfileField('biometricsEnabled', v)}
              />
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

      {onLogout && (
        <Button label="Sign out" icon="log-out-outline" variant="danger" onPress={onLogout} full />
      )}
    </View>
  );
};
