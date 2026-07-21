import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Login } from './pages/Login';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Projects } from './pages/Projects';
import { Branches } from './pages/Branches';
import { PlanningWorkspace } from './pages/PlanningWorkspace';
import { Assignments } from './pages/Assignments';
import { Scheduling } from './pages/Scheduling';
import { Documents } from './pages/Documents';
import { Validation } from './pages/Validation';
import { Users } from './pages/Users';
import { Assayers } from './pages/Assayers';
import { Rules } from './pages/Rules';
import { api } from './services/api';

interface UserProfile {
  displayName: string;
  email: string;
  username: string;
}

export const App: React.FC = () => {
  const [token, setToken] = useState<string | null>(localStorage.getItem('fapoms_token'));
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (token) {
      api.request<UserProfile>('/users/me', { method: 'GET' })
        .then(setCurrentUser)
        .catch(() => {
          handleLogout();
        });
    }
  }, [token]);

  const handleLoginSuccess = (jwtToken: string) => {
    localStorage.setItem('fapoms_token', jwtToken);
    setToken(jwtToken);
    navigate('/dashboard');
  };

  const handleLogout = () => {
    localStorage.removeItem('fapoms_token');
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
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/branches" element={<Branches />} />
        <Route path="/planning" element={<PlanningWorkspace />} />
        <Route path="/assignments" element={<Assignments />} />
        <Route path="/scheduling" element={<Scheduling />} />
        <Route path="/documents" element={<Documents />} />
        <Route path="/validation" element={<Validation />} />
        <Route path="/users" element={<Users />} />
        <Route path="/assayers" element={<Assayers />} />
        <Route path="/rules" element={<Rules />} />
        
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
  );
};

export default App;
