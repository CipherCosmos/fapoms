import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { Login } from './pages/Login';
import { Layout } from './components/Layout';
import { Dashboard } from './pages/Dashboard';
import { Projects } from './pages/Projects';
import { Branches } from './pages/Branches';
import { PlanningWorkspace } from './pages/PlanningWorkspace';
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
      api.request<UserProfile>('/users/me', { method: 'GET' }, {
        displayName: 'Sandbox Admin',
        email: 'admin@fapoms.com',
        username: 'admin'
      })
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
        
        {/* Placeholder routes for Phase 1 endpoints */}
        <Route path="/assignments" element={
          <div className="glass-card">
            <h3>Assignments Module</h3>
            <p style={{ color: 'var(--text-secondary)', marginTop: '8px' }}>Assignments lifecycle tracking (Phase 4).</p>
          </div>
        } />
        <Route path="/scheduling" element={
          <div className="glass-card">
            <h3>Scheduling Module</h3>
            <p style={{ color: 'var(--text-secondary)', marginTop: '8px' }}>Calendar grid & national holiday conflict checkers (Phase 4).</p>
          </div>
        } />
        <Route path="/documents" element={
          <div className="glass-card">
            <h3>Document Management</h3>
            <p style={{ color: 'var(--text-secondary)', marginTop: '8px' }}>Branch list imports, master data mapping, PDF builder (Phase 5).</p>
          </div>
        } />
        <Route path="/validation" element={
          <div className="glass-card">
            <h3>Validation Dashboard</h3>
            <p style={{ color: 'var(--text-secondary)', marginTop: '8px' }}>Validator human review workspace (Phase 6).</p>
          </div>
        } />
        <Route path="/reports" element={
          <div className="glass-card">
            <h3>Operational Reports</h3>
            <p style={{ color: 'var(--text-secondary)', marginTop: '8px' }}>Coverage statistics, assayer utilization analytics (Phase 6).</p>
          </div>
        } />
        <Route path="/admin" element={
          <div className="glass-card">
            <h3>Administration</h3>
            <p style={{ color: 'var(--text-secondary)', marginTop: '8px' }}>Role privileges configurations, user listings, reference parameters (Phase 1).</p>
          </div>
        } />
        
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </Layout>
  );
};

export default App;
