/**
 * The machine-readable name of a failure, alongside the sentence a person reads.
 *
 * ── Why this exists ────────────────────────────────────────────────────────────────────────
 *
 * The mobile app is translated; the API's error messages are not. Until this file, the only way
 * the phone could translate "Invalid credentials" into an assayer's own language was to match
 * the English sentence — see `packages/mobile/src/i18n/server-errors.ts`, which does exactly
 * that for about thirty-five of them, and documents why it is a stopgap. Three ways it breaks:
 * rewording a message on the server silently drops the translation and nobody finds out; a
 * composed message (`"Karnatka" is not a state we recognise`, a class-validator array) can
 * never be matched at all; and two unrelated failures that happen to share wording become one.
 *
 * Two errors already did it properly — the auth guard's `PASSWORD_CHANGE_REQUIRED` and
 * `REGISTRATION_IN_PROGRESS`, which the app switches on to raise the right gate. This file is
 * that pattern generalised, and it lives in `shared` rather than in the backend so that the
 * client and the server cannot drift: a code the API can send is a code the app can name.
 *
 * ── The rule that makes it safe ────────────────────────────────────────────────────────────
 *
 * A code is an ADDITION. `message` keeps its exact current wording and remains the fallback for
 * any client that has no translation for a code yet. Several of those sentences were written
 * for a non-technical reader standing at a bank counter and are better than anything a code
 * alone conveys, so nothing here replaces them.
 *
 * ── Renaming ───────────────────────────────────────────────────────────────────────────────
 *
 * A code is a wire contract with an app that is already installed on phones in the field, so a
 * value here is permanent once shipped. Add new ones freely; never rename or repurpose an
 * existing one. `PASSWORD_CHANGE_REQUIRED` and `REGISTRATION_IN_PROGRESS` in particular keep
 * their original unprefixed spelling because released builds compare against those literals —
 * which is also why the rest of this list is unprefixed, so the vocabulary reads as one set
 * rather than as two generations of naming.
 */

// ---------------------------------------------------------------------------
// Sign-in, session and password
// ---------------------------------------------------------------------------

/**
 * Failures a person meets before they are inside the app, plus the ones that eject them.
 *
 * The distinctions here are the ones worth spending screens on: "your password is wrong" and
 * "your account is closed" both arrive as a 401 today, and an app that can only see the status
 * shows the same retry affordance for a thing retrying will fix and a thing it never will.
 */
export const AUTH_ERROR_CODES = {
  /** Username, assayer code or password did not match. Deliberately does not say which. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  /** Too many wrong attempts; the message carries how many minutes remain. */
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  /** The account exists but its status is not one that may sign in. */
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  /** Lifecycle refusal: suspended/on hold. Recoverable — HR can lift it. */
  ACCOUNT_ON_HOLD: 'ACCOUNT_ON_HOLD',
  /** Lifecycle refusal: exited. Not recoverable by anything the user can do. */
  ACCOUNT_CLOSED: 'ACCOUNT_CLOSED',
  /** On the roster, but no credential was ever issued. There is nothing to type. */
  NO_PASSWORD_SET: 'NO_PASSWORD_SET',
  /** Refresh token missing, unknown, revoked or past its life. Sign in again. */
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  /** A temporary/HR-issued password whose validity window has passed. */
  TEMPORARY_PASSWORD_EXPIRED: 'TEMPORARY_PASSWORD_EXPIRED',
  /**
   * Signed in, but every route except the password screen is closed until they change it.
   *
   * Shipped before the rest of this file; the spelling is load-bearing. See the note on
   * renaming above.
   */
  PASSWORD_CHANGE_REQUIRED: 'PASSWORD_CHANGE_REQUIRED',
  /** Signed in, but the session may go no further than finishing registration. As above. */
  REGISTRATION_IN_PROGRESS: 'REGISTRATION_IN_PROGRESS',
  /** The current password supplied alongside a new one did not match. */
  CURRENT_PASSWORD_WRONG: 'CURRENT_PASSWORD_WRONG',
  /** The proposed new password is below the minimum length. */
  PASSWORD_TOO_SHORT: 'PASSWORD_TOO_SHORT',
  /** The proposed new password is on the common-password list. */
  PASSWORD_TOO_WEAK: 'PASSWORD_TOO_WEAK',
  /** A password change arrived without one or both of the two fields it needs. */
  PASSWORD_FIELDS_MISSING: 'PASSWORD_FIELDS_MISSING',
} as const;

// ---------------------------------------------------------------------------
// Assayer self-service and registration
// ---------------------------------------------------------------------------

/**
 * The paths an assayer drives alone, on a phone, with no colleague at their elbow.
 *
 * These are the errors most worth translating: the person meeting them is furthest from help,
 * and several are refusals they can fix themselves the moment they understand them — which is
 * precisely what an untranslated sentence prevents.
 */
export const ASSAYER_ERROR_CODES = {
  /** The request claimed a file but carried none. */
  UPLOAD_NO_FILE: 'UPLOAD_NO_FILE',
  /** Over the size ceiling. The message names the limit. */
  UPLOAD_TOO_LARGE: 'UPLOAD_TOO_LARGE',
  /** A file type the document store will not accept. */
  UPLOAD_TYPE_NOT_ALLOWED: 'UPLOAD_TYPE_NOT_ALLOWED',
  /** Refused for a reason other than size or type — corrupt, empty, failed a scan. */
  UPLOAD_REJECTED: 'UPLOAD_REJECTED',
  /** A PAN, Aadhaar, IFSC or phone number that is not the right shape for its kind. */
  DOCUMENT_NUMBER_INVALID: 'DOCUMENT_NUMBER_INVALID',
  /** A document slot the server does not have on its checklist. */
  DOCUMENT_REQUIREMENT_UNKNOWN: 'DOCUMENT_REQUIREMENT_UNKNOWN',
  /**
   * The field is real, but HR owns it and the assayer may not set it from the app.
   *
   * Distinct from a permissions failure on purpose: the answer is "ask your HR contact", not
   * "you are not allowed to be here", and only a code can carry that difference.
   */
  HR_MAINTAINED_FIELD: 'HR_MAINTAINED_FIELD',
  /**
   * A masked display value (`******234F`) was submitted back as if it were the real number.
   *
   * Almost always a client round-tripping a redacted read into an edit body rather than anyone
   * doing anything wrong, and the refusal is what stops asterisks overwriting a real PAN.
   */
  MASKED_VALUE_REJECTED: 'MASKED_VALUE_REJECTED',
  /** Acting on somebody else's record through a self-service route. */
  NOT_YOUR_RECORD: 'NOT_YOUR_RECORD',
  /** A state or district name that is not in the canonical list. The message quotes it back. */
  UNKNOWN_STATE: 'UNKNOWN_STATE',
  /** Coordinates outside the plausible range, or otherwise unusable. */
  INVALID_COORDINATES: 'INVALID_COORDINATES',
  /** Registration cannot be submitted yet — something on the checklist is still missing. */
  REGISTRATION_INCOMPLETE: 'REGISTRATION_INCOMPLETE',
} as const;

// ---------------------------------------------------------------------------
// Generic, and the floor under everything
// ---------------------------------------------------------------------------

/**
 * Codes that are not about one feature.
 *
 * `VALIDATION_FAILED` is the interesting one. class-validator produces an array of English
 * sentences and nothing else — the exact case the client's string matcher cannot touch, because
 * there is no single sentence to match and the array's contents change with the DTO. The
 * response carries `fields` alongside it (see `FieldError`), so a client can mark the offending
 * input and say something in its own language about *why*, which is more use than any of the
 * sentences would have been.
 *
 * The remainder are the floor: whatever a route throws, the error boundary attaches one of
 * these from the HTTP status when nothing more precise was named. That is deliberate. A precise
 * code has to be chosen by a person and will therefore be missing somewhere, and a client that
 * has to handle `code === undefined` is back to reading sentences. Coarse-but-present beats
 * precise-but-absent.
 */
export const GENERAL_ERROR_CODES = {
  /** DTO validation refused the body. Always accompanied by `fields`. */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** 400 with no more specific code. */
  BAD_REQUEST: 'BAD_REQUEST',
  /** 401 with no more specific code — no credential presented, or one that is not valid. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** 403 with no more specific code — signed in, not permitted. */
  FORBIDDEN: 'FORBIDDEN',
  /** 404. */
  NOT_FOUND: 'NOT_FOUND',
  /** 409 — the composed `Save failed (409)` family the client could never match. */
  CONFLICT: 'CONFLICT',
  /** 413 — body or file over the transport ceiling. */
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  /** 422. */
  UNPROCESSABLE: 'UNPROCESSABLE',
  /** 429 — throttled. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** 5xx, and anything that reached the boundary unrecognised. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  /** 502/503/504 — a dependency this server needs did not answer. */
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

/** Every code the API can send, as one object. */
export const API_ERROR_CODES = {
  ...AUTH_ERROR_CODES,
  ...ASSAYER_ERROR_CODES,
  ...GENERAL_ERROR_CODES,
} as const;

/** Every code the API can send, as a union. Clients switch on this. */
export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

/** Whether a string is a code this build knows. Use before trusting a value off the wire. */
export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(API_ERROR_CODES, value);
}

// ---------------------------------------------------------------------------
// Field-level codes, for validation failures
// ---------------------------------------------------------------------------

/**
 * Why one field was refused.
 *
 * Kept small on purpose. This is not a re-encoding of every class-validator constraint — it is
 * the set of distinctions a client can actually *act* on: colour this input, put this sentence
 * under it. `BAD_FORMAT` absorbs the long tail rather than growing a code per decorator, since
 * a client that has to render "did not match the expected pattern" gains nothing from knowing
 * the pattern's name.
 *
 * The four identity codes are the exception, and earn their place: PAN, Aadhaar, IFSC and phone
 * each have a different thing the person should go and look at (a card, a cheque book, their
 * own handset), and that advice cannot be derived from `BAD_FORMAT`.
 */
export const FIELD_ERROR_CODES = {
  /** Absent, null, or empty where a value is required. */
  REQUIRED: 'REQUIRED',
  /** Present but the wrong JSON type — a string where a number belongs, and so on. */
  WRONG_TYPE: 'WRONG_TYPE',
  /** Longer than the maximum, or more entries than the maximum. */
  TOO_LONG: 'TOO_LONG',
  /** Shorter than the minimum, or fewer entries than the minimum. */
  TOO_SHORT: 'TOO_SHORT',
  /** Numeric value outside the permitted range. */
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  /** Not one of an enumerated set of permitted values. */
  NOT_ALLOWED_VALUE: 'NOT_ALLOWED_VALUE',
  /** Not a well-formed identifier, date or email. */
  BAD_FORMAT: 'BAD_FORMAT',
  /** A property the endpoint does not accept at all (`forbidNonWhitelisted`). */
  UNKNOWN_FIELD: 'UNKNOWN_FIELD',
  /** PAN: five letters, four digits, one letter. */
  BAD_PAN: 'BAD_PAN',
  /** Aadhaar: twelve digits, and the Verhoeff check digit must agree. */
  BAD_AADHAAR: 'BAD_AADHAAR',
  /** IFSC: four letters, a zero, six alphanumerics. */
  BAD_IFSC: 'BAD_IFSC',
  /** An Indian mobile number that cannot be normalised to ten digits. */
  BAD_PHONE: 'BAD_PHONE',
} as const;

export type FieldErrorCode = (typeof FIELD_ERROR_CODES)[keyof typeof FIELD_ERROR_CODES];

/**
 * One refused field.
 *
 * `field` is the DTO property path, dotted for nested objects and indexed for arrays
 * (`contacts.0.phone`), so a client can address the input it belongs to. `message` is
 * class-validator's own English for the same failure, kept verbatim — the same fallback rule
 * as the top-level `message`.
 */
export interface FieldError {
  readonly field: string;
  readonly code: FieldErrorCode;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// The response body
// ---------------------------------------------------------------------------

/**
 * The shape of every error the API returns.
 *
 * Every field except `code` and `fields` predates this contract and is unchanged; both
 * additions are optional to a reader, because an older client parses this body today and must
 * keep working. `message` stays a `string | string[]` for the same reason — the array is what
 * validation failures have always returned and the web app already renders it.
 */
export interface ApiErrorBody {
  readonly statusCode: number;
  readonly message: string | string[];
  readonly error?: string;
  /** Present on every error response. Coarse when nothing precise was named — never absent. */
  readonly code: ApiErrorCode;
  /** Present when `code` is `VALIDATION_FAILED`. */
  readonly fields?: readonly FieldError[];
  readonly correlationId?: string;
}

/**
 * The code to use when a route did not name one.
 *
 * Lives in `shared` rather than in the backend so a client can tell a coarse code from a
 * deliberate one: seeing `FORBIDDEN` means "some route refused this and nobody has given that
 * refusal a name yet", which is a different thing from `HR_MAINTAINED_FIELD`, and it is worth
 * being able to tell them apart when deciding what to translate next.
 */
export function fallbackCodeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400: return GENERAL_ERROR_CODES.BAD_REQUEST;
    case 401: return GENERAL_ERROR_CODES.UNAUTHENTICATED;
    case 403: return GENERAL_ERROR_CODES.FORBIDDEN;
    case 404: return GENERAL_ERROR_CODES.NOT_FOUND;
    case 409: return GENERAL_ERROR_CODES.CONFLICT;
    case 413: return GENERAL_ERROR_CODES.PAYLOAD_TOO_LARGE;
    case 422: return GENERAL_ERROR_CODES.UNPROCESSABLE;
    case 429: return GENERAL_ERROR_CODES.RATE_LIMITED;
    case 502:
    case 503:
    case 504: return GENERAL_ERROR_CODES.SERVICE_UNAVAILABLE;
    default:
      return status >= 500
        ? GENERAL_ERROR_CODES.INTERNAL_ERROR
        : GENERAL_ERROR_CODES.BAD_REQUEST;
  }
}
