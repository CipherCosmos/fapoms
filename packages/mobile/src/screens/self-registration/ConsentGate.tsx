import React, { useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { AppText, Button, Card, Icon, Tappable } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import type { RegistrationHydration } from '../../services/self-registration.service';

/**
 * What the candidate reads before the form exists.
 *
 * The server refuses every answer, code and scan until this is accepted, so it is a gate in front
 * of the form rather than a tick-box beside Submit. The words come from the API and the accepted
 * version is sent back, so what was shown and what the record says was agreed cannot differ.
 */
export const ConsentGate: React.FC<{
  notice: RegistrationHydration['consentNotice'];
  candidateName: string | null;
  busy: boolean;
  onAccept: () => void;
}> = ({ notice, candidateName, busy, onAccept }) => {
  const t = useTheme();
  const tr = useT();
  const [ticked, setTicked] = useState(false);

  return (
    <Card level={2} style={{ gap: t.space.lg, padding: t.space.xl, borderRadius: t.radius['2xl'] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
        <View style={{
          width: 48, height: 48, borderRadius: 24, backgroundColor: t.colors.successSoft,
          alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon name="shield-checkmark" size={26} color={t.colors.success} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <AppText variant="h2">{notice.title}</AppText>
          <AppText variant="caption" tone="muted">
            {candidateName ? `${candidateName} · ` : ''}{tr('selfRegistration.consent.collectedBy', { name: notice.collectedBy })}
          </AppText>
        </View>
      </View>

      <AppText variant="body" tone="muted">{notice.intro}</AppText>

      <View style={{ gap: t.space.sm }}>
        {notice.purposes.map((purpose) => (
          <View key={purpose.what} style={{ backgroundColor: t.colors.surfaceAlt, borderRadius: t.radius.lg, padding: t.space.md, gap: 3 }}>
            <AppText variant="bodyStrong">{purpose.what}</AppText>
            <AppText variant="small" tone="muted">{purpose.why}</AppText>
          </View>
        ))}
      </View>

      <NoticeSection title={tr('selfRegistration.consent.retentionTitle')}>
        <AppText variant="small" tone="muted">{notice.retention}</AppText>
      </NoticeSection>

      <NoticeSection title={tr('selfRegistration.consent.rightsTitle')}>
        {notice.rights.map((right) => (
          <View key={right} style={{ flexDirection: 'row', gap: t.space.sm }}>
            <AppText variant="small" tone="muted">•</AppText>
            <AppText variant="small" tone="muted" style={{ flex: 1 }}>{right}</AppText>
          </View>
        ))}
      </NoticeSection>

      <NoticeSection title={tr('selfRegistration.consent.withdrawalTitle')}>
        <AppText variant="small" tone="muted">{notice.withdrawal}</AppText>
      </NoticeSection>

      <NoticeSection title={tr('selfRegistration.consent.contactTitle')}>
        <AppText variant="small" tone="muted">{notice.grievanceContact}</AppText>
      </NoticeSection>

      <Tappable
        onPress={() => setTicked((v) => !v)}
        disabled={busy}
        accessibilityRole="switch"
        accessibilityState={{ checked: ticked, disabled: busy }}
        accessibilityLabel={notice.declaration}
      >
        <View style={{
          flexDirection: 'row', gap: t.space.md, padding: t.space.md, borderRadius: t.radius.lg,
          backgroundColor: ticked ? t.colors.primarySoft : t.colors.surfaceAlt,
          borderWidth: 1.5, borderColor: ticked ? t.colors.primary : 'transparent',
        }}>
          <Icon name={ticked ? 'checkbox' : 'square-outline'} size={26} color={ticked ? t.colors.primary : t.colors.textMuted} />
          <AppText variant="small" style={{ flex: 1 }}>{notice.declaration}</AppText>
        </View>
      </Tappable>

      <Button
        label={tr('selfRegistration.consent.agree')}
        icon="checkmark"
        onPress={onAccept}
        disabled={!ticked}
        loading={busy}
        size="lg"
        glow
        full
      />

      <AppText variant="caption" tone="faint">
        {tr('selfRegistration.consent.versionNote', { version: notice.version })}
      </AppText>
    </Card>
  );
};

const NoticeSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.xs }}>
      <AppText variant="overline" tone="faint">{title}</AppText>
      {children}
    </View>
  );
};
