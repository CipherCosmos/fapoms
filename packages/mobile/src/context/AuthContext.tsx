import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { MobileApiService } from '../services/api.service';
import { disconnectMobileSocket } from '../services/socket';
import { clearCache } from '../services/token-store';
import { clearQueue } from '../services/location-queue';
import { getPreference } from '../services/preferences';

/**
 * How long the app may sit in the background before it re-locks.
 *
 * Not zero, deliberately. The OS backgrounds the app for things the assayer did not choose and
 * does not think of as leaving: a permission dialog, the camera for a scan, the file picker,
 * a maps handoff. Re-locking on every one of those would put a fingerprint prompt between the
 * assayer and each step of their own work. Two minutes covers all of those and still locks a
 * phone that has been put in a pocket or handed to a bank officer.
 */
const LOCK_AFTER_BACKGROUND_MS = 2 * 60 * 1000;

/** Whether this handset can actually do a biometric check right now. */
async function biometricsUsable(): Promise<boolean> {
  const [hasHardware, isEnrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync().catch(() => false),
    LocalAuthentication.isEnrolledAsync().catch(() => false),
  ]);
  return hasHardware && isEnrolled;
}

interface AuthUser {
  id: string;
  name: string;
  assayerCode?: string;
  email?: string;
  /**
   * Set when this account is still using a password somebody else chose — a seeded
   * credential or an HR reset. The app routes straight to the change-password screen and
   * will not show audit work until it is cleared.
   */
  mustChangePassword?: boolean;
}

interface AuthContextType {
  isAuthenticated: boolean;
  user: AuthUser | null;
  assayerName: string;
  authenticating: boolean;
  login: (u: string, p: string) => Promise<{ success: boolean; error?: string }>;
  biometricLogin: () => Promise<{ success: boolean; error?: string }>;
  verifyIdentity: (identifier: string) => Promise<{ verified: boolean; assayer?: any; error?: string }>;
  logout: () => void;
  /** Called after a successful password change so the app can leave the forced-change screen. */
  clearMustChangePassword: () => void;
  refreshUserSession: () => Promise<void>;
  /**
   * A restored session that has not been unlocked yet.
   *
   * Biometric sign-in used to live only on the login screen — which an assayer with a valid
   * saved session never sees, so in practice the feature was unreachable. Keeping someone
   * signed in and never re-checking who is holding the phone is also the wrong trade for an
   * app carrying bank collateral evidence: a handset left on a branch counter is an open
   * session. This gates the restored session instead of the password.
   */
  locked: boolean;
  unlock: () => Promise<{ success: boolean; error?: string }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authenticating, setAuthenticating] = useState<boolean>(true);
  const [locked, setLocked] = useState<boolean>(false);
  const backgroundedAt = useRef<number | null>(null);

  /**
   * Boot auth is decided from the keystore alone — never blocked on a network round trip.
   *
   * This used to `await validateSession()` (up to a 5s request) before revealing anything, so
   * every cold start paid that latency even when the token was perfectly fine, and on a branch
   * with no signal the app never got past the spinner at all — an assayer standing in a vault
   * with a saved session could not open the app to see yesterday's schedule. The stored token
   * is sufficient to resume the UI immediately: `AssignmentContext` already paints the last
   * cached assignments the moment `isAuthenticated` flips, so the assayer sees their real last
   * state (not a blank screen, not a stranger's) whether or not the network answers.
   *
   * Server validation still happens — just after the UI is already usable, and it can only ever
   * *downgrade* a session (an explicit 401/403 rejection), never hold up showing one.
   */
  const initSession = useCallback(async () => {
    setAuthenticating(true);
    // Awaited: reading the OS keystore is async, so this is the point at which the app
    // learns whether a session survived the last launch. Typically single-digit milliseconds —
    // nothing here touches the network.
    const session = await MobileApiService.restoreSession();
    if (session && session.token) {
      // Locked before the session is exposed, not after — the schedule, branch addresses and
      // customer counts must not paint behind the prompt even for a frame.
      if (getPreference('biometrics') && (await biometricsUsable())) {
        setLocked(true);
      }
      setIsAuthenticated(true);
      setUser({
        id: session.userId || MobileApiService.getCurrentUserId() || '',
        name: session.userName || MobileApiService.getCurrentUserName() || 'Assayer',
        /**
         * Carried through the restore, not just set at sign-in.
         *
         * Rebuilding the user here without it left the flag `undefined`, so the "choose your
         * own password" gate never rendered on a restored session — and restarting the app was
         * enough to walk past a requirement that exists precisely because the current password
         * is one an administrator issued and therefore already knows.
         */
        mustChangePassword: MobileApiService.mustChangePassword,
      });
      setAuthenticating(false);

      // Background revalidation. `unreachable` (no signal, a permission dialog pausing the
      // app) changes nothing — see validateSession's own comment on why that must not sign
      // anyone out. Only an explicit rejection ends the session, and only once the server has
      // actually had the chance to say so.
      MobileApiService.validateSession().then((verdict) => {
        if (verdict === 'invalid') {
          setIsAuthenticated(false);
          setUser(null);
          setLocked(false);
        } else if (verdict === 'valid') {
          setUser((prev) => (prev ? { ...prev, mustChangePassword: MobileApiService.mustChangePassword } : prev));
        }
      });
    } else {
      setIsAuthenticated(false);
      setUser(null);
      setAuthenticating(false);
    }
  }, []);

  useEffect(() => {
    initSession();
  }, [initSession]);

  const unlock = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    try {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock Orbit',
        cancelLabel: 'Cancel',
        // Forces the biometric sensor rather than silently accepting the device PIN. The
        // point of the gate is to confirm the person holding the phone is the assayer the
        // work will be recorded against, and a shared branch PIN does not establish that.
        disableDeviceFallback: true,
      });
      if (result.success) {
        setLocked(false);
        return { success: true };
      }
      return {
        success: false,
        error: result.error === 'user_cancel' ? undefined : 'Not recognised. Try again.',
      };
    } catch (err: any) {
      // If the sensor itself is unavailable, refusing to unlock would strand the assayer in an
      // app they are legitimately signed in to, mid-audit, with no way forward.
      setLocked(false);
      return { success: true };
    }
  }, []);

  /**
   * Re-locks after a real absence.
   *
   * Tracked by timestamp rather than by "did we background at all", because the app is
   * backgrounded constantly by its own flows — the ML Kit scanner, the document picker, the
   * location permission dialog. Locking on those would make the scan-to-upload path
   * unusable.
   */
  useEffect(() => {
    const onChange = (state: AppStateStatus) => {
      if (state === 'background' || state === 'inactive') {
        if (backgroundedAt.current === null) backgroundedAt.current = Date.now();
        return;
      }
      if (state !== 'active') return;

      const since = backgroundedAt.current;
      backgroundedAt.current = null;
      if (since === null || Date.now() - since < LOCK_AFTER_BACKGROUND_MS) return;
      if (!isAuthenticated || locked) return;

      void (async () => {
        if (getPreference('biometrics') && (await biometricsUsable())) setLocked(true);
      })();
    };

    const sub = AppState.addEventListener('change', onChange);
    return () => sub.remove();
  }, [isAuthenticated, locked]);

  /** Clears the forced-rotation flag locally once the server has accepted a new password. */
  const clearMustChangePassword = () => {
    // Cleared on the service too, so the next session restore does not re-raise the gate from a
    // stale flag captured before the change went through.
    MobileApiService.mustChangePassword = false;
    setUser((prev) => (prev ? { ...prev, mustChangePassword: false } : prev));
  };

  /**
   * `authenticating` is deliberately NOT touched by an interactive sign-in attempt.
   *
   * App.tsx swaps the whole screen for a bare spinner while `authenticating` is true — correct
   * for the one-time boot-time session restore, where there is no form to preserve yet. But this
   * flag used to be raised on every login/biometric attempt too, which unmounted LoginScreen for
   * the duration of the request and remounted a fresh one on failure: the assayer's code,
   * password, and the error message itself were wiped by a component remount that had nothing to
   * do with their input. The inline spinner already built into LoginScreen's Sign In button
   * (`authenticating` prop, driven by its own `internalLoading`) is what should show progress
   * here — it does not require unmounting the form underneath it.
   */
  const login = async (u: string, p: string) => {
    const res = await MobileApiService.login(u, p);
    if (res.success && res.user) {
      setIsAuthenticated(true);
      setUser({
        id: res.user.id || MobileApiService.getCurrentUserId() || '',
        name: res.user.name || res.user.displayName || res.user.username || u,
        assayerCode: res.user.assayerCode,
        mustChangePassword: !!res.user.mustChangePassword,
      });
      return { success: true };
    }
    return { success: false, error: res.error || 'Authentication failed' };
  };

  const biometricLogin = async () => {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync().catch(() => false);
      const isEnrolled = await LocalAuthentication.isEnrolledAsync().catch(() => false);

      if (hasHardware && isEnrolled) {
        const authResult = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Authenticate to Sign In',
          fallbackLabel: 'Use Assayer Code & Password',
          cancelLabel: 'Cancel',
        });
        if (!authResult.success) {
          return {
            success: false,
            error: authResult.error === 'user_cancel' ? 'Biometric scan cancelled' : 'Biometric verification failed.',
          };
        }
      }

      const res = await MobileApiService.biometricLogin();
      if (res.success && res.user) {
        setIsAuthenticated(true);
        setUser({
          id: res.user.id || MobileApiService.getCurrentUserId() || '',
          // No hardcoded identity fallback: if the server did not tell us who this is,
          // we must not decide on its behalf. Showing a name the session does not own is
          // how every action ends up attributed to the wrong person.
          name: res.user.name || res.user.displayName || res.user.username || 'Assayer',
          assayerCode: res.user.assayerCode || '',
        });
        return { success: true };
      }

      /**
       * A failed biometric login means "sign in with your password", never "sign in as
       * somebody else".
       *
       * This previously fell through to `MobileApiService.login('AS0127', 'Password@123')` —
       * a real, active assayer account (Belekar Satish Shankarrao, 8 assignments, ₹14,571.90
       * earned). And it was the *normal* path, not an edge case: `getRefreshToken()` reads
       * `globalThis.localStorage`, which does not exist in React Native, so it always returned
       * null, so biometric login always failed, so this always fired. On a handset with no
       * enrolled fingerprint the biometric prompt is skipped entirely — one tap and you were
       * inside as a named field worker.
       *
       * The consequence was not "wrong screen": every GPS check-in, uploaded audit packet,
       * expense claim and query answer from any device holding the APK was recorded against
       * that person. For evidence in a bank collateral audit, that destroys chain of custody.
       */
      return { success: false, error: res.error || 'Please sign in with your Assayer Code and password.' };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Biometric login failed.' };
    }
  };

  const verifyIdentity = async (identifier: string) => {
    return MobileApiService.verifyAssayerIdentity(identifier);
  };

  const logout = () => {
    MobileApiService.clearSession();
    // The live socket is part of the session. Left open it stays joined to this assayer's room,
    // so on a shared handset the next person to sign in would keep receiving the previous
    // person's offers and fees — and none of their own.
    disconnectMobileSocket();
    // One assayer's cached schedule must not survive into the next person's session on a
    // shared handset.
    void clearCache();
    // Explicit as well as implicit: clearCache() drops the whole cache file on native, but its
    // web branch returns early, and one assayer's movements must never upload under another's login.
    void clearQueue();
    setIsAuthenticated(false);
    setUser(null);
    // Or the next sign-in lands straight on the lock screen.
    setLocked(false);
  };

  const refreshUserSession = async () => {
    await initSession();
  };

  const assayerName = user?.name || 'Field Assayer';

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated,
        user,
        assayerName,
        authenticating,
        login,
        biometricLogin,
        locked,
        unlock,
        verifyIdentity,
        logout,
        clearMustChangePassword,
        refreshUserSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
