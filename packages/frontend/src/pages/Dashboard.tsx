import React, { useState, useEffect } from 'react';
import { 
  Building2, 
  Users, 
  Percent, 
  ArrowUpRight, 
  Clock 
} from 'lucide-react';

interface DashboardMetrics {
  clients: number;
  projects: number;
  activeProjects: number;
  branches: number;
  activeBranches: number;
  users: number;
  activities: Array<{
    id: string;
    action: string;
    detail: string;
    occurredAt: string;
  }>;
}

export const Dashboard: React.FC = () => {
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadMetrics();
  }, []);

  const loadMetrics = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/v1/system-dashboard/metrics', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('fapoms_token')}`
        }
      });
      const resData = await response.json();
      if (response.ok && resData.success) {
        setMetrics(resData.data);
      }
    } catch (err) {
      console.error('Failed to fetch dashboard metrics');
    } finally {
      setIsLoading(false);
    }
  };

  const getMetricCards = () => {
    if (!metrics) return [];
    return [
      { name: 'Total Clients', value: String(metrics.clients), icon: Building2, change: 'Master profiles registered', color: 'var(--accent-primary)' },
      { name: 'Active Users', value: String(metrics.users), icon: Users, change: 'System staff accounts', color: 'var(--accent-secondary)' },
      { name: 'Total Branch Audits', value: String(metrics.branches), icon: Percent, change: 'Master branch directory', color: 'var(--status-active)' },
      { name: 'Active Project Allocations', value: String(metrics.activeBranches), icon: Clock, change: 'Confirmed branch queue links', color: 'var(--status-pending)' },
    ];
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
      
      {/* Welcome Banner */}
      <div className="glass-card" style={{ 
        background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(6, 182, 212, 0.1) 100%)',
        border: '1px solid rgba(99, 102, 241, 0.2)'
      }}>
        <h3 style={{ fontSize: '24px', fontWeight: 700, marginBottom: '6px', fontFamily: 'var(--font-display)' }}>
          Welcome back, Admin
        </h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>
          Here is your operational snapshot for today. The Axis Bank planning workspace is active.
        </p>
      </div>

      {isLoading ? (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-secondary)' }}>
          Loading dashboard metrics...
        </div>
      ) : (
        <>
          {/* Metrics Row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '24px' }}>
            {getMetricCards().map((m) => {
              const Icon = m.icon;
              return (
                <div key={m.name} className="glass-card" style={{ padding: '20px', display: 'flex', alignItems: 'center', gap: '20px' }}>
                  <div style={{
                    background: `rgba(255, 255, 255, 0.03)`,
                    border: `1px solid var(--border-color)`,
                    width: '48px',
                    height: '48px',
                    borderRadius: 'var(--radius-md)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: m.color
                  }}>
                    <Icon size={24} />
                  </div>
                  <div>
                    <span style={{ fontSize: '13px', color: 'var(--text-secondary)', fontWeight: 500 }}>{m.name}</span>
                    <h4 style={{ fontSize: '28px', fontWeight: 800, margin: '2px 0', color: '#fff', fontFamily: 'var(--font-display)' }}>{m.value}</h4>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{m.change}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Main Grid split */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '32px' }}>
            
            {/* Projects Overview panel */}
            <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h4 style={{ fontSize: '18px', fontWeight: 600 }}>Active Projects Summary</h4>
                <button onClick={loadMetrics} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px' }}>
                  Refresh <ArrowUpRight size={14} />
                </button>
              </div>
              
              <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                Total Active Projects: <b>{metrics?.projects}</b> | Target Branches: <b>{metrics?.branches}</b>
              </div>
            </div>

            {/* Recent Activities Timeline Panel */}
            <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <h4 style={{ fontSize: '18px', fontWeight: 600 }}>Recent Activities</h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                {metrics?.activities && metrics.activities.length > 0 ? (
                  metrics.activities.map((act) => (
                    <div key={act.id} style={{ display: 'flex', gap: '14px' }}>
                      <div style={{
                        marginTop: '4px',
                        width: '8px',
                        height: '8px',
                        borderRadius: 'var(--radius-full)',
                        background: 'var(--status-active)',
                        boxShadow: '0 0 8px var(--status-active)'
                      }} />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{act.action}</span>
                        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{act.detail}</span>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{new Date(act.occurredAt).toLocaleTimeString()}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-muted)' }}>
                    No recent operational activities recorded.
                  </div>
                )}
              </div>
            </div>

          </div>
        </>
      )}

    </div>
  );
};
