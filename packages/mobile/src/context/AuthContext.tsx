import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { MobileApiService } from '../services/api.service';

interface AuthUser {
  id: string;
  name: string;
  assayerCode?: string;
  email?: string;
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
  refreshUserSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [authenticating, setAuthenticating] = useState<boolean>(true);

  const initSession = useCallback(async () => {
    setAuthenticating(true);
    const session = MobileApiService.restoreSession();
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

  const login = async (u: string, p: string) => {
    setAuthenticating(true);
    const res = await MobileApiService.login(u, p);
    if (res.success && res.user) {
      setIsAuthenticated(true);
      setUser({
        id: res.user.id || MobileApiService.getCurrentUserId() || '',
        name: res.user.name || res.user.displayName || res.user.username || u,
        assayerCode: res.user.assayerCode,
      });
      setAuthenticating(false);
      return { success: true };
    }
    setAuthenticating(false);
    return { success: false, error: res.error || 'Authentication failed' };
  };

  const biometricLogin = async () => {
    setAuthenticating(true);
    const res = await MobileApiService.biometricLogin();
    if (res.success && res.user) {
      setIsAuthenticated(true);
      setUser({
        id: res.user.id || MobileApiService.getCurrentUserId() || '',
        name: res.user.name || res.user.displayName || res.user.username || 'Assayer',
      });
      setAuthenticating(false);
      return { success: true };
    }
    setAuthenticating(false);
    return { success: false, error: res.error || 'Biometric authentication failed' };
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
