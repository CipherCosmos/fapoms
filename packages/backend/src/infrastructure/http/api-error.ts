import { HttpException } from '@nestjs/common';
import type { ValidationError } from '@nestjs/common';
import {
  fallbackCodeForStatus,
  isApiErrorCode,
  FIELD_ERROR_CODES,
  type ApiErrorCode,
  type FieldError,
  type FieldErrorCode,
} from '@fapoms/shared';

/**
 * Attaching a machine-readable `code` to an error without disturbing the sentence a person reads.
 *
 * The vocabulary itself lives in `@fapoms/shared` (`error-codes.ts`) so the mobile app and this
 * server cannot drift. What lives here is the mechanics: how a code gets onto an exception, how
 * the error boundary finds one, and how class-validator's output becomes per-field codes.
 *
 * Why a helper rather than object literals at each throw site: the two errors that pioneered this
 * pattern (`PASSWORD_CHANGE_REQUIRED`, `REGISTRATION_IN_PROGRESS` in `auth/guards.ts`) each spell
 * out `{ statusCode, error, message, code }` by hand, because passing an object to a Nest
 * exception replaces the whole body rather than extending it. That is four chances to typo a
 * status or drop the `error` key, repeated per site. `withCode` extends the body Nest already
 * built, so the site writes only what is new.
 */

/**
 * Name a failure, keeping everything else about it identical.
 *
 * The exception class is unchanged — `withCode(new UnauthorizedException('Invalid credentials'),
 * 'INVALID_CREDENTIALS')` is still an `UnauthorizedException` with that exact message, still
 * `instanceof` whatever a caller or a test expects. Nest has already built the response body by
 * the time the constructor returns (`{ statusCode, message, error }`), so this only adds a key.
 *
 * A string-bodied exception is left alone rather than being rewritten into an object: that would
 * change the response from `"message": "..."` to a shape the client has never seen, and the
 * boundary attaches a status-derived code to it anyway. In practice every Nest HTTP exception
 * builds an object body, so this branch is a guard rather than a case that happens.
 */
export function withCode<T extends HttpException>(exception: T, code: ApiErrorCode): T {
  const body = exception.getResponse();
  if (typeof body === 'object' && body !== null) {
    Object.assign(body, { code });
  }
  return exception;
}

/**
 * The code to report for an exception on its way out.
 *
 * Returns what the throw site named, or a coarse code derived from the status when it named
 * nothing. The fallback is the point: a precise code has to be chosen by a person, so somewhere
 * one will be forgotten, and a client forced to handle `code === undefined` is straight back to
 * reading English sentences. Every error response carries a code; the only question is how
 * specific it is.
 */
export function codeForResponse(body: unknown, status: number): ApiErrorCode {
  if (typeof body === 'object' && body !== null) {
    const named = (body as Record<string, unknown>).code;
    if (isApiErrorCode(named)) return named;
  }
  return fallbackCodeForStatus(status);
}

// ---------------------------------------------------------------------------
// class-validator constraints → field codes
// ---------------------------------------------------------------------------

/**
 * Which constraint failed, in terms a client can act on.
 *
 * Keys are class-validator's own constraint names, including the four custom identity rules
 * declared in `assayer.controller.ts` (`isPanFormat` and friends) — those are the shape checks an
 * assayer meets while registering, and each one sends them to a different physical document, so
 * they are worth distinguishing from a generic bad format.
 *
 * Anything absent from this map becomes `BAD_FORMAT`. That is deliberate rather than lazy: the
 * long tail of constraints all mean "this value is not acceptable here", and a client that has to
 * render that gains nothing from knowing which decorator produced it. The English message travels
 * alongside for the cases where the detail does matter.
 *
 * `whitelistValidation` is the constraint `forbidNonWhitelisted` raises, and it is not a bad value
 * at all — it is a property this endpoint does not accept, which usually means a client is sending
 * a field the API dropped. Worth its own code so that shows up as an integration bug rather than
 * being reported to a user as though they had mistyped something.
 */
const FIELD_CODE_BY_CONSTRAINT: Readonly<Record<string, FieldErrorCode>> = {
  isDefined: FIELD_ERROR_CODES.REQUIRED,
  isNotEmpty: FIELD_ERROR_CODES.REQUIRED,
  isNotEmptyObject: FIELD_ERROR_CODES.REQUIRED,

  isString: FIELD_ERROR_CODES.WRONG_TYPE,
  isNumber: FIELD_ERROR_CODES.WRONG_TYPE,
  isInt: FIELD_ERROR_CODES.WRONG_TYPE,
  isBoolean: FIELD_ERROR_CODES.WRONG_TYPE,
  isBooleanString: FIELD_ERROR_CODES.WRONG_TYPE,
  isArray: FIELD_ERROR_CODES.WRONG_TYPE,
  isObject: FIELD_ERROR_CODES.WRONG_TYPE,

  maxLength: FIELD_ERROR_CODES.TOO_LONG,
  arrayMaxSize: FIELD_ERROR_CODES.TOO_LONG,
  minLength: FIELD_ERROR_CODES.TOO_SHORT,
  arrayMinSize: FIELD_ERROR_CODES.TOO_SHORT,

  min: FIELD_ERROR_CODES.OUT_OF_RANGE,
  max: FIELD_ERROR_CODES.OUT_OF_RANGE,

  isEnum: FIELD_ERROR_CODES.NOT_ALLOWED_VALUE,
  isIn: FIELD_ERROR_CODES.NOT_ALLOWED_VALUE,

  isUuid: FIELD_ERROR_CODES.BAD_FORMAT,
  isDateString: FIELD_ERROR_CODES.BAD_FORMAT,
  isEmail: FIELD_ERROR_CODES.BAD_FORMAT,
  matches: FIELD_ERROR_CODES.BAD_FORMAT,

  isPanFormat: FIELD_ERROR_CODES.BAD_PAN,
  isAadhaarNumber: FIELD_ERROR_CODES.BAD_AADHAAR,
  isIfscFormat: FIELD_ERROR_CODES.BAD_IFSC,
  isIndianMobile: FIELD_ERROR_CODES.BAD_PHONE,

  whitelistValidation: FIELD_ERROR_CODES.UNKNOWN_FIELD,
};

/** class-validator lower-cases some constraint names inconsistently across versions. */
function fieldCodeFor(constraint: string): FieldErrorCode {
  return (
    FIELD_CODE_BY_CONSTRAINT[constraint] ??
    FIELD_CODE_BY_CONSTRAINT[constraint.toLowerCase()] ??
    FIELD_ERROR_CODES.BAD_FORMAT
  );
}

/**
 * Turn class-validator's tree into a flat list of `{ field, code, message }`.
 *
 * The tree is walked here rather than reusing Nest's own flattening because Nest throws the
 * property path away — it prefixes the path onto the English message (`address.city must be a
 * string`) and returns strings, which leaves a client parsing prose to discover which input to
 * mark. Walking it directly keeps `field` as data: `address.city`, or `contacts.0.phone` for an
 * array element, addressable straight from a form.
 *
 * One entry per failed constraint, not per field, because a single input commonly fails two at
 * once (`@IsString()` and `@IsNotEmpty()` on a missing value) and collapsing them would drop the
 * more specific of the two arbitrarily.
 */
export function fieldErrorsFrom(errors: readonly ValidationError[]): FieldError[] {
  const collected: FieldError[] = [];

  const walk = (error: ValidationError, parentPath: string): void => {
    const path = parentPath ? `${parentPath}.${error.property}` : String(error.property);

    for (const [constraint, message] of Object.entries(error.constraints ?? {})) {
      collected.push({
        field: path,
        code: fieldCodeFor(constraint),
        // class-validator's own English, verbatim. Same fallback rule as the top-level message:
        // a client with no translation for this code still has something to put on screen.
        message: typeof message === 'string' ? message : String(message),
      });
    }

    for (const child of error.children ?? []) {
      walk(child, path);
    }
  };

  for (const error of errors) walk(error, '');
  return collected;
}
