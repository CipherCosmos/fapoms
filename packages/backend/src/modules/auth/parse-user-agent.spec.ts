import { parseUserAgent } from './parse-user-agent';

/**
 * The parse is a display nicety over the raw user-agent (always stored separately), so the bar is
 * "reads sensibly for the agents this app actually sees, and never throws". These cover the common
 * web browsers, the mobile app's own client, and the empty/garbage cases that must degrade to null.
 */
describe('parseUserAgent', () => {
  it('labels Chrome on Windows', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    expect(parseUserAgent(ua)).toEqual({ browser: 'Chrome', os: 'Windows', label: 'Chrome on Windows' });
  });

  it('labels Safari on iOS', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    expect(parseUserAgent(ua).os).toBe('iOS');
    expect(parseUserAgent(ua).browser).toBe('Safari');
  });

  it('recognises the FAPOMS mobile app client over the WebView underneath', () => {
    expect(parseUserAgent('okhttp/4.9 FAPOMS/1.0 (Android)').browser).toBe('FAPOMS app');
    expect(parseUserAgent('MyApp CFNetwork/1410 Darwin/22.0').browser).toBe('FAPOMS app');
  });

  it('prefers Edge and Opera over the Chrome token they both carry', () => {
    expect(parseUserAgent('… Chrome/120.0 … Edg/120.0').browser).toBe('Edge');
    expect(parseUserAgent('… Chrome/120.0 … OPR/106.0').browser).toBe('Opera');
  });

  it('degrades to nulls for empty or unrecognised agents, never throwing', () => {
    expect(parseUserAgent(null)).toEqual({ browser: null, os: null, label: null });
    expect(parseUserAgent('')).toEqual({ browser: null, os: null, label: null });
    expect(parseUserAgent('some-cli/1.0')).toEqual({ browser: null, os: null, label: null });
  });
});
