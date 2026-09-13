jest.mock('expo-localization', () => ({ getLocales: () => [] }));

// eslint-disable-next-line import/first
import { applyLanguagePreference } from './i18n';
// eslint-disable-next-line import/first
import { serverErrorText, translateServerError } from './server-errors';
// eslint-disable-next-line import/first
import { en } from './locales/en';

afterEach(() => applyLanguagePreference('en'));

/**
 * The rule this suite protects is the *shape* of the fallback, not the list of mappings.
 *
 * An unrecognised server message must reach the screen unchanged. That is easy to break by
 * "improving" the helper into always returning a generic sentence — which would replace a
 * specific, actionable English error with one that says nothing, on exactly the screens where a
 * field assayer is already stuck.
 */
describe('errors from the server', () => {
  it('translates the messages this app has been taught', () => {
    expect(translateServerError('Invalid credentials')).toBe(en.errors.invalidCredentials);

    applyLanguagePreference('hi');
    const hindi = translateServerError('Invalid credentials');
    expect(hindi).not.toBeNull();
    expect(hindi).not.toBe('Invalid credentials');
    expect(hindi).not.toBe(en.errors.invalidCredentials);
  });

  it('ignores punctuation and case drift on the server side', () => {
    // A full stop appearing or disappearing on a backend exception must not silently unmap it.
    for (const variant of ['Invalid credentials', 'invalid credentials.', '  INVALID CREDENTIALS  ']) {
      expect(translateServerError(variant)).toBe(en.errors.invalidCredentials);
    }
  });

  it('collapses the whole "Network error …" family to one sentence', () => {
    for (const raw of ['Network error.', 'Network error fetching profile', 'Network request failed']) {
      expect(translateServerError(raw)).toBe(en.errors.network);
    }
  });

  it('strips the rejected value out of the state-validation message', () => {
    expect(translateServerError('"Karnatka" is not a state we recognise')).toBe(en.errors.unknownState);
  });

  it('keeps the minutes out of a lockout message', () => {
    expect(translateServerError('Too many incorrect sign-in attempts. Please try again in 12 minutes.'))
      .toBe(en.errors.lockedMinutes.replace('%{count}', '12'));
    expect(translateServerError('Too many incorrect sign-in attempts. Please try again in 1 minute.'))
      .toBe(en.errors.lockedOneMinute);
  });

  it('distinguishes the two code-bearing 403s from the auth guard', () => {
    // Different screens answer these, so they must not collapse into one sentence — and neither
    // may say the app is closed to an onboarding assayer, who can now sign in and finish their
    // own registration from it.
    const registration = translateServerError(
      'You can finish your registration here. Your HR contact will open the rest of the app once your joining checks are done.',
    );
    const password = translateServerError(
      'You must change your password before you can continue. Please set a new password.',
    );
    expect(registration).toBe(en.errors.registrationInProgress);
    expect(password).toBe(en.errors.passwordChangeRequired);
    expect(registration).not.toBe(password);
    expect(registration).not.toMatch(/cannot|unavailable|not allowed/i);
  });

  it('returns null for anything it has not been taught', () => {
    expect(translateServerError('Pincode 411045 is in Maharashtra, but the entered state is Kerala')).toBeNull();
    expect(translateServerError('Save failed (409)')).toBeNull();
    expect(translateServerError(undefined)).toBeNull();
    expect(translateServerError('')).toBeNull();
    expect(translateServerError({ message: 'nope' })).toBeNull();
  });

  it('keeps an unrecognised message rather than replacing it with a generic one', () => {
    // The important case. A specific English sentence the assayer can read out to the office
    // beats a translated "something went wrong".
    const raw = 'Pincode 411045 is in Maharashtra, but the entered state is Kerala';
    expect(serverErrorText(raw, 'errors.generic')).toBe(raw);
  });

  it('falls back to the screen’s own copy only when there is no message at all', () => {
    expect(serverErrorText(undefined, 'errors.generic')).toBe(en.errors.generic);
    expect(serverErrorText('   ', 'errors.generic')).toBe(en.errors.generic);
  });
});

/**
 * The code is checked before the message, so a rewording on the server cannot silently unmap a
 * failure the way it could when text was the only signal.
 */
describe('errors carrying a code', () => {
  it('translates a code even when the message alone would never have matched', () => {
    expect(translateServerError('This account is presently inactive.', 'ACCOUNT_INACTIVE'))
      .toBe(en.errors.accountInactive);
  });

  it('prefers the code over the message when both are present but disagree', () => {
    // The message text here would match nothing in EXACT/PATTERNS at all — proving the result
    // came from the code, not from a lucky text match.
    expect(translateServerError('Save failed (409)', 'NOT_YOUR_RECORD')).toBe(en.errors.notYourRecord);
  });

  it('ignores a code this build does not recognise and falls back to the message', () => {
    expect(translateServerError('Invalid credentials', 'SOME_FUTURE_CODE_NOT_YET_SHIPPED'))
      .toBe(en.errors.invalidCredentials);
  });

  it('ignores a non-string code without throwing', () => {
    expect(translateServerError('Invalid credentials', undefined)).toBe(en.errors.invalidCredentials);
    expect(translateServerError('Invalid credentials', 42)).toBe(en.errors.invalidCredentials);
  });

  it('leaves ACCOUNT_LOCKED out of the code table so the minutes are never lost', () => {
    // If ACCOUNT_LOCKED mapped straight to a flat key, this would lose the "12" the assayer
    // actually needs — the whole reason a lockout message is matched by CAPTURING, not EXACT.
    const translated = translateServerError(
      'Too many incorrect sign-in attempts. Please try again in 12 minutes.',
      'ACCOUNT_LOCKED',
    );
    expect(translated).toBe(en.errors.lockedMinutes.replace('%{count}', '12'));
  });

  it('serverErrorText threads the code through the same way', () => {
    expect(serverErrorText('Save failed (409)', 'errors.generic', 'NOT_YOUR_RECORD')).toBe(en.errors.notYourRecord);
    // Existing call sites that pass no code at all must keep behaving exactly as before.
    expect(serverErrorText('Save failed (409)', 'errors.generic')).toBe('Save failed (409)');
  });
});
