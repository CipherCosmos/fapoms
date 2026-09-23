import React, { useState } from 'react';
import { View } from 'react-native';
import { APPLICATION_REFERENCES_MAX, referenceEmailProblem, referencePhoneForDisplay } from '@fapoms/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { AppText, Button, Card, Input } from '../../components/ui/primitives';
import { useT } from '../../i18n';
import { GroupHeader } from './parts';
import type { RegistrationReference } from '../../services/self-registration.service';

/**
 * People who can vouch for the candidate — up to three, at least one with a number.
 *
 * Each add/remove saves straight away through `onChange`, like every other answer on this
 * form. Submit refuses without a ringable one; the screen hands that refusal in as `error`
 * so the candidate hears it here rather than on the last step.
 */
export const ReferencesSection: React.FC<{
  references: RegistrationReference[];
  onChange: (next: RegistrationReference[]) => void;
  error: string | null;
}> = ({ references, onChange, error }) => {
  const t = useTheme();
  const tr = useT();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [relationship, setRelationship] = useState('');
  const [email, setEmail] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const add = () => {
    if (!name.trim()) {
      setLocalError(tr('selfRegistration.form.referenceNameNeeded'));
      return;
    }
    if (references.length >= APPLICATION_REFERENCES_MAX) {
      setLocalError(tr('selfRegistration.form.referenceTooMany'));
      return;
    }
    if (email.trim() && referenceEmailProblem(email.trim().toLowerCase())) {
      setLocalError(tr('selfRegistration.form.referenceEmailInvalid'));
      return;
    }
    setLocalError(null);
    onChange([...references, {
      fullName: name.trim(),
      phone: phone.replace(/\D/g, '').slice(0, 15),
      relationship: relationship.trim(),
      email: email.trim().toLowerCase(),
    }]);
    setName('');
    setPhone('');
    setRelationship('');
    setEmail('');
  };

  const problem = localError ?? error;

  return (
    <Card level={1} style={{ gap: t.space.md }}>
      <GroupHeader
        icon="people-outline"
        title={tr('selfRegistration.form.referencesTitle')}
        note={tr('selfRegistration.form.referencesNote')}
      />
      {references.map((r, i) => (
        <View
          key={`${r.fullName}-${i}`}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: t.space.sm,
            padding: t.space.sm, borderRadius: t.radius.md, backgroundColor: t.colors.surfaceAlt,
          }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <AppText variant="bodyStrong">{r.fullName}</AppText>
            <AppText variant="small" tone="muted">
              {[r.relationship, r.phone ? referencePhoneForDisplay(r.phone) : null, r.email].filter(Boolean).join(' · ')}
            </AppText>
          </View>
          <Button
            label={tr('selfRegistration.form.referenceRemove')}
            variant="ghost"
            size="sm"
            onPress={() => onChange(references.filter((_, j) => j !== i))}
          />
        </View>
      ))}
      {references.length < APPLICATION_REFERENCES_MAX ? (
        <View style={{ gap: t.space.sm }}>
          <Input
            label={tr('selfRegistration.form.referenceName')}
            value={name}
            onChangeText={setName}
            placeholder={tr('selfRegistration.form.referenceNamePlaceholder')}
            autoCapitalize="words"
            maxLength={200}
          />
          <Input
            label={tr('selfRegistration.form.referencePhone')}
            value={phone}
            onChangeText={(v) => setPhone(v.replace(/\D/g, '').slice(0, 15))}
            placeholder={tr('selfRegistration.form.referencePhonePlaceholder')}
            keyboardType="number-pad"
          />
          <Input
            label={tr('selfRegistration.form.referenceRelation')}
            value={relationship}
            onChangeText={setRelationship}
            placeholder={tr('selfRegistration.form.referenceRelationPlaceholder')}
            maxLength={100}
          />
          <Input
            label={tr('selfRegistration.form.referenceEmail')}
            value={email}
            onChangeText={setEmail}
            placeholder={tr('selfRegistration.form.referenceEmailPlaceholder')}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={255}
          />
          <Button
            label={tr('selfRegistration.form.referenceAdd')}
            icon="add-outline"
            variant="neutral"
            onPress={add}
            style={{ alignSelf: 'flex-start' }}
          />
        </View>
      ) : (
        <AppText variant="small" tone="muted">{tr('selfRegistration.form.referenceMaxNote')}</AppText>
      )}
      {problem ? <AppText variant="small" tone="danger">{problem}</AppText> : null}
    </Card>
  );
};
