import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Plus, Trash2, Shield } from 'lucide-react';

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

  // Form states
  const [name, setName] = useState('');
  const [scope, setScope] = useState('GLOBAL');
  const [targetId, setTargetId] = useState('');
  const [ruleType, setRuleType] = useState('SKILL');
  const [conditionKey, setConditionKey] = useState('requiredSkill');
  const [conditionValue, setConditionValue] = useState('');

  useEffect(() => {
    fetchRules();
  }, []);

  const fetchRules = async () => {
    setLoading(true);
    try {
      const res = await api.request<{ success: boolean; data: BusinessRule[] }>('/planning/rules');
      if (res && res.data) {
        setRules(res.data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleCreateRule = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.request('/planning/rules', {
        method: 'POST',
        body: JSON.stringify({
          name,
          scope,
          targetId: targetId || undefined,
          ruleType,
          conditions: { [conditionKey]: conditionValue },
        }),
      });
      setShowModal(false);
      setName('');
      setConditionValue('');
      fetchRules();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to create business rule');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteRule = async (id: string) => {
    if (!confirm('Are you sure you want to delete this rule?')) return;
    try {
      await api.request(`/planning/rules/${id}`, { method: 'DELETE' });
      fetchRules();
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to delete rule');
    }
  };

  return (
    <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0 }}>Business Rule Engine</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px', marginTop: '4px' }}>
            Configure candidate eligibility filters and soft constraint scoring rules.
          </p>
        </div>
        <button
          onClick={() => setShowModal(true)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            background: 'var(--gradient-neon)',
            border: 'none',
            color: '#fff',
            padding: '10px 18px',
            borderRadius: 'var(--radius-md)',
            fontWeight: 600,
            cursor: 'pointer',
            boxShadow: 'var(--shadow-neon)',
          }}
        >
          <Plus size={16} /> Create Rule
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '20px' }}>
        {loading ? (
          <div>Loading business rules...</div>
        ) : rules.length === 0 ? (
          <div style={{ gridColumn: '1 / -1', padding: '40px', textAlign: 'center', background: 'var(--bg-card)', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-lg)', color: 'var(--text-muted)' }}>
            No rules configured. Eligibility filters will fallback to standard constraints.
          </div>
        ) : (
          rules.map((rule) => (
            <div
              key={rule.id}
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border-color)',
                borderRadius: 'var(--radius-lg)',
                padding: '20px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: '16px',
              }}
            >
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <Shield size={18} className="text-indigo" />
                    <span style={{ fontWeight: 600, fontSize: '15px' }}>{rule.name}</span>
                  </div>
                  <button
                    onClick={() => handleDeleteRule(rule.id)}
                    style={{ background: 'transparent', border: 'none', color: 'var(--red-primary)', cursor: 'pointer' }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
                <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '11px', background: 'rgba(255,255,255,0.05)', padding: '4px 8px', borderRadius: 'var(--radius-sm)' }}>
                    Scope: {rule.scope}
                  </span>
                  <span style={{ fontSize: '11px', background: 'rgba(99, 102, 241, 0.15)', color: 'var(--accent-primary)', padding: '4px 8px', borderRadius: 'var(--radius-sm)' }}>
                    Type: {rule.ruleType}
                  </span>
                </div>
              </div>

              <div style={{ background: 'rgba(0,0,0,0.15)', borderRadius: 'var(--radius-md)', padding: '12px', fontSize: '13px' }}>
                <div style={{ fontWeight: 600, color: 'var(--text-muted)', fontSize: '11px', textTransform: 'uppercase', marginBottom: '4px' }}>Conditions</div>
                <pre style={{ margin: 0, fontFamily: 'monospace', fontSize: '12px', overflowX: 'auto' }}>
                  {JSON.stringify(rule.conditions, null, 2)}
                </pre>
              </div>
            </div>
          ))
        )}
      </div>

      {showModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-lg)', width: '500px', padding: '24px', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.3)' }}>
            <h3 style={{ fontSize: '18px', fontWeight: 600, marginBottom: '20px' }}>Create Business Rule</h3>
            <form onSubmit={handleCreateRule}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '20px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Rule Name</label>
                  <input type="text" style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff' }} value={name} onChange={(e) => setName(e.target.value)} required placeholder="e.g. Require Gold Assayer Certification" />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Scope</label>
                  <select style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff' }} value={scope} onChange={(e) => setScope(e.target.value)}>
                    <option value="GLOBAL">GLOBAL</option>
                    <option value="CLIENT">CLIENT</option>
                    <option value="BRANCH">BRANCH</option>
                  </select>
                </div>
                {scope !== 'GLOBAL' && (
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Target ID (UUID)</label>
                    <input type="text" style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff' }} value={targetId} onChange={(e) => setTargetId(e.target.value)} required placeholder="Target client or branch ID" />
                  </div>
                )}
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Rule Type</label>
                  <select style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff' }} value={ruleType} onChange={(e) => {
                    setRuleType(e.target.value);
                    if (e.target.value === 'SKILL') setConditionKey('requiredSkill');
                    if (e.target.value === 'CERTIFICATION') setConditionKey('requiredCertification');
                  }}>
                    <option value="SKILL">Required Skill</option>
                    <option value="CERTIFICATION">Required Certification</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '6px' }}>Required Value</label>
                  <input type="text" style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-page)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)', color: '#fff' }} value={conditionValue} onChange={(e) => setConditionValue(e.target.value)} required placeholder="e.g. Gold Assaying, NABL Certified" />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '12px' }}>
                <button type="button" onClick={() => setShowModal(false)} style={{ background: 'transparent', border: '1px solid var(--border-color)', color: 'var(--text-muted)', padding: '8px 16px', borderRadius: 'var(--radius-md)', fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                <button type="submit" disabled={submitting} style={{ background: 'var(--gradient-neon)', border: 'none', color: '#fff', padding: '8px 16px', borderRadius: 'var(--radius-md)', fontWeight: 600, cursor: 'pointer', boxShadow: 'var(--shadow-neon)' }}>{submitting ? 'Creating...' : 'Create'}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
