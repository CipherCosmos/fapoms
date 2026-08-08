import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import { MobileApiService } from '../services/api.service';

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
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authenticating, setAuthenticating] = useState<boolean>(true);

  const initSession = useCallback(async () => {
    setAuthenticating(true);
    // Awaited: reading the OS keystore is async, so this is the point at which the app
    // learns whether a session survived the last launch.
    const session = await MobileApiService.restoreSession();
    if (session && session.token) {
      const valid = await MobileApiService.validateSession();
      if (valid) {
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
    setIsAuthenticated(false);
    setUser(null);
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
