import Constants from 'expo-constants';
import * as Application from 'expo-application';
import * as Updates from 'expo-updates';

/**
 * What is actually running on this handset, in one line a person can read down a phone.
 *
 * Three things change independently and each one answers a different support question:
 *
 *  - `version` (1.0.0) — the name someone types in app.config.js. It changes only when someone
 *    remembers to bump it, and stayed at 1.0.0 across every APK shipped so far. On its own it
 *    cannot tell one install from the next.
 *  - the native BUILD number (Android versionCode) — the thing that distinguishes one APK from
 *    another; the OS refuses to install a lower one over a higher one. This is what answers
 *    "did the new install actually take". Read from `expo-application`, i.e. the running
 *    binary, not from app config: config says what was INTENDED at build time, the binary says
 *    what is really there.
 *  - the JS BUNDLE — over-the-air updates change the code without changing either number
 *    above, so two assayers both on "v1.0.0 build 4" can be running different code, and the one
 *    reporting a bug may already have the fix, or be on a handset whose updates never arrived.
 *    Shown as publish time + the first 7 chars of the update id: the time answers "current or
 *    stuck", the short id matches an `eas update:list` entry the way a 7-char SHA matches a
 *    commit, without reading a full hex string aloud.
 *
 * One helper, used by every screen that shows a version, so they cannot drift.
 */

export const appVersion: string = Constants.expoConfig?.version ?? '1.0.0';

export const nativeBuild: string = Application.nativeBuildVersion ?? '?';

export const bundleLabel = (): string => {
  if (!Updates.isEnabled) return 'bundled';
  if (Updates.isEmbeddedLaunch || !Updates.createdAt) return 'as installed';
  const when = Updates.createdAt.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const shortId = Updates.updateId ? ` · ${Updates.updateId.slice(0, 7)}` : '';
  return `updated ${when}${shortId}`;
};

/** The full one-liner: `v1.0.0 (build 4) • updated 18 Aug 16:05 · 9937bea` */
export const versionLine = (): string => `v${appVersion} (build ${nativeBuild}) • ${bundleLabel()}`;
