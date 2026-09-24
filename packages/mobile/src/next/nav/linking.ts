/**
 * Deep links into the new app.
 *
 *  - `<scheme>://register/<token>`       → the registration invite
 *  - `https://<server host>/register/<token>` → the same invite, from the link in the SMS/email
 *    (only opens the app once Android App Links / iOS universal links are set up — see the report)
 *  - `<scheme>://today/<assignmentId>`   → a job (used by notification taps)
 *
 * Pure, for node tests.
 */

/** The custom URL scheme. Must match `scheme` in app.config.js (set only for the new app build). */
export const APP_SCHEME = 'com.fapoms.assayer';

export type RootStackParamList = {
  Language: undefined;
  Login: undefined;
  Register: { token?: string };
  Locked: undefined;
  Password: undefined;
  RegistrationGate: undefined;
  Main: undefined;
};

export type TabParamList = {
  Today: { assignmentId?: string; queryId?: string } | undefined;
  Money: undefined;
  Me: undefined;
};

/**
 * The https origin invite links use, derived from the server address the build points at, so no
 * host is hard-coded. `https://homeserver.x.ts.net/api/v1` → `https://homeserver.x.ts.net`.
 * Plain http is not offered: App Links / universal links require https.
 */
export function webOrigin(apiUrl: string | null | undefined): string | null {
  if (!apiUrl) return null;
  const m = /^https:\/\/([^/?#]+)/i.exec(apiUrl.trim());
  return m ? `https://${m[1].toLowerCase()}` : null;
}

export function linkingPrefixes(apiUrl: string | null | undefined): string[] {
  const origin = webOrigin(apiUrl);
  return [`${APP_SCHEME}://`, ...(origin ? [origin] : [])];
}

/** The React Navigation `linking.config`. */
export const LINKING_SCREENS = {
  screens: {
    Register: 'register/:token',
    Main: {
      screens: {
        Today: 'today/:assignmentId?',
        Money: 'money',
        Me: 'me',
      },
    },
  },
} as const;

/** A registration token from a URL, or null. Tolerates a trailing slash or query string. */
export function registrationTokenFrom(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /\/register\/([A-Za-z0-9._~-]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}
