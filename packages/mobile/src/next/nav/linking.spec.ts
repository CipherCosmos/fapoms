import { APP_SCHEME, linkingPrefixes, registrationTokenFrom, webOrigin } from './linking';

describe('deep link prefixes', () => {
  it('derives the https origin from the server address, never hard-coding a host', () => {
    expect(webOrigin('https://Homeserver.tailc73ec8.ts.net/api/v1')).toBe('https://homeserver.tailc73ec8.ts.net');
    expect(webOrigin('https://example.org')).toBe('https://example.org');
  });

  it('offers no web prefix for plain http or nothing (app links need https)', () => {
    expect(webOrigin('http://192.168.1.4:3001/api/v1')).toBeNull();
    expect(webOrigin('')).toBeNull();
    expect(linkingPrefixes(undefined)).toEqual([`${APP_SCHEME}://`]);
  });

  it('always includes the custom scheme', () => {
    expect(linkingPrefixes('https://h.ts.net/api/v1')).toEqual([`${APP_SCHEME}://`, 'https://h.ts.net']);
  });
});

describe('registrationTokenFrom', () => {
  it('reads the token from either kind of link', () => {
    expect(registrationTokenFrom('https://h.ts.net/register/abc-123_X')).toBe('abc-123_X');
    expect(registrationTokenFrom(`${APP_SCHEME}://register/tok.en?utm=sms`)).toBe('tok.en');
    expect(registrationTokenFrom('https://h.ts.net/register/abc/')).toBe('abc');
  });

  it('returns null for anything else', () => {
    expect(registrationTokenFrom('https://h.ts.net/login')).toBeNull();
    expect(registrationTokenFrom(null)).toBeNull();
  });
});
