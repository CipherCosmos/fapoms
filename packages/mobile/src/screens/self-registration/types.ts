import type { RegistrationFormField, RegistrationFormValues } from '@fapoms/shared';
import type { DraftPatch } from '../../services/self-registration.service';
import type { StepErrors } from './registration-form';

/** What every step of the registration wizard is handed by the screen that owns the form. */
export interface StepProps {
  token: string;
  form: RegistrationFormValues;
  /** Sentences for the boxes the last Continue refused, already translated. */
  errors: StepErrors;
  /** Updates a box as it is typed, and clears that box's red error. Saves nothing. */
  setField: (key: RegistrationFormField, value: string) => void;
  /** Tidies a box on leaving it (spaces in a PAN, +91 on a phone) and saves that one field. */
  commitField: (key: RegistrationFormField) => void;
  /** Sets and saves a picked value in one go — chips, lists, lookups. */
  pickField: (key: RegistrationFormField, value: string) => void;
  /** Saves a patch the step built itself (several fields a lookup filled at once). */
  save: (patch: DraftPatch) => void;
}
