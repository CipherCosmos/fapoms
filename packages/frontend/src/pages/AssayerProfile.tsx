import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import {
  ArrowLeft, Star, Briefcase, MapPin, Phone, Mail, Award, CheckCircle, XCircle,
  Clock, DollarSign, Calendar, TrendingUp
} from 'lucide-react';

interface AssayerProfile {
  id: string;
  assayerCode: string;
  displayName: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string;
  address: string;
  state: string;
  district: string;
  city: string;
  pincode: string | null;
  status: string;
  lifecycleStatus: string;
  employmentType: string;
  joiningDate: string | null;
  department: string | null;
  region: string | null;
  skills: string[] | null;
  certifications: { name: string; expiryDate: string }[] | null;
  languages: string[] | null;
  specializations: string[] | null;
  experienceYears: number;
  performanceRating: number;
  totalAssignments: number;
  completedAssignments: number;
  cancelledAssignments: number;
  onTimeCompletions: number;
  totalEarnings: number;
  lastAssignmentDate: string | null;
  averageRating: number;
  notes: string | null;
}

interface Remark {
  id: string;
  content: string;
  category: string;
  visibility: string;
  authorName: string;
  rating: number | null;
  createdAt: string;
}

const CATEGORY_COLORS: Record<string, string> = {
  PERFORMANCE: '#8b5cf6',
  QUALITY: '#3b82f6',
  BEHAVIORAL: '#f59e0b',
  TRAINING: '#10b981',
  GENERAL: '#6b7280',
};

export const AssayerProfile: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [assayer, setAssayer] = useState<AssayerProfile | null>(null);
  const [remarks, setRemarks] = useState<Remark[]>([]);
  const [loading, setLoading] = useState(true);
  const [remarkText, setRemarkText] = useState('');
  const [remarkCategory, setRemarkCategory] = useState('GENERAL');
  const [remarkRating, setRemarkRating] = useState<number>(0);
  const [submittingRemark, setSubmittingRemark] = useState(false);

  useEffect(() => {
    if (id) {
      Promise.all([
        api.request<AssayerProfile>(`/assayers/${id}/profile`, { method: 'GET' }),
        api.request<Remark[]>(`/assayers/${id}/remark`, { method: 'GET' }),
      ]).then(([profileData, remarksData]) => {
        setAssayer(profileData);
        setRemarks(Array.isArray(remarksData) ? remarksData : []);
      }).catch(() => {
        navigate('/assayers');
      }).finally(() => setLoading(false));
    }
  }, [id]);

  const handleAddRemark = async () => {
    if (!remarkText.trim() || !id) return;
    setSubmittingRemark(true);
    try {
      const newRemark = await api.request<Remark>(`/assayers/${id}/remark`, {
        method: 'POST',
        body: JSON.stringify({
          content: remarkText,
          category: remarkCategory,
          visibility: 'PUBLIC',
          rating: remarkRating > 0 ? remarkRating : undefined,
        }),
      });
      setRemarks(prev => [newRemark, ...prev]);
      setRemarkText('');
      setRemarkRating(0);
      // Refresh assayer data to get updated average rating
      const updated = await api.request<AssayerProfile>(`/assayers/${id}/profile`, { method: 'GET' });
      setAssayer(updated);
    } catch { /* ignore */ }
    finally { setSubmittingRemark(false); }
  };

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        <div style={{ color: 'var(--text-muted)' }}>Loading assayer profile...</div>
      </div>
    );
  }

  if (!assayer) {
    return <div style={{ padding: '32px', color: 'var(--text-muted)' }}>Assayer not found.</div>;
  }

  const completionRate = assayer.totalAssignments > 0
    ? Math.round((assayer.completedAssignments / assayer.totalAssignments) * 100) : 0;
  const onTimeRate = assayer.completedAssignments > 0
    ? Math.round((assayer.onTimeCompletions / assayer.completedAssignments) * 100) : 0;

  return (
    <div style={{ padding: '24px 32px', maxWidth: '1200px', margin: '0 auto' }}>
      {/* Back button */}
      <button onClick={() => navigate('/assayers')} className="btn btn-secondary"
        style={{ padding: '6px 12px', fontSize: '12px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '6px' }}>
        <ArrowLeft size={14} /> Back to Assayers
      </button>

      {/* Header Card */}
      <div className="glass-card" style={{ padding: '24px', borderRadius: 'var(--radius-md)', marginBottom: '20px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ width: '56px', height: '56px', borderRadius: '50%', background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-secondary))', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: '22px', fontWeight: 700 }}>
              {assayer.displayName.charAt(0).toUpperCase()}
            </div>
            <div>
              <h1 style={{ fontSize: '22px', fontWeight: 700, margin: 0 }}>{assayer.displayName}</h1>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{assayer.assayerCode}</span>
                <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: 'var(--text-muted)' }} />
                <span style={{ fontSize: '12px', padding: '2px 8px', borderRadius: '10px', background: assayer.lifecycleStatus === 'ACTIVE' ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.1)', color: assayer.lifecycleStatus === 'ACTIVE' ? 'var(--status-active)' : '#f59e0b', fontWeight: 500 }}>{assayer.lifecycleStatus}</span>
                <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: 'var(--text-muted)' }} />
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Briefcase size={12} /> {assayer.employmentType}
                </span>
                <span style={{ width: '4px', height: '4px', borderRadius: '50%', background: 'var(--text-muted)' }} />
                <span style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <Star size={12} /> {assayer.experienceYears} yrs exp
                </span>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '28px', fontWeight: 700, color: assayer.averageRating >= 4 ? 'var(--status-active)' : assayer.averageRating >= 3 ? '#f59e0b' : '#ef4444' }}>
                {assayer.averageRating > 0 ? assayer.averageRating.toFixed(1) : '—'}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Avg Rating</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '28px', fontWeight: 700, color: 'var(--accent-primary)' }}>
                {assayer.performanceRating.toFixed(1)}
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>Perf. Rating</div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '16px', paddingTop: '16px', borderTop: '1px solid var(--border-color)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
            <MapPin size={13} /> {assayer.city}, {assayer.state}
          </div>
          {assayer.phone && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
              <Phone size={13} /> {assayer.phone}
            </div>
          )}
          {assayer.email && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
              <Mail size={13} /> {assayer.email}
            </div>
          )}
          {assayer.department && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
              <Briefcase size={13} /> {assayer.department}
            </div>
          )}
          {assayer.region && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--text-secondary)' }}>
              <MapPin size={13} /> Region: {assayer.region}
            </div>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: '12px', marginBottom: '20px' }}>
        <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Briefcase size={11} /> Total Assignments
          </div>
          <div style={{ fontSize: '26px', fontWeight: 700, color: 'var(--accent-primary)' }}>{assayer.totalAssignments}</div>
        </div>
        <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <CheckCircle size={11} /> Completed
          </div>
          <div style={{ fontSize: '26px', fontWeight: 700, color: 'var(--status-active)' }}>{assayer.completedAssignments}</div>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{completionRate}% completion rate</div>
        </div>
        <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Clock size={11} /> On-Time
          </div>
          <div style={{ fontSize: '26px', fontWeight: 700, color: '#3b82f6' }}>{onTimeRate}%</div>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '2px' }}>{assayer.onTimeCompletions} jobs on time</div>
        </div>
        <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <XCircle size={11} /> Cancelled
          </div>
          <div style={{ fontSize: '26px', fontWeight: 700, color: '#ef4444' }}>{assayer.cancelledAssignments}</div>
        </div>
        <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <DollarSign size={11} /> Total Earnings
          </div>
          <div style={{ fontSize: '26px', fontWeight: 700, color: '#f59e0b' }}>₹{Number(assayer.totalEarnings).toLocaleString()}</div>
        </div>
        <div className="glass-card" style={{ padding: '14px', borderRadius: 'var(--radius-md)' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Calendar size={11} /> Last Assignment
          </div>
          <div style={{ fontSize: '13px', fontWeight: 600, color: '#fff' }}>
            {assayer.lastAssignmentDate ? new Date(assayer.lastAssignmentDate).toLocaleDateString() : '—'}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        {/* Left Column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Skills & Certifications */}
          <div className="glass-card" style={{ padding: '16px', borderRadius: 'var(--radius-md)' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Award size={15} /> Skills & Certifications
            </h3>
            <div style={{ marginBottom: '12px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '6px' }}>SKILLS</div>
              {assayer.skills && assayer.skills.length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {assayer.skills.map(s => (
                    <span key={s} style={{ padding: '3px 8px', background: 'rgba(99,102,241,0.1)', color: 'var(--accent-primary)', borderRadius: '10px', fontSize: '11px' }}>{s}</span>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No skills recorded</div>
              )}
            </div>
            <div>
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '6px' }}>CERTIFICATIONS</div>
              {assayer.certifications && assayer.certifications.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {assayer.certifications.map(c => (
                    <div key={c.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 8px', background: 'rgba(16,185,129,0.05)', borderRadius: 'var(--radius-sm)' }}>
                      <span style={{ fontSize: '12px', color: '#fff' }}>{c.name}</span>
                      <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>Exp: {new Date(c.expiryDate).toLocaleDateString()}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No certifications recorded</div>
              )}
            </div>
          </div>

          {/* Strengths & Weaknesses */}
          <div className="glass-card" style={{ padding: '16px', borderRadius: 'var(--radius-md)' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <TrendingUp size={15} /> Performance Insights
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>COMPLETION RATE</div>
                <div style={{ height: '8px', background: 'var(--bg-primary)', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${completionRate}%`, background: completionRate >= 80 ? 'var(--status-active)' : completionRate >= 50 ? '#f59e0b' : '#ef4444', borderRadius: '4px', transition: 'width 0.3s' }} />
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>{completionRate}%</div>
              </div>
              <div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>ON-TIME DELIVERY</div>
                <div style={{ height: '8px', background: 'var(--bg-primary)', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', width: `${onTimeRate}%`, background: onTimeRate >= 80 ? 'var(--status-active)' : onTimeRate >= 50 ? '#f59e0b' : '#ef4444', borderRadius: '4px', transition: 'width 0.3s' }} />
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>{onTimeRate}%</div>
              </div>
              {assayer.totalEarnings > 0 && (
                <div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>AVERAGE EARNINGS PER JOB</div>
                  <div style={{ fontSize: '16px', fontWeight: 600, color: '#f59e0b' }}>
                    ₹{Math.round(Number(assayer.totalEarnings) / Math.max(assayer.completedAssignments, 1)).toLocaleString()}
                  </div>
                </div>
              )}
              {assayer.experienceYears > 0 && (
                <div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 600, marginBottom: '4px' }}>EXPERIENCE</div>
                  <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>{assayer.experienceYears} years</div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {/* Reviews & Remarks */}
          <div className="glass-card" style={{ padding: '16px', borderRadius: 'var(--radius-md)' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 600, margin: '0 0 12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Star size={15} /> Reviews & Remarks
            </h3>

            {/* Add remark form */}
            <div style={{ marginBottom: '16px', padding: '12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)' }}>
              <textarea value={remarkText} onChange={e => setRemarkText(e.target.value)} placeholder="Add a remark or review..."
                style={{ width: '100%', minHeight: '60px', padding: '8px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: '12px', outline: 'none', resize: 'vertical' }} />
              <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={remarkCategory} onChange={e => setRemarkCategory(e.target.value)}
                  style={{ padding: '4px 8px', background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: '11px', outline: 'none' }}>
                  <option value="GENERAL">General</option>
                  <option value="PERFORMANCE">Performance</option>
                  <option value="QUALITY">Quality</option>
                  <option value="BEHAVIORAL">Behavioral</option>
                  <option value="TRAINING">Training</option>
                </select>
                <div style={{ display: 'flex', gap: '2px', alignItems: 'center' }}>
                  {[1, 2, 3, 4, 5].map(r => (
                    <button key={r} onClick={() => setRemarkRating(remarkRating === r ? 0 : r)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '2px', color: r <= remarkRating ? '#f59e0b' : 'var(--text-muted)' }}>
                      <Star size={14} fill={r <= remarkRating ? '#f59e0b' : 'none'} />
                    </button>
                  ))}
                </div>
                <button onClick={handleAddRemark} disabled={!remarkText.trim() || submittingRemark}
                  className="btn btn-primary" style={{ marginLeft: 'auto', padding: '4px 10px', fontSize: '11px' }}>
                  {submittingRemark ? 'Saving...' : 'Add Remark'}
                </button>
              </div>
            </div>

            {/* Remarks list */}
            {remarks.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '16px', color: 'var(--text-muted)', fontSize: '12px' }}>No remarks yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '400px', overflowY: 'auto' }}>
                {remarks.map(r => (
                  <div key={r.id} style={{ padding: '10px 12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', borderLeft: `3px solid ${CATEGORY_COLORS[r.category] || '#6b7280'}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '4px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '10px', padding: '1px 6px', borderRadius: '4px', background: `${CATEGORY_COLORS[r.category] || '#6b7280'}20`, color: CATEGORY_COLORS[r.category] || '#6b7280', fontWeight: 600 }}>{r.category}</span>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>by {r.authorName}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                        {r.rating != null && [1, 2, 3, 4, 5].map(s => (
                          <Star key={s} size={10} fill={s <= r.rating! ? '#f59e0b' : 'none'} color={s <= r.rating! ? '#f59e0b' : 'var(--text-muted)'} />
                        ))}
                      </div>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>{r.content}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>{new Date(r.createdAt).toLocaleString()}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
