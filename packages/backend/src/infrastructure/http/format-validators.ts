import { ValidateBy, ValidationOptions } from 'class-validator';
import { normalisePhone } from '@fapoms/shared';

/**
 * Format rules that more than one module needs, stated once.
 *
 * ## Why this file exists
 *
 * `assayer.controller.ts` grew a small, well-made family of these — PAN, IFSC, Aadhaar, mobile,
 * pincode — each with a message written for the person who has to fix it rather than for a
 * developer reading a log. Nothing else could use them, because they were private to that file,
 * and the predictable happened: `POST /clients` accepted `contactPhone: "abcdefg!!!"` and
 * `website: "not a url at all"` with a 201 and stored both, while the same phone string on an
 * assayer was refused with a sentence naming the format.
 *
 * That inconsistency is not cosmetic. The application's own roster screens tell staff that a bad
 * phone number "blocks calling and phone-channel dispatch"; a client contact number is dialled by
 * the same people for the same reason.
 *
 * The factory and the mobile rule live here now. The assayer controller imports the factory and
 * keeps its identity-document rules where they are — those are about identity documents and
 * belong beside the code that reasons about them; a phone number and a URL are not.
 */

/**
 * Build a format rule that is skipped when the field is absent and when it is blank.
 *
 * Blank passes deliberately, and it is the reason these read as `@IsOptional() @IsString()
 * @IsWhatever()` at the call sites: clearing a field is how somebody corrects a value they should
 * never have entered, and a rule that refuses an empty string turns "remove this" into an
 * argument with a validation error. Absent keys are skipped by `@IsOptional()` before this runs,
 * which is what stops a record imported before the rule existed from being unfixable — an update
 * correcting one field is not blocked by an invalid value sitting in another.
 */
export const formatRule = (
  name: string,
  ok: (value: string) => boolean,
  message: string | ((value: unknown) => string),
) =>
  (options?: ValidationOptions): PropertyDecorator =>
    ValidateBy({
      name,
      validator: {
        validate: (value: unknown) =>
          typeof value === 'string' && (value.trim() === '' || ok(value)),
        defaultMessage: (args) =>
          typeof message === 'function' ? message(args?.value) : message,
      },
    }, options);

/**
 * A number somebody can actually ring, in any of the shapes people type it.
 *
 * Delegates to the shared `normalisePhone`, so "with or without +91", with spaces, with a leading
 * zero, all resolve the same way here as they do everywhere else that stores a phone number.
 */
export const IsIndianMobile = formatRule(
  'isIndianMobile',
  (value) => normalisePhone(value) !== null,
  "This phone number doesn't look right — please enter a 10-digit Indian mobile number, "
  + 'like 98765 43210 (with or without +91).',
);

/**
 * A web address that a browser would actually open.
 *
 * `new URL()` rather than a regular expression, because the question being asked is precisely
 * "would this resolve", and the platform already answers it. Restricted to http and https: a
 * `javascript:` or `data:` URL parses perfectly well and is a link nobody should be storing on a
 * client record, let alone rendering as an anchor.
 */
export const IsHttpUrl = formatRule(
  'isHttpUrl',
  (value) => {
    try {
      const url = new URL(value.trim());
      return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
      return false;
    }
  },
  "That web address doesn't look right — include the whole address, like https://example.com.",
);
