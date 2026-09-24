import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import {
  REFERRAL_SOURCE_LABELS, ReferralSourceType, candidateMayEditSourceReferral, normalizeSourceReferral,
  sourceReferralLine, type SourceReferral,
} from '@fapoms/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { AppText, Button, Card, Icon, Input, SelectField, Tappable } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { GroupHeader } from './parts';

type Draft = { type: string; name: string; mobile: string; email: string };
const fromStored = (r: SourceReferral | null | undefined): Draft =>
  ({ type: r?.type ?? '', name: r?.name ?? '', mobile: r?.mobile ?? '', email: r?.email ?? '' });
const payloadOf = (d: Draft): Draft | null =>
  (d.type || d.name.trim() || d.mobile.trim() || d.email.trim() ? d : null);
const sameAs = (a: Draft | null, b: Draft | null) => JSON.stringify(a) === JSON.stringify(b);

/** Long enough for a tap to land on the next box of this group before the group counts as left. */
const LEAVE_DELAY_MS = 250;

/**
 * WHO REFERRED THEM — the source reference, not a fourth referee. The same shared rule as the web
 * form and HR's screens (`normalizeSourceReferral`). When HR recorded it at intake it is shown,
 * not asked.
 *
 * Saved the way the web form saves it: when the person LEAVES the group, not per box — so a
 * half-typed entry is not called wrong while they are moving from the name to the mobile. It used
 * to have its own Save button, and anybody who pressed Next instead lost the answer; leaving the
 * step now saves it too.
 *
 * Collapsed behind "Someone referred me" — most people were not referred, and four empty boxes
 * read as four more questions to answer.
 */
export const SourceReferralSection: React.FC<{
  stored: SourceReferral | null | undefined;
  save: (patch: { sourceReferral: Draft | null }) => void;
}> = ({ stored, save }) => {
  const t = useTheme();
  const tr = useT();
  const [draft, setDraft] = useState<Draft>(fromStored(stored));
  const [open, setOpen] = useState(() => payloadOf(fromStored(stored)) !== null);
  const [error, setError] = useState<string | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { setDraft(fromStored(stored)); }, [stored]);

  // The latest of everything, for the save on leaving the step (an unmount cannot read state).
  const latest = useRef({ draft, stored, save });
  latest.current = { draft, stored, save };

  /** Saves when the answer is whole and changed. `quiet` keeps an incomplete one from being scolded. */
  const commit = (next: Draft, quiet: boolean) => {
    const payload = payloadOf(next);
    const { error: problem } = normalizeSourceReferral(payload, 'CANDIDATE');
    if (problem) {
      if (!quiet) setError(problem);
      return;
    }
    setError(null);
    if (!sameAs(payload, payloadOf(fromStored(latest.current.stored)))) save({ sourceReferral: payload });
  };

  // Leaving the step (Next or Back) unmounts this: whatever is whole and unsaved goes with it.
  useEffect(() => () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    const { draft: last, stored: was, save: send } = latest.current;
    if (!candidateMayEditSourceReferral(was)) return;
    const payload = payloadOf(last);
    if (normalizeSourceReferral(payload, 'CANDIDATE').error) return;
    if (!sameAs(payload, payloadOf(fromStored(was)))) send({ sourceReferral: payload });
  }, []);

  if (!candidateMayEditSourceReferral(stored)) {
    return (
      <Card level={1} style={{ gap: t.space.sm }}>
        <GroupHeader icon="person-add-outline" title={tr('selfRegistration.form.referralTitle')} />
        <AppText variant="small" tone="muted">{tr('selfRegistration.form.referralByHr', { who: sourceReferralLine(stored) })}</AppText>
      </Card>
    );
  }

  if (!open) {
    return (
      <Tappable
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={tr('selfRegistration.form.referralToggle')}
        hitSlop={8}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, paddingVertical: t.space.sm, paddingHorizontal: t.space.xs }}>
          <Icon name="person-add-outline" size={16} color={t.colors.primary} />
          <AppText variant="small" tone="primary" style={{ fontWeight: '700' }}>
            {tr('selfRegistration.form.referralToggle')} ›
          </AppText>
        </View>
      </Tappable>
    );
  }

  const focusIn = () => {
    if (leaveTimer.current) clearTimeout(leaveTimer.current);
    leaveTimer.current = null;
  };
  const focusOut = () => {
    focusIn();
    leaveTimer.current = setTimeout(() => commit(latest.current.draft, false), LEAVE_DELAY_MS);
  };
  const set = (k: keyof Draft) => (v: string) => { setDraft((d) => ({ ...d, [k]: v })); setError(null); };

  return (
    <Card level={1} style={{ gap: t.space.md }}>
      <GroupHeader icon="person-add-outline" title={tr('selfRegistration.form.referralTitle')} note={tr('selfRegistration.form.referralNote')} />
      <SelectField
        label={tr('selfRegistration.form.referralType')}
        placeholder={tr('selfRegistration.form.referralTypePlaceholder')}
        closeLabel={tr('common.close')}
        value={draft.type}
        onChange={(v) => {
          const next = { ...draft, type: v };
          setDraft(next);
          setError(null);
          commit(next, true);
        }}
        options={Object.values(ReferralSourceType).map((v) => ({ value: v, label: REFERRAL_SOURCE_LABELS[v] }))}
      />
      <Input label={tr('selfRegistration.form.referralName')} value={draft.name} onChangeText={set('name')} onFocus={focusIn} onBlur={focusOut} maxLength={200} />
      <Input label={tr('selfRegistration.form.referralMobile')} value={draft.mobile} onChangeText={set('mobile')} onFocus={focusIn} onBlur={focusOut} keyboardType="phone-pad" prefix="+91" maxLength={14} />
      <Input label={tr('selfRegistration.form.referralEmail')} value={draft.email} onChangeText={set('email')} onFocus={focusIn} onBlur={focusOut} keyboardType="email-address" autoCapitalize="none" />
      {error ? <AppText variant="small" tone="danger">{error}</AppText> : null}
      {stored ? (
        <Button
          label={tr('selfRegistration.form.referralClear')}
          variant="ghost"
          size="sm"
          style={{ alignSelf: 'flex-end' }}
          onPress={() => { focusIn(); setDraft(fromStored(null)); setError(null); save({ sourceReferral: null }); }}
        />
      ) : null}
    </Card>
  );
};
