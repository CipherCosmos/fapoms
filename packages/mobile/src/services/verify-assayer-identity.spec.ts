/**
 * The pre-login identity check has to tell three answers apart, not two.
 *
 * 540 sign-in-eligible assayers were imported from the roster and never sent an invite, so they
 * have no password at all. The login endpoint cannot distinguish them: a missing password hash
 * and a wrong password both come back as "Invalid credentials", deliberately, so that nobody can
 * enumerate who has app access. The result was an app that confirmed somebody's identifier,
 * greeted them by their real name, and then told them their password was wrong for an account
 * that has never had one — nothing to correct, and no way to learn that from the screen.
 *
 * `verify-assayer` is the one place that can say so, via `needsAppAccess`. This suite pins the
 * three outcomes apart, and in particular pins that "recognised but no access issued" does NOT
 * reuse the not-recognised wording.
 *
 * Native modules are mocked rather than loaded: this runs in node, and nothing under test needs
 * them. The same shape as `password-rotation-gate.spec.ts` next door.
 */
jest.mock('react-native', () => ({ Platform: { OS: 'android', select: (o: any) => o.android } }));
jest.mock('expo-file-system', () => ({}));
jest.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
jest.mock('expo-localization', () => ({ getLocales: () => [] }));
jest.mock('./token-store', () => ({
  readToken: jest.fn().mockResolvedValue(null),
  writeToken: jest.fn().mockResolvedValue(undefined),
  deleteToken: jest.fn().mockResolvedValue(undefined),
  ALL_TOKEN_KEYS: [],
}));
jest.mock('./server-config', () => ({
  getDefaultServerUrl: () => 'http://localhost:3000/api/v1',
  loadStoredServerUrl: jest.fn().mockResolvedValue(null),
  saveServerUrl: jest.fn(),
  clearServerUrl: jest.fn(),
  normaliseServerUrl: (u: string) => u,
}));

// eslint-disable-next-line import/first
import { MobileApiService } from './api.service';
// eslint-disable-next-line import/first
import { en } from '../i18n/locales/en';

const respond = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

afterEach(() => {
  // @ts-expect-error — restoring the global the tests replaced.
  delete globalThis.fetch;
});

function serverAnswers(data: unknown) {
  globalThis.fetch = jest.fn().mockResolvedValue(respond(data)) as unknown as typeof fetch;
}

describe('confirming an identifier before the password step', () => {
  it('lets a recognised assayer with a password go on to the password field', async () => {
    serverAnswers({ verified: true, displayName: 'Anita Rao', assayerCode: 'AS0042' });

    const result = await MobileApiService.verifyAssayerIdentity('AS0042');

    expect(result.verified).toBe(true);
    expect(result.needsAppAccess).toBeUndefined();
    expect(result.assayer?.displayName).toBe('Anita Rao');
  });

  it('says an unknown identifier was not recognised', async () => {
    serverAnswers({ verified: false });

    const result = await MobileApiService.verifyAssayerIdentity('AS9999');

    expect(result.verified).toBe(false);
    expect(result.needsAppAccess).toBeUndefined();
    expect(result.error).toBe(en.login.identifierNotRecognised);
  });

  it('tells a recognised assayer with no access issued who can fix it', async () => {
    serverAnswers({
      verified: true,
      displayName: 'Anita Rao',
      assayerCode: 'AS0042',
      needsAppAccess: true,
    });

    const result = await MobileApiService.verifyAssayerIdentity('AS0042');

    expect(result.needsAppAccess).toBe(true);
    expect(result.error).toBe(en.login.needsAppAccess);
    // The point of the whole case: these people ARE on the roster, so they must never be told
    // their identifier was not recognised.
    expect(result.error).not.toBe(en.login.identifierNotRecognised);
    expect(result.error).toMatch(/HR/);
    // The name still comes back, so the screen can address them by it while explaining.
    expect(result.assayer?.displayName).toBe('Anita Rao');
    // And they must not be waved on to a password field that can only ever reject them.
    expect(result.verified).toBe(false);
  });

  it('degrades to a network message rather than throwing when the call fails', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('Network request failed')) as unknown as typeof fetch;

    const result = await MobileApiService.verifyAssayerIdentity('AS0042');

    expect(result.verified).toBe(false);
    expect(result.error).toBe(en.errors.network);
  });
});
