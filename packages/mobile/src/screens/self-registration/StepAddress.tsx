import React, { useCallback, useRef, useState } from 'react';
import { View } from 'react-native';
import * as Location from 'expo-location';
import {
  INDIAN_STATES, REGISTRATION_EXPERIENCE_MAX, REGISTRATION_EXPERIENCE_MIN, REGISTRATION_FIELD_LIMITS,
  identifierFormatIssue, isSixDigitPincode, normaliseIdentifierOnBlur, pincodeFromAddress,
} from '@fapoms/shared';
import { useTheme } from '../../theme/ThemeProvider';
import { Button, Card, Input, SelectField, type SelectOption } from '../../components/ui/primitives';
import { MapPicker, isPlausibleIndianCoord } from '../../components/ui/MapPicker';
import { useT, type TranslationKey, type TranslationVars } from '../../i18n';
import { SelfRegistrationApi, type DraftPatch } from '../../services/self-registration.service';
import { FieldNote, GroupHeader, StepFooter } from './parts';
import { FORMAT_HINT_KEYS } from './registration-form';
import type { StepProps } from './types';

export interface HomePin { latitude: number; longitude: number }

export interface StepAddressProps extends StepProps {
  pin: HomePin | null;
  onPinChange: (pin: HomePin | null) => void;
  onBack: () => void;
  onContinue: () => void;
}

type Note = { key: TranslationKey; vars?: TranslationVars; tone: 'info' | 'warning' };
type Place = { state: string; district: string; city: string };

const placeLine = (p: Place) => [p.city, p.district, p.state].filter(Boolean).join(' · ');

export const StepAddress: React.FC<StepAddressProps> = ({
  token, form, errors, setField, commitField, pickField, save, pin, onPinChange, onBack, onContinue,
}) => {
  const t = useTheme();
  const tr = useT();

  // The lookup answers after an await; it must compare against what is in the boxes by then.
  const formRef = useRef(form);
  formRef.current = form;
  const lookupSeq = useRef(0);
  const [pincodeBusy, setPincodeBusy] = useState(false);
  const [pincodeNote, setPincodeNote] = useState<Note | null>(null);
  const [pincodeOffer, setPincodeOffer] = useState<Place | null>(null);

  const [locating, setLocating] = useState(false);
  const [pinError, setPinError] = useState<TranslationKey | null>(null);

  const runPincodeLookup = useCallback(async (pincode: string) => {
    const clean = (pincode || '').trim();
    const seq = ++lookupSeq.current;
    setPincodeOffer(null);
    if (!isSixDigitPincode(clean)) {
      setPincodeBusy(false);
      setPincodeNote(null);
      return;
    }
    setPincodeBusy(true);
    setPincodeNote(null);
    const result = await SelfRegistrationApi.lookupPincode(token, clean);
    if (seq !== lookupSeq.current) return;
    setPincodeBusy(false);

    const answer = result.success ? result.data : null;
    if (!answer || answer.status !== 'found' || !answer.state || !answer.district) {
      setPincodeNote(answer?.status === 'not-found'
        ? { key: 'selfRegistration.form.pincodeNotFound', vars: { pincode: clean }, tone: 'warning' }
        : { key: 'selfRegistration.form.pincodeUnavailable', tone: 'info' });
      return;
    }

    const place: Place = { state: answer.state, district: answer.district, city: answer.city || answer.district };
    // An answer without a source is treated as the map's: for an address, asking to check is the safe side.
    const fromMap = answer.source !== 'directory';
    const current = formRef.current;
    const patch: DraftPatch = {};
    const filled: string[] = [];
    if (!current.state.trim()) {
      setField('state', place.state);
      patch.state = place.state;
      filled.push(place.state);
    }
    if (!current.district.trim()) {
      setField('district', place.district);
      patch.record = { district: place.district };
      filled.push(place.district);
    }
    if (!current.city.trim()) {
      setField('city', place.city);
      patch.city = place.city;
      filled.push(place.city);
    }

    if (filled.length > 0) {
      save(patch);
      setPincodeNote({
        key: fromMap ? 'selfRegistration.form.pincodeFilledFromMap' : 'selfRegistration.form.pincodeFilled',
        vars: { place: filled.join(' · ') },
        tone: fromMap ? 'warning' : 'info',
      });
      return;
    }

    const held = placeLine(place);
    const differs = current.state.trim() !== place.state
      || current.district.trim() !== place.district
      || current.city.trim() !== place.city;
    if (differs) {
      setPincodeNote({ key: 'selfRegistration.form.pincodeDiffers', vars: { pincode: clean, place: held }, tone: 'warning' });
      setPincodeOffer(place);
      return;
    }
    setPincodeNote(fromMap
      ? { key: 'selfRegistration.form.pincodeKnownFromMap', vars: { pincode: clean, place: held }, tone: 'warning' }
      : { key: 'selfRegistration.form.pincodeKnown', vars: { pincode: clean, place: held }, tone: 'info' });
  }, [token, setField, save]);

  const onPincodeBlur = () => {
    const value = normaliseIdentifierOnBlur('pincode', form.pincode) ?? form.pincode;
    commitField('pincode');
    void runPincodeLookup(value);
  };

  const acceptOffer = () => {
    if (!pincodeOffer) return;
    const place = pincodeOffer;
    setField('state', place.state);
    setField('district', place.district);
    setField('city', place.city);
    save({ state: place.state, city: place.city, record: { district: place.district } });
    setPincodeOffer(null);
    setPincodeNote({ key: 'selfRegistration.form.pincodeUsed', vars: { place: placeLine(place) }, tone: 'info' });
  };

  const locateHome = useCallback(async () => {
    setLocating(true);
    setPinError(null);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setPinError('profile.address.permissionOff');
        return;
      }
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const { latitude, longitude } = fix.coords;
      if (!isPlausibleIndianCoord(latitude, longitude)) {
        setPinError('profile.address.fixOutsideIndia');
        return;
      }
      onPinChange({ latitude, longitude });
    } catch {
      setPinError('profile.address.noFix');
    } finally {
      setLocating(false);
    }
  }, [onPinChange]);

  const onMapMove = (latitude: number, longitude: number) => {
    if (!isPlausibleIndianCoord(latitude, longitude)) {
      setPinError('profile.address.pinOutsideIndia');
      return;
    }
    setPinError(null);
    onPinChange({ latitude, longitude });
  };

  const yearOptions: SelectOption[] = [];
  for (let n = REGISTRATION_EXPERIENCE_MIN; n <= REGISTRATION_EXPERIENCE_MAX; n++) {
    yearOptions.push({
      value: String(n),
      label: n === 0
        ? tr('selfRegistration.form.fresher')
        : n === 1 ? tr('selfRegistration.form.oneYear') : tr('selfRegistration.form.years', { count: n }),
    });
  }

  const stateOptions: SelectOption[] = form.state && !INDIAN_STATES.some((s) => s.value === form.state)
    ? [...INDIAN_STATES, { value: form.state, label: tr('selfRegistration.form.asRecorded', { value: form.state }) }]
    : INDIAN_STATES;

  const pincodeIssue = identifierFormatIssue('pincode', form.pincode);
  const pincodeHint = !pincodeBusy && !pincodeNote && pincodeIssue ? tr(FORMAT_HINT_KEYS[pincodeIssue]) : undefined;

  const circleConflict = isSixDigitPincode(form.pincode) && form.state.trim()
    ? pincodeFromAddress(form.pincode.trim(), form.state.trim()).reason
    : null;

  return (
    <View style={{ gap: t.space.lg }}>
      <Card level={1} style={{ gap: t.space.lg }}>
        <GroupHeader icon="briefcase-outline" title={tr('selfRegistration.form.experienceTitle')} />
        <SelectField
          closeLabel={tr('common.close')}
          label={tr('selfRegistration.form.experienceYears')}
          value={form.experienceYears}
          options={yearOptions}
          placeholder={tr('selfRegistration.form.chooseYears')}
          onChange={(v) => pickField('experienceYears', v)}
          error={errors.experienceYears}
        />
        <Input
          label={tr('selfRegistration.form.currentEmployer')}
          value={form.currentEmployer}
          onChangeText={(v) => setField('currentEmployer', v)}
          onBlur={() => commitField('currentEmployer')}
          placeholder={tr('selfRegistration.form.currentEmployerPlaceholder')}
          autoCapitalize="words"
          maxLength={REGISTRATION_FIELD_LIMITS.currentEmployer}
          error={errors.currentEmployer}
        />
        <Input
          label={tr('selfRegistration.form.expertise')}
          value={form.expertise}
          onChangeText={(v) => setField('expertise', v)}
          onBlur={() => commitField('expertise')}
          placeholder={tr('selfRegistration.form.expertisePlaceholder')}
          maxLength={REGISTRATION_FIELD_LIMITS.expertise}
          error={errors.expertise}
        />
        <Input
          label={tr('selfRegistration.form.availability')}
          value={form.availability}
          onChangeText={(v) => setField('availability', v)}
          onBlur={() => commitField('availability')}
          placeholder={tr('selfRegistration.form.availabilityPlaceholder')}
          maxLength={REGISTRATION_FIELD_LIMITS.availability}
          error={errors.availability}
        />
      </Card>

      <Card level={1} style={{ gap: t.space.lg }}>
        <GroupHeader
          icon="home-outline"
          title={tr('selfRegistration.form.addressTitle')}
          note={tr('selfRegistration.form.addressNote')}
        />
        <View style={{ gap: t.space.sm }}>
          <Input
            label={tr('selfRegistration.form.pincode')}
            value={form.pincode}
            onChangeText={(v) => setField('pincode', v.replace(/\D/g, '').slice(0, 6))}
            onBlur={onPincodeBlur}
            placeholder={tr('selfRegistration.form.pincodePlaceholder')}
            keyboardType="number-pad"
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={6}
            hint={pincodeHint}
            error={errors.pincode}
          />
          {pincodeBusy && <FieldNote text={tr('selfRegistration.form.pincodeLooking')} busy />}
          {!pincodeBusy && pincodeNote && (
            <FieldNote text={tr(pincodeNote.key, pincodeNote.vars)} tone={pincodeNote.tone} />
          )}
          {!pincodeBusy && pincodeOffer && (
            <Button
              label={tr('selfRegistration.form.pincodeUse', { place: placeLine(pincodeOffer) })}
              icon="checkmark"
              variant="neutral"
              size="sm"
              onPress={acceptOffer}
              style={{ alignSelf: 'flex-start' }}
            />
          )}
        </View>
        <SelectField
          closeLabel={tr('common.close')}
          label={tr('selfRegistration.form.state')}
          value={form.state}
          options={stateOptions}
          placeholder={tr('selfRegistration.form.chooseState')}
          onChange={(v) => pickField('state', v)}
          error={errors.state}
        />
        <Input
          label={tr('selfRegistration.form.district')}
          value={form.district}
          onChangeText={(v) => setField('district', v)}
          onBlur={() => commitField('district')}
          placeholder={tr('selfRegistration.form.districtPlaceholder')}
          autoCapitalize="words"
          error={errors.district}
        />
        <Input
          label={tr('selfRegistration.form.city')}
          value={form.city}
          onChangeText={(v) => setField('city', v)}
          onBlur={() => commitField('city')}
          placeholder={tr('selfRegistration.form.cityPlaceholder')}
          autoCapitalize="words"
          maxLength={REGISTRATION_FIELD_LIMITS.city}
          error={errors.city}
        />
        {circleConflict && <FieldNote text={circleConflict} tone="warning" />}
        <Input
          label={tr('selfRegistration.form.address')}
          value={form.address}
          onChangeText={(v) => setField('address', v)}
          onBlur={() => commitField('address')}
          placeholder={tr('selfRegistration.form.addressPlaceholder')}
          multiline
          error={errors.address}
        />
      </Card>

      <Card level={1} style={{ gap: t.space.lg }}>
        <GroupHeader
          icon="location-outline"
          title={tr('selfRegistration.form.pinTitle')}
          note={tr('selfRegistration.form.pinNote')}
        />
        {pin ? (
          <>
            <MapPicker
              latitude={pin.latitude}
              longitude={pin.longitude}
              onChange={onMapMove}
              editable
              initialZoom={16}
              height={200}
            />
            <FieldNote text={tr('selfRegistration.form.pinSaved')} />
            <Button
              label={tr('selfRegistration.form.pinRemove')}
              icon="trash-outline"
              variant="ghost"
              onPress={() => { setPinError(null); onPinChange(null); }}
              style={{ alignSelf: 'flex-start' }}
            />
          </>
        ) : (
          <Button
            label={tr('selfRegistration.form.pinUseCurrent')}
            icon="navigate-outline"
            variant="neutral"
            size="lg"
            onPress={() => { void locateHome(); }}
            loading={locating}
            full
          />
        )}
        {pinError && <FieldNote text={tr(pinError)} tone="danger" />}
      </Card>

      <StepFooter onBack={onBack} onContinue={onContinue} />
    </View>
  );
};
