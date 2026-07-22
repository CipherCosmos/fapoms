import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Plus, Trash2, Shield, Search, Sliders } from 'lucide-react';

interface BusinessRule {
  id: string;
  name: string;
  scope: string;
  ruleType: string;
  conditions: Record<string, any>;
  actions: Record<string, any> | null;
}

export const Rules: React.FC = () => {
  const [rules, setRules] = useState<BusinessRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');

  const [name, setName] = useState('');
  const [scope, setScope] = useState('GLOBAL');
  const [targetId, setTargetId] = useState('');
  const [ruleType, setRuleType] = useState('SKILL');
  const [conditionKey, setConditionKey] = useState('requiredSkill');
  const [conditionValue, setConditionValue] = useState('');

  useEffect(() => { fetchRules(); }, []);

  const fetchRules = async () => {
    setLoading(true);
    try { const data = await api.request<BusinessRule[]>('/planning/rules'); if (data) setRules(data); }
    catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  const handleCreateRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.request('/planning/rules', { method: 'POST', body: JSON.stringify({ name, scope, targetId: targetId || undefined, ruleType, conditions: { [conditionKey]: conditionValue } }) });
      setShowModal(false); setName(''); setConditionValue(''); fetchRules();
    } catch (e) { alert(e instanceof Error ? e.message : 'Failed to create business rule'); }
    finally { setSubmitting(false); }
  };

  const handleDeleteRule = async (id: string) => {
    if (!confirm('Delete this rule?')) return;
    try { await api.request(`/planning/rules/${id}`, { method: 'DELETE' }); fetchRules(); }
    catch (e) { alert(e instanceof Error ? e.message : 'Failed to delete rule'); }
  };

  const filtered = rules.filter(r =>
    r.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    r.scope.toLowerCase().includes(searchTerm.toLowerCase()) ||
    r.ruleType.toLowerCase().includes(searchTerm.toLowerCase())
  );
  const globalCount = rules.filter(r => r.scope === 'GLOBAL').length;
  const skillCount = rules.filter(r => r.ruleType === 'SKILL').length;
  const certCount = rules.filter(r => r.ruleType === 'CERTIFICATION').length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: '24px', fontWeight: 700, fontFamily: 'var(--font-display)' }}>Business Rule Engine</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '14px', marginTop: '4px' }}>Configure candidate eligibility filters and scoring rules</p>
        </div>
        <button onClick={() => setShowModal(true)}
          style={{ display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--gradient-neon)', border: 'none', color: '#fff', padding: '10px 18px', borderRadius: 'var(--radius-md)', fontWeight: 600, cursor: 'pointer', boxShadow: 'var(--shadow-neon)' }}>
          <Plus size={16} /> Create Rule
        </button>
      </div>

      {/* KPI Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' }}>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(99,102,241,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Sliders size={20} style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{rules.length}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Total Rules</div></div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(99,102,241,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Shield size={20} style={{ color: 'var(--accent-primary)' }} />
          </div>
          <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{globalCount}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Global</div></div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(16,185,129,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Shield size={20} style={{ color: 'var(--status-active)' }} />
          </div>
          <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{skillCount}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Skill Rules</div></div>
        </div>
        <div className="glass-card" style={{ padding: '16px', display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{ width: '40px', height: '40px', borderRadius: 'var(--radius-md)', background: 'rgba(139,92,246,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Shield size={20} style={{ color: '#8b5cf6' }} />
          </div>
          <div><div style={{ fontSize: '22px', fontWeight: 800, fontFamily: 'var(--font-display)' }}>{certCount}</div><div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Certification Rules</div></div>
        </div>
      </div>

      {/* Search */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <div style={{ flex: 1, maxWidth: '320px', position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: '10px', top: '8px', color: 'var(--text-muted)' }} />
          <input type="text" placeholder="Search rules..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)}
            style={{ width: '100%', padding: '7px 10px 7px 30px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none', fontSize: '13px' }} />
        </div>
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{filtered.length} rules</span>
      </div>

      {/* Rules Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '16px' }}>
        {loading ? (
          <div style={{ gridColumn: '1 / -1', padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ gridColumn: '1 / -1', padding: '60px 20px', textAlign: 'center', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-lg)', color: 'var(--text-muted)' }}>
            <Sliders size={40} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
            <p>{searchTerm ? 'No rules match your search.' : 'No rules configured. Create one to define eligibility filters.'}</p>
          </div>
        ) : (
          filtered.map(rule => (
            <div key={rule.id} className="glass-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <Shield size={18} style={{ color: 'var(--accent-primary)' }} />
                  <span style={{ fontWeight: 600, fontSize: '15px' }}>{rule.name}</span>
                </div>
                <button onClick={() => handleDeleteRule(rule.id)}
                  style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '4px' }}>
                  <Trash2 size={14} />
                </button>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '11px', padding: '3px 8px', borderRadius: 'var(--radius-sm)', background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}>
                  Scope: {rule.scope}
                </span>
                <span style={{ fontSize: '11px', padding: '3px 8px', borderRadius: 'var(--radius-sm)', background: 'rgba(99,102,241,0.1)', color: 'var(--accent-primary)' }}>
                  {rule.ruleType}
                </span>
              </div>
              <div style={{ padding: '12px', background: 'rgba(0,0,0,0.15)', borderRadius: 'var(--radius-md)', fontSize: '12px' }}>
                <div style={{ fontWeight: 600, color: 'var(--text-muted)', fontSize: '10px', textTransform: 'uppercase', marginBottom: '4px', letterSpacing: '0.5px' }}>Conditions</div>
                <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: '11px', overflowX: 'auto', color: 'var(--text-secondary)' }}>
                  {JSON.stringify(rule.conditions, null, 2)}
                </pre>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Create Modal */}
      {showModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="glass-card" style={{ width: '500px', padding: '24px' }}>
            <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '20px' }}>Create Business Rule</h3>
            <form onSubmit={handleCreateRule}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '20px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Rule Name</label>
                  <input type="text" value={name} onChange={e => setName(e.target.value)} required placeholder="e.g. Require Gold Assayer Certification"
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Scope</label>
                  <select value={scope} onChange={e => setScope(e.target.value)}
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}>
                    <option value="GLOBAL">Global</option>
                    <option value="CLIENT">Client</option>
                    <option value="BRANCH">Branch</option>
                  </select>
                </div>
                {scope !== 'GLOBAL' && (
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Target ID</label>
                    <input type="text" value={targetId} onChange={e => setTargetId(e.target.value)} required placeholder="Client or branch UUID"
                      style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
                  </div>
                )}
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Rule Type</label>
                  <select value={ruleType} onChange={e => { setRuleType(e.target.value); setConditionKey(e.target.value === 'SKILL' ? 'requiredSkill' : 'requiredCertification'); }}
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }}>
                    <option value="SKILL">Required Skill</option>
                    <option value="CERTIFICATION">Required Certification</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Required Value</label>
                  <input type="text" value={conditionValue} onChange={e => setConditionValue(e.target.value)} required placeholder="e.g. Gold Assaying"
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px', borderTop: '1px solid var(--border-color)', paddingTop: '16px' }}>
                <button type="button" onClick={() => setShowModal(false)} className="btn btn-secondary">Cancel</button>
                <button type="submit" disabled={submitting} className="btn btn-primary">{submitting ? 'Creating...' : 'Create Rule'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
