/**
 * A registration token exists on exactly one server. A browser follows the invite link's host on
 * its own; the app asked only the server it signs in to, so a link made on any other stack said
 * "not valid" on mobile while opening fine on the web. Development builds now follow the link;
 * release builds must not, or a pasted link could steer identity and bank details to any host.
 */

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('./api.service', () => ({ getApiBaseUrl: () => 'http://localhost:3001/api/v1' }));

import { SelfRegistrationApi, registrationLinkApiRoot, registrationSessionHeaders } from './self-registration.service';

const APP = 'http://localhost:3001/api/v1';
const RIG = 'http://localhost:8080/api/v1';
const TOKEN = 'abc123';
const LINK = `http://localhost:8080/register/${TOKEN}`;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const notFound = () => json(404, { message: 'This registration link is not valid. Ask HR to resend it.', code: 'NOT_FOUND' });
const found = () => json(200, { success: true, data: { application: { id: 'app-1' }, documents: [], documentsRequested: [] } });

const fetchMock = jest.fn();
const calledUrls = () => fetchMock.mock.calls.map(([url]) => url as string);
const g = globalThis as any;

beforeEach(() => {
  fetchMock.mockReset();
  g.fetch = fetchMock;
  g.__DEV__ = true;
});

describe('registrationLinkApiRoot', () => {
  it('reads the host out of an invite link, including one served under a path', () => {
    expect(registrationLinkApiRoot(LINK)).toBe(RIG);
    expect(registrationLinkApiRoot(' https://orbit.example.com/app/register/x?y=1 ')).toBe('https://orbit.example.com/api/v1');
  });

  it('has nothing to say about a bare token', () => {
    expect(registrationLinkApiRoot(TOKEN)).toBeNull();
  });
});

describe('SelfRegistrationApi.open', () => {
  it('asks the app server first and stays there when it knows the link', async () => {
    fetchMock.mockResolvedValueOnce(found());
    const { token, result } = await SelfRegistrationApi.open(LINK);
    expect(token).toBe(TOKEN);
    expect(result.success).toBe(true);
    expect(calledUrls()).toEqual([`${APP}/public/registration/${TOKEN}`]);
  });

  it('in development, finds the link on its own server and keeps using that server', async () => {
    fetchMock.mockResolvedValueOnce(notFound()).mockResolvedValueOnce(found()).mockResolvedValueOnce(found());
    const { result } = await SelfRegistrationApi.open(LINK);
    expect(result.success).toBe(true);
    await SelfRegistrationApi.submit(TOKEN);
    expect(calledUrls()).toEqual([
      `${APP}/public/registration/${TOKEN}`,
      `${RIG}/public/registration/${TOKEN}`,
      `${RIG}/public/registration/${TOKEN}/submit`,
    ]);
  });

  it('in a release build, never sends anything to the host a pasted link names', async () => {
    g.__DEV__ = false;
    fetchMock.mockResolvedValueOnce(notFound());
    const { result } = await SelfRegistrationApi.open(LINK);
    expect(result.success).toBe(false);
    expect(calledUrls()).toEqual([`${APP}/public/registration/${TOKEN}`]);
  });

  it('does not look elsewhere when the app server holds the link but refuses it', async () => {
    fetchMock.mockResolvedValueOnce(json(400, { message: 'This registration link has expired.', code: 'BAD_REQUEST' }));
    const { result } = await SelfRegistrationApi.open(LINK);
    expect(result).toMatchObject({ success: false, code: 'BAD_REQUEST' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports the original answer and returns to the app server when the link host fails too', async () => {
    fetchMock.mockResolvedValueOnce(notFound()).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(found());
    const { result } = await SelfRegistrationApi.open(LINK);
    expect(result).toMatchObject({ success: false, code: 'NOT_FOUND' });
    await SelfRegistrationApi.submit(TOKEN);
    expect(calledUrls()[2]).toBe(`${APP}/public/registration/${TOKEN}/submit`);
  });

  it('forgets the previous registration server when a new one is opened', async () => {
    fetchMock.mockResolvedValueOnce(notFound()).mockResolvedValueOnce(found());
    await SelfRegistrationApi.open(LINK);
    fetchMock.mockResolvedValueOnce(found());
    await SelfRegistrationApi.open('other-token');
    expect(calledUrls()[2]).toBe(`${APP}/public/registration/other-token`);
  });
});

/**
 * A registration link's saved identity numbers and scans are withheld until the link's code is
 * verified in this session. The key the verify answers with must ride on every later read and
 * save — and only for the link it was minted for.
 */
describe('the registration session key', () => {
  const headerOf = (i: number) => ((fetchMock.mock.calls[i][1] as RequestInit).headers as Record<string, string>)['x-registration-session'];

  it('is kept from a verified code and sent when opening, saving, asking for a code and sending scans', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { success: true, data: { verified: true, sessionKey: 'k'.repeat(43) } }));
    await SelfRegistrationApi.verifyOtp('link-one', '9876543210', '123456');

    fetchMock.mockResolvedValue(found());
    await SelfRegistrationApi.hydrate('link-one');
    await SelfRegistrationApi.updateDraft('link-one', { fullName: 'A' });
    await SelfRegistrationApi.requestOtp('link-one', '9876543210');
    await SelfRegistrationApi.uploadDocument('link-one', 'PAN_CARD', { uri: 'file:///x.jpg', name: 'x.jpg' });
    for (let i = 1; i <= 4; i++) expect(headerOf(i)).toBe('k'.repeat(43));
    expect(registrationSessionHeaders('link-one')).toEqual({ 'x-registration-session': 'k'.repeat(43) });
  });

  it('is not sent for a different link, nor before any code was verified', async () => {
    fetchMock.mockResolvedValue(found());
    await SelfRegistrationApi.hydrate('another-link-token');
    expect(headerOf(0)).toBeUndefined();
  });

  it('is not kept from a failed verify', async () => {
    fetchMock.mockResolvedValueOnce(json(400, { message: 'Wrong code' }));
    await SelfRegistrationApi.verifyOtp('link-three', '9876543210', '000000');
    expect(registrationSessionHeaders('link-three')).toEqual({});
  });
});

/**
 * 2026-09-24: a PDF scan is opened by the phone's viewer, which cannot send the session header.
 * The app asks (with the header) for a two-minute link to that one page and opens that.
 */
describe('SelfRegistrationApi.documentOpenUrl', () => {
  it('asks for a link with the session header and returns an address on the same server', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { success: true, data: { path: `/public/registration/${TOKEN}/documents/PAN_CARD/file/0?t=123.sig` } }));
    const res = await SelfRegistrationApi.documentOpenUrl(TOKEN, 'PAN_CARD', 0);
    expect(calledUrls()[0]).toBe(`${APP}/public/registration/${TOKEN}/documents/PAN_CARD/file/0/link`);
    expect(res).toEqual({ success: true, data: `${APP}/public/registration/${TOKEN}/documents/PAN_CARD/file/0?t=123.sig` });
  });

  it('opens nothing when the server refuses (still locked)', async () => {
    fetchMock.mockResolvedValueOnce(json(403, { message: 'Verify your mobile number to view your saved scans.' }));
    const res = await SelfRegistrationApi.documentOpenUrl(TOKEN, 'PAN_CARD', 0);
    expect(res.success).toBe(false);
  });
});
