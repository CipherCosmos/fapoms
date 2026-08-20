import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Trash2, Edit2, Shield, Sliders, AlertTriangle, Info } from 'lucide-react';
import { INDIAN_STATES } from '@fapoms/shared';
import { api } from '../services/api';
import { useClientOptions } from '../hooks/useClients';
import { StatusBadge, Modal, SearchInput, FilterSelect, PrimaryButton, Select, ChipMultiSelect } from '../components/ui';
import { useWorkforceVocabulary, asOptions } from '../hooks/useWorkforceVocabulary';
import { useCurrentRoles, canManageRules, canDeleteRules } from '../hooks/useCurrentRoles';

/**
 * The business rule engine.
 *
 * These rows are read directly by RuleEngine.evaluate() during candidate
 * recommendation (recommendation.engine.ts) — this is not a config screen for
 * its own sake, it decides who gets offered work. The old form only knew about
 * two of the five rule types the evaluator actually understands (SKILL,
 * CERTIFICATION), had no editor at all (despite the backend supporting it), and
 * asked an admin to hand-type a client or branch UUID into a text box for
 * anything scoped narrower than GLOBAL.
 */

interface BusinessRule {
  id: string;
  name: string;
  scope: 'GLOBAL' | 'CLIENT' | 'BRANCH';
  targetId: string | null;
  ruleType: string;
  conditions: Record<string, any>;
  actions: { type?: string; value?: number } | null;
  isActive?: boolean;
}

interface BranchOption { id: string; name: string; branchCode?: string }

/**
 * The five types RuleEngine.evaluateSingleRule() actually branches on, and the
 * exact condition key each one reads. PREFERENCE reads restrictedAssayers from
 * the client's own configuration, not from this row's `conditions` at all — so
 * it is shown read-only here rather than offered as something this page
 * configures, and ELIGIBILITY (mentioned nowhere in the evaluator) is not
 * offered at all: creating one would silently do nothing.
 */
const RULE_TYPES: { value: string; label: string; conditionKey: string; creatable: boolean; hint: string }[] = [
  { value: 'SKILL', label: 'Required skill', conditionKey: 'requiredSkill', creatable: true, hint: 'Assayer must have this exact skill recorded.' },
  { value: 'CERTIFICATION', label: 'Required certification', conditionKey: 'requiredCertification', creatable: true, hint: 'Assayer must hold this certification, unexpired, on the audit date.' },
  { value: 'TERRITORY', label: 'Restricted territory', conditionKey: 'restrictedStates', creatable: true, hint: 'Assayers based in these states are excluded.' },
  { value: 'CAPACITY', label: 'Concurrent assignment limit', conditionKey: 'maxWeeklyCapacity', creatable: true, hint: 'Excludes an assayer once this many assignments are open at once. Not windowed to a calendar week — an audit scheduled next month still occupies them.' },
  { value: 'PREFERENCE', label: 'Client preference (read-only)', conditionKey: '', creatable: false, hint: "Driven by the client's preferred/restricted assayer list, not by a condition set here." },
];

const ACTION_TYPES = [
  { value: 'BLOCK', label: 'Block — exclude the candidate entirely' },
  { value: 'SCORE_ADJUSTMENT', label: 'Score adjustment — nudge ranking up or down' },
  { value: 'ALERT', label: 'Alert only — surface a warning, do not exclude' },
];

/**
 * Short name for a rule action. `ACTION_TYPES` already carries the wording for the form's
 * dropdown, but those read as "Alert only — surface a warning, do not exclude": a full
 * explanation, right for a picker and far too long for a badge. Taking the part before the
 * dash reuses the one list rather than starting a second, and the raw value (SCORE_ADJUSTMENT)
 * never reaches the badge.
 */
function actionTypeLabel(t: string) {
  const meta = ACTION_TYPES.find((a) => a.value === t);
  return meta ? meta.label.split('—')[0].trim() : t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, ' ');
}

function ruleTypeMeta(t: string) {
  return RULE_TYPES.find((r) => r.value === t);
}

/** True when a rule's conditions object is missing the key the evaluator actually reads for its type — a silently-inert rule. */
function isMisconfigured(rule: BusinessRule): boolean {
  const meta = ruleTypeMeta(rule.ruleType);
  if (!meta || !meta.conditionKey) return false;
  const v = rule.conditions?.[meta.conditionKey];
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

const emptyForm = {
  name: '', scope: 'GLOBAL' as BusinessRule['scope'], targetId: '',
  ruleType: 'SKILL', requiredSkill: '', requiredCertification: '',
  restrictedStates: [] as string[], maxWeeklyCapacity: '',
  actionType: 'BLOCK', actionValue: '',
};

/**
 * Who may be sent to a job, and how their ranking is nudged.
 *
 * This was a page of its own at `/rules`, titled "Business Rule Engine", next to a separate
 * "Platform Settings" screen — so "where do I change how the system behaves" had two answers
 * and no signpost between them. It is a section of that screen now; the engine, the per-client
 * and per-branch scoping, and every stored rule are unchanged.
 */
export const RulesSection: React.FC = () => {
  const roles = useCurrentRoles();
  const canManage = canManageRules(roles);
  // Deletion is admin-only on the backend; showing it more widely only produced a 403 on click.
  const canDelete = canDeleteRules(roles);

  const [rules, setRules] = useState<BusinessRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilter] = useState('ALL');
  const [err, setErr] = useState<string | null>(null);

  const [form, setForm] = useState(emptyForm);

  /**
   * A rule's skill/certification is compared to an assayer's recorded competencies by exact
   * string match inside RuleEngine.evaluateSingleRule(). Typed free-hand, "Gold Assaying " or
   * "Gold Assayer" is accepted happily and then matches nobody — a BLOCK rule that excludes
   * every candidate, or a SCORE_ADJUSTMENT that never fires, with nothing on screen to say so.
   * Picking from the roster's own vocabulary makes that unrepresentable.
   */
  const { skills: skillOptions, certifications: certOptions } = useWorkforceVocabulary();

  const { data: clientsRes } = useClientOptions();
  const clients = (Array.isArray(clientsRes) ? clientsRes : (clientsRes as any)?.data) || [];
  const { data: branchesRes } = useQuery({ queryKey: ['branches', 'all'], queryFn: () => api.request<any>('/branches?limit=1000') });
  const branches: BranchOption[] = (Array.isArray(branchesRes) ? branchesRes : branchesRes?.data) || [];

  const fetchRules = async () => {
    setLoading(true);
    try {
      const data = await api.request<BusinessRule[]>('/planning/rules');
      setRules(Array.isArray(data) ? data : []);
    } catch (e) { setErr(e instanceof Error ? e.message : 'Failed to load rules'); }
    finally { setLoading(false); }
  };

  React.useEffect(() => { fetchRules(); }, []);

  const openCreate = () => { setEditingId(null); setForm(emptyForm); setShowModal(true); };

  const openEdit = (r: BusinessRule) => {
    setEditingId(r.id);
    setForm({
      name: r.name, scope: r.scope, targetId: r.targetId || '', ruleType: r.ruleType,
      requiredSkill: r.ruleType === 'SKILL' ? (r.conditions?.requiredSkill ?? '') : '',
      requiredCertification: r.ruleType === 'CERTIFICATION' ? (r.conditions?.requiredCertification ?? '') : '',
      restrictedStates: r.ruleType === 'TERRITORY' ? (r.conditions?.restrictedStates ?? []) : [],
      maxWeeklyCapacity: r.ruleType === 'CAPACITY' ? String(r.conditions?.maxWeeklyCapacity ?? '') : '',
      actionType: r.actions?.type ?? 'BLOCK',
      actionValue: r.actions?.value !== undefined ? String(r.actions.value) : '',
    });
    setShowModal(true);
  };

  const buildConditions = (): Record<string, any> => {
    switch (form.ruleType) {
      case 'SKILL': return { requiredSkill: form.requiredSkill.trim() };
      case 'CERTIFICATION': return { requiredCertification: form.requiredCertification.trim() };
      case 'TERRITORY': return { restrictedStates: form.restrictedStates };
      case 'CAPACITY': return { maxWeeklyCapacity: Number(form.maxWeeklyCapacity) };
      default: return {};
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // The target select is no longer a native <select required>, which used to block submission
    // via the browser's own constraint validation — that guarantee has to be re-asserted here now.
    if (form.scope !== 'GLOBAL' && !form.targetId) {
      setErr(`Choose a ${form.scope === 'CLIENT' ? 'client' : 'branch'} for this rule's scope.`);
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const payload: any = {
        name: form.name,
        scope: form.scope,
        targetId: form.scope === 'GLOBAL' ? undefined : (form.targetId || undefined),
        ruleType: form.ruleType,
        conditions: buildConditions(),
        actions: {
          type: form.actionType,
          ...(form.actionType === 'SCORE_ADJUSTMENT' && form.actionValue ? { value: Number(form.actionValue) } : {}),
        },
      };
      if (editingId) {
        await api.request(`/planning/rules/${editingId}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api.request('/planning/rules', { method: 'POST', body: JSON.stringify(payload) });
      }
      setShowModal(false);
      fetchRules();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to save rule');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this rule? Candidate scoring will stop applying it immediately.')) return;
    try { await api.request(`/planning/rules/${id}`, { method: 'DELETE' }); fetchRules(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Failed to delete rule'); }
  };

  const filtered = rules.filter((r) => {
    if (typeFilter !== 'ALL' && r.ruleType !== typeFilter) return false;
    const q = searchTerm.toLowerCase();
    return !q || r.name.toLowerCase().includes(q) || r.scope.toLowerCase().includes(q) || r.ruleType.toLowerCase().includes(q);
  });

  const misconfiguredCount = rules.filter(isMisconfigured).length;
  const targetName = (r: BusinessRule) => {
    if (r.scope === 'GLOBAL') return null;
    if (r.scope === 'CLIENT') return clients.find((c: any) => c.id === r.targetId)?.name ?? r.targetId;
    return branches.find((b: any) => b.id === r.targetId)?.name ?? r.targetId;
  };

  const conditionSummary = (r: BusinessRule): string => {
    const meta = ruleTypeMeta(r.ruleType);
    if (!meta) return JSON.stringify(r.conditions);
    switch (r.ruleType) {
      case 'SKILL': return r.conditions?.requiredSkill ? `Requires skill: ${r.conditions.requiredSkill}` : 'No skill set';
      case 'CERTIFICATION': return r.conditions?.requiredCertification ? `Requires certification: ${r.conditions.requiredCertification}` : 'No certification set';
      case 'TERRITORY': return (r.conditions?.restrictedStates ?? []).length ? `Excludes: ${r.conditions.restrictedStates.join(', ')}` : 'No states set';
      case 'CAPACITY': { const cap = r.conditions?.maxConcurrentAssignments ?? r.conditions?.maxWeeklyCapacity ?? r.conditions?.maxConcurrent; return cap ? `Excludes once open assignments ≥ ${cap}` : 'No limit set'; }
      case 'PREFERENCE': return "Mirrors the client's preferred/restricted assayer list";
      default: return JSON.stringify(r.conditions);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: '13px', margin: 0, maxWidth: '62ch', lineHeight: 1.55 }}>
          A rule can require a skill or a certificate, keep work out of a state, or cap how many
          open assignments someone may hold. Rules apply to everyone unless you point one at a
          single client or branch.
        </p>
        {canManage && <PrimaryButton onClick={openCreate}>Add a rule</PrimaryButton>}
      </div>

      {err && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'var(--status-cancelled-bg)', color: 'var(--danger)', fontSize: '13px' }}>{err}</div>
      )}

      {misconfiguredCount > 0 && (
        <div style={{ padding: '10px 14px', borderRadius: '8px', background: 'var(--status-pending-bg)', border: '1px solid var(--status-pending-bg)', color: 'var(--warning)', fontSize: '13px', display: 'flex', gap: '8px', alignItems: 'center' }}>
          <AlertTriangle size={15} /> {misconfiguredCount} rule(s) are missing the field their type actually needs — they are silently doing nothing. Flagged below with ⚠.
        </div>
      )}

      {/*
        * Four tiles counting rules by category used to sit here. With no rules configured they
        * were four zeroes above an empty list, and with a handful they restated what the list
        * already shows. The count that matters is beside the filter.
        */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <SearchInput value={searchTerm} onChange={setSearchTerm} placeholder="Search rules..." style={{ maxWidth: '320px' }} />
        <FilterSelect value={typeFilter} onChange={setTypeFilter} options={[{ value: 'ALL', label: 'All types' }, ...RULE_TYPES.map((t) => ({ value: t.value, label: t.label }))]} />
        <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{filtered.length} rules</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(340px, 100%), 1fr))', gap: '16px' }}>
        {loading ? (
          <div style={{ gridColumn: '1 / -1', padding: '40px', textAlign: 'center', color: 'var(--text-muted)' }}>Loading...</div>
        ) : filtered.length === 0 ? (
          <div style={{ gridColumn: '1 / -1', padding: '60px 20px', textAlign: 'center', border: '1px dashed var(--border-color)', borderRadius: 'var(--radius-lg)', color: 'var(--text-muted)' }}>
            <Sliders size={40} style={{ margin: '0 auto 12px', opacity: 0.4 }} />
            <p style={{ maxWidth: '46ch', margin: '0 auto', lineHeight: 1.6 }}>
              {searchTerm
                ? 'No rules match your search.'
                : 'No rules yet. Without any, every assayer is eligible for every job and ranking is decided by the recommendation score alone — which is a perfectly normal way to run. Add one when a client or a branch needs something specific.'}
            </p>
          </div>
        ) : (
          filtered.map((rule) => {
            const misconfigured = isMisconfigured(rule);
            const tn = targetName(rule);
            return (
              <div key={rule.id} className="glass-card" style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '14px', border: misconfigured ? '1px solid var(--status-pending-bg)' : undefined }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {misconfigured && <span title="Missing the field this rule type needs — currently doing nothing">⚠️</span>}
                    <Shield size={18} style={{ color: 'var(--accent-primary)' }} />
                    <span style={{ fontWeight: 600, fontSize: '15px' }}>{rule.name}</span>
                  </div>
                  {canManage && (
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button aria-label="Edit rule" onClick={() => openEdit(rule)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: '4px' }}><Edit2 size={14} /></button>
                      {canDelete && <button aria-label="Delete rule" onClick={() => handleDelete(rule.id)} style={{ background: 'none', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: '4px' }}><Trash2 size={14} /></button>}
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <StatusBadge label={tn ? `${rule.scope}: ${tn}` : rule.scope} bg="var(--border-hair)" color="var(--text-secondary)" />
                  <StatusBadge label={ruleTypeMeta(rule.ruleType)?.label ?? rule.ruleType} bg="rgba(216,174,71,0.1)" color="var(--accent-primary)" />
                  {rule.actions?.type && rule.actions.type !== 'BLOCK' && (
                    <StatusBadge label={actionTypeLabel(rule.actions.type)} bg="var(--status-pending-bg)" color="var(--warning)" />
                  )}
                </div>
                <div style={{ padding: '12px', background: 'rgba(0,0,0,0.15)', borderRadius: 'var(--radius-md)', fontSize: '12.5px', color: misconfigured ? 'var(--warning)' : 'var(--text-secondary)' }}>
                  {conditionSummary(rule)}
                </div>
              </div>
            );
          })
        )}
      </div>

      {showModal && canManage && (
        <Modal open onClose={() => setShowModal(false)} title={editingId ? 'Edit Business Rule' : 'Create Business Rule'} width="540px" asForm onSubmit={handleSubmit}
          footer={
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', width: '100%' }}>
              <button type="button" onClick={() => setShowModal(false)} className="btn btn-secondary" style={{ padding: '8px 16px', minHeight: '38px', fontSize: '13px', fontWeight: 600 }}>
                Cancel
              </button>
              <button type="submit" disabled={submitting} className="btn btn-primary" style={{ padding: '8px 20px', minHeight: '38px', fontSize: '13px', fontWeight: 700 }}>
                {submitting ? 'Saving Rule...' : '✓ Save Rule'}
              </button>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '20px' }}>
            <Field label="Rule Name">
              <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required placeholder="e.g. Require Gold Assayer Certification" style={inputStyle} />
            </Field>

            <Field label="Scope">
              <FilterSelect value={form.scope} onChange={(v) => setForm({ ...form, scope: v as any, targetId: '' })} options={[
                { value: 'GLOBAL', label: 'Global — applies to everyone' },
                { value: 'CLIENT', label: 'One client' },
                { value: 'BRANCH', label: 'One branch' },
              ]} />
            </Field>

            {form.scope === 'CLIENT' && (
              <Field label="Client">
                <Select
                  value={form.targetId}
                  onChange={(v) => setForm({ ...form, targetId: v })}
                  options={clients.map((c: any) => ({ value: c.id, label: c.name || c.clientCode }))}
                  placeholder="Select a client…"
                  style={inputStyle}
                />
              </Field>
            )}
            {form.scope === 'BRANCH' && (
              <Field label="Branch">
                <Select
                  value={form.targetId}
                  onChange={(v) => setForm({ ...form, targetId: v })}
                  options={branches.map((b: any) => ({ value: b.id, label: `${b.name} ${b.branchCode ? `(${b.branchCode})` : ''}` }))}
                  placeholder="Select a branch…"
                  style={inputStyle}
                />
              </Field>
            )}

            <Field label="Rule Type">
              <FilterSelect
                value={form.ruleType}
                onChange={(v) => setForm({ ...form, ruleType: v })}
                options={RULE_TYPES.filter((t) => t.creatable).map((t) => ({ value: t.value, label: t.label }))}
              />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', display: 'flex', gap: '5px', alignItems: 'flex-start' }}>
                <Info size={11} style={{ marginTop: '2px', flexShrink: 0 }} /> {ruleTypeMeta(form.ruleType)?.hint}
              </div>
            </Field>

            {form.ruleType === 'SKILL' && (
              <Field label="Required Skill">
                {/* Still loading, or the HR-scoped vocabulary is not readable by this role: keep the
                    old free-text box so a rule can always be recorded, rather than blocking the form. */}
                {skillOptions === null || skillOptions.length === 0 ? (
                  <input type="text" required value={form.requiredSkill} onChange={(e) => setForm({ ...form, requiredSkill: e.target.value })} placeholder="e.g. Gold Assaying" style={inputStyle} />
                ) : (
                  <ChipMultiSelect
                    aria-label="Required skill"
                    single
                    options={asOptions(skillOptions)}
                    value={form.requiredSkill ? [form.requiredSkill] : []}
                    onChange={(next) => setForm({ ...form, requiredSkill: next[0] ?? '' })}
                    searchPlaceholder="Search skills…"
                    emptyText="No skills recorded on the roster yet."
                  />
                )}
              </Field>
            )}
            {form.ruleType === 'CERTIFICATION' && (
              <Field label="Required Certification">
                {certOptions === null || certOptions.length === 0 ? (
                  <input type="text" required value={form.requiredCertification} onChange={(e) => setForm({ ...form, requiredCertification: e.target.value })} placeholder="e.g. Certified Gold Assayer" style={inputStyle} />
                ) : (
                  <ChipMultiSelect
                    aria-label="Required certification"
                    single
                    options={asOptions(certOptions)}
                    value={form.requiredCertification ? [form.requiredCertification] : []}
                    onChange={(next) => setForm({ ...form, requiredCertification: next[0] ?? '' })}
                    searchPlaceholder="Search certifications…"
                    emptyText="No certifications recorded on the roster yet."
                  />
                )}
              </Field>
            )}
            {form.ruleType === 'TERRITORY' && (
              <Field label="Restricted States">
                {/* Was "type a state and press Enter", which is the same exact-match trap as the
                    skill fields: TERRITORY compares these strings to the assayer's own state, so
                    "Maharastra" excludes nobody and the rule reads as configured. INDIAN_STATES is
                    the same canonical list the Zones page and the branch form already pick from. */}
                <ChipMultiSelect
                  aria-label="Restricted states"
                  options={INDIAN_STATES}
                  value={form.restrictedStates}
                  onChange={(next) => setForm({ ...form, restrictedStates: next })}
                  searchPlaceholder="Search states…"
                />
                <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
                  {form.restrictedStates.length === 0 ? 'None selected yet — the rule will do nothing until at least one state is chosen.' : `${form.restrictedStates.length} selected.`}
                </div>
              </Field>
            )}
            {form.ruleType === 'CAPACITY' && (
              <Field label="Max Weekly Capacity">
                <input type="number" min={1} required value={form.maxWeeklyCapacity} onChange={(e) => setForm({ ...form, maxWeeklyCapacity: e.target.value })} placeholder="e.g. 5" style={inputStyle} />
              </Field>
            )}

            <Field label="Action">
              <FilterSelect value={form.actionType} onChange={(v) => setForm({ ...form, actionType: v })} options={ACTION_TYPES} />
            </Field>
            {form.actionType === 'SCORE_ADJUSTMENT' && (
              <Field label="Score Adjustment Value">
                <input type="number" value={form.actionValue} onChange={(e) => setForm({ ...form, actionValue: e.target.value })} placeholder="e.g. -10 or 10" style={inputStyle} />
              </Field>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
};

const inputStyle: React.CSSProperties = { width: '100%', padding: '8px 12px', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontSize: '13px', boxSizing: 'border-box' };

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>{label}</label>
    {children}
  </div>
);

export default RulesSection;
