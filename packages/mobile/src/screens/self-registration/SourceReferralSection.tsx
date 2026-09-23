import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import {
  REFERRAL_SOURCE_LABELS, ReferralSourceType, candidateMayEditSourceReferral, normalizeSourceReferral,
  sourceReferralLine, type SourceReferral,
} from '@fapoms/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { AppText, Button, Card, Input, SelectField } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { GroupHeader } from './parts';

type Draft = { type: string; name: string; mobile: string; email: string };
const fromStored = (r: SourceReferral | null | undefined): Draft =>
  ({ type: r?.type ?? '', name: r?.name ?? '', mobile: r?.mobile ?? '', email: r?.email ?? '' });
const payloadOf = (d: Draft): Draft | null =>
  (d.type || d.name.trim() || d.mobile.trim() || d.email.trim() ? d : null);

/**
 * WHO REFERRED THEM — the source reference, not a fourth referee. The same shared rule as the web
 * form and HR's screens (`normalizeSourceReferral`). When HR recorded it at intake it is shown,
 * not asked; otherwise the candidate may give it, saved with its own button so a half-typed entry
 * is not called wrong while they are still typing it.
 */
export const SourceReferralSection: React.FC<{
  stored: SourceReferral | null | undefined;
  save: (patch: { sourceReferral: Draft | null }) => void;
}> = ({ stored, save }) => {
  const t = useTheme();
  const tr = useT();
  const [draft, setDraft] = useState<Draft>(fromStored(stored));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(fromStored(stored)); }, [stored]);

  if (!candidateMayEditSourceReferral(stored)) {
    return (
      <Card level={1} style={{ gap: t.space.sm }}>
        <GroupHeader icon="person-add-outline" title={tr('selfRegistration.form.referralTitle')} />
        <AppText variant="small" tone="muted">{tr('selfRegistration.form.referralByHr', { who: sourceReferralLine(stored) })}</AppText>
      </Card>
    );
  }

  const set = (k: keyof Draft) => (v: string) => { setDraft({ ...draft, [k]: v }); setError(null); };
  const commit = (next: Draft | null) => {
    const { error: problem } = normalizeSourceReferral(next, 'CANDIDATE');
    if (problem) { setError(problem); return; }
    setError(null);
    save({ sourceReferral: next });
  };

  return (
    <Card level={1} style={{ gap: t.space.md }}>
      <GroupHeader icon="person-add-outline" title={tr('selfRegistration.form.referralTitle')} note={tr('selfRegistration.form.referralNote')} />
      <SelectField
        label={tr('selfRegistration.form.referralType')}
        placeholder={tr('selfRegistration.form.referralTypePlaceholder')}
        value={draft.type}
        onChange={set('type')}
        options={Object.values(ReferralSourceType).map((v) => ({ value: v, label: REFERRAL_SOURCE_LABELS[v] }))}
      />
      <Input label={tr('selfRegistration.form.referralName')} value={draft.name} onChangeText={set('name')} maxLength={200} />
      <Input label={tr('selfRegistration.form.referralMobile')} value={draft.mobile} onChangeText={set('mobile')} keyboardType="phone-pad" prefix="+91" maxLength={14} />
      <Input label={tr('selfRegistration.form.referralEmail')} value={draft.email} onChangeText={set('email')} keyboardType="email-address" autoCapitalize="none" />
      {error ? <AppText variant="small" tone="danger">{error}</AppText> : null}
      <View style={{ flexDirection: 'row', gap: t.space.sm, justifyContent: 'flex-end' }}>
        {stored ? (
          <Button label={tr('selfRegistration.form.referralClear')} variant="ghost" size="sm" onPress={() => { setDraft(fromStored(null)); commit(null); }} />
        ) : null}
        <Button label={tr('selfRegistration.form.referralSave')} size="sm" onPress={() => commit(payloadOf(draft))} />
      </View>
    </Card>
  );
};
