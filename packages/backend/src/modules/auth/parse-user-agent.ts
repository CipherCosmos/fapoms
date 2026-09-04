/**
 * A small, dependency-free parse of a User-Agent string into a human device label.
 *
 * Deliberately not a full UA-parsing library: the sessions UI needs "Chrome on Windows" or
 * "FAPOMS app on Android", not exhaustive version detection, and pulling a parsing dependency in
 * would mean a container rebuild for a display nicety. The raw user-agent is always stored
 * alongside this, so forensics never depend on the parse — this only makes the list readable.
 *
 * Heuristic and best-effort: an unrecognised agent yields nulls and the UI falls back to the raw
 * string. It is never used for any security decision.
 */
export interface ParsedUserAgent {
  browser: string | null;
  os: string | null;
  label: string | null;
}

export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
  if (!ua || typeof ua !== 'string') return { browser: null, os: null, label: null };

  const os =
    /Windows NT/i.test(ua) ? 'Windows' :
    /iPhone|iPad|iOS/i.test(ua) ? 'iOS' :
    /Android/i.test(ua) ? 'Android' :
    /Mac OS X|Macintosh/i.test(ua) ? 'macOS' :
    /Linux/i.test(ua) ? 'Linux' :
    null;

  // The mobile app's own client (React Native / Expo) before the generic browser families, so an
  // in-app request is labelled as the app rather than as the WebView underneath it.
  const browser =
    /FAPOMS|Expo|okhttp|CFNetwork/i.test(ua) ? 'FAPOMS app' :
    /Edg\//i.test(ua) ? 'Edge' :
    /OPR\/|Opera/i.test(ua) ? 'Opera' :
    /Chrome\//i.test(ua) ? 'Chrome' :
    /Firefox\//i.test(ua) ? 'Firefox' :
    /Safari\//i.test(ua) ? 'Safari' :
    null;

  const label =
    browser && os ? `${browser} on ${os}` :
    browser ? browser :
    os ? os :
    null;

  return { browser, os, label };
}
