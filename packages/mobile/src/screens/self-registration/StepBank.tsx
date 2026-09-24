import React, { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import {
  EMERGENCY_CONTACT_RELATIONS, EmploymentCategory, REGISTRATION_FIELD_LIMITS,
  bankAccountConfirmProblem, identifierFormatIssue, isValidIfsc, normaliseIdentifierOnBlur, type RegistrationFormField,
} from '@fapoms/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { AppText, Card, FieldLabel, Icon, Input, Tappable, SelectField, type SelectOption } from '../../components/ui/primitives';
import { useT, type TranslationKey, type TranslationVars } from '../../i18n';
import { SelfRegistrationApi } from '../../services/self-registration.service';
import { FieldNote, GroupHeader, StepFooter } from './parts';
import { FORMAT_HINT_KEYS, registrationFieldPatch } from './registration-form';
import type { StepProps } from './types';

export interface StepBankProps extends StepProps {
  onCategoryChange: (category: EmploymentCategory) => void;
  /** Already translated. */
  categoryNote: string | null;
  onBack: () => void;
  onContinue: () => void;
}

const CATEGORY_CARDS: { value: EmploymentCategory; title: TranslationKey; desc: TranslationKey; docs: TranslationKey }[] = [
  {
    value: EmploymentCategory.FREELANCER,
    title: 'selfRegistration.form.freelancer',
    desc: 'selfRegistration.form.freelancerDesc',
    docs: 'selfRegistration.form.freelancerDocs',
  },
  {
    value: EmploymentCategory.PROPRIETOR,
    title: 'selfRegistration.form.proprietor',
    desc: 'selfRegistration.form.proprietorDesc',
    docs: 'selfRegistration.form.proprietorDocs',
  },
];

const OTHER_RELATION = '__other';
const RELATIONS: readonly string[] = EMERGENCY_CONTACT_RELATIONS;

type Note = { key: TranslationKey; vars?: TranslationVars; tone: 'info' | 'warning' };

const digitsOnly = (v: string, max: number) => v.replace(/\D/g, '').slice(0, max);

export const StepBank: React.FC<StepBankProps> = ({
  token, form, errors, setField, commitField, pickField, save, onCategoryChange, categoryNote, onBack, onContinue,
}) => {
  const t = useTheme();
  const tr = useT();

  const formRef = useRef(form);
  formRef.current = form;
  const lookupSeq = useRef(0);
  const lastResolvedBank = useRef<string | null>(null);
  const [ifscBusy, setIfscBusy] = useState(false);
  const [ifscNote, setIfscNote] = useState<Note | null>(null);
  // The bank name the IFSC filled in and locked; null when the box is open for typing.
  const [lockedBank, setLockedBank] = useState<string | null>(null);
  const [relationOtherOpen, setRelationOtherOpen] = useState(false);

  const formatHint = (key: RegistrationFormField): string | undefined => {
    const issue = identifierFormatIssue(key, String(form[key] ?? ''));
    return issue ? tr(FORMAT_HINT_KEYS[issue]) : undefined;
  };

  const runIfscLookup = useCallback(async (code: string) => {
    const clean = (code || '').trim().toUpperCase();
    const seq = ++lookupSeq.current;
    if (!isValidIfsc(clean)) {
      setIfscBusy(false);
      setIfscNote(null);
      return;
    }
    setIfscBusy(true);
    setIfscNote(null);
    const result = await SelfRegistrationApi.lookupIfsc(token, clean);
    if (seq !== lookupSeq.current) return;
    setIfscBusy(false);

    const found = result.success && result.data?.bankName ? result.data : null;
    if (!found) {
      setIfscNote({ key: 'selfRegistration.form.ifscNotFound', tone: 'warning' });
      setLockedBank(null);
      return;
    }
    const previousResolved = lastResolvedBank.current;
    lastResolvedBank.current = found.bankName;
    const typed = (formRef.current.bankName ?? '').trim();
    const vars = { bank: found.bankName, branch: found.branchName || found.city || '' };
    // A name the candidate typed themselves wins; one an earlier IFSC filled in is ours to replace.
    if (typed && typed !== previousResolved && typed !== found.bankName) {
      setLockedBank(null);
      setIfscNote({ key: 'selfRegistration.form.ifscFoundKept', vars: { ...vars, typed }, tone: 'info' });
      return;
    }
    setLockedBank(found.bankName);
    setIfscNote({ key: 'selfRegistration.form.ifscFound', vars, tone: 'info' });
    pickField('bankName', found.bankName);
  }, [token, pickField]);

  const onIfscBlur = () => {
    const value = (normaliseIdentifierOnBlur('ifscCode', form.ifscCode) ?? form.ifscCode).toUpperCase();
    commitField('ifscCode');
    void runIfscLookup(value);
  };

  const relationOptions: SelectOption[] = [
    ...RELATIONS.map((r) => ({ value: r, label: r })),
    { value: OTHER_RELATION, label: tr('selfRegistration.form.relationOther') },
  ];
  const storedRelation = form.emergencyContactRelation.trim();
  const relationIsListed = RELATIONS.includes(form.emergencyContactRelation);
  const relationPickerValue = !storedRelation
    ? (relationOtherOpen ? OTHER_RELATION : '')
    : relationIsListed ? form.emergencyContactRelation : OTHER_RELATION;
  const showRelationOther = relationOtherOpen || (Boolean(storedRelation) && !relationIsListed);

  const onRelationPick = (v: string) => {
    if (v === OTHER_RELATION) {
      setRelationOtherOpen(true);
      pickField('emergencyContactRelation', '');
      return;
    }
    setRelationOtherOpen(false);
    pickField('emergencyContactRelation', v);
  };

  const bankIsLocked = lockedBank !== null && form.bankName === lockedBank;
  const ifscHint = !ifscBusy && !ifscNote ? formatHint('ifscCode') : undefined;

  return (
    <View style={{ gap: t.space.lg }}>
      <Card level={1} style={{ gap: t.space.md }}>
        <FieldLabel>{tr('selfRegistration.form.categoryTitle')}</FieldLabel>
        {CATEGORY_CARDS.map((c) => {
          const selected = form.employmentCategory === c.value;
          return (
            <Tappable
              key={c.value}
              onPress={() => onCategoryChange(c.value)}
              accessibilityRole="button"
              accessibilityLabel={tr(c.title)}
              accessibilityState={{ selected }}
              scaleTo={0.98}
            >
              <View style={{
                borderWidth: 2,
                borderColor: selected ? t.colors.primary : t.colors.border,
                backgroundColor: selected ? t.colors.primarySoft : t.colors.surfaceAlt,
                borderRadius: t.radius.lg,
                padding: t.space.lg,
                gap: t.space.sm,
              }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
                  <View style={{
                    width: 24, height: 24, borderRadius: 12, borderWidth: 2,
                    borderColor: selected ? t.colors.primary : t.colors.textMuted,
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    {selected && <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: t.colors.primary }} />}
                  </View>
                  <AppText variant="h3" style={{ flex: 1 }}>{tr(c.title)}</AppText>
                </View>
                <AppText variant="small" tone="muted">{tr(c.desc)}</AppText>
                <View style={{
                  alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: t.space.xs,
                  backgroundColor: t.colors.warningSoft, borderRadius: t.radius.sm,
                  paddingHorizontal: t.space.sm, paddingVertical: t.space.xs,
                }}>
                  <Icon name="document-text-outline" size={13} color={t.colors.warning} />
                  <AppText variant="caption" tone="warning" style={{ flexShrink: 1, fontWeight: '600' }}>{tr(c.docs)}</AppText>
                </View>
              </View>
            </Tappable>
          );
        })}
        {errors.employmentCategory ? (
          <AppText variant="caption" tone="danger">{errors.employmentCategory}</AppText>
        ) : null}
        {categoryNote ? <FieldNote text={categoryNote} tone="warning" /> : null}
      </Card>

      <Card level={1} style={{ gap: t.space.lg }}>
        <GroupHeader icon="card-outline" title={tr('selfRegistration.form.idNumbersTitle')} />
        <Input
          label={tr('selfRegistration.form.pan')}
          value={form.panNumber}
          onChangeText={(v) => setField('panNumber', v.toUpperCase())}
          onBlur={() => commitField('panNumber')}
          placeholder={tr('selfRegistration.form.panPlaceholder')}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={10}
          hint={formatHint('panNumber')}
          error={errors.panNumber}
        />
        <Input
          label={tr('selfRegistration.form.aadhaar')}
          value={form.aadhaarNumber}
          onChangeText={(v) => setField('aadhaarNumber', digitsOnly(v, 12))}
          onBlur={() => commitField('aadhaarNumber')}
          placeholder={tr('selfRegistration.form.aadhaarPlaceholder')}
          keyboardType="number-pad"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={12}
          hint={formatHint('aadhaarNumber')}
          error={errors.aadhaarNumber}
        />
      </Card>

      <Card level={1} style={{ gap: t.space.lg }}>
        <GroupHeader
          icon="business-outline"
          title={tr('selfRegistration.form.bankTitle')}
          note={tr('selfRegistration.form.bankNote')}
        />
        <Input
          label={tr('selfRegistration.form.bankAccountNumber')}
          value={form.bankAccountNumber}
          onChangeText={(v) => {
            setField('bankAccountNumber', digitsOnly(v, 18));
            // A changed number is a new number: it has to be typed a second time.
            setField('bankAccountNumberConfirm', '');
          }}
          onBlur={() => {
            // Saved once confirmed (below) — except emptying it, which needs no second typing and
            // must reach the server so a wrong number can be cleared.
            if (!form.bankAccountNumber.trim()) commitField('bankAccountNumber');
          }}
          placeholder={tr('selfRegistration.form.bankAccountPlaceholder')}
          keyboardType="number-pad"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={18}
          error={errors.bankAccountNumber}
        />
        {/*
          Typed twice, because nothing else catches a wrong digit — Indian account numbers carry no
          check digit. The copy/paste menu is hidden on this box: a pasted copy repeats the slip.
        */}
        <Input
          label={tr('selfRegistration.form.bankAccountConfirm')}
          value={form.bankAccountNumberConfirm ?? ''}
          onChangeText={(v) => setField('bankAccountNumberConfirm', digitsOnly(v, 18))}
          onBlur={() => {
            if (form.bankAccountNumber.trim()
              && !bankAccountConfirmProblem(form.bankAccountNumber, form.bankAccountNumberConfirm ?? '')) {
              save(registrationFieldPatch('bankAccountNumber', form.bankAccountNumber));
            }
          }}
          placeholder={tr('selfRegistration.form.bankAccountConfirmPlaceholder')}
          keyboardType="number-pad"
          autoCapitalize="none"
          autoCorrect={false}
          contextMenuHidden
          maxLength={18}
          error={errors.bankAccountNumberConfirm
            ?? ((form.bankAccountNumberConfirm ?? '').trim()
              // Both typed and they differ — the shared rule decides, the catalogue says it.
              && bankAccountConfirmProblem(form.bankAccountNumber, form.bankAccountNumberConfirm ?? '')
              ? tr('selfRegistration.errors.accountConfirmMismatch')
              : undefined)}
        />
        <View style={{ gap: t.space.sm }}>
          <Input
            label={tr('selfRegistration.form.ifsc')}
            value={form.ifscCode}
            onChangeText={(v) => { setField('ifscCode', v.toUpperCase()); setLockedBank(null); }}
            onBlur={onIfscBlur}
            placeholder={tr('selfRegistration.form.ifscPlaceholder')}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={11}
            hint={ifscHint}
            error={errors.ifscCode}
          />
          {ifscBusy && <FieldNote text={tr('selfRegistration.form.ifscLooking')} busy />}
          {!ifscBusy && ifscNote && <FieldNote text={tr(ifscNote.key, ifscNote.vars)} tone={ifscNote.tone} />}
        </View>
        {bankIsLocked ? (
          <View style={{ gap: t.space.sm }}>
            <Input label={tr('selfRegistration.form.bankName')} value={form.bankName} readOnly />
            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: t.space.sm }}>
              <Icon name="checkmark-circle" size={14} color={t.colors.success} />
              <AppText variant="caption" tone="muted">{tr('selfRegistration.form.bankChecked')}</AppText>
              <Tappable onPress={() => setLockedBank(null)} accessibilityRole="button" hitSlop={12}>
                <AppText variant="caption" tone="primary" style={{ fontWeight: '700', textDecorationLine: 'underline' }}>
                  {tr('selfRegistration.form.bankEdit')}
                </AppText>
              </Tappable>
            </View>
          </View>
        ) : (
          <Input
            label={tr('selfRegistration.form.bankName')}
            value={form.bankName}
            onChangeText={(v) => setField('bankName', v)}
            onBlur={() => commitField('bankName')}
            placeholder={tr('selfRegistration.form.bankNamePlaceholder')}
            autoCapitalize="words"
            maxLength={REGISTRATION_FIELD_LIMITS.bankName}
            error={errors.bankName}
          />
        )}
      </Card>

      <Card level={1} style={{ gap: t.space.lg }}>
        <Input
          label={tr('selfRegistration.form.qualification')}
          value={form.qualification}
          onChangeText={(v) => setField('qualification', v)}
          onBlur={() => commitField('qualification')}
          placeholder={tr('selfRegistration.form.qualificationPlaceholder')}
          maxLength={REGISTRATION_FIELD_LIMITS.qualification}
          hint={tr('selfRegistration.form.qualificationHint')}
          error={errors.qualification}
        />
      </Card>

      <Card level={1} style={{ gap: t.space.lg }}>
        <GroupHeader
          icon="people-outline"
          title={tr('selfRegistration.form.emergencyTitle')}
          note={tr('selfRegistration.form.emergencyHint')}
        />
        <Input
          label={tr('selfRegistration.form.emergencyName')}
          value={form.emergencyContactName}
          onChangeText={(v) => setField('emergencyContactName', v)}
          onBlur={() => commitField('emergencyContactName')}
          placeholder={tr('selfRegistration.form.emergencyNamePlaceholder')}
          autoCapitalize="words"
          maxLength={REGISTRATION_FIELD_LIMITS.emergencyContactName}
          error={errors.emergencyContactName}
        />
        <Input
          label={tr('selfRegistration.form.emergencyPhone')}
          value={form.emergencyContactPhone}
          onChangeText={(v) => setField('emergencyContactPhone', v)}
          onBlur={() => commitField('emergencyContactPhone')}
          placeholder={tr('selfRegistration.otp.phonePlaceholder')}
          prefix="+91"
          keyboardType="phone-pad"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={16}
          error={errors.emergencyContactPhone}
        />
        <View style={{ gap: t.space.sm }}>
          <SelectField
            closeLabel={tr('common.close')}
            label={tr('selfRegistration.form.emergencyRelation')}
            value={relationPickerValue}
            options={relationOptions}
            placeholder={tr('selfRegistration.form.chooseRelation')}
            onChange={onRelationPick}
            error={showRelationOther ? undefined : errors.emergencyContactRelation}
          />
          {showRelationOther && (
            <Input
              value={form.emergencyContactRelation}
              onChangeText={(v) => setField('emergencyContactRelation', v)}
              onBlur={() => commitField('emergencyContactRelation')}
              placeholder={tr('selfRegistration.form.relationOtherPlaceholder')}
              accessibilityLabel={tr('selfRegistration.form.relationOther')}
              autoCapitalize="words"
              maxLength={REGISTRATION_FIELD_LIMITS.emergencyContactRelation}
              error={errors.emergencyContactRelation}
            />
          )}
        </View>
        <Input
          label={tr('selfRegistration.form.alternatePhone')}
          value={form.alternatePhone}
          onChangeText={(v) => setField('alternatePhone', v)}
          onBlur={() => commitField('alternatePhone')}
          placeholder={tr('selfRegistration.form.alternatePhonePlaceholder')}
          prefix="+91"
          keyboardType="phone-pad"
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={16}
          error={errors.alternatePhone}
        />
      </Card>

      <StepFooter onBack={onBack} onContinue={onContinue} />
    </View>
  );
};
