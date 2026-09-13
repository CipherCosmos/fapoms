import { resolveLiveKitUrl } from './livekit-url';

describe('resolveLiveKitUrl', () => {
  it('prefixes a relative signaling path with the caller\'s own origin', () => {
    expect(resolveLiveKitUrl('/livekit', 'https://app.example.com')).toBe('https://app.example.com/livekit');
  });

  it('passes an absolute, non-localhost URL through unchanged', () => {
    expect(resolveLiveKitUrl('wss://sfu.example.com/rtc', 'https://app.example.com'))
      .toBe('wss://sfu.example.com/rtc');
  });

  describe('without rewriteLocalhost (the web default)', () => {
    it('passes an absolute localhost URL through unchanged', () => {
      expect(resolveLiveKitUrl('ws://localhost:7880', 'https://app.example.com'))
        .toBe('ws://localhost:7880');
    });
  });

  describe('with rewriteLocalhost (mobile)', () => {
    it('rewrites a legacy localhost URL onto the resolved API host, preserving scheme and port', () => {
      expect(resolveLiveKitUrl('ws://localhost:7880', 'http://192.168.1.20:3000', { rewriteLocalhost: true }))
        .toBe('ws://192.168.1.20:7880');
    });

    it('rewrites 127.0.0.1 the same way', () => {
      expect(resolveLiveKitUrl('ws://127.0.0.1:7880/room', 'http://10.0.2.2:3000', { rewriteLocalhost: true }))
        .toBe('ws://10.0.2.2:7880/room');
    });

    it('still prefers the relative-path branch over the localhost rewrite', () => {
      expect(resolveLiveKitUrl('/livekit', 'http://10.0.2.2:3000', { rewriteLocalhost: true }))
        .toBe('http://10.0.2.2:3000/livekit');
    });

    it('leaves a non-localhost absolute URL alone', () => {
      expect(resolveLiveKitUrl('wss://sfu.example.com/rtc', 'http://10.0.2.2:3000', { rewriteLocalhost: true }))
        .toBe('wss://sfu.example.com/rtc');
    });

    it('falls back to the raw URL when the API origin itself has no parseable host', () => {
      expect(resolveLiveKitUrl('ws://localhost:7880', 'not-a-url', { rewriteLocalhost: true }))
        .toBe('ws://localhost:7880');
    });
  });
});
