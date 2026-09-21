/**
 * A registration token exists on exactly one server. A browser follows the invite link's host on
 * its own; the app asked only the server it signs in to, so a link made on any other stack said
 * "not valid" on mobile while opening fine on the web. Development builds now follow the link;
 * release builds must not, or a pasted link could steer identity and bank details to any host.
 */

jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('./api.service', () => ({ getApiBaseUrl: () => 'http://localhost:3001/api/v1' }));

import { SelfRegistrationApi, registrationLinkApiRoot } from './self-registration.service';

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
