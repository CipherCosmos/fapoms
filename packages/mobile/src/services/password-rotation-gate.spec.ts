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

/** The guard's exact body, from `guards.ts` — including the discriminator this all turns on. */
const rotationRefusal = () =>
  new Response(
    JSON.stringify({
      statusCode: 403,
      error: 'Forbidden',
      message: 'You must change your password before you can continue. Please set a new password.',
      code: 'PASSWORD_CHANGE_REQUIRED',
    }),
    { status: 403, headers: { 'Content-Type': 'application/json' } },
  );

const respond = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('a 403 that means "change your password first"', () => {
  let raised: number;

  beforeEach(() => {
    raised = 0;
    MobileApiService.mustChangePassword = false;
    MobileApiService.onPasswordChangeRequired = () => {
      raised += 1;
    };
  });

  afterEach(() => {
    MobileApiService.onPasswordChangeRequired = null;
    MobileApiService.mustChangePassword = false;
  });

  it('raises the gate mid-session, without waiting for a restart', async () => {
    global.fetch = jest.fn().mockResolvedValue(rotationRefusal()) as any;

    await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/assayers/assignments');

    expect(MobileApiService.mustChangePassword).toBe(true);
    expect(raised).toBe(1);
  });

  it('still hands the caller a readable body — the response is not consumed by the check', async () => {
    global.fetch = jest.fn().mockResolvedValue(rotationRefusal()) as any;

    const response = await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/assayers/notifications');
    const body = await response.json();

    // Read through a clone precisely so this still works. A caller left with a used body would
    // have lost the message it is meant to show.
    expect(response.status).toBe(403);
    expect(body.message).toMatch(/change your password/i);
  });

  it('raises the gate once, not once per blocked request', async () => {
    global.fetch = jest.fn().mockResolvedValue(rotationRefusal()) as any;

    // Everything is gated now, so a screen with three reads on mount produces three 403s.
    // Re-notifying on each would rebuild the user object and re-render the app three times.
    await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/a');
    await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/b');
    await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/c');

    expect(raised).toBe(1);
  });

  it('leaves an ordinary permissions 403 alone', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(respond({ statusCode: 403, message: 'Forbidden resource' }, 403)) as any;

    const response = await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/admin/thing');

    expect(response.status).toBe(403);
    expect(MobileApiService.mustChangePassword).toBe(false);
    expect(raised).toBe(0);
  });

  it('leaves a 403 with no JSON body alone rather than throwing', async () => {
    // A proxy or gateway can refuse with HTML. Parsing must fail quietly and hand the caller
    // exactly what arrived — the detection is a courtesy, never a thing that can break a request.
    global.fetch = jest
      .fn()
      .mockResolvedValue(new Response('<html>Forbidden</html>', { status: 403 })) as any;

    const response = await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/thing');

    expect(response.status).toBe(403);
    expect(await response.text()).toContain('Forbidden');
    expect(MobileApiService.mustChangePassword).toBe(false);
    expect(raised).toBe(0);
  });

  it('does not touch a successful response', async () => {
    global.fetch = jest.fn().mockResolvedValue(respond({ ok: true }, 200)) as any;

    const response = await MobileApiService.fetchWithAuth('http://localhost:3000/api/v1/thing');

    expect(await response.json()).toEqual({ ok: true });
    expect(raised).toBe(0);
  });
});
