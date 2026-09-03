/**
 * A password reset issued while the app is open must raise the change-password gate.
 *
 * The forced-rotation guard answers every non-exempt route with 403 and
 * `code: PASSWORD_CHANGE_REQUIRED`. Nothing on the phone read that code, and the flag behind the
 * gate was only ever learned once — from the profile read inside `validateSession`, at cold
 * start. So an HR-issued reset landed on a running app and stranded the assayer: the gate stayed
 * down, every request came back 403, and the screens that swallow a failed read into an empty
 * collection (schedule, notifications) showed nothing at all. Force-quitting was the only way
 * through, which is not a thing to ask of somebody standing at a branch counter.
 *
 * Nothing here logs anybody out, and that half must keep working: `fetchWithAuthOnce` handles
 * only 401, and the two places that do destroy a session on a 403 sit behind routes the guard
 * exempts. A 403 that is *not* this code must stay an ordinary response the caller reads itself.
 *
 * The native modules are mocked away rather than loaded — this suite runs in node, and none of
 * the code under test touches them.
 */

jest.mock('react-native', () => ({ Platform: { OS: 'android', select: (o: any) => o.android } }));
jest.mock('expo-file-system', () => ({}));
jest.mock('expo-constants', () => ({ default: { expoConfig: { extra: {} } } }));
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

import { MobileApiService } from './api.service';

/** The registration guard's exact body, from `guards.ts`. */
const registrationRefusal = () =>
  new Response(
    JSON.stringify({
      statusCode: 403,
      error: 'Forbidden',
      message: 'You can finish your registration here. Your HR contact will open the rest of the app once your joining checks are done.',
      code: 'REGISTRATION_IN_PROGRESS',
    }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );

/** A refusal that is neither gate — an ordinary permissions failure. */
const plainRefusal = () =>
  new Response(
    JSON.stringify({ statusCode: 403, error: 'Forbidden', message: 'Forbidden resource' }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );

/**
 * A 403 that means "you may only finish registering".
 *
 * An assayer in one of the joining stages can now sign in, and the server answers this on every
 * route outside registration. Unread, the app behaves exactly as it did before the forced-password
 * gate was wired: a successful sign-in, then Home, then every read failing into an empty list with
 * no route to the one screen the session exists for. Signing somebody in and showing them nothing
 * is a worse answer than the refusal it replaced, because the refusal at least said why.
 */
describe('a 403 that means "finish registering first"', () => {
  let raised: number;

  beforeEach(() => {
    raised = 0;
    MobileApiService.registrationInProgress = false;
    MobileApiService.mustChangePassword = false;
    MobileApiService.onRegistrationInProgress = () => { raised += 1; };
  });

  afterEach(() => {
    MobileApiService.onRegistrationInProgress = null;
    MobileApiService.registrationInProgress = false;
  });

  it('raises the gate mid-session', async () => {
    global.fetch = jest.fn().mockResolvedValue(registrationRefusal()) as any;

    await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/assignments/assayer/x');

    expect(MobileApiService.registrationInProgress).toBe(true);
    expect(raised).toBe(1);
  });

  it('raises it once, not once per blocked read', async () => {
    global.fetch = jest.fn().mockResolvedValue(registrationRefusal()) as any;

    await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/a');
    await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/b');

    expect(raised).toBe(1);
  });

  it('leaves the caller a readable body', async () => {
    global.fetch = jest.fn().mockResolvedValue(registrationRefusal()) as any;

    const response = await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/a');

    expect((await response.json()).message).toMatch(/finish your registration/i);
  });

  it('does not confuse the two gates', async () => {
    // They need different screens. A registration session routed to change-password, or a
    // password-reset session routed to the checklist, is a dead end in both directions.
    let password = 0;
    MobileApiService.onPasswordChangeRequired = () => { password += 1; };
    global.fetch = jest.fn().mockResolvedValue(registrationRefusal()) as any;

    await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/a');

    expect(raised).toBe(1);
    expect(password).toBe(0);
    expect(MobileApiService.mustChangePassword).toBe(false);
    MobileApiService.onPasswordChangeRequired = null;
  });

  it('ignores an ordinary permissions 403', async () => {
    // Most 403s are neither gate, and raising a gate on one would strand somebody who simply
    // asked for something not theirs.
    global.fetch = jest.fn().mockResolvedValue(plainRefusal()) as any;

    await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/a');

    expect(raised).toBe(0);
    expect(MobileApiService.registrationInProgress).toBe(false);
  });

  it('clears with the session, so a shared handset does not inherit it', async () => {
    global.fetch = jest.fn().mockResolvedValue(registrationRefusal()) as any;
    await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/a');
    expect(MobileApiService.registrationInProgress).toBe(true);

    MobileApiService.clearSession();

    expect(MobileApiService.registrationInProgress).toBe(false);
  });
});
