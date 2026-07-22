import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Building2, 
  Users, 
  Percent, 
  AlertTriangle,
  ArrowRight,
  TrendingUp
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

interface SlaSummary {
  statusCounts: Record<string, number>;
  slaCounts: {
    COMPLIANT: number;
    BREACHED: number;
  };
}

export const Dashboard: React.FC = () => {
  const navigate = useNavigate();
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [slaSummary, setSlaSummary] = useState<SlaSummary | null>(null);
  const [projects, setProjects] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    loadAllData();
  }, []);

  const loadAllData = async () => {
    setIsLoading(true);
    try {
      const token = localStorage.getItem('fapoms_token');
      const headers = { 'Authorization': `Bearer ${token}` };

      const [metricsRes, slaRes, projectsRes] = await Promise.all([
        fetch('/api/v1/system-dashboard/metrics', { headers }),
        fetch('/api/v1/assignments/dashboard/summary', { headers }),
        fetch('/api/v1/projects', { headers })
      ]);

      const metricsData = await metricsRes.json();
      const slaData = await slaRes.json();
      const projectsData = await projectsRes.json();

      if (metricsRes.ok && metricsData.success) {
        setMetrics(metricsData.data);
      }
      if (slaRes.ok && slaData.success) {
        setSlaSummary(slaData.data);
      }
      if (projectsRes.ok && projectsData.success) {
        setProjects(projectsData.data || []);
      }
    } catch (err) {
      console.error('Failed to fetch dashboard metrics', err);
    } finally {
      setIsLoading(false);
    }
  };

  const getMetricCards = () => {
    if (!metrics) return [];
    const breachCount = slaSummary?.slaCounts?.BREACHED ?? 0;
    return [
      { name: 'Total Clients', value: String(metrics.clients), icon: Building2, change: 'Master profiles registered', color: 'var(--accent-primary)', link: '/clients' },
      { name: 'Active Users', value: String(metrics.users), icon: Users, change: 'System staff accounts', color: 'var(--accent-secondary)', link: '/users' },
      { name: 'Total Branch Audits', value: String(metrics.branches), icon: Percent, change: 'Master branch directory', color: 'var(--status-active)', link: '/branches' },
      { 
        name: 'SLA Breaches', 
        value: String(breachCount), 
        icon: AlertTriangle, 
        change: 'Overdue assignment offers', 
        color: breachCount > 0 ? '#ef4444' : 'var(--text-muted)',
        link: '/assignments'
      },
    ];
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
      
      {/* Welcome & Command Banner */}
      <div className="glass-card" style={{ 
        background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.15) 0%, rgba(6, 182, 212, 0.1) 100%)',
        border: '1px solid rgba(99, 102, 241, 0.2)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '24px 30px',
        flexWrap: 'wrap',
        gap: '16px'
      }}>
        <div>
          <h3 style={{ fontSize: '24px', fontWeight: 800, marginBottom: '6px', fontFamily: 'var(--font-display)', color: '#fff' }}>
            Operations Control Dashboard
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', margin: 0 }}>
            Unified scheduling system, assayer qualifications tracker, and geographic SLA verification workspace.
          </p>
        </div>
        <button onClick={() => navigate('/executive-map')} className="btn btn-primary" style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 18px', fontWeight: 600 }}>
          🗺️ Command Center Map <ArrowRight size={14} />
        </button>
      </div>

      {isLoading ? (
        <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--text-secondary)' }}>
          Loading live operational snapshot...
        </div>
      ) : (
        <>
          {/* Metrics Row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '24px' }}>
            {getMetricCards().map((m) => {
              const Icon = m.icon;
              return (
                <div 
                  key={m.name} 
                  className="glass-card" 
                  onClick={() => navigate(m.link)}
                  style={{ padding: '20px', display: 'flex', alignItems: 'center', gap: '20px', cursor: 'pointer', transition: 'all 0.2s' }}
                >
                  <div style={{
                    background: `rgba(255, 255, 255, 0.03)`,
                    border: `1px solid var(--border-color)`,
                    width: '52px',
                    height: '52px',
                    borderRadius: 'var(--radius-md)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: m.color
                  }}>
                    <Icon size={24} />
                  </div>
                  <div>
                    <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontWeight: 600 }}>{m.name}</span>
                    <h4 style={{ fontSize: '28px', fontWeight: 800, margin: '2px 0', color: '#fff', fontFamily: 'var(--font-display)' }}>{m.value}</h4>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{m.change}</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Main Grid Split */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1.2fr', gap: '24px' }}>
            
            {/* Active Projects Operational Progress */}
            <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h4 style={{ fontSize: '18px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <TrendingUp size={18} style={{ color: 'var(--accent-primary)' }} /> Live Audit Portfolios
                  </h4>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Real-time field completions and compliance tracking.</span>
                </div>
                <button onClick={loadAllData} className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px' }}>
                  Sync Data
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginTop: '6px' }}>
                {projects.slice(0, 5).map((p) => {
                  const total = p.branches?.length || 0;
                  const completed = p.branches?.filter((b: any) => b.status === 'CLOSED' || b.status === 'AUDIT_COMPLETED').length || 0;
                  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
                  return (
                    <div key={p.id} style={{ padding: '14px', background: 'rgba(255,255,255,0.01)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                        <div>
                          <span style={{ fontWeight: 700, fontSize: '13px', color: '#fff' }}>{p.name}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '11px', marginLeft: '8px', fontFamily: 'monospace' }}>({p.projectNumber})</span>
                        </div>
                        <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--accent-secondary)' }}>{pct}% Complete</span>
                      </div>
                      
                      {/* Custom visual progress bar */}
                      <div style={{ width: '100%', height: '6px', background: 'var(--bg-primary)', borderRadius: '3px', overflow: 'hidden', marginBottom: '8px' }}>
                        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--gradient-neon)', borderRadius: '3px', transition: 'width 0.3s' }} />
                      </div>

                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-muted)' }}>
                        <span>Completed Sites: <b>{completed} / {total}</b></span>
                        <span>Client: <b>{p.client?.name || 'N/A'}</b></span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* SLA Risk Breakdown & Activities */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
              
              {/* SLA statistics widget */}
              <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <h4 style={{ fontSize: '16px', fontWeight: 700 }}>SLA Compliance</h4>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div style={{ padding: '14px', background: 'rgba(16,185,129,0.04)', border: '1px solid rgba(16,185,129,0.15)', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>COMPLIANT</span>
                    <b style={{ fontSize: '20px', color: '#10b981' }}>{slaSummary?.slaCounts?.COMPLIANT ?? 0}</b>
                  </div>
                  <div style={{ padding: '14px', background: 'rgba(239,68,68,0.04)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: 'var(--radius-md)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600 }}>OVERDUE / RISK</span>
                    <b style={{ fontSize: '20px', color: '#ef4444' }}>{slaSummary?.slaCounts?.BREACHED ?? 0}</b>
                  </div>
                </div>
              </div>

              {/* Recent Actions Feed */}
              <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '16px', flex: 1 }}>
                <h4 style={{ fontSize: '16px', fontWeight: 700 }}>Operations Feed</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxHeight: '240px', overflowY: 'auto' }}>
                  {metrics?.activities && metrics.activities.length > 0 ? (
                    metrics.activities.slice(0, 6).map((act) => (
                      <div key={act.id} style={{ display: 'flex', gap: '12px', fontSize: '12px' }}>
                        <div style={{
                          marginTop: '4px',
                          width: '6px',
                          height: '6px',
                          borderRadius: '50%',
                          background: 'var(--accent-secondary)',
                          boxShadow: '0 0 6px var(--accent-secondary)',
                          flexShrink: 0
                        }} />
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                          <span style={{ fontWeight: 700, color: '#fff' }}>{act.action.replace(/_/g, ' ')}</span>
                          <span style={{ color: 'var(--text-secondary)', fontSize: '11px' }}>{act.detail}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: '9px' }}>{new Date(act.occurredAt).toLocaleTimeString()}</span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '20px 0' }}>No recent history.</div>
                  )}
                </div>
              </div>

            </div>

          </div>
        </>
      )}

    </div>
  );
};
