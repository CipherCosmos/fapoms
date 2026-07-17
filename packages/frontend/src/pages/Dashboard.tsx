import React from 'react';
import { 
  Building2, 
  Users, 
  Percent, 
  ArrowUpRight, 
  Clock 
} from 'lucide-react';

export const Dashboard: React.FC = () => {
  // Mock metrics and statistics for Phase 1 visualization
  const metrics = [
    { name: 'Total Branch Audits', value: '142', icon: Building2, change: '+12% this month', color: 'var(--accent-primary)' },
    { name: 'Active Assayers', value: '28', icon: Users, change: '3 on standby', color: 'var(--accent-secondary)' },
    { name: 'Overall Coverage', value: '91.5%', icon: Percent, change: 'Goal: 95%', color: 'var(--status-active)' },
    { name: 'Pending Assignments', value: '12', icon: Clock, change: 'Action required', color: 'var(--status-pending)' },
  ];

  const recentProjects = [
    { id: '1', name: 'Axis Bank July Cycle', branches: 45, coverage: 95.5, status: 'EXECUTION' },
    { id: '2', name: 'ICICI Bank West Zone', branches: 60, coverage: 90.0, status: 'SCHEDULING' },
    { id: '3', name: 'RBL Rural Coverage', branches: 37, coverage: 86.4, status: 'PLANNING' },
  ];

  const recentActivities = [
    { id: '1', action: 'Assignment accepted', detail: 'Assayer Nilesh R. accepted Axis Pune Branch', time: '10 mins ago', type: 'success' },
    { id: '2', action: 'Schedule proposed', detail: 'Axis Mumbai Scheduled for 2026-07-20', time: '45 mins ago', type: 'info' },
    { id: '3', action: 'Negotiation logged', detail: 'Assayer Pooja K. requested fee adjust (+10%)', time: '2 hours ago', type: 'warning' },
  ];

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

      {/* Metrics Row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '24px' }}>
        {metrics.map((m) => {
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
        
        {/* Projects Table panel */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h4 style={{ fontSize: '18px', fontWeight: 600 }}>Active Projects</h4>
            <button className="btn btn-secondary" style={{ padding: '6px 12px', fontSize: '12px' }}>
              View All <ArrowUpRight size={14} />
            </button>
          </div>
          
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Project Name</th>
                  <th>Branches</th>
                  <th>Coverage</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {recentProjects.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 600 }}>{p.name}</td>
                    <td>{p.branches}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div style={{ flex: 1, width: '60px', height: '6px', background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                          <div style={{ width: `${p.coverage}%`, height: '100%', background: 'var(--status-active)' }} />
                        </div>
                        <span style={{ fontSize: '12px', fontWeight: 600 }}>{p.coverage}%</span>
                      </div>
                    </td>
                    <td>
                      <span className="badge" style={{
                        background: p.status === 'EXECUTION' ? 'var(--status-completed-bg)' : 'var(--status-pending-bg)',
                        color: p.status === 'EXECUTION' ? 'var(--status-completed)' : 'var(--status-pending)',
                      }}>
                        {p.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Recent Activities Timeline Panel */}
        <div className="glass-card" style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          <h4 style={{ fontSize: '18px', fontWeight: 600 }}>Recent Activities</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {recentActivities.map((act) => (
              <div key={act.id} style={{ display: 'flex', gap: '14px' }}>
                <div style={{
                  marginTop: '4px',
                  width: '8px',
                  height: '8px',
                  borderRadius: 'var(--radius-full)',
                  background: act.type === 'success' ? 'var(--status-active)' : act.type === 'warning' ? 'var(--status-pending)' : 'var(--status-completed)',
                  boxShadow: `0 0 8px ${act.type === 'success' ? 'var(--status-active)' : act.type === 'warning' ? 'var(--status-pending)' : 'var(--status-completed)'}`
                }} />
                <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>{act.action}</span>
                  <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{act.detail}</span>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{act.time}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

      </div>

    </div>
  );
};
