import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { SystemRole } from '@fapoms/shared';
import { Login } from './pages/Login';
import { Layout } from './components/Layout';
import { ProtectedRoute } from './components/ProtectedRoute';
import { Dashboard } from './pages/Dashboard';
import { ExecutiveMap } from './pages/ExecutiveMap';
import { Projects } from './pages/Projects';
import { Branches } from './pages/Branches';
import { PlanningWorkspace } from './pages/PlanningWorkspace';
import { Assignments } from './pages/Assignments';
import { Scheduling } from './pages/Scheduling';
import { Documents } from './pages/Documents';
import { Validation } from './pages/Validation';
import { Users } from './pages/Users';
import { Assayers } from './pages/Assayers';
import { AssayerProfile } from './pages/AssayerProfile';
import { Clients } from './pages/Clients';
import { Rules } from './pages/Rules';
import { Notifications } from './pages/Notifications';
import { Holidays } from './pages/Holidays';
import { api } from './services/api';

interface UserProfile {
  displayName: string;
  email: string;
  username: string;
  roles: { name: SystemRole }[];
}

export const App: React.FC = () => {
  const [token, setToken] = useState<string | null>(localStorage.getItem('fapoms_token'));
  
  const getCachedUser = (): UserProfile | null => {
    try {
      const cached = localStorage.getItem('fapoms_user_cache');
      return cached ? JSON.parse(cached) : null;
    } catch {
      return null;
    }
  };

  const [currentUser, setCurrentUser] = useState<UserProfile | null>(getCachedUser);
  const [isLoadingUser, setIsLoadingUser] = useState<boolean>(Boolean(token) && !currentUser);
  const navigate = useNavigate();

  useEffect(() => {
    if (token) {
      setIsLoadingUser(true);
      api.request<UserProfile>('/users/me', { method: 'GET' })
        .then((user) => {
          setCurrentUser(user);
          try {
            localStorage.setItem('fapoms_user_cache', JSON.stringify(user));
          } catch {}
        })
        .catch(() => {
          handleLogout();
        })
        .finally(() => {
          setIsLoadingUser(false);
        });
    } else {
      setIsLoadingUser(false);
    }
  }, [token]);

  const userRoles = currentUser?.roles?.map((r) => r.name) ?? [];

  const handleLoginSuccess = (jwtToken: string, refreshToken: string) => {
    localStorage.setItem('fapoms_token', jwtToken);
    localStorage.setItem('fapoms_refresh_token', refreshToken);
    setToken(jwtToken);
    navigate('/dashboard');
  };

  const handleLogout = () => {
    localStorage.removeItem('fapoms_token');
    localStorage.removeItem('fapoms_refresh_token');
    localStorage.removeItem('fapoms_user_cache');
    setToken(null);
    setCurrentUser(null);
    navigate('/login');
  };

  if (!token) {
    return (
      <Routes>
        <Route path="/login" element={<Login onLoginSuccess={handleLoginSuccess} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Layout onLogout={handleLogout} user={currentUser || undefined}>
      <Routes>
        <Route path="/dashboard" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Dashboard /></ProtectedRoute>} />
        <Route path="/executive-map" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><ExecutiveMap /></ProtectedRoute>} />
        <Route path="/projects" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Projects /></ProtectedRoute>} />
        <Route path="/branches" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Branches /></ProtectedRoute>} />
        <Route path="/planning" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><PlanningWorkspace /></ProtectedRoute>} />
        <Route path="/assignments" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Assignments /></ProtectedRoute>} />
        <Route path="/scheduling" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Scheduling /></ProtectedRoute>} />
        <Route path="/documents" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Documents /></ProtectedRoute>} />
        <Route path="/validation" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Validation /></ProtectedRoute>} />
        <Route path="/users" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Users /></ProtectedRoute>} />
        <Route path="/assayers" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Assayers /></ProtectedRoute>} />
        <Route path="/assayers/:id" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><AssayerProfile /></ProtectedRoute>} />
        <Route path="/clients" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Clients /></ProtectedRoute>} />
        <Route path="/rules" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Rules /></ProtectedRoute>} />
        <Route path="/holidays" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Holidays /></ProtectedRoute>} />
        <Route path="/notifications" element={<ProtectedRoute userRoles={userRoles} isLoading={isLoadingUser}><Notifications /></ProtectedRoute>} />
        
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
  );
};

export default App;
