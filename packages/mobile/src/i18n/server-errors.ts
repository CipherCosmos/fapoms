import { t, type TranslationKey } from './i18n';

/**
 * Turning an error sentence from somewhere else into one this app can translate.
 *
 * ── The problem ────────────────────────────────────────────────────────────────────────────
 *
 * A dozen places in this app render an error string straight from the API into a toast or an
 * inline alert — `result.error`, `upload.error`, `err.message`. Those strings are English
 * prose composed on the server (or, for the roughly forty sentinel messages in
 * `api.service.ts`, by the transport layer here) and no amount of catalogue work makes them
 * translatable, because the client never sees a code, only the finished sentence.
 *
 * ── What this does about it ────────────────────────────────────────────────────────────────
 *
 * It matches the sentences that are actually stable — the app's own sentinels, and the handful
 * of backend messages that are fixed literals rather than composed strings — and returns a
 * catalogue key for them. Matching is on normalised text (case-folded, trimmed, trailing
 * punctuation dropped) so a full stop appearing or disappearing on the server does not silently
 * break a translation.
 *
 * ── What it deliberately does NOT do ───────────────────────────────────────────────────────
 *
 * It does not guess. An unrecognised message falls through to `null`, and every call site then
 * renders the server's own English rather than a generic "something went wrong". That is the
 * right trade: a specific English sentence a colleague or the office can act on beats a
 * translated sentence that says nothing. It also keeps the gap visible instead of papering
 * over it.
 *
 * ── The backend ask ────────────────────────────────────────────────────────────────────────
 *
 * String matching is a stopgap and should be read as one. Every one of these mappings breaks
 * silently the day somebody rewords an exception on the server, and it can never cover the
 * composed messages (`"Karnatka" is not a state we recognise`, `Save failed (409)`,
 * `Upload failed (413)`) or the class-validator arrays that arrive joined with commas.
 *
 * The fix is on the API side: every error response should carry a stable machine-readable
 * `code` alongside its human `message`, so the client can key a catalogue entry off the code
 * and fall back to the message only for codes it has not been taught yet. Until that exists,
 * the list below is the honest maximum — and the mobile app's error toasts remain English for
 * every failure not enumerated here.
 */

/** Normalise for comparison: case, surrounding whitespace, and a trailing full stop. */
function normalise(message: string): string {
  return message.trim().toLowerCase().replace(/[.\s]+$/, '');
}

/**
 * Exact sentences, normalised. Sourced from the backend's thrown exceptions and from
 * `api.service.ts`'s own fallbacks — both are literals, which is what makes them matchable.
 */
const EXACT: Record<string, TranslationKey> = {
  // — Sign-in ————————————————————————————————————————————————————————————————
  'invalid credentials': 'errors.invalidCredentials',
  'invalid credentials or unregistered assayer code': 'errors.invalidCredentials',
  'account is temporarily locked': 'errors.accountLocked',
  'account is not active': 'errors.accountInactive',
  'user account is not active': 'errors.accountInactive',
  'user not found or inactive': 'errors.accountInactive',
  'this account has no password set. ask your hr contact to set one for you':
    'errors.noPasswordSet',
  'invalid or expired refresh token': 'errors.sessionExpired',
  // `signInRefusal` on the backend, for the two lifecycle states that can still be refused.
  // Its third branch — the one for the four onboarding stages — is now unreachable, because
  // those stages pass `maySignIn`; it is not mapped here rather than mapped to copy that would
  // be wrong if it ever fired again.
  'your access is on hold. please speak to your hr contact': 'errors.accessOnHold',
  'this account is closed. if you think that is wrong, please speak to your hr contact':
    'errors.accountClosed',
  // The two `code`-bearing 403s from the auth guard. Their `message` fields are fixed literals,
  // so they map like any other — but a client that only reads the message is doing it the hard
  // way: both responses carry a machine-readable `code`, which is what should actually route the
  // app to the change-password screen or to the registration checklist. See the backend ask below.
  'you must change your password before you can continue. please set a new password':
    'errors.passwordChangeRequired',
  'you can finish your registration here. your hr contact will open the rest of the app once your joining checks are done':
    'errors.registrationInProgress',
  'biometric session expired. please sign in with your password': 'errors.sessionExpired',
  'no saved session found. please sign in with your assayer code and password first':
    'errors.notSignedIn',
  'not authenticated': 'errors.notSignedIn',
  'you are not signed in': 'errors.notSignedIn',

  // — Passwords ——————————————————————————————————————————————————————————————
  'your current password is not correct': 'errors.currentPasswordWrong',
  'please choose a password of at least 8 characters': 'errors.passwordTooShort',
  'that password is too easy to guess. please choose a different one': 'errors.passwordTooEasy',
  'please enter your current password and your new password': 'errors.passwordFieldsMissing',

  // — Ownership ——————————————————————————————————————————————————————————————
  'you may only update your own profile': 'errors.notYourRecord',
  'you may only set your own location': 'errors.notYourRecord',
  'you may only update your own live location': 'errors.notYourRecord',
  'you may only change your own live-location sharing': 'errors.notYourRecord',
  'insufficient permissions': 'errors.notYourRecord',
  'insufficient role permissions': 'errors.notYourRecord',

  // — Location ———————————————————————————————————————————————————————————————
  'invalid live coordinates': 'errors.badCoordinates',

  // — Files and uploads ——————————————————————————————————————————————————————
  'no file was uploaded. choose a file and try again': 'errors.noFileChosen',
  'no file content to upload': 'errors.noFileChosen',
  'the scanned file is no longer on the device': 'errors.fileGone',
  'the document did not reach the office': 'errors.uploadNotArrived',
  'no connection. it will be sent again later': 'errors.network',

  // — Reachability ———————————————————————————————————————————————————————————
  'unable to reach the server': 'errors.serverUnreachable',
  'could not reach the server. check your connection and try again': 'errors.serverUnreachable',
  'network request failed': 'errors.network',
  'failed to fetch': 'errors.network',
  // `getDocumentDownloadUrl`'s 401 branch. It also returns `reason: 'SESSION_EXPIRED'`, which is
  // what a call site should really key off; matched here so the message translates until one does.
  'your session has expired. please log out and sign in again': 'errors.sessionExpired',
};

/**
 * Messages that carry a value worth keeping. Matched before the plain patterns below, because
 * each one produces a different sentence depending on what it captured.
 */
const CAPTURING: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  // "Too many incorrect sign-in attempts. Please try again in 12 minutes." The number is the
  // only useful part of a lockout message — "try again later" leaves somebody refreshing a
  // sign-in screen with no idea whether that means seconds or an hour.
  [
    /^too many incorrect sign-in attempts.*?in (\d+) minutes?/i,
    (m) => (m[1] === '1' ? t('errors.lockedOneMinute') : t('errors.lockedMinutes', { count: Number(m[1]) })),
  ],
];

/**
 * Families of messages that vary but share a recognisable stem.
 *
 * Kept small and anchored. A loose pattern here would mistranslate a message it merely
 * resembles, which is the one outcome worse than leaving it in English.
 */
const PATTERNS: Array<[RegExp, TranslationKey]> = [
  // `api.service.ts` composes about a dozen of these — "Network error fetching profile",
  // "Network error during biometric login" — all meaning the same thing to the person holding
  // the phone: there is no signal here.
  [/^network error\b/i, 'errors.network'],
  // The backend's state validator interpolates the rejected name: `"Karnatka" is not a state
  // we recognise`. The name itself is what the assayer typed and adds nothing to the advice.
  [/is not a state we recognise/i, 'errors.unknownState'],
];

/**
 * A catalogue sentence for a known error, or null when this app has never seen it before.
 *
 * Callers should prefer `serverErrorText`, which handles the null case correctly. This is
 * exported for the tests and for anywhere that genuinely needs to know whether a message was
 * recognised.
 */
export function translateServerError(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = normalise(raw);
  if (!text) return null;

  const exact = EXACT[text];
  if (exact) return t(exact);

  for (const [pattern, render] of CAPTURING) {
    const match = raw.match(pattern);
    if (match) return render(match);
  }

  for (const [pattern, key] of PATTERNS) {
    if (pattern.test(raw)) return t(key);
  }
  return null;
}

/**
 * What to actually put on screen for a failed call.
 *
 * The order is the point. A recognised error becomes a translated sentence. An unrecognised
 * one keeps the server's own wording, because a specific English sentence somebody can read
 * out to the office beats a translated generic. Only when there is no message at all does the
 * screen's own fallback copy apply.
 */
export function serverErrorText(raw: unknown, fallback: TranslationKey): string {
  const translated = translateServerError(raw);
  if (translated) return translated;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return t(fallback);
}
