import React, { useState } from 'react';
import { View } from 'react-native';
import { AppText, Button, Icon } from './ui/primitives';
import { useTheme } from '../theme/ThemeProvider';
import { useT } from '../i18n';

/**
 * "The office is still waiting for some of your papers."
 *
 * Shown on the home screen only when there is something the person can actually do about it, and
 * dismissable for the session — the same shape as `LocationConfirmBanner`, for the same reason.
 * A field worker opens this app to see today's work; anything else on that screen is borrowing
 * their attention and has to earn it and then get out of the way.
 *
 * What it must never become is a gate. Registration is completed by HR from the desk, for people
 * with no smartphone at all, so this is an offer of a shortcut and is worded as one. It says how
 * many papers are outstanding and nothing about consequences, because there are none in this app.
 */
export function RegistrationPapersBanner({
  outstanding,
  failed,
  onOpen,
}: {
  /** Required documents with nothing sent yet. */
  outstanding: number;
  /** Documents captured on this phone whose upload did not arrive. */
  failed: number;
  onOpen: () => void;
}) {
  const t = useTheme();
  const tr = useT();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || (outstanding === 0 && failed === 0)) return null;

  // A failed upload is the more urgent of the two and reads differently: the person has already
  // done the work, and the only thing between them and being finished is a tap. Saying "3 papers
  // needed" to somebody who photographed all three an hour ago would be both wrong and dispiriting.
  const urgent = failed > 0;
  const title = urgent
    ? failed === 1 ? tr('registration.banner.oneFailed') : tr('registration.banner.manyFailed', { count: failed })
    : outstanding === 1 ? tr('registration.banner.oneNeeded') : tr('registration.banner.manyNeeded', { count: outstanding });
  const body = urgent
    ? tr('registration.banner.failedBody')
    : tr('registration.banner.neededBody');

  return (
    <View
      style={{
        backgroundColor: urgent ? t.colors.dangerSoft : t.colors.infoSoft,
        borderRadius: t.radius.lg,
        padding: t.space.md,
        gap: t.space.sm,
        marginBottom: t.space.md,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        <Icon
          name={urgent ? 'alert-circle-outline' : 'document-text-outline'}
          size={18}
          color={urgent ? t.colors.danger : t.colors.info}
        />
        <AppText variant="bodyStrong" tone={urgent ? 'danger' : 'info'} style={{ flex: 1 }}>
          {title}
        </AppText>
      </View>
      <AppText variant="caption" tone="muted">{body}</AppText>
      <View style={{ flexDirection: 'row', gap: t.space.sm }}>
        <Button
          label={urgent ? tr('registration.banner.sendAgain') : tr('registration.banner.seeWhatIsNeeded')}
          icon={urgent ? 'refresh' : 'arrow-forward'}
          variant="primary"
          onPress={onOpen}
          style={{ flex: 1 }}
        />
        <Button label={tr('common.notNow')} variant="ghost" onPress={() => setDismissed(true)} />
      </View>
    </View>
  );
}
