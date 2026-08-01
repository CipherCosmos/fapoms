import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { Trash2, Shield, Sliders } from 'lucide-react';
import { StatusBadge, Modal, SearchInput, FilterSelect, PrimaryButton } from '../components/ui';

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
        <PrimaryButton onClick={() => setShowModal(true)}>Create Rule</PrimaryButton>
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
        <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search rules..." style={{ maxWidth: '320px' }} />
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
                <StatusBadge label={`Scope: ${rule.scope}`} bg="rgba(255,255,255,0.05)" color="var(--text-secondary)" />
                <StatusBadge label={rule.ruleType} bg="rgba(99,102,241,0.1)" color="var(--accent-primary)" />
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
        <Modal open onClose={() => setShowModal(false)} title="Create Business Rule" width="500px" asForm onSubmit={handleCreateRule}
          footer={
            <>
              <button type="button" onClick={() => setShowModal(false)} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={submitting} className="btn btn-primary">{submitting ? 'Creating...' : 'Create Rule'}</button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '20px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Rule Name</label>
                  <input type="text" value={name} onChange={e => setName(e.target.value)} required placeholder="e.g. Require Gold Assayer Certification"
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Scope</label>
                  <FilterSelect value={scope} onChange={setScope} options={[
                    { value: 'GLOBAL', label: 'Global' },
                    { value: 'CLIENT', label: 'Client' },
                    { value: 'BRANCH', label: 'Branch' },
                  ]} />
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
                  <FilterSelect value={ruleType} onChange={(v) => { setRuleType(v); setConditionKey(v === 'SKILL' ? 'requiredSkill' : 'requiredCertification'); }} options={[
                    { value: 'SKILL', label: 'Required Skill' },
                    { value: 'CERTIFICATION', label: 'Required Certification' },
                  ]} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Required Value</label>
                  <input type="text" value={conditionValue} onChange={e => setConditionValue(e.target.value)} required placeholder="e.g. Gold Assaying"
                    style={{ width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: '#fff', outline: 'none' }} />
                </div>
              </div>
        </Modal>
      )}
    </div>
  );
};
