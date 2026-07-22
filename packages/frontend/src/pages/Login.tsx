import React, { useState } from 'react';

interface LoginProps {
  onLoginSuccess: (accessToken: string, refreshToken: string) => void;
}

export const Login: React.FC<LoginProps> = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      // Live request
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const resData = await response.json();

      if (response.ok && resData.success) {
        onLoginSuccess(resData.data.accessToken, resData.data.refreshToken);
      } else {
        setError(resData.message || resData.error?.message || 'Invalid credentials');
      }
    } catch (err) {
      setError('Authentication server connection failed.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      width: '100vw',
      background: 'radial-gradient(circle at 10% 20%, rgba(99, 102, 241, 0.15) 0%, rgba(9, 13, 22, 1) 90.2%)',
      padding: '24px'
    }}>
      <div className="glass-card" style={{
        width: '100%',
        maxWidth: '440px',
        padding: '40px',
        boxShadow: 'var(--shadow-lg), var(--shadow-neon)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: 'var(--radius-lg)',
        position: 'relative',
        overflow: 'hidden'
      }}>
        {/* Glow Element */}
        <div style={{
          position: 'absolute',
          top: '-150px',
          right: '-150px',
          width: '300px',
          height: '300px',
          borderRadius: '50%',
          background: 'rgba(9, 182, 212, 0.15)',
          filter: 'blur(60px)',
          zIndex: 0
        }} />

        <div style={{ position: 'relative', zIndex: 1 }}>
          
          {/* Logo Header */}
          <div style={{ textAlign: 'center', marginBottom: '36px' }}>
            <div style={{
              background: 'var(--gradient-neon)',
              width: '48px',
              height: '48px',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontWeight: 800,
              fontSize: '24px',
              fontFamily: 'var(--font-display)',
              margin: '0 auto 16px auto',
              boxShadow: '0 0 20px rgba(99, 102, 241, 0.4)'
            }}>
              F
            </div>
            <h1 style={{ fontSize: '24px', fontWeight: 800, fontFamily: 'var(--font-display)', marginBottom: '6px' }}>FAPOMS</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>Field Audit Planning & Operations Management</p>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            
            {error && (
              <div style={{
                background: 'var(--status-cancelled-bg)',
                border: '1px solid rgba(239, 68, 68, 0.2)',
                color: 'var(--status-cancelled)',
                padding: '12px 16px',
                borderRadius: 'var(--radius-md)',
                fontSize: '13px',
                lineHeight: 1.4
              }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)' }}>Username or Email</label>
              <input 
                type="text"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter admin or email"
                style={{
                  padding: '12px 16px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  outline: 'none',
                  transition: 'border var(--transition-fast)'
                }}
                onFocus={(e) => e.target.style.borderColor = 'var(--accent-primary)'}
                onBlur={(e) => e.target.style.borderColor = 'var(--border-color)'}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)' }}>Password</label>
              <input 
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter password"
                style={{
                  padding: '12px 16px',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-primary)',
                  fontSize: '14px',
                  outline: 'none',
                  transition: 'border var(--transition-fast)'
                }}
                onFocus={(e) => e.target.style.borderColor = 'var(--accent-primary)'}
                onBlur={(e) => e.target.style.borderColor = 'var(--border-color)'}
              />
            </div>

            <button 
              type="submit" 
              disabled={isLoading}
              className="btn btn-primary"
              style={{
                padding: '12px',
                fontWeight: 600,
                fontSize: '15px',
                marginTop: '10px',
                width: '100%',
                display: 'block'
              }}
            >
              {isLoading ? 'Authenticating...' : 'Sign In'}
            </button>

          </form>

        </div>
      </div>
    </div>
  );
};
