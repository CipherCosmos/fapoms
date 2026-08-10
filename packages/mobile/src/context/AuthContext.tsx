import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { MobileApiService } from '../services/api.service';
import { clearCache } from '../services/token-store';
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

  const initSession = useCallback(async () => {
    setAuthenticating(true);
    // Awaited: reading the OS keystore is async, so this is the point at which the app
    // learns whether a session survived the last launch.
    const session = await MobileApiService.restoreSession();
    if (session && session.token) {
      /**
       * Keeps the session unless the server actually rejected it.
       *
       * `unreachable` means we could not ask — a permission dialog pausing the app, or no
       * signal at the branch. Signing someone out for that is both wrong and expensive: they
       * are standing in a bank vault and now need their password to carry on.
       */
      const verdict = await MobileApiService.validateSession();
      if (verdict !== 'invalid') {
        // Locked before the session is exposed, not after — the schedule, branch addresses and
        // customer counts must not paint behind the prompt even for a frame.
        if (getPreference('biometrics') && (await biometricsUsable())) {
          setLocked(true);
        }
        setIsAuthenticated(true);
        setUser({
          id: session.userId || MobileApiService.getCurrentUserId() || '',
          name: session.userName || MobileApiService.getCurrentUserName() || 'Assayer',
        });
      } else {
        setIsAuthenticated(false);
        setUser(null);
      }
    } else {
      setIsAuthenticated(false);
      setUser(null);
    }
    setAuthenticating(false);
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
    setUser((prev) => (prev ? { ...prev, mustChangePassword: false } : prev));
  };

  const login = async (u: string, p: string) => {
    setAuthenticating(true);
    const res = await MobileApiService.login(u, p);
    if (res.success && res.user) {
      setIsAuthenticated(true);
      setUser({
        id: res.user.id || MobileApiService.getCurrentUserId() || '',
        name: res.user.name || res.user.displayName || res.user.username || u,
        assayerCode: res.user.assayerCode,
        mustChangePassword: !!res.user.mustChangePassword,
      });
      setAuthenticating(false);
      return { success: true };
    }
    setAuthenticating(false);
    return { success: false, error: res.error || 'Authentication failed' };
  };

  const biometricLogin = async () => {
    setAuthenticating(true);
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
          setAuthenticating(false);
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
        setAuthenticating(false);
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
      setAuthenticating(false);
      return { success: false, error: res.error || 'Please sign in with your Assayer Code and password.' };
    } catch (err: any) {
      setAuthenticating(false);
      return { success: false, error: err?.message || 'Biometric login failed.' };
    }
  };

  const verifyIdentity = async (identifier: string) => {
    return MobileApiService.verifyAssayerIdentity(identifier);
  };

  const logout = () => {
    MobileApiService.clearSession();
    // One assayer's cached schedule must not survive into the next person's session on a
    // shared handset.
    void clearCache();
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
